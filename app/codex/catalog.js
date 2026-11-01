// Team commons catalog (lane L3b). Main-process Node module, no Electron imports.
//
// Builds this machine's catalog of what its Codex agent knows, as metadata only:
//   skill     (Workshop) $CODEX_HOME/skills/*, ~/.agents/skills/*, <project>/.agents/skills/* (not .system,
//                        not skills adopted through petpack)
//   memory    (Library)  the project's AGENTS.md sections (git root down to cwd), MEMORY.md "Reusable knowledge"
//                        per task group, answers this agent gave through petpack (answersDir/*.md)
//   technique (Dojo)     $CODEX_HOME/prompts/*.md, MEMORY.md "Failures and how to do differently", the
//                        global $CODEX_HOME/AGENTS.md rules
//   resource  (Campfire) config.toml [mcp_servers.*]: name, command + args or url, env key names
//
// Item: {ref:'<kind>:<slug>', kind, title, summary (<=240), bytes, sha, mtime}. Content stays here and is read on
// demand with readItem(ref, as). Notes install as $CODEX_HOME/skills/petpack-note-<slug>/SKILL.md; resources
// install through `codex mcp add`.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export const KINDS = ['skill', 'memory', 'technique', 'resource']
const MAX_TEXT = 1024 * 1024 // a text source above this is skipped
const MAX_PKG_FILE = 1024 * 1024
const MAX_PKG_TOTAL = 2.5 * 1024 * 1024 // stays under the relay's 4 MB frame after base64
const MAX_SKILL_FILES = 300
const MAX_PROJECTS = 3
const SUMMARY_MAX = 240

// ---------------------------------------------------------------- paths

export function resolveCodexHome (opts = {}) {
  if (opts.codexHome) return opts.codexHome
  const env = opts.env || process.env
  const home = opts.homeDir || os.homedir()
  if (env.CODEX_HOME && isDir(env.CODEX_HOME)) return env.CODEX_HOME
  if (process.platform === 'win32' && env.USERPROFILE) {
    const p = path.join(env.USERPROFILE, '.codex')
    if (isDir(p)) return p
  }
  return env.CODEX_HOME || path.join(home, '.codex')
}

export function defaultAnswersDir (opts = {}) {
  if (opts.answersDir) return opts.answersDir
  const env = opts.env || process.env
  if (env.PETPACK_ANSWERS) return env.PETPACK_ANSWERS
  return path.join(opts.homeDir || os.homedir(), '.petpack', 'answers')
}

function isDir (p) { try { return fs.statSync(p).isDirectory() } catch { return false } }
function isFile (p) { try { return fs.statSync(p).isFile() } catch { return false } }

// ---------------------------------------------------------------- small helpers

export function slugify (s, max = 48) {
  const out = String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (out.slice(0, max).replace(/-+$/, '')) || 'item'
}

function sha (text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) }

export function summarize (text, max = SUMMARY_MAX) {
  const s = String(text || '')
    .replace(/^---[\s\S]*?\n---\s*/m, '') // frontmatter
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[`*>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

function looksBinary (buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

// Reads a text file, or null when it is missing, huge or binary.
async function readText (file, max = MAX_TEXT) {
  try {
    const st = await fsp.stat(file)
    if (!st.isFile() || st.size > max) return null
    const buf = await fsp.readFile(file)
    if (looksBinary(buf)) return null
    return { text: buf.toString('utf8'), mtime: st.mtimeMs, size: st.size }
  } catch { return null }
}

async function readDirSafe (dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }) } catch { return [] }
}

// Minimal YAML frontmatter: `key: value`, quoted values, and `>`/`|` blocks.
export function parseFrontmatter (text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out = {}
  if (!m) return out
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    let v = kv[2].trim()
    if (v === '>' || v === '|' || v === '>-' || v === '|-' || v === '') {
      const block = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim())
      v = block.join(v.startsWith('|') ? '\n' : ' ')
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      if (v.startsWith('"')) { try { v = JSON.parse(v) } catch { v = v.slice(1, -1) } } else v = v.slice(1, -1).replace(/''/g, "'")
    }
    out[kv[1]] = v
  }
  return out
}

// Splits markdown into sections at the given heading level ('## ' by default). Text before the first heading is
// returned with title null. Fenced code is respected.
export function splitSections (text, level = 2) {
  const marker = '#'.repeat(level) + ' '
  const out = []
  let cur = { title: null, lines: [] }
  let fence = false
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence
    if (!fence && line.startsWith(marker)) {
      out.push(cur)
      cur = { title: line.slice(marker.length).trim(), lines: [] }
    } else cur.lines.push(line)
  }
  out.push(cur)
  return out.map(s => ({ title: s.title, body: s.lines.join('\n').trim() })).filter(s => s.title || s.body)
}

// ---------------------------------------------------------------- config.toml (just enough for mcp_servers)

// Parses one TOML value starting at s[i]. Returns [value, nextIndex]. Inline tables become plain objects.
function tomlValue (s, i) {
  while (s[i] === ' ' || s[i] === '\t') i++
  const c = s[i]
  if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
    const q = s.slice(i, i + 3)
    const end = s.indexOf(q, i + 3)
    const raw = s.slice(i + 3, end < 0 ? s.length : end).replace(/^\r?\n/, '')
    return [raw, end < 0 ? s.length : end + 3]
  }
  if (c === '"') {
    let j = i + 1; let out = ''
    while (j < s.length && s[j] !== '"') {
      if (s[j] === '\\' && j + 1 < s.length) {
        const e = s[j + 1]
        const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }
        if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8
          out += String.fromCodePoint(parseInt(s.slice(j + 2, j + 2 + len), 16) || 0x3f); j += 2 + len; continue
        }
        out += map[e] ?? e; j += 2; continue
      }
      out += s[j++]
    }
    return [out, j + 1]
  }
  if (c === "'") {
    const end = s.indexOf("'", i + 1)
    return [s.slice(i + 1, end < 0 ? s.length : end), end < 0 ? s.length : end + 1]
  }
  if (c === '[') {
    const arr = []; let j = i + 1
    for (;;) {
      while (j < s.length && /[\s,]/.test(s[j])) j++
      if (s[j] === '#') { while (j < s.length && s[j] !== '\n') j++; continue }
      if (j >= s.length || s[j] === ']') return [arr, j + 1]
      const [v, k] = tomlValue(s, j); arr.push(v); j = k
    }
  }
  if (c === '{') {
    const obj = {}; let j = i + 1
    for (;;) {
      while (j < s.length && /[\s,]/.test(s[j])) j++
      if (j >= s.length || s[j] === '}') return [obj, j + 1]
      const [key, k] = tomlKey(s, j)
      j = k
      while (s[j] === ' ' || s[j] === '\t') j++
      if (s[j] !== '=') return [obj, s.length]
      const [v, k2] = tomlValue(s, j + 1)
      setPath(obj, key, v); j = k2
    }
  }
  const m = /^[^\s,\]}#]+/.exec(s.slice(i))
  const raw = m ? m[0] : ''
  let v = raw
  if (raw === 'true') v = true
  else if (raw === 'false') v = false
  else if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(raw)) v = Number(raw.replace(/_/g, ''))
  return [v, i + raw.length]
}

function tomlKey (s, i) {
  const parts = []
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t') i++
    if (s[i] === '"' || s[i] === "'") { const [v, k] = tomlValue(s, i); parts.push(String(v)); i = k } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i)); if (!m) break
      parts.push(m[0]); i += m[0].length
    }
    while (s[i] === ' ' || s[i] === '\t') i++
    if (s[i] === '.') { i++; continue }
    break
  }
  return [parts, i]
}

function setPath (obj, keys, v) {
  let o = obj
  for (let k = 0; k < keys.length - 1; k++) {
    if (typeof o[keys[k]] !== 'object' || o[keys[k]] === null) o[keys[k]] = {}
    o = o[keys[k]]
  }
  o[keys[keys.length - 1]] = v
}

// A forgiving TOML reader: tables, dotted keys, strings, arrays (multi-line), inline tables. Unknown syntax on a
// line is skipped, never thrown. Good enough for Codex's config.toml.
export function parseToml (text) {
  const root = {}
  let table = root
  const s = String(text).replace(/\r\n/g, '\n')
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    if (s[i] === '#') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (s[i] === '[') {
      const arrayTable = s[i + 1] === '['
      const [keys, k] = tomlKey(s, i + (arrayTable ? 2 : 1))
      i = k
      while (i < s.length && s[i] !== '\n') i++
      if (!keys.length) continue
      let o = root
      for (let n = 0; n < keys.length; n++) {
        const key = keys[n]
        const last = n === keys.length - 1
        if (last && arrayTable) {
          if (!Array.isArray(o[key])) o[key] = []
          const t = {}; o[key].push(t); o = t
        } else {
          if (typeof o[key] !== 'object' || o[key] === null) o[key] = {}
          o = Array.isArray(o[key]) ? o[key][o[key].length - 1] : o[key]
        }
      }
      table = o
      continue
    }
    try {
      const [keys, k] = tomlKey(s, i)
      let j = k
      while (s[j] === ' ' || s[j] === '\t') j++
      if (!keys.length || s[j] !== '=') { while (i < s.length && s[i] !== '\n') i++; continue }
      const [v, k2] = tomlValue(s, j + 1)
      setPath(table, keys, v)
      i = k2
      while (i < s.length && s[i] !== '\n') i++
    } catch { while (i < s.length && s[i] !== '\n') i++ }
  }
  return root
}

export function readMcpServers (codexHome) {
  let text = ''
  try { text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') } catch { return {} }
  try {
    const cfg = parseToml(text)
    return (cfg.mcp_servers && typeof cfg.mcp_servers === 'object') ? cfg.mcp_servers : {}
  } catch { return {} }
}

// ---------------------------------------------------------------- current project

// The cwd in session_meta of the newest rollout (by mtime) in the two newest day folders, or null.
export async function findCurrentProject (codexHome) {
  const root = path.join(codexHome, 'sessions')
  const days = []
  const years = (await readDirSafe(root)).filter(d => d.isDirectory()).map(d => d.name).sort().reverse()
  outer: for (const y of years) {
    const months = (await readDirSafe(path.join(root, y))).filter(d => d.isDirectory()).map(d => d.name).sort().reverse()
    for (const m of months) {
      const ds = (await readDirSafe(path.join(root, y, m))).filter(d => d.isDirectory()).map(d => d.name).sort().reverse()
      for (const d of ds) {
        days.push(path.join(root, y, m, d))
        if (days.length >= 2) break outer
      }
    }
  }
  let best = null
  for (const dir of days) {
    for (const e of await readDirSafe(dir)) {
      if (!e.isFile() || !/^rollout-.*\.jsonl$/.test(e.name)) continue
      const f = path.join(dir, e.name)
      try {
        const st = await fsp.stat(f)
        if (!best || st.mtimeMs > best.mtime) best = { f, mtime: st.mtimeMs }
      } catch {}
    }
  }
  if (!best) return null
  return readRolloutCwd(best.f)
}

export async function readRolloutCwd (file) {
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const buf = Buffer.alloc(256 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead).toString('utf8')
    const line = head.split('\n')[0]
    try {
      const j = JSON.parse(line)
      const cwd = j?.payload?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    } catch {}
    const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head)
    return m ? JSON.parse(m[1]) : null
  } catch { return null } finally { await fh?.close().catch(() => {}) }
}

function gitRoot (dir) {
  let d = path.resolve(dir)
  for (let n = 0; n < 40; n++) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
  return null
}

// Directories Codex reads AGENTS.md from for a cwd: git root down to cwd (or just cwd outside git).
export function projectChain (cwd) {
  const abs = path.resolve(cwd)
  const root = gitRoot(abs)
  if (!root) return [abs]
  const rel = path.relative(root, abs)
  const chain = [root]
  if (rel && !rel.startsWith('..')) {
    let d = root
    for (const part of rel.split(path.sep)) { d = path.join(d, part); chain.push(d) }
  }
  return chain
}

async function projectDirs (opts, codexHome) {
  if (opts.cwd) return [opts.cwd].filter(isDir)
  const env = opts.env || process.env
  const out = []
  const add = d => { if (d && isDir(d) && !out.includes(path.resolve(d))) out.push(path.resolve(d)) }
  add(env.PETPACK_PROJECT)
  add(await findCurrentProject(codexHome))
  if (opts.includeProcessCwd !== false) {
    const pc = process.cwd()
    if (pc !== path.parse(pc).root) add(pc)
  }
  return out.slice(0, MAX_PROJECTS)
}

// ---------------------------------------------------------------- sources

async function skillDirs (root) {
  const out = []
  for (const e of await readDirSafe(root)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    if (e.name.startsWith('.')) continue
    const dir = path.join(root, e.name)
    if (isFile(path.join(dir, 'SKILL.md'))) { out.push(dir); continue }
    // one level of grouping (skills/<group>/<skill>/SKILL.md)
    for (const e2 of await readDirSafe(dir)) {
      if (e2.name.startsWith('.')) continue
      const d2 = path.join(dir, e2.name)
      if (isFile(path.join(d2, 'SKILL.md'))) out.push(d2)
    }
  }
  return out
}

async function listFiles (dir, max = MAX_SKILL_FILES) {
  const out = []
  async function walk (d, rel) {
    for (const e of await readDirSafe(d)) {
      if (out.length >= max) return
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.petpack.json') continue
      const abs = path.join(d, e.name)
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) await walk(abs, r)
      else if (e.isFile()) {
        try { const st = await fsp.stat(abs); out.push({ abs, path: r, size: st.size, mtime: st.mtimeMs }) } catch {}
      }
    }
  }
  await walk(dir, '')
  return out
}

async function collectSkills (roots, add) {
  for (const root of roots) {
    for (const dir of await skillDirs(root)) {
      if (isFile(path.join(dir, '.petpack.json'))) continue // adopted through petpack: not ours to re-publish
      const md = await readText(path.join(dir, 'SKILL.md'))
      if (!md) continue
      const fm = parseFrontmatter(md.text)
      const name = fm.name || path.basename(dir)
      const files = await listFiles(dir)
      const bytes = files.reduce((n, f) => n + f.size, 0)
      const mtime = Math.max(md.mtime, ...files.map(f => f.mtime))
      add({
        kind: 'skill',
        slug: slugify(name, 64),
        title: name,
        summary: summarize(fm.description || md.text),
        bytes,
        sha: sha(md.text + '\n' + files.map(f => `${f.path}:${f.size}:${Math.round(f.mtime)}`).join('\n')),
        mtime,
        src: { type: 'skill', dir, name, description: fm.description || '' }
      })
    }
  }
}

function sectionItem (kind, slug, title, text, mtime, src) {
  const body = text.replace(/^#\s+.*\n+/, '').replace(/^\([^)\n]*AGENTS\.md\)\n+/, '')
  return { kind, slug, title, summary: summarize(body), bytes: Buffer.byteLength(text), sha: sha(text), mtime, src: { type: 'text', text, ...src } }
}

// MEMORY.md: "# Task Group: X" blocks. "Reusable knowledge" -> memory, "Failures and how to do differently" ->
// technique. "User preferences", task lists, rollout files and keywords stay home.
async function collectMemories (codexHome, add) {
  const file = path.join(codexHome, 'memories', 'MEMORY.md')
  const md = await readText(file, 4 * MAX_TEXT)
  if (!md) return
  for (const group of splitSections(md.text, 1)) {
    if (!group.title) continue
    const name = group.title.replace(/^task group:\s*/i, '').trim()
    for (const sec of splitSections(group.body, 2)) {
      if (!sec.title || !sec.body) continue
      if (/^reusable knowledge/i.test(sec.title)) {
        add(sectionItem('memory', 'mem-' + slugify(name), name, `# ${name}\n\n${sec.body}\n`, md.mtime, { file }))
      } else if (/^failures/i.test(sec.title)) {
        const title = `${name}: what to do differently`
        add(sectionItem('technique', 'avoid-' + slugify(name), title, `# ${title}\n\n${sec.body}\n`, md.mtime, { file }))
      }
    }
  }
}

// An AGENTS.md becomes one item per `##` section (or `#` section, or the whole file when it has no headings).
function agentsSections (text) {
  let secs = splitSections(text, 2)
  if (!secs.some(s => s.title)) secs = splitSections(text, 1)
  return secs.filter(s => s.body && s.body.length >= 8)
}

const RULEY = /\b(rules?|conventions?|style|guidelines?|workflow|process|commits?|testing|tests|review|do not|don't|never|always|checklist|how to)\b/i

async function collectAgents (projects, codexHome, add) {
  const seen = new Set()
  for (const project of projects) {
    const chain = projectChain(project)
    const projName = path.basename(chain[0]) || 'project'
    for (const dir of chain) {
      const file = ['AGENTS.override.md', 'AGENTS.md'].map(n => path.join(dir, n)).find(isFile)
      if (!file || seen.has(file)) continue
      seen.add(file)
      const md = await readText(file)
      if (!md) continue
      const relDir = path.relative(chain[0], dir).split(path.sep).join('/')
      const where = relDir ? `${projName}/${relDir}` : projName
      for (const sec of agentsSections(md.text)) {
        const title = sec.title || `${where} AGENTS.md`
        const kind = RULEY.test(sec.title || '') ? 'technique' : 'memory'
        const text = `# ${title}\n\n(${where}/AGENTS.md)\n\n${sec.body}\n`
        add(sectionItem(kind, `agents-${slugify(where, 24)}-${slugify(sec.title || 'rules', 32)}`, title, text, md.mtime, { file }))
      }
    }
  }
  // The global AGENTS.md: the owner's house rules, offered in the Dojo.
  const globalFile = ['AGENTS.override.md', 'AGENTS.md'].map(n => path.join(codexHome, n)).find(isFile)
  if (globalFile) {
    const md = await readText(globalFile)
    if (md) {
      for (const sec of agentsSections(md.text)) {
        const title = sec.title ? `House rules: ${sec.title}` : 'House rules (global AGENTS.md)'
        add(sectionItem('technique', 'rules-' + slugify(sec.title || 'global'), title, `# ${title}\n\n${sec.body}\n`, md.mtime, { file: globalFile }))
      }
    }
  }
}

async function collectPrompts (codexHome, add) {
  const dir = path.join(codexHome, 'prompts')
  for (const e of await readDirSafe(dir)) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const file = path.join(dir, e.name)
    const md = await readText(file)
    if (!md || !md.text.trim()) continue
    const fm = parseFrontmatter(md.text)
    const name = e.name.replace(/\.md$/, '')
    const title = fm.description ? `/${name}: ${fm.description}` : `/${name}`
    add({ ...sectionItem('technique', 'prompt-' + slugify(name), title.slice(0, 120), md.text, md.mtime, { file }), summary: summarize(fm.description ? fm.description + ' ' + md.text : md.text) })
  }
}

function resourceSnippet (name, cfg) {
  const q = v => JSON.stringify(String(v))
  const lines = [`[mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : q(name)}]`]
  if (cfg.command) lines.push(`command = ${q(cfg.command)}`)
  if (Array.isArray(cfg.args) && cfg.args.length) lines.push(`args = [${cfg.args.map(q).join(', ')}]`)
  if (cfg.url) lines.push(`url = ${q(cfg.url)}`)
  const envKeys = envKeyNames(cfg)
  if (envKeys.length) lines.push(`# env: ${envKeys.join(', ')} (set your own values)`)
  return lines.join('\n') + '\n'
}

function envKeyNames (cfg) {
  const keys = new Set()
  if (cfg.env && typeof cfg.env === 'object') for (const k of Object.keys(cfg.env)) keys.add(k)
  if (Array.isArray(cfg.env_vars)) for (const k of cfg.env_vars) keys.add(String(k))
  if (cfg.bearer_token_env_var) keys.add(String(cfg.bearer_token_env_var))
  return [...keys]
}

async function collectResources (codexHome, add) {
  const file = path.join(codexHome, 'config.toml')
  let mtime = 0
  try { mtime = (await fsp.stat(file)).mtimeMs } catch { return }
  const servers = readMcpServers(codexHome)
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object' || name === 'petpack') continue
    if (!cfg.command && !cfg.url) continue
    const snippet = resourceSnippet(name, cfg)
    const how = cfg.url ? String(cfg.url) : [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].join(' ')
    const envKeys = envKeyNames(cfg)
    const summary = `MCP server ${name}: ${how}${envKeys.length ? ` (env ${envKeys.join(', ')})` : ''}`
    add({
      kind: 'resource',
      slug: slugify(name, 64),
      title: name,
      summary: summarize(summary),
      bytes: Buffer.byteLength(snippet),
      sha: sha(snippet),
      mtime,
      src: {
        type: 'resource',
        text: snippet,
        pkg: { kind: 'resource', name, command: cfg.command || null, args: Array.isArray(cfg.args) ? cfg.args.map(String) : [], url: cfg.url || null, env_keys: envKeys }
      }
    })
  }
}

// Answers this agent gave through petpack (answer.js saves them), offered as Library cards.
async function collectAnswers (answersDir, add) {
  for (const e of await readDirSafe(answersDir)) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const file = path.join(answersDir, e.name)
    const md = await readText(file)
    if (!md) continue
    const first = /^#\s+(.+)$/m.exec(md.text)
    const title = (first ? first[1] : e.name.replace(/\.md$/, '')).slice(0, 120)
    const body = md.text.replace(/^#\s+.+$/m, '')
    add({ ...sectionItem('memory', 'answer-' + slugify(e.name.replace(/\.md$/, ''), 60), title, md.text, md.mtime, { file }), summary: summarize(body) })
  }
}

// ---------------------------------------------------------------- catalog

let lastBuilt = null // { at, key, items, index }

function optsKey (opts) {
  return JSON.stringify([opts.codexHome, opts.homeDir, opts.cwd, opts.answersDir, opts.includeProcessCwd, opts.env?.CODEX_HOME])
}

// Builds the catalog. Returns {items, index (Map ref -> internal entry), projects, codexHome}.
export async function buildCatalog (opts = {}) {
  const codexHome = resolveCodexHome(opts)
  const homeDir = opts.homeDir || os.homedir()
  const answersDir = defaultAnswersDir(opts)
  const projects = await projectDirs(opts, codexHome)
  const index = new Map()
  const add = (e) => {
    let ref = `${e.kind}:${e.slug}`
    if (index.has(ref)) {
      if (e.kind === 'skill') return // first root wins (CODEX_HOME before ~/.agents)
      ref = `${ref}-${e.sha.slice(0, 6)}`
      if (index.has(ref)) return
    }
    const item = { ref, kind: e.kind, title: String(e.title).slice(0, 120), summary: e.summary, bytes: e.bytes, sha: e.sha, mtime: Math.round(e.mtime || 0) }
    index.set(ref, { item, src: e.src })
  }
  const skillRoots = [path.join(codexHome, 'skills'), path.join(homeDir, '.agents', 'skills')]
  for (const p of projects) {
    for (const d of projectChain(p).reverse()) skillRoots.push(path.join(d, '.agents', 'skills'))
  }
  const steps = [
    () => collectSkills([...new Set(skillRoots)], add),
    () => collectAgents(projects, codexHome, add),
    () => collectMemories(codexHome, add),
    () => collectPrompts(codexHome, add),
    () => collectResources(codexHome, add),
    () => collectAnswers(answersDir, add)
  ]
  for (const step of steps) { try { await step() } catch {} } // one bad source never sinks the catalog
  const items = [...index.values()].map(e => e.item)
  const built = { at: Date.now(), key: optsKey(opts), items, index, projects, codexHome }
  lastBuilt = built
  return built
}

// The bridge's getCatalog(): metadata only.
export async function getCatalog (opts = {}) {
  return (await buildCatalog(opts)).items
}

async function cached (opts, maxAgeMs = 5000) {
  if (lastBuilt && lastBuilt.key === optsKey(opts) && Date.now() - lastBuilt.at < maxAgeMs) return lastBuilt
  return buildCatalog(opts)
}

async function packSkillDir (dir, name, description) {
  const files = []
  let total = 0
  for (const f of await listFiles(dir)) {
    if (f.size > MAX_PKG_FILE || total + f.size > MAX_PKG_TOTAL) continue
    try {
      const buf = await fsp.readFile(f.abs)
      total += buf.length
      files.push({ path: f.path, b64: buf.toString('base64') })
    } catch {}
  }
  return { kind: 'skill', id: name, name, description, files }
}

// readItem(ref, as='text'|'pkg') -> {ok, ref, kind, title, sha, text?, pkg?, reason?}
// text: the section, the SKILL.md plus its file list, or the config snippet.
// pkg: what installItem takes on the other side (skill files, a note, or an MCP server).
export async function readItem (ref, as = 'text', opts = {}) {
  if (typeof as === 'object' && as) { opts = as; as = 'text' }
  let built = await cached(opts)
  let entry = built.index.get(ref)
  if (!entry) { built = await buildCatalog(opts); entry = built.index.get(ref) }
  if (!entry) return { ok: false, ref, reason: 'not found' }
  const { item, src } = entry
  const base = { ok: true, ref, kind: item.kind, title: item.title, sha: item.sha }
  try {
    if (src.type === 'skill') {
      if (as === 'pkg') return { ...base, pkg: { ...(await packSkillDir(src.dir, src.name, src.description)), ref, title: item.title } }
      const md = await readText(path.join(src.dir, 'SKILL.md'))
      const files = (await listFiles(src.dir)).filter(f => f.path !== 'SKILL.md')
      const list = files.length ? '\n\nFiles in this skill:\n' + files.map(f => `- ${f.path} (${f.size} bytes)`).join('\n') + '\n' : ''
      return { ...base, text: (md ? md.text : '') + list }
    }
    if (src.type === 'resource') {
      return as === 'pkg' ? { ...base, text: src.text, pkg: { ...src.pkg, ref, title: item.title } } : { ...base, text: src.text }
    }
    if (as === 'pkg') return { ...base, text: src.text, pkg: { kind: item.kind, ref, title: item.title, text: src.text } }
    return { ...base, text: src.text }
  } catch (err) {
    return { ok: false, ref, reason: String(err?.message || err) }
  }
}

// Internal: where an item lives on disk (answer.js points its exec at these).
export async function itemSource (ref, opts = {}) {
  const built = await cached(opts)
  const e = built.index.get(ref)
  if (!e) return null
  return e.src.dir ? path.join(e.src.dir, 'SKILL.md') : (e.src.file || null)
}

// ---------------------------------------------------------------- install (notes and resources)

function noteName (title, n) {
  const base = 'petpack-note-' + slugify(title, 40)
  return n > 1 ? `${base}-${n}` : base
}

// installNote(pkg, fromName) for memory/technique items: writes skills/petpack-note-<slug>/SKILL.md, which Codex
// loads without a restart. Never overwrites a different note; re-installing the same one is a no-op.
export async function installNote (pkg, fromName = 'a teammate', opts = {}) {
  const codexHome = resolveCodexHome(opts)
  const title = String(pkg?.title || pkg?.ref || 'note').replace(/^#+\s*/, '').slice(0, 120)
  const text = String(pkg?.text ?? pkg?.body ?? '')
  if (!text.trim()) return { installed: false, reason: 'empty' }
  const kind = pkg.kind === 'technique' ? 'technique' : 'memory'
  const from = String(fromName || 'a teammate').slice(0, 60)
  const hash = sha(text)
  const skillsDir = path.join(codexHome, 'skills')
  for (let n = 1; n < 50; n++) {
    const name = noteName(title, n)
    const dir = path.join(skillsDir, name)
    if (fs.existsSync(dir)) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, '.petpack.json'), 'utf8'))
        if (meta.sha === hash) return { installed: true, path: dir, name, existed: true }
      } catch {}
      continue
    }
    const what = kind === 'technique' ? 'technique' : 'note'
    const desc = `${title}. A ${what} from ${from}'s agent, shared through petpack. Use when working on: ${summarize(text, 600)}`.slice(0, 1024)
    const body = text.replace(/^#\s+.+\n+/, '')
    const md = `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n# ${title}\n\nFrom ${from}'s agent (petpack ${kind}).\n\n${body.trim()}\n`
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'SKILL.md'), md)
    await fsp.writeFile(path.join(dir, '.petpack.json'), JSON.stringify({ from, ref: pkg.ref || null, kind, title, sha: hash, installedAt: new Date().toISOString() }, null, 2) + '\n')
    return { installed: true, path: dir, name }
  }
  return { installed: false, reason: 'too many notes with that name' }
}

function run (cmd, args, { env, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    const quoted = win ? args.map(a => /[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a) : args
    let child
    try { child = spawn(cmd, quoted, { env: env || process.env, shell: win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (err) { return resolve({ code: -1, out: '', err: String(err) }) }
    let out = ''; let errOut = ''
    child.stdout?.on('data', d => { out += d })
    child.stderr?.on('data', d => { errOut += d })
    const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.on('error', err => { clearTimeout(t); resolve({ code: -1, out, err: String(err) }) })
    child.on('close', code => { clearTimeout(t); resolve({ code, out, err: errOut }) })
  })
}

// installResource(pkg): `codex mcp add <name> -- <command> <args...>` or `--url <url>`. Existing names are kept.
export async function installResource (pkg, fromName = 'a teammate', opts = {}) {
  const codexHome = resolveCodexHome(opts)
  const name = String(pkg?.name || '').trim()
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return { installed: false, reason: 'bad name' }
  const configPath = path.join(codexHome, 'config.toml')
  if (readMcpServers(codexHome)[name]) return { installed: true, existed: true, path: configPath, name }
  const args = ['mcp', 'add', name]
  if (pkg.url) args.push('--url', String(pkg.url))
  else if (pkg.command) args.push('--', String(pkg.command), ...(Array.isArray(pkg.args) ? pkg.args.map(String) : []))
  else return { installed: false, reason: 'no command or url' }
  const env = { ...(opts.env || process.env), CODEX_HOME: codexHome }
  const r = await run(opts.codexBin || env.PETPACK_CODEX || 'codex', args, { env })
  if (r.code !== 0) return { installed: false, reason: (r.err || r.out || `codex exited ${r.code}`).trim().slice(0, 300) }
  return { installed: true, path: configPath, name, env_keys: pkg.env_keys || [] }
}

// installItem(item|pkg, fromName): notes and resources here; skill packages belong to install.js (L3a).
export async function installItem (pkg, fromName, opts = {}) {
  const kind = pkg?.kind || String(pkg?.ref || '').split(':')[0]
  if (kind === 'resource') return installResource(pkg, fromName, opts)
  if (kind === 'memory' || kind === 'technique') return installNote({ ...pkg, kind }, fromName, opts)
  return { installed: false, reason: `kind ${kind || 'unknown'} is installed by installSkill` }
}

// ---------------------------------------------------------------- watch

// Rebuilds on start, every 30 s and when the source folders change; calls onChange(items) when the set changes.
export function watchCatalog (opts = {}, onChange = () => {}, { intervalMs = 30000, debounceMs = 1000 } = {}) {
  let last = ''
  let timer = null
  let stopped = false
  const watchers = []
  const rebuild = async () => {
    if (stopped) return
    try {
      const items = await getCatalog(opts)
      const sig = items.map(i => i.ref + '@' + i.sha).sort().join('|')
      if (sig !== last) { last = sig; onChange(items) }
    } catch {}
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(rebuild, debounceMs) }
  const codexHome = resolveCodexHome(opts)
  const homeDir = opts.homeDir || os.homedir()
  for (const d of [path.join(codexHome, 'skills'), path.join(homeDir, '.agents', 'skills'), path.join(codexHome, 'memories'), path.join(codexHome, 'prompts'), codexHome, defaultAnswersDir(opts)]) {
    try {
      const w = fs.watch(d, { persistent: false }, (ev, name) => {
        if (d === codexHome && name && !/^(config\.toml|AGENTS(\.override)?\.md)$/.test(String(name))) return
        soon()
      })
      w.on('error', () => {})
      watchers.push(w)
    } catch {}
  }
  const iv = setInterval(rebuild, intervalMs)
  iv.unref?.()
  rebuild()
  return () => { stopped = true; clearInterval(iv); clearTimeout(timer); for (const w of watchers) { try { w.close() } catch {} } }
}
