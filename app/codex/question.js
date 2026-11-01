// Questions (lane L3b): bubble-sized questions, and proactive asks from a stuck Codex session.
//
// shortQuestion(q)       -> <= 40 chars for the bubble, keeping the key nouns ("PDF tables?", "ship to Azure?").
// currentNeed(codexHome) -> {question, short, kind?, why, error?, prompt?, session, at} when the newest live Codex
//                           session looks stuck (its turn failed, it has worked > 3 min on one turn, or an error
//                           repeated), else null. It reads rollout structure only: the latest user prompt and the
//                           latest failed tool output or error line.
//
// No Node imports at the top, so the renderer can import shortQuestion too; currentNeed loads fs lazily.

export const SHORT_MAX = 40
export const STUCK_WORKING_MS = 3 * 60 * 1000
export const LIVE_MS = 15 * 60 * 1000

const LEAD = /^\s*(?:(?:hey|so|ok|okay|quick q(?:uestion)?)[,:!]?\s+)?(?:(?:how|what|where|why|when|which)\s+(?:do|does|did|can|could|should|would|is|are|was|were)\s+(?:i|we|you|one|it|they)\s+|how\s+to\s+|what(?:'s| is| are)\s+(?:the\s+)?(?:best\s+)?(?:way\s+to\s+)?|is\s+there\s+(?:a\s+)?(?:way\s+to\s+)?|does\s+any(?:one|body)\s+know\s+(?:how\s+to\s+)?|any(?:one|body)\s+(?:know|done|tried|have|got)\s+(?:how\s+to\s+)?|can\s+(?:i|we|you)\s+|(?:please\s+)?(?:help\s+me\s+|tell\s+me\s+(?:how\s+to\s+)?))/i
const FILLER = new Set('a an the my our your their this that these those some any just really please actually basically'.split(' '))
const STOP = new Set(('a an and are as at be but by can could do does did for from get got has have how i if in into is it its ' +
  'me my of on or our so that the their them then there these this to too was we what when where which who why will with ' +
  'would you your out up off just really please also any some way about thing things stuff here now again still').split(' '))
const VERBS = new Set('pull get make do use put take add set run fix find handle deal work need want try keep let'.split(' '))

function clip (s, max) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…'
}

// "how do I pull tables out of a PDF?" -> "PDF tables?"; "how do we ship the relay to Azure?" -> "ship relay to Azure?"
export function shortQuestion (q, max = SHORT_MAX) {
  let s = String(q || '').replace(/[`*_#>]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  s = s.split(/(?<=[?!.])\s/)[0] // the first sentence carries the ask
  s = s.replace(/[?!.\s]+$/, '').replace(LEAD, '')
  const words = s.split(' ').filter(w => !FILLER.has(w.toLowerCase()))
  const tidy = words.join(' ').replace(/\bout of\b/gi, 'from')
  // Keyword form: proper nouns, acronyms and code-ish words first, then the remaining content words.
  const content = words.map(w => w.replace(/[^\w./+-]/g, '')).filter(w => w && !STOP.has(w.toLowerCase()))
  const special = content.filter(w => !/^\d+$/.test(w) && /[A-Z]{2,}|^[A-Z][a-z]|[./_-]|\d/.test(w))
  const nouns = content.filter(w => !special.includes(w) && !VERBS.has(w.toLowerCase()))
  const keys = [...new Set([...special, ...nouns])]
  const keysFit = keys.length && keys.length <= 3 && keys.join(' ').length + 1 <= max
  const leadsWithVerb = VERBS.has((tidy.split(' ')[0] || '').toLowerCase())
  let short = ''
  if (keysFit && (leadsWithVerb || tidy.length + 1 > max)) short = keys.join(' ') // "pull tables out of a PDF" -> "PDF tables"
  else if (tidy.length + 1 <= max) short = tidy // "ship relay to Azure"
  else {
    for (const k of content.filter(w => !VERBS.has(w.toLowerCase()))) {
      if ((short ? short.length + 1 : 0) + k.length + 1 > max) break
      short = short ? `${short} ${k}` : k
    }
    if (!short) short = clip(tidy, max - 1).replace(/…$/, '')
  }
  return (short + '?').slice(0, max)
}

// ---------------------------------------------------------------- rollouts (structure only)

const NOT_PROMPT = /^\s*(?:# AGENTS\.md instructions|<environment_context|<user_instructions|<INSTRUCTIONS>|<user_shell_command|<turn_aborted|<subagent_notification)/
const FAIL_MARK = /("exit_code"\s*:\s*[1-9]\d*|exit(?:ed)? (?:with )?code:? [1-9]\d*|Script failed|Script error|Traceback \(most recent call last\)|\bnpm ERR!|command not found|\bFAIL\b|\b(?:Error|ERROR|error|Exception|panic(?:ked)?)\b[:!])/
const ERROR_LINE = /(?:\b(?:error|failed|failure|cannot|can't|could not|not found|denied|refused|timed? ?out|exception|traceback|panic|fatal|invalid|undefined|unexpected|missing)\b|\bFAIL\b|npm ERR!)/i

function textOf (content) {
  if (typeof content === 'string') {
    if (content.startsWith('[')) { try { return textOf(JSON.parse(content)) } catch {} }
    return content
  }
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object') ? (c.text ?? '') : String(c ?? '')).join('\n')
  if (content && typeof content === 'object') return content.text ?? content.output ?? JSON.stringify(content)
  return ''
}

function errorLineOf (output) {
  const text = textOf(output).replace(/\\n/g, '\n')
  if (!FAIL_MARK.test(text)) return null
  const lines = text.split('\n').map(l => l.replace(/^[\s"{},[\]]+|[\s"{},[\]]+$/g, '').trim()).filter(Boolean)
  const skip = /^(Script failed|Script error:?|Wall time|Output:?|Process exited|Exit code|exit_code)/i
  const hit = lines.find(l => !skip.test(l) && ERROR_LINE.test(l) && l.length >= 8) || lines.find(l => !skip.test(l) && l.length >= 8)
  return hit ? clip(hit.replace(/\s*\(?\bat .*:\d+:\d+\)?$/, ''), 160) : 'a command failed'
}

function promptGist (text) {
  const lines = String(text || '').split('\n').map(l => l.replace(/^#+\s*|^[-*]\s+/, '').trim()).filter(Boolean)
  return clip(lines[0] || '', 120)
}

function normError (s) { return String(s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim() }

// Reads one rollout's lines and works out the current turn's state. Pure (for tests).
export function analyzeRollout (lines, now = Date.now()) {
  let meta = null
  let prompt = null // { text, at }
  let turn = null // { id, startedAt, done: false|true, failed, error }
  let errors = [] // current turn: [{ line, at }]
  for (const raw of lines) {
    if (!raw || raw[0] !== '{') continue
    let j
    try { j = JSON.parse(raw) } catch { continue }
    const p = j.payload || {}
    const at = Date.parse(j.timestamp || '') || null
    if (j.type === 'session_meta') { meta = p; continue }
    if (j.type === 'event_msg') {
      if (p.type === 'task_started') {
        turn = { id: p.turn_id || null, startedAt: at, done: false, failed: false }
        errors = []
      } else if (p.type === 'task_complete' && turn) {
        turn.done = true
        turn.endedAt = at
        if (p.error) { turn.failed = true; turn.error = textOf(p.error.message ?? p.error) }
      } else if (p.type === 'turn_aborted' && turn) {
        turn.done = true; turn.aborted = true
      } else if (p.type === 'error' || p.type === 'stream_error') {
        const line = clip(textOf(p.message ?? p.error ?? ''), 160) || 'an error'
        errors.push({ line, at })
      }
      continue
    }
    if (j.type !== 'response_item') continue
    if (p.type === 'message' && p.role === 'user') {
      const text = textOf(p.content)
      if (text.trim() && !NOT_PROMPT.test(text)) prompt = { text, at }
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') {
      const line = errorLineOf(p.output)
      if (line) errors.push({ line, at })
    }
  }
  return { meta, prompt, turn, errors, now }
}

// Decides whether the session is stuck and phrases the question. Pure (for tests).
export function needFrom ({ meta, prompt, turn, errors, now }, { workingMs = STUCK_WORKING_MS } = {}) {
  if (!turn) return null
  const lastError = errors[errors.length - 1] || null
  const counts = new Map()
  for (const e of errors) counts.set(normError(e.line), (counts.get(normError(e.line)) || 0) + 1)
  const repeated = errors.slice().reverse().find(e => counts.get(normError(e.line)) >= 2) || null
  let why = null
  if (turn.failed) why = 'failed'
  else if (repeated && !turn.done) why = 'repeated'
  else if (!turn.done && turn.startedAt && now - turn.startedAt > workingMs) why = 'slow'
  if (!why) return null
  const error = turn.failed ? clip(turn.error || lastError?.line || 'the turn failed', 160) : (repeated || lastError)?.line || null
  const gist = promptGist(prompt?.text)
  let question
  if (error && gist) question = `How do I get past "${clip(error, 100)}" while working on: ${gist}?`
  else if (error) question = `How do I fix "${clip(error, 140)}"?`
  else if (gist) question = `Anyone solved this before: ${gist}?`
  else return null
  question = question.replace(/[?.!]+\?$/, '?')
  const short = shortQuestion(error ? error.replace(/^(?:error|fatal|failed|fail)\b[:\s]*/i, '') : gist)
  const out = { question, short, why, session: meta?.id || null, at: now }
  if (error) out.error = error
  if (gist) out.prompt = gist
  if (error) out.kind = 'technique'
  return out
}

async function newestRollout (codexHome, fsp, path) {
  const root = path.join(codexHome, 'sessions')
  const list = async d => { try { return (await fsp.readdir(d, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort().reverse() } catch { return [] } }
  const days = []
  outer: for (const y of await list(root)) {
    for (const m of await list(path.join(root, y))) {
      for (const d of await list(path.join(root, y, m))) {
        days.push(path.join(root, y, m, d))
        if (days.length >= 2) break outer
      }
    }
  }
  const files = []
  for (const dir of days) {
    let names = []
    try { names = await fsp.readdir(dir) } catch {}
    for (const n of names) {
      if (!/^rollout-.*\.jsonl$/.test(n)) continue
      try { const st = await fsp.stat(path.join(dir, n)); files.push({ f: path.join(dir, n), mtime: st.mtimeMs, size: st.size }) } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  // the newest non-subagent session
  for (const file of files.slice(0, 12)) {
    let fh
    try {
      fh = await fsp.open(file.f, 'r')
      const buf = Buffer.alloc(Math.min(file.size, 64 * 1024))
      await fh.read(buf, 0, buf.length, 0)
      const head = buf.toString('utf8')
      if (/"source"\s*:\s*\{\s*"subagent"/.test(head.split('\n')[0] || head)) continue
      return file
    } catch { continue } finally { await fh?.close().catch(() => {}) }
  }
  return null
}

// currentNeed(codexHome, {now, file, workingMs}) -> need | null. Never throws.
export async function currentNeed (codexHome, opts = {}) {
  try {
    if (typeof codexHome !== 'string') { // called with main's ctx object: resolve the home like the catalog does
      const { resolveCodexHome } = await import('./catalog.js')
      opts = { ...(codexHome || {}), ...opts }
      codexHome = resolveCodexHome(codexHome || {})
    }
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const now = opts.now ?? Date.now()
    const file = opts.file ? { f: opts.file, ...(await fsp.stat(opts.file).then(st => ({ mtime: st.mtimeMs, size: st.size }))) } : await newestRollout(codexHome, fsp, path)
    if (!file) return null
    if (!opts.file && now - file.mtime > LIVE_MS) return null // not live
    const MAX = 16 * 1024 * 1024
    let text
    if (file.size <= MAX) text = await fsp.readFile(file.f, 'utf8')
    else {
      const fh = await fsp.open(file.f, 'r')
      try {
        const head = Buffer.alloc(256 * 1024)
        await fh.read(head, 0, head.length, 0)
        const tail = Buffer.alloc(MAX / 2)
        await fh.read(tail, 0, tail.length, file.size - tail.length)
        text = head.toString('utf8').split('\n')[0] + '\n' + tail.toString('utf8').split('\n').slice(1).join('\n')
      } finally { await fh.close() }
    }
    const need = needFrom(analyzeRollout(text.split('\n'), now), opts)
    return need ? { ...need, file: file.f } : null
  } catch { return null }
}
