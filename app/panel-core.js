// Tray popover helpers with no Electron (TRAY lane): where the popover sits, what the pet says when recalled, and a
// read-only tail of Codex's live rollouts turned into short terminal lines.

import fs from 'node:fs'
import path from 'node:path'
import { codexHomes } from './codex/home.js'

export const PANEL = Object.freeze({ width: 320, height: 460 })

/**
 * Popover bounds under (macOS menu bar) or over (Windows taskbar) the tray icon, kept inside the work area.
 * tray: the tray icon's bounds ({x,y,width,height}; zeros when the platform can't tell, e.g. most Linux trays).
 * workArea / bounds: the display's. Falls back to the top-right corner of the work area.
 */
export function anchorBounds ({ tray, workArea, bounds = workArea, size = PANEL, gap = 6 }) {
  const { width, height } = size
  const clampX = x => Math.round(Math.max(workArea.x + gap, Math.min(x, workArea.x + workArea.width - width - gap)))
  const clampY = y => Math.round(Math.max(workArea.y + gap, Math.min(y, workArea.y + workArea.height - height - gap)))
  const known = tray && tray.width > 0 && tray.height > 0
  if (!known) return { x: clampX(workArea.x + workArea.width - width - gap), y: clampY(workArea.y + gap), width, height }
  const cx = tray.x + tray.width / 2
  const cy = tray.y + tray.height / 2
  const midY = bounds.y + bounds.height / 2
  // Taskbar on the left or right edge (Windows): open beside it.
  if (tray.x < workArea.x || tray.x >= workArea.x + workArea.width) {
    const x = tray.x < workArea.x ? workArea.x + gap : workArea.x + workArea.width - width - gap
    return { x: clampX(x), y: clampY(cy - height / 2), width, height }
  }
  const y = cy < midY ? tray.y + tray.height + gap : tray.y - height - gap
  return { x: clampX(cx - width / 2), y: clampY(y), width, height }
}

/** The pet's reply to "Come home". state: what the pane last reported ({ errand, home, dnd }). */
export function recallReply (state = {}, petName = 'your pet') {
  const errand = state.errand || (state.busyWith ? { with: state.busyWith } : null)
  if (errand) {
    const who = errand.with || errand.owner || null
    const what = errand.label ? ` with ${errand.label}` : ''
    return who ? `busy helping ${who}${what}, back soon` : `busy on an errand${what}, back soon`
  }
  if (state.dnd) return 'already home, tucked in'
  if (state.home === true) return 'already home'
  return `${petName} is on the way home`
}

/** One word for the header, from the pane's report and Codex's status. */
export function statusLine (pane = {}, codexStatus = 'idle') {
  if (pane.dnd) return { key: 'dnd', text: 'do not disturb' }
  if (pane.errand) {
    const who = pane.errand.with || pane.errand.owner
    return { key: 'away', text: who ? `away on an errand · helping ${who}` : 'away on an errand' }
  }
  // busyWith: who our pet's current job is with (the pane's 2 s report); home: whether it is on its own screen.
  if (pane.busyWith) return { key: 'away', text: pane.home === false ? `away · helping ${pane.busyWith}` : `busy · helping ${pane.busyWith}` }
  if (codexStatus === 'waiting') return { key: 'waiting', text: 'waiting for you' }
  if (codexStatus === 'working') return { key: 'working', text: 'working' }
  if (codexStatus === 'failed') return { key: 'failed', text: 'hit a snag' }
  if (codexStatus === 'done') return { key: 'done', text: 'done' }
  return { key: 'idle', text: 'idle' }
}

// ---------------------------------------------------------------------------------------------------------------
// Rollout lines -> terminal lines.

const clip = (s, n = 96) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
function firstLine (s) {
  for (const line of String(s ?? '').split('\n')) { const t = line.trim(); if (t && !t.startsWith('//')) return t }
  return ''
}
function commandOf (args) {
  let a = args
  if (typeof a === 'string') { try { a = JSON.parse(a) } catch { return clip(a) } }
  if (!a || typeof a !== 'object') return ''
  const cmd = a.cmd ?? a.command
  if (Array.isArray(cmd)) {
    const last = cmd[cmd.length - 1]
    return clip(cmd.length >= 3 && /^(ba|z)?sh$/.test(path.basename(String(cmd[0]))) ? last : cmd.join(' '))
  }
  if (typeof cmd === 'string') return clip(cmd)
  if (a.path || a.file_path) return clip(a.path || a.file_path)
  if (a.query) return clip(a.query)
  return ''
}
function textOf (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(c => c?.text ?? '').join(' ')
}

// Codex's code-mode `exec` tool runs a script of tools.<name>({...}) calls; each one is a terminal line.
const RX_SCRIPT_CALL = /tools\.([A-Za-z_][\w.]*)\(\s*\{\s*(?:(?:cmd|command|query|path)\s*:\s*"((?:[^"\\]|\\.)*)")?/g
function scriptCalls (input) {
  const out = []
  for (const m of String(input || '').matchAll(RX_SCRIPT_CALL)) {
    let arg = m[2] ?? ''
    try { arg = JSON.parse(`"${arg}"`) } catch {}
    if (/^(exec_command|shell|local_shell)$/.test(m[1]) && arg) out.push({ kind: 'cmd', text: clip(arg) })
    else out.push({ kind: 'tool', text: clip(arg ? `${m[1]} ${arg}` : m[1]) })
    if (out.length >= 4) break
  }
  return out
}

/** Every terminal line one rollout JSON line makes ([] for none). */
export function rolloutEntries (line) {
  const e = rolloutEntry(line)
  return !e ? [] : Array.isArray(e) ? e : [e]
}

/** One rollout JSON line -> { kind, text }, an array of them (a script of calls), or null. kind: 'cmd' | 'tool' | 'say' | 'think' | 'task'. */
export function rolloutEntry (line) {
  if (!line || line.length < 20) return null
  let o
  try { o = JSON.parse(line) } catch { return null }
  const p = o?.payload
  if (!p || typeof p !== 'object') return null
  if (o.type === 'event_msg') {
    if (p.type === 'task_started') return { kind: 'task', text: 'started a task' }
    if (p.type === 'task_complete') return { kind: 'task', text: 'task done' }
    if (p.type === 'turn_aborted') return { kind: 'task', text: 'stopped' }
    if (p.type === 'exec_command_begin') { const c = commandOf({ command: p.command }); return c ? { kind: 'cmd', text: c } : null }
    if (p.type === 'web_search_begin' || p.type === 'web_search_end') return p.query ? { kind: 'tool', text: `search ${clip(p.query, 80)}` } : null
    if (p.type === 'mcp_tool_call_begin') {
      const inv = p.invocation || {}
      return { kind: 'tool', text: clip(`${inv.server || 'mcp'}.${inv.tool || 'call'}`) }
    }
    return null
  }
  if (o.type !== 'response_item') return null
  if (p.type === 'function_call' || p.type === 'local_shell_call') {
    const name = p.name || 'shell'
    const c = commandOf(p.arguments ?? p.action)
    if (/^(shell|exec_command|local_shell|container\.exec)$/.test(name) || p.type === 'local_shell_call') return c ? { kind: 'cmd', text: c } : null
    return { kind: 'tool', text: clip(c ? `${name} ${c}` : name) }
  }
  if (p.type === 'custom_tool_call') {
    const calls = scriptCalls(p.input)
    if (calls.length) return calls.length === 1 ? calls[0] : calls
    const first = firstLine(p.input)
    if (p.name === 'apply_patch') {
      const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(String(p.input || ''))
      return { kind: 'tool', text: clip(`apply_patch ${m ? path.basename(m[1]) : ''}`) }
    }
    return { kind: 'tool', text: clip(`${p.name || 'tool'}${first ? ` ${first}` : ''}`) }
  }
  if (p.type === 'web_search_call') return { kind: 'tool', text: clip(`search ${p.action?.query || ''}`) }
  if (p.type === 'reasoning') {
    const t = textOf(p.summary)
    const m = /\*\*(.+?)\*\*/.exec(t)
    const title = m ? m[1] : firstLine(t)
    return title ? { kind: 'think', text: clip(title, 80) } : null
  }
  if (p.type === 'message' && p.role === 'assistant') {
    const t = firstLine(textOf(p.content))
    return t ? { kind: 'say', text: clip(t, 110) } : null
  }
  return null
}

const pad = n => String(n).padStart(2, '0')
function dayDirs (home, now) {
  const out = new Set()
  for (const back of [0, 1]) {
    const d = new Date(now - back * 86400000)
    out.add(path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
    out.add(path.join(home, 'sessions', String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())))
  }
  return [...out]
}

/**
 * Tail Codex's live rollouts (read-only). onLine({ source: 'codex', kind, text, at, session }) per new line.
 * The newest few sessions touched in the last 10 minutes; on first sight only their last `backlog` lines.
 * -> stop()
 */
export function tailRollouts (onLine, { homes, env, intervalMs = 1000, backlog = 6, maxFiles = 3, now = Date.now } = {}) {
  const files = new Map() // file -> { offset, partial }
  let stopped = false
  let busy = false
  const emit = (entry, file) => {
    try { onLine({ source: 'codex', ...entry, at: now(), session: path.basename(file).slice(-14, -6) }) } catch {}
  }
  function readFrom (file, st, size) {
    if (size <= st.offset) { if (size < st.offset) st.offset = size; return [] }
    const len = Math.min(size - st.offset, 2 * 1024 * 1024)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, buf, 0, len, st.offset) } finally { fs.closeSync(fd) }
    st.offset += len
    const text = st.partial + buf.toString('utf8')
    const lines = text.split('\n')
    st.partial = lines.pop() || ''
    if (st.partial.length > 4 * 1024 * 1024) st.partial = ''
    return lines
  }
  function tick () {
    if (busy || stopped) return
    busy = true
    try {
      const t = now()
      const found = []
      for (const home of homes || codexHomes({ env })) {
        for (const dir of dayDirs(home, t)) {
          let names = []
          try { names = fs.readdirSync(dir) } catch { continue }
          for (const name of names) {
            if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
            const file = path.join(dir, name)
            try {
              const s = fs.statSync(file)
              if (t - s.mtimeMs <= 10 * 60 * 1000) found.push({ file, size: s.size, mtimeMs: s.mtimeMs })
            } catch {}
          }
        }
      }
      found.sort((a, b) => b.mtimeMs - a.mtimeMs)
      for (const { file, size } of found.slice(0, maxFiles)) {
        let st = files.get(file)
        if (!st) {
          st = { offset: Math.max(0, size - 64 * 1024), partial: '' }
          files.set(file, st)
          const lines = readFrom(file, st, size)
          if (st.offset > 0 && size > 64 * 1024) lines.shift() // a cut line
          const entries = lines.flatMap(rolloutEntries)
          for (const e of entries.slice(-backlog)) emit(e, file)
          continue
        }
        for (const line of readFrom(file, st, size)) for (const e of rolloutEntries(line)) emit(e, file)
      }
    } catch {} finally { busy = false }
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}

/** A bounded line buffer for the terminal. */
export function ringBuffer (max = 200) {
  const lines = []
  return {
    push (line) { lines.push(line); if (lines.length > max) lines.splice(0, lines.length - max); return line },
    all: () => lines.slice(),
    get size () { return lines.length },
  }
}
