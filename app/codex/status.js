// Live Codex status from session rollouts (main-process Node only; no Electron imports).
//
// readStatus(opts) -> Promise<{ status, at, session, cwd }>   one look at the rollouts right now
// watchStatus(cb, opts) -> stop()   polls every opts.intervalMs (1000); calls cb({ status, at, session, cwd }) on the
//                                   first poll and whenever the status changes. stop.current() is the last status.
// createStatusTracker(opts) -> { poll(): Promise<status>, sessions(), task(), files: Map }
//                                   the incremental reader both use; sessions() is the per-rollout view.
//   opts.onEvent(e): e = { type: 'started'|'waiting'|'done'|'failed', title, session, threadId, cwd, at } on each
//                    session's status transition (not for the state found on the first poll).
// currentTask(opts) -> Promise<{ title (<= 48 chars), status, since, sessions (live count), approvalPending,
//                     session, threadId, cwd }>. title = the thread's name from <home>/session_index.jsonl, else the
//                     latest prompt, compressed.
// compressTitle(text, max = 48) -> one-line title.
//
// status: 'working' | 'waiting' | 'done' | 'failed' | 'idle'; at: ms epoch of the event that set it.
// opts: { homes?, home?, env?, intervalMs?, now?: () => ms }
//
// Rules (SCOPE-backend "Status"), per non-subagent rollout in <home>/sessions/YYYY/MM/DD (today and yesterday, local
// and UTC dates):
//   working  a task_started with no later task_complete/turn_aborted, file written <= 10 min ago
//   waiting  while working, a function_call/custom_tool_call pending >= 2 s (no *_output with its call_id) whose line
//            has "sandbox_permissions":"require_escalated" or a request_user_input* name
//   done     task_complete without error, held 15 min;   failed: task_complete with error, held 15 min
//   idle     anything else (incl. turn_aborted)
// Several live sessions (the Codex app runs many threads) combine as waiting > working > failed/done (newest) > idle.
// Files are read incrementally: each poll reads only the bytes appended since the last one.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { codexHomes } from './home.js'

export const WORKING_WINDOW_MS = 10 * 60 * 1000
export const HOLD_MS = 15 * 60 * 1000
export const WAIT_AFTER_MS = 2000
const FIRST_READ_MAX = 32 * 1024 * 1024
const CHUNK = 4 * 1024 * 1024
const RANK = { waiting: 4, working: 3, failed: 2, done: 2, idle: 0 }

const pad = (n) => String(n).padStart(2, '0')
function dayDirs (home, now) {
  const out = new Set()
  for (const back of [0, 1]) {
    const d = new Date(now - back * 86400000)
    out.add(path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
    out.add(path.join(home, 'sessions', String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())))
  }
  return [...out]
}

function newFileState () {
  return {
    offset: 0, partial: '', size: 0, mtimeMs: 0, meta: null,
    open: new Map(), pending: new Map(), terminal: null, lastAt: 0
  }
}

const RX_HEAD = /"type":"(event_msg|response_item)","payload":\{"type":"([a-z_]+)"/
const RX_TS = /^\{"timestamp":"([^"]+)"/
const RX_TURN = /"turn_id":"([^"]+)"/
const RX_CALL = /"call_id":"([^"]+)"/

// What the person typed: the user message's text, minus the context Codex injects (AGENTS.md, environment, etc.).
function userText (line) {
  if (line.length > 256 * 1024) return null
  try {
    const p = JSON.parse(line).payload || {}
    const parts = Array.isArray(p.content) ? p.content : []
    const text = parts.filter((c) => c && (c.type === 'input_text' || c.type === 'text') && typeof c.text === 'string')
      .map((c) => c.text).join('\n').trim()
    if (!text || text.startsWith('<') || /^# AGENTS\.md/.test(text) || /^<?(environment_context|user_instructions)/.test(text)) return null
    return text.slice(0, 400)
  } catch { return null }
}

// <= max chars, one line: the first sentence-ish of a prompt.
export function compressTitle (s, max = 48) {
  let t = String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim()
  t = t.replace(/^(please|pls|can you|could you|hey codex,?|codex,?)\s+/i, '')
  const stop = t.search(/[.?!\n](\s|$)/)
  if (stop > 12 && stop < max) t = t.slice(0, stop)
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…'
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

function applyLine (st, line) {
  if (line.length < 20) return
  const head = line.slice(0, 400)
  const m = RX_HEAD.exec(head)
  if (!m) return
  const kind = m[2]
  const ts = RX_TS.exec(head)
  const at = (ts && Date.parse(ts[1])) || Date.now()
  st.lastAt = Math.max(st.lastAt, at)
  if (m[1] === 'event_msg') {
    if (kind === 'task_started') {
      const t = RX_TURN.exec(head)
      st.open.set(t ? t[1] : `turn@${at}`, at)
      st.terminal = null
    } else if (kind === 'task_complete' || kind === 'turn_aborted') {
      const t = RX_TURN.exec(head)
      if (t && st.open.has(t[1])) st.open.delete(t[1])
      else st.open.clear()
      st.open.delete('?')
      st.pending.clear()
      if (kind === 'turn_aborted') { st.terminal = { status: 'idle', at }; return }
      let failed = false
      try {
        const p = JSON.parse(line).payload || {}
        failed = p.error != null && p.error !== false
      } catch { failed = line.includes('"codex_error_info"') }
      st.terminal = { status: failed ? 'failed' : 'done', at }
    }
    return
  }
  if (kind === 'message') {
    if (!/"role":"user"/.test(head)) return
    const text = userText(line)
    if (text) st.lastPrompt = text
    return
  }
  if (kind === 'function_call' || kind === 'custom_tool_call') {
    const needsUser = line.includes('require_escalated') || /"name":"request_user_input/.test(line)
    if (!needsUser) return
    let id = null
    const c = RX_CALL.exec(line)
    if (c) id = c[1]
    if (!id) try { id = JSON.parse(line).payload.call_id } catch {}
    st.pending.set(id || `call@${at}`, at)
  } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
    if (!st.pending.size) return
    const c = RX_CALL.exec(head) || RX_CALL.exec(line)
    if (c) st.pending.delete(c[1])
  }
}

async function readMeta (file) {
  // session_meta is the first line; its small keys (cwd, source) come before the long base_instructions.
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const buf = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const s = buf.toString('utf8', 0, bytesRead)
    const first = s.split('\n', 1)[0]
    const sub = /"source":\s*\{\s*"subagent"/.test(first) || /"thread_source":\s*"subagent"/.test(first)
    let cwd = null
    const c = /"cwd":("(?:[^"\\]|\\.)*")/.exec(first)
    if (c) try { cwd = JSON.parse(c[1]) } catch {}
    const idm = /"payload":\{[^{}]*?"id":"([0-9a-f-]{20,})"/.exec(first) || /"session_id":"([0-9a-f-]{20,})"/.exec(first)
    const fromName = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)
    const threadId = (idm && idm[1]) || (fromName && fromName[1]) || null
    return { sub, cwd, threadId, ok: /"source":/.test(first) || s.includes('\n') }
  } catch { return { sub: false, cwd: null, threadId: null, ok: false } } finally { await fh?.close().catch(() => {}) }
}

async function readAppended (file, st, size) {
  if (size < st.offset) { Object.assign(st, newFileState(), { meta: st.meta }) }
  if (st.offset === 0 && size > FIRST_READ_MAX) {
    st.offset = size - FIRST_READ_MAX
    st.skipPartial = true
    st.open.set('?', 0) // started mid-file: assume a turn may be open until a completion says otherwise
  }
  if (size <= st.offset) return
  let fh
  try {
    fh = await fsp.open(file, 'r')
    while (st.offset < size) {
      const len = Math.min(CHUNK, size - st.offset)
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, st.offset)
      if (!bytesRead) break
      st.offset += bytesRead
      let text = st.partial + buf.toString('utf8', 0, bytesRead)
      const lines = text.split('\n')
      st.partial = lines.pop()
      if (st.skipPartial) { lines.shift(); st.skipPartial = false }
      for (const line of lines) applyLine(st, line)
      text = null
      if (st.partial.length > 64 * 1024 * 1024) st.partial = '' // a runaway line; drop it
    }
  } catch {} finally { await fh?.close().catch(() => {}) }
}

function fileStatus (st, now) {
  const fresh = now - st.mtimeMs <= WORKING_WINDOW_MS
  if (fresh && st.open.size) {
    for (const at of st.pending.values()) if (now - at >= WAIT_AFTER_MS) return { status: 'waiting', at: at + WAIT_AFTER_MS }
    let at = 0
    for (const a of st.open.values()) at = Math.max(at, a)
    return { status: 'working', at: at || st.lastAt || st.mtimeMs }
  }
  if (st.terminal && st.terminal.status !== 'idle' && now - st.terminal.at <= HOLD_MS) return { ...st.terminal }
  return { status: 'idle', at: (st.terminal && st.terminal.at) || st.lastAt || st.mtimeMs }
}

export function createStatusTracker (opts = {}) {
  const files = new Map()
  const nowFn = opts.now || Date.now
  async function poll () {
    const now = nowFn()
    const homes = opts.homes || codexHomes(opts)
    const seen = new Set()
    for (const home of homes) {
      for (const dir of dayDirs(home, now)) {
        let names = []
        try { names = fs.readdirSync(dir) } catch { continue }
        for (const name of names) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
          const file = path.join(dir, name)
          let stat
          try { stat = fs.statSync(file) } catch { continue }
          if (now - stat.mtimeMs > HOLD_MS && !files.has(file)) continue
          seen.add(file)
          let st = files.get(file)
          if (!st) { st = newFileState(); files.set(file, st) }
          if (!st.meta || !st.meta.ok) st.meta = await readMeta(file)
          if (st.meta.sub) { st.mtimeMs = stat.mtimeMs; continue }
          if (stat.size !== st.size || stat.mtimeMs !== st.mtimeMs) {
            await readAppended(file, st, stat.size)
            st.size = stat.size
            st.mtimeMs = stat.mtimeMs
          }
        }
      }
    }
    const titles = readTitles(homes)
    let best = { status: 'idle', at: 0, session: null, cwd: null }
    for (const [file, st] of files) {
      if (!seen.has(file) || now - st.mtimeMs > HOLD_MS) { files.delete(file); continue }
      if (st.meta?.sub) continue
      const s = fileStatus(st, now)
      st.title = (st.meta?.threadId && titles.get(st.meta.threadId)) || compressTitle(st.lastPrompt) || null
      // transitions -> events (none on the first poll: that's the state we found, not something that happened)
      const prev = st.prevStatus ?? (polled ? 'idle' : s.status)
      if (s.status !== prev && opts.onEvent) {
        const type = s.status === 'working' ? (prev === 'waiting' ? null : 'started')
          : s.status === 'waiting' ? 'waiting' : s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : null
        if (type) {
          try { opts.onEvent({ type, title: st.title || 'Codex task', session: path.basename(file), threadId: st.meta?.threadId || null, cwd: st.meta?.cwd || null, at: s.at }) } catch {}
        }
      }
      st.prevStatus = s.status
      const better = RANK[s.status] > RANK[best.status] ||
        (RANK[s.status] === RANK[best.status] && (s.at > best.at || (s.status === 'idle' && st.mtimeMs > (best.mtimeMs || 0))))
      if (better) best = { ...s, session: path.basename(file), cwd: st.meta?.cwd || null, title: st.title, threadId: st.meta?.threadId || null, mtimeMs: st.mtimeMs }
    }
    polled = true
    delete best.mtimeMs
    if (!best.at) best.at = now
    last = best
    return best
  }
  let polled = false
  let last = null
  // Per-session view of the last poll: [{ session, threadId, cwd, title, status, at }], newest first.
  function sessions () {
    const now = nowFn()
    return [...files].filter(([, st]) => !st.meta?.sub)
      .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
      .map(([file, st]) => ({ session: path.basename(file), threadId: st.meta?.threadId || null, cwd: st.meta?.cwd || null, title: st.title || null, ...fileStatus(st, now) }))
  }
  // What Codex is doing, from the last poll.
  function task () {
    const all = sessions()
    const live = all.filter((s) => s.status === 'working' || s.status === 'waiting')
    const b = last || { status: 'idle', at: nowFn() }
    const top = all.find((s) => s.session === b.session) || null
    return {
      title: (top && top.title) || null,
      status: b.status,
      since: b.at,
      sessions: live.length,
      approvalPending: live.some((s) => s.status === 'waiting'),
      session: b.session || null,
      threadId: (top && top.threadId) || null,
      cwd: b.cwd || null
    }
  }
  return { poll, sessions, task, files }
}

// Thread titles the Codex app and CLI keep in <home>/session_index.jsonl ({ id, thread_name, updated_at } per line).
const titleCache = new Map()
function readTitles (homes) {
  const out = new Map()
  for (const home of homes) {
    const file = path.join(home, 'session_index.jsonl')
    let st
    try { st = fs.statSync(file) } catch { continue }
    let hit = titleCache.get(file)
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      const map = new Map()
      try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue
          try { const e = JSON.parse(line); if (e && e.id && e.thread_name) map.set(e.id, String(e.thread_name)) } catch {}
        }
      } catch {}
      hit = { mtimeMs: st.mtimeMs, size: st.size, map }
      titleCache.set(file, hit)
    }
    for (const [k, v] of hit.map) out.set(k, compressTitle(v))
  }
  return out
}

// Read-only snapshot: { title, status, since, sessions, approvalPending, session, threadId, cwd }.
export async function currentTask (opts = {}) {
  try {
    const t = createStatusTracker(opts)
    await t.poll()
    return t.task()
  } catch { return { title: null, status: 'idle', since: Date.now(), sessions: 0, approvalPending: false, session: null, threadId: null, cwd: null } }
}

export async function readStatus (opts = {}) {
  try { return await createStatusTracker(opts).poll() } catch { return { status: 'idle', at: Date.now(), session: null, cwd: null } }
}

export function watchStatus (cb, opts = {}) {
  const tracker = createStatusTracker(opts)
  let last = null
  let busy = false
  let stopped = false
  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try {
      const s = await tracker.poll()
      if (!stopped && (!last || s.status !== last.status)) {
        last = s
        try { cb(s) } catch {}
      }
    } catch {} finally { busy = false }
  }
  tick()
  const timer = setInterval(tick, opts.intervalMs || 1000)
  if (timer.unref && opts.unref !== false) timer.unref()
  const stop = () => { stopped = true; clearInterval(timer) }
  stop.current = () => last
  stop.tracker = tracker
  return stop
}
