// Peer answers for petpack_ask (lane L3b). Main-process Node module, no Electron imports.
//
// answerAsk(question | {question, kind, fromName}, ctx) -> {ok, tier, text, share?, pkg?, item?, ms, reason?, busy?}
//   tier 1: an item in this machine's catalog scores >= 0.5 against the question. Instant: its summary and an
//           excerpt, and the item itself as the dot (pkg).
//   tier 2: a read-only, ephemeral `codex exec` answers from this machine's knowledge, with an output schema and a
//           35 s kill. One exec at a time with a queue of 1; past that it replies busy at once. Each answer is
//           saved as a Library card (answersDir/*.md) so the next asker finds it with search.
//
// ctx: catalog options (codexHome, homeDir, cwd, answersDir, env) plus codexBin, timeoutMs, effort, noExec,
//      tier1Threshold.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { buildCatalog, readItem, itemSource, defaultAnswersDir, slugify, summarize, invalidateCatalog } from './catalog.js'
import { shortQuestion, SHORT_MAX } from './question.js'

// GUI launches (Finder, login items) get a thin PATH; add the usual homes of a `codex` binary.
export function childEnv (env = process.env) {
  if (process.platform === 'win32') return env
  const home = os.homedir()
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin')]
  const have = String(env.PATH || '').split(path.delimiter).filter(Boolean)
  return { ...env, PATH: [...have, ...extra.filter(d => !have.includes(d))].join(path.delimiter) }
}

export const TIER1_MIN = 0.5
export const ROUTE_MIN = 0.3
export const ASK_TIMEOUT_MS = 35000
export const ANSWER_MAX = 1200

export const ASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'short', 'share'],
  properties: {
    answer: { type: 'string', description: 'The answer, like a teammate would say it: at most two short sentences.' },
    short: { type: 'string', description: 'The gist for a speech bubble, at most 40 characters.' },
    share: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'title', 'body'],
          properties: {
            kind: { type: 'string', enum: ['memory', 'technique'] },
            title: { type: 'string' },
            body: { type: 'string' }
          }
        }
      ]
    }
  }
}

// ---------------------------------------------------------------- scoring (same rule the brain routes with)

const STOP = new Set(('a an and are as at be but by can could do does did for from get got has have how i if in into ' +
  'is it its me my of on or our so that the their them then there these this to too use used using was we what when ' +
  'where which who why will with would you your make made need needs want also just like any some there here should ' +
  'please help know about way does work works working out up off one thing things stuff').split(' '))

// Single-word names too common to count as "the question names this item" on their own.
const GENERIC_NAMES = new Set(('build design research product paper test review deploy debug fix doc docs code data ' +
  'app web api plan run write read search tool tools note notes board conductor devops frontier ml ui setup config ' +
  'help rule rules project').split(' '))

function stem (t) {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y'
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1)
  return t
}

export function tokenize (s) {
  const out = new Set()
  for (const raw of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue
    out.add(stem(raw))
  }
  return out
}

// Token overlap of the question with the item's title (weight 1) and summary (weight 0.5), normalised by
// min(question size, 4), plus 0.2 when the kind matches: the same rule as the brain's search and routing.
export function scoreItem (question, item, kind) {
  const q = question instanceof Set ? question : tokenize(question)
  if (!q.size || !item) return 0
  const title = tokenize(String(item.title || '') + ' ' + String(item.ref || '').split(':').slice(1).join(' '))
  const summary = tokenize(item.summary)
  let hits = 0
  for (const t of q) {
    if (title.has(t)) hits += 1
    else if (summary.has(t)) hits += 0.5
  }
  let s = hits / Math.min(q.size, 4)
  if (s > 0 && kind && item.kind === kind) s += 0.2
  return Math.min(1.5, Math.round(s * 1000) / 1000)
}

// The question names the item: every token of its name (title) is in the question, e.g. "pdf" in "how do I pull
// tables out of a PDF?". Names of 1-4 tokens only; a lone generic word ("build", "design") doesn't count.
export function namesItem (question, item) {
  const q = question instanceof Set ? question : tokenize(question)
  const name = tokenize(item?.title)
  if (!name.size || name.size > 4) return false
  if (name.size === 1 && GENERIC_NAMES.has([...name][0])) return false
  if (![...name].some(t => t.length >= 3)) return false
  for (const t of name) if (!q.has(t)) return false
  return true
}

export function rankItems (question, items, kind, n = 3) {
  const q = tokenize(question)
  return (items || [])
    .map(item => {
      const named = namesItem(q, item)
      return { item, score: scoreItem(q, item, kind), named }
    })
    .filter(r => r.score > 0)
    .sort((a, b) => Number(b.named) - Number(a.named) || b.score - a.score || (b.item.mtime || 0) - (a.item.mtime || 0))
    .slice(0, n)
}

// Tier 1 takes the top item when it scores >= 0.5 or the question names it.
export function tier1Pick (question, items, kind, threshold = TIER1_MIN) {
  const top = rankItems(question, items, kind, 1)[0]
  return top && (top.named || top.score >= threshold) ? top : null
}

// ---------------------------------------------------------------- tier 1

function excerptOf (text, max = 900) {
  const body = String(text || '').replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\s*/, '').trim()
  return body.length > max ? body.slice(0, max - 1).trimEnd() + '…' : body
}

export const SAY_MAX = 110

function clipWords (s, max) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.4 ? cut.slice(0, sp) : cut).replace(/[\s,;:(-]+$/, '') + '…'
}

// Candidate clauses from a description and a section/SKILL.md body, cleaned of markdown.
function clausesOf (...texts) {
  const out = []
  for (const t of texts) {
    const clean = String(t || '')
      .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\s*/, '')
      .replace(/```[\s\S]*?```/g, '\n')
      .replace(/^\s*#+\s.*$/gm, '\n')
      .replace(/^\([^)\n]*AGENTS\.md\)$/gm, '\n')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_>]/g, '')
    for (const part of clean.split(/\n+|(?<=[.!?])\s+|;\s+|\s+-\s+/)) {
      const c = part.replace(/^\s*(?:[-+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim().replace(/[.:,]+$/, '')
      if (c.length >= 12 && c.length <= 400 && !/^(name|description):/i.test(c)) out.push(c)
    }
  }
  return out
}

// The clause that best matches the question (token overlap; "Use when ..." boilerplate scores lower).
export function bestClause (question, ...texts) {
  const q = tokenize(question)
  let best = null
  for (const [i, c] of clausesOf(...texts).entries()) {
    const toks = tokenize(c)
    let s = 0
    for (const t of q) if (toks.has(t)) s += 1
    if (/^use (this( skill)? )?when\b/i.test(c)) s -= 0.4
    if (/(?:^|\s)[~.]?\/[\w.-]+\/|[{}]|\w+\.(?:json|md|js|py|ts|txt)\b/.test(c)) s -= 1.5 // paths and file soup read badly in a bubble
    s -= i * 0.001 + Math.max(0, c.length - 140) * 0.002
    if (!best || s > best.s) best = { c, s }
  }
  if (!best) return ''
  let c = best.c.replace(/^use (this( skill)? )?when\b/i, 'Handy when')
  return c.charAt(0).toUpperCase() + c.slice(1)
}

const LEAD = {
  skill: t => `I've got a skill for that: ${t}.`,
  resource: t => `I use the ${t} MCP server for that.`,
  memory: () => "I've hit this before.",
  technique: () => 'Been there.'
}
const SHORT = {
  skill: t => `my ${t} skill has it`,
  resource: t => `my ${t} server does it`,
  memory: t => `my notes: ${t}`,
  technique: t => `my trick: ${t}`
}

// One short teammate sentence (<= 110 chars) and a bubble line (<= 40 chars) about an item.
export function teammateSay (item, question, text = '', { unsure = false } = {}) {
  const kind = LEAD[item.kind] ? item.kind : 'memory'
  const title = clipWords(item.title, 40)
  if (unsure) {
    const what = kind === 'skill' ? `my ${title} skill` : kind === 'resource' ? `my ${title} server` : `my note on ${title}`
    return { text: clipWords(`Not sure, but ${what} might help.`, SAY_MAX), short: clipWords(`maybe ${what}?`, SHORT_MAX) }
  }
  const lead = LEAD[kind](title)
  const clause = bestClause(question, item.summary, text)
  const room = SAY_MAX - lead.length - 1
  let part = clause && room >= 20 ? clipWords(clause, room - 1) : ''
  if (part.endsWith('…')) { // cut back to a whole phrase rather than a dangling word
    part = part.slice(0, -1)
    const k = Math.max(part.lastIndexOf(','), part.lastIndexOf(' ('))
    if (k > part.length * 0.55) part = part.slice(0, k)
  }
  const say = part ? `${lead} ${part.replace(/[\s,;:(-]+$/, '')}.` : lead
  return { text: say.replace(/\.\.$/, '.').slice(0, SAY_MAX), short: clipWords(SHORT[kind](item.title), SHORT_MAX) }
}

// The bubble line for a free-text answer: its first sentence, clipped.
export function shortAnswer (text) {
  const first = String(text || '').replace(/[`*_#>]/g, '').split(/(?<=[.!?])\s+|\n/)[0] || ''
  return clipWords(first.replace(/[.!]+$/, ''), SHORT_MAX)
}

// At most two sentences when a model runs long.
export function twoSentences (text, max = 320) {
  const s = String(text || '').trim()
  if (s.length <= max) return s
  const parts = s.split(/(?<=[.!?])\s+/)
  const two = parts.slice(0, 2).join(' ')
  return two.length <= max + 80 ? two : clipWords(two, max)
}

// A short teammate answer from the item, and the item itself as the dot (pkg) so the asker installs it.
async function tier1 (best, ctx, question, opts = {}) {
  const { item } = best
  const r = await readItem(item.ref, 'pkg', ctx)
  if (!r.ok) return null
  let text = r.text
  if (item.kind === 'skill') text = (await readItem(item.ref, 'text', ctx)).text || ''
  const say = teammateSay(item, question, text, opts)
  return {
    ok: true,
    tier: 1,
    text: say.text,
    short: say.short,
    item,
    share: { kind: item.kind, ref: item.ref, title: item.title, body: excerptOf(text, 4000) },
    pkg: r.pkg
  }
}

// ---------------------------------------------------------------- tier 2

function prompt ({ question, kind, fromName }, hints) {
  const lines = [
    `A teammate's coding agent (${fromName || 'a teammate'}'s agent) asks you a question through petpack, a team commons.`,
    'Answer from what you already know on this machine: your skills, memories, AGENTS.md and the files of the current',
    'project. Read files if useful, but change nothing and avoid long commands; reply quickly.',
    'Reply like a teammate: answer is at most two short sentences (under 280 characters), concrete (the command, file,',
    'setting or tool to use); short is the gist in at most 40 characters for a speech bubble (e.g. "use pdfplumber',
    'extract_tables"). If the full how-to is worth keeping, put it in share as {kind: "memory" or "technique", title,',
    'body}; otherwise share is null.'
  ]
  if (hints.length) {
    lines.push('', 'Possibly relevant things you know (from your own catalog):')
    for (const h of hints) lines.push(`- [${h.item.kind}] ${h.item.title}: ${h.item.summary}${h.file ? ` (file: ${h.file})` : ''}`)
  }
  lines.push('', `Question${kind ? ` (they are looking for a ${kind})` : ''}: ${question}`, '')
  return lines.join('\n')
}

export function execArgs ({ project, schemaPath, outPath, effort }) {
  return [
    'exec',
    '-s', 'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '-C', project,
    '-c', 'mcp_servers={}', // no MCP servers in the answer run: petpack can't recurse, and nothing slow starts
    '-c', 'features.hooks=false',
    '-c', `model_reasoning_effort=${effort}`, // bare word: Codex takes non-TOML values as strings (no quotes for cmd.exe)
    '--output-schema', schemaPath,
    '-o', outPath,
    '-'
  ]
}

function killTree (child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch {}
    return
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
}

function lastJson (s) {
  const str = String(s || '')
  for (let end = str.lastIndexOf('}'); end > 0; end = str.lastIndexOf('}', end - 1)) {
    for (let start = str.lastIndexOf('{', end); start >= 0; start = str.lastIndexOf('{', start - 1)) {
      try { const j = JSON.parse(str.slice(start, end + 1)); if (j && typeof j.answer === 'string') return j } catch {}
      if (end - start > 20000) break
    }
  }
  return null
}

// Runs one `codex exec`. Resolves {ok, answer, share, reason, ms, args}. Never rejects.
export async function runExec ({ question, kind, fromName, hints = [], project, codexBin, env, timeoutMs, effort }) {
  const t0 = Date.now()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'petpack-ask-'))
  const schemaPath = path.join(dir, 'ask.json')
  const outPath = path.join(dir, 'out.json')
  await fsp.writeFile(schemaPath, JSON.stringify(ASK_SCHEMA, null, 2))
  const args = execArgs({ project, schemaPath, outPath, effort })
  const win = process.platform === 'win32'
  const spawnArgs = win ? args.map(a => /[\s"&|<>^=]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a) : args
  const result = await new Promise((resolve) => {
    let child
    try {
      child = spawn(codexBin, spawnArgs, { cwd: project, env, shell: win, detached: !win, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) { return resolve({ ok: false, reason: 'spawn: ' + (err?.message || err) }) }
    let out = ''; let errOut = ''
    let timedOut = false
    child.stdout.on('data', d => { if (out.length < 1e6) out += d })
    child.stderr.on('data', d => { if (errOut.length < 1e5) errOut += d })
    child.stdin.on('error', () => {})
    const timer = setTimeout(() => { timedOut = true; killTree(child) }, timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, reason: err.code === 'ENOENT' ? 'codex not found' : String(err.message || err) }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return resolve({ ok: false, reason: 'timeout', pid: child.pid })
      let j = null
      try { j = JSON.parse(fs.readFileSync(outPath, 'utf8')) } catch {}
      if (!j || typeof j.answer !== 'string') j = lastJson(out)
      if (!j) return resolve({ ok: false, reason: code === 0 ? 'no answer' : `codex exited ${code}: ${(errOut || out).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`, pid: child.pid })
      resolve({ ok: true, answer: j.answer, short: typeof j.short === 'string' ? j.short : '', share: j.share ?? null, pid: child.pid })
    })
    child.stdin.end(prompt({ question, kind, fromName }, hints))
  })
  fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  return { ...result, ms: Date.now() - t0, args }
}

function cleanShare (share) {
  if (!share || typeof share !== 'object') return null
  const title = String(share.title || '').trim().slice(0, 120)
  const body = String(share.body || '').trim().slice(0, 8000)
  if (!title || !body) return null
  return { kind: share.kind === 'technique' ? 'technique' : 'memory', title, body }
}

function stamp (d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// Saves a Q&A as a Library card. Returns the file path, or null.
export async function saveAnswerCard ({ question, fromName, answer, share }, ctx = {}) {
  try {
    const dir = defaultAnswersDir(ctx)
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${stamp()}-${slugify(question, 40)}.md`)
    const q = String(question).replace(/\s+/g, ' ').trim().slice(0, 120)
    let md = `# ${q}\n\nAsked by ${fromName || 'a teammate'}'s agent through petpack, ${new Date().toISOString()}.\n\n${answer.trim()}\n`
    if (share) md += `\n## ${share.title}\n\n${share.body}\n`
    await fsp.writeFile(file, md)
    return file
  } catch { return null }
}

// ---------------------------------------------------------------- answerer

export function createAnswerer ({ queueMax = 1 } = {}) {
  let active = 0
  const waiters = []
  const acquire = async () => {
    if (!active) { active = 1; return true }
    if (waiters.length >= queueMax) return false
    await new Promise(resolve => waiters.push(resolve))
    return true
  }
  const release = () => { const next = waiters.shift(); if (next) next(); else active = 0 }

  async function answerAsk (q, ctx = {}) {
    const t0 = Date.now()
    const ask = typeof q === 'string' ? { question: q } : { ...(q || {}) }
    const question = String(ask.question || '').trim().slice(0, 2000)
    const kind = ask.kind || null
    const fromName = ask.fromName || ctx.fromName || 'a teammate'
    if (!question) return { ok: false, tier: 0, text: 'no question', short: '', reason: 'empty', ms: 0 }
    const done = r => ({ ...r, ms: Date.now() - t0 })

    let built = { items: [], projects: [] }
    try { built = await buildCatalog(ctx) } catch {}
    const ranked = rankItems(question, built.items, kind, 3)
    const pick = tier1Pick(question, built.items, kind, ctx.tier1Threshold ?? TIER1_MIN)
    if (pick) {
      try {
        const r = await tier1(pick, ctx, question)
        if (r) return done({ ...r, score: pick.score, named: pick.named })
      } catch {}
    }
    if (ctx.noExec) return done({ ok: false, tier: 1, text: "I don't know that one.", short: 'no idea, sorry', reason: 'no match' })

    if (!(await acquire())) return done({ ok: false, busy: true, tier: 2, text: "I'm busy with another question.", short: 'busy right now', reason: 'busy' })
    try {
      const env = childEnv(ctx.env || process.env)
      const timeoutMs = Math.max(1000, (ctx.timeoutMs ?? ASK_TIMEOUT_MS) - (Date.now() - t0))
      const hints = []
      for (const r of ranked) hints.push({ ...r, file: await itemSource(r.item.ref, ctx).catch(() => null) })
      const project = [ctx.cwd, built.projects[0], os.homedir()].find(d => d && fs.existsSync(d))
      const r = await runExec({
        question,
        kind,
        fromName,
        hints,
        project,
        codexBin: ctx.codexBin || env.PETPACK_CODEX || 'codex',
        env,
        timeoutMs,
        effort: ctx.effort || env.PETPACK_ASK_EFFORT || 'low'
      })
      if (!r.ok) {
        // Exec failed or timed out: hand over the closest item rather than nothing.
        if (ranked[0]) {
          try {
            const t1 = await tier1(ranked[0], ctx, question, { unsure: true })
            if (t1) return done({ ...t1, score: ranked[0].score, fallback: r.reason, execMs: r.ms })
          } catch {}
        }
        return done({ ok: false, tier: 2, text: "couldn't finish", short: "couldn't finish", reason: r.reason, execMs: r.ms })
      }
      const text = twoSentences(String(r.answer).trim()).slice(0, ANSWER_MAX)
      const share = cleanShare(r.share)
      const card = await saveAnswerCard({ question, fromName, answer: text, share }, ctx)
      invalidateCatalog()
      const out = { ok: true, tier: 2, text, short: clipWords(r.short || shortAnswer(text), SHORT_MAX), execMs: r.ms, card }
      if (share) {
        out.share = share
        out.pkg = { kind: share.kind, ref: null, title: share.title, text: `# ${share.title}\n\n${share.body}\n` }
      }
      return done(out)
    } finally { release() }
  }

  return { answerAsk, get busy () { return active > 0 && waiters.length >= queueMax } }
}

const shared = createAnswerer()

// The bridge's answerAsk({question, kind, fromName}); also takes a bare question string.
export function answerAsk (q, ctx = {}) { return shared.answerAsk(q, ctx) }

export { summarize, shortQuestion }
