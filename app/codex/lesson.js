// Lessons (lane L3b): when a Codex session finishes, keep what worked as a Library card the team can find.
//
// lessonFromSession(codexHome | ctx, session, opts?) -> Promise<{ref, kind:'memory', title, summary, tags, path,
//   existed?} | null>
//   session: a session id, a rollout file path, or L3a's status object ({session, file?}). Reads the rollout's
//   structure: the latest user prompt, the final assistant message, notable commands, touched files and errors.
//   Only a finished turn (task_complete without error) makes a card. The card is markdown in
//   <userData>/cards/ (opts.cardsDir, else <opts.userData>/cards, else ~/.petpack/cards); catalog.js lists it as a
//   Library item `memory:card-<slug>` owned by this pet. One card per session turn; re-running returns it.
// lessonFromLines(lines) -> card fields or null (pure, for tests).

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { analyzeRollout } from './question.js'

const STOP = new Set(('a an and are as at be but by can could do does did for from get got has have how i if in into is it ' +
  'its me my of on or our so that the their them then there these this to too was we what when where which who why will ' +
  'with would you your out up just never after before always first last next same other both onto over under also any some way about here now again still should must make made need please use ' +
  'using used run ran then than more most very only each every one two all not no yes done ready okay ok sure').split(' '))

export function defaultCardsDir (opts = {}) {
  if (opts.cardsDir) return opts.cardsDir
  if (opts.userData) return path.join(opts.userData, 'cards')
  return path.join(opts.homeDir || os.homedir(), '.petpack', 'cards')
}

function clip (s, max) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:(-]+$/, '') + '…'
}

function plain (s) {
  return String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_>#]/g, '').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
}

function firstSentence (s, max = 170) {
  const t = plain(s).split('\n').map(l => l.replace(/^\s*[-+]\s+|^\s*\d+[.)]\s+/, '').trim()).filter(l => l.length > 3)
  const joined = t.join(' ')
  const sentences = joined.split(/(?<=[.!?])\s+/).filter(x => x.length > 3)
  let out = sentences[0] || joined
  if (out.length < 70 && sentences[1]) out = `${out.replace(/[.!?]$/, ';')} ${sentences[1]}` // a verdict alone says little
  return clip(out, max)
}

// The ask in a prompt: the first paragraph that isn't a preamble (rules, instructions, bullet lists, tags).
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s/
function gist (prompt) {
  const text = String(prompt || '')
  for (const para of text.split(/\n\s*\n/)) {
    const lines = para.split('\n').map(l => l.trim()).filter(Boolean)
    if (!lines.length) continue
    const first = lines[0].replace(/^#+\s*/, '')
    if (BULLET.test(lines[0]) || /^[[<]/.test(first)) continue
    if (/\b(?:rulings?|instructions|guidelines|house rules|AGENTS\.md)\b/i.test(first)) continue
    if (lines.filter(l => BULLET.test(l)).length / lines.length > 0.6) continue
    const s = first.replace(/\s*\([^)]*\/[^)]*\)/g, '') // drop "(/some/path)" asides
    const m = /^(.{12,}?[.!?])(\s|$)/.exec(s)
    return clip(m ? m[1] : s, 200)
  }
  const lines = text.split('\n').map(l => l.replace(/^#+\s*|^[-*]\s+/, '').trim()).filter(Boolean)
  return lines[0] || ''
}

function textOf (content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object') ? (c.text ?? '') : String(c ?? '')).join('\n')
  return ''
}

const CMD_RE = /\bcmd\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g
const FILE_RE = /\*\*\* (?:Update|Add) File: (.+)/g
const NOISE_CMD = /^(?:pwd|ls|cat|nl|cd|sed|awk|head|tail|wc|rg|grep|find|sort|uniq|jq|git (?:status|log|diff|show|rev-parse|remote|branch|fetch)|echo|printf|date|which|true|node --version|stat|file|du|df)\b/
const NOTABLE_CMD = /\b(?:test|tests|install|build|deploy|publish|npm|pnpm|yarn|npx|node --test|pytest|cargo|make|docker|az|gcloud|kubectl|terraform|vitest|jest|tsc|eslint|prettier|codex|electron|git (?:commit|push|rebase|merge|cherry-pick|tag))\b/

function commandsAndFiles (lines) {
  const cmds = []
  const files = []
  for (const raw of lines) {
    if (!raw || raw[0] !== '{' || !/_call"/.test(raw)) continue
    let j
    try { j = JSON.parse(raw) } catch { continue }
    const p = j.payload || {}
    if (p.type !== 'custom_tool_call' && p.type !== 'function_call' && p.type !== 'local_shell_call') continue
    const body = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.action || p.arguments || '')
    let m
    CMD_RE.lastIndex = 0
    while ((m = CMD_RE.exec(body))) {
      let c = (m[1] ?? m[2] ?? m[3] ?? '')
      if (m[1] != null) { try { c = JSON.parse(`"${m[1]}"`) } catch {} }
      for (const part of c.split(/\s*&&\s*|\s*;\s*|\n/)) {
        const s = part.trim()
        if (s && !NOISE_CMD.test(s) && s.length <= 200) cmds.push(s)
      }
    }
    if (p.name === 'exec_command' || p.name === 'shell') {
      try {
        const a = JSON.parse(p.arguments)
        const c = Array.isArray(a.command) ? a.command.join(' ') : a.cmd
        if (c && !NOISE_CMD.test(c)) cmds.push(String(c).slice(0, 200))
      } catch {}
    }
    FILE_RE.lastIndex = 0
    while ((m = FILE_RE.exec(body))) files.push(m[1].replace(/\\n.*$/, '').trim())
  }
  const uniq = a => [...new Set(a)]
  const notable = uniq(cmds).filter(c => NOTABLE_CMD.test(c))
  return { commands: notable.slice(-6), files: uniq(files).slice(-8) }
}

function tagsOf (...texts) {
  const counts = new Map()
  for (const t of texts) {
    for (const w of String(t || '').replace(/\S*[\\/]\S*/g, ' ').toLowerCase().split(/[^a-z0-9+#.-]+/)) {
      const k = w.replace(/^[.-]+|[.-]+$/g, '')
      if (k.length < 3 || k.length > 24 || STOP.has(k) || /^\d+$/.test(k) || /^[0-9a-f]{7,}$/.test(k)) continue
      counts.set(k, (counts.get(k) || 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)
}

// Pure: card fields from a rollout's lines, or null when the latest turn didn't finish cleanly.
export function lessonFromLines (lines) {
  const a = analyzeRollout(lines)
  if (!a.turn || !a.turn.done || a.turn.failed || a.turn.aborted) return null
  let final = ''
  let turnId = a.turn.id
  for (const raw of lines) {
    if (!raw || raw[0] !== '{') continue
    if (!raw.includes('task_complete') && !raw.includes('"assistant"')) continue
    try {
      const j = JSON.parse(raw)
      const p = j.payload || {}
      if (p.type === 'task_complete' && p.last_agent_message) { final = String(p.last_agent_message); turnId = p.turn_id || turnId }
      else if (p.type === 'message' && p.role === 'assistant' && (p.phase === 'final_answer' || p.phase === 'final' || !p.phase)) final = textOf(p.content) || final
    } catch {}
  }
  const ask = gist(a.prompt?.text)
  if (!ask || !final.trim()) return null
  const { commands, files } = commandsAndFiles(lines)
  const title = clip(ask, 60)
  const worked = firstSentence(final)
  const s1 = `Asked: ${clip(ask, 140).replace(/[.?!]$/, '')}.`
  const s2 = `What worked: ${worked.replace(/[.?!]$/, '')}.`
  const keys = [...commands.slice(0, 2).map(c => `\`${clip(c, 60)}\``), ...files.slice(0, 2)]
  const s3 = keys.length ? `Key commands/files: ${keys.join(', ')}.` : ''
  const summary = [s1, s2, s3].filter(Boolean).join(' ')
  // real error lines only (not source code that happens to mention "error")
  const REAL = /^(?:[\w.]*(?:Error|Exception)\b|error\b|npm ERR!|FAIL\b|fatal\b|Traceback|panic|command not found)/i
  const errors = [...new Set(a.errors.map(e => e.line).filter(l => REAL.test(l) && !/\\t|^\d/.test(l)))].slice(-4)
  return { kind: 'memory', title, summary, tags: tagsOf(ask, final, files.join(' ')), ask, final, commands, files, errors, session: a.meta?.id || null, turn: turnId, cwd: a.meta?.cwd || null }
}

function cardMarkdown (c) {
  const parts = [`# ${c.title}`, '', c.summary, '', `Tags: ${c.tags.join(', ')}`, '', '## Asked', '', clip(c.ask, 600), '', '## What worked', '', c.final.trim().slice(0, 3000)]
  if (c.commands.length) parts.push('', '## Commands', '', ...c.commands.map(x => `- \`${x}\``))
  if (c.files.length) parts.push('', '## Files', '', ...c.files.map(x => `- ${x}`))
  if (c.errors.length) parts.push('', '## Errors hit on the way', '', ...c.errors.map(x => `- ${x}`))
  parts.push('', `(From a Codex session${c.cwd ? ` in ${path.basename(c.cwd)}` : ''}, ${new Date().toISOString().slice(0, 10)}.)`, '')
  return parts.join('\n')
}

async function findRollout (codexHome, session) {
  if (session && typeof session === 'object') session = session.file || session.path || session.session || session.id
  if (!session) return null
  session = String(session)
  if (session.endsWith('.jsonl')) return fs.existsSync(session) ? session : null
  const root = path.join(codexHome, 'sessions')
  const list = async d => { try { return (await fsp.readdir(d)).sort().reverse() } catch { return [] } }
  let checked = 0
  for (const y of await list(root)) {
    for (const m of await list(path.join(root, y))) {
      for (const d of await list(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d)
        const hit = (await list(dir)).find(n => n.endsWith(`${session}.jsonl`))
        if (hit) return path.join(dir, hit)
        if (++checked > 14) return null // two weeks back is plenty
      }
    }
  }
  return null
}

export async function lessonFromSession (codexHome, session, opts = {}) {
  try {
    if (typeof codexHome !== 'string') {
      const { resolveCodexHome } = await import('./catalog.js')
      opts = { ...(codexHome || {}), ...opts }
      codexHome = resolveCodexHome(codexHome || {})
    }
    const file = await findRollout(codexHome, session)
    if (!file) return null
    const st = await fsp.stat(file)
    if (st.size > 64 * 1024 * 1024) return null
    const card = lessonFromLines((await fsp.readFile(file, 'utf8')).split('\n'))
    if (!card) return null
    const dir = defaultCardsDir(opts)
    const { slugify, invalidateCatalog } = await import('./catalog.js')
    const name = `${slugify(card.title, 40)}-${String(card.turn || card.session || 'x').replace(/[^\w-]/g, '').slice(-8)}.md`
    const out = path.join(dir, name)
    const base = { ref: `memory:card-${slugify(name.replace(/\.md$/, ''), 60)}`, kind: 'memory', title: card.title, summary: card.summary, tags: card.tags, path: out }
    if (fs.existsSync(out)) return { ...base, existed: true }
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(out, cardMarkdown(card))
    invalidateCatalog()
    return base
  } catch (err) { if (process.env.PETPACK_DEBUG) console.error(err); return null }
}
