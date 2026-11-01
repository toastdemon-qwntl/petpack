// Codex skills: list and pack (main-process Node only; no Electron imports).
//
// listSkills(opts) -> Array<{ id, name, description, path, root, installedFrom? }>
//   Every skill folder with a SKILL.md in <home>/skills/* (each Codex home) and ~/.agents/skills/*, except dot
//   folders such as `.system`. `id` is the folder name (first one wins on duplicates). Symlinked folders count.
//   `installedFrom` is set for skills petpack installed (read from their .petpack.json).
// packSkill(id, opts) -> Promise<{ id, name, description, files: [{ path, b64 }], bytes, truncated }>
//   Packs the folder of the skill with that id (or name, or an absolute folder path). Paths are posix and relative.
//   Skips .git, node_modules, .DS_Store and .petpack.json; SKILL.md always goes first; stops at opts.maxBytes
//   (default 512 KB of file content). Rejects (throws) only when the skill doesn't exist.
// parseFrontmatter(text) -> { name?, description?, ... } the YAML-subset frontmatter of a SKILL.md.
//
// opts: { homes?, home?, env?, agentsDir?, maxBytes? }

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { codexHomes, agentsSkillsDir } from './home.js'

export const PACK_MAX_BYTES = 512 * 1024
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.petpack.json', '__pycache__'])

export function parseFrontmatter (text) {
  const out = {}
  const s = String(text || '').replace(/^\uFEFF/, '')
  const m = s.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/)
  if (!m) return out
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    let v = kv[2].trim()
    if (/^[|>][+-]?$/.test(v)) {
      // block scalar: following indented lines
      const fold = v[0] === '>'
      const parts = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) parts.push(lines[++i].trim())
      v = fold ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n').trim()
    } else if (/^"/.test(v)) {
      try { v = JSON.parse(v) } catch { v = v.replace(/^"|"$/g, '') }
    } else if (/^'/.test(v)) {
      v = v.replace(/^'|'$/g, '').replace(/''/g, "'")
    } else {
      // plain scalar, possibly continued on indented lines
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*[A-Za-z0-9_-]+:\s/.test(lines[i + 1])) v += ' ' + lines[++i].trim()
    }
    out[key] = v
  }
  return out
}

export function skillRoots (opts = {}) {
  const homes = opts.homes || codexHomes(opts)
  const roots = homes.map((h) => path.join(h, 'skills'))
  roots.push(opts.agentsDir || agentsSkillsDir(opts))
  return [...new Set(roots)]
}

function readSkill (dir, root) {
  try {
    const st = fs.statSync(dir)
    if (!st.isDirectory()) return null
    const md = path.join(dir, 'SKILL.md')
    if (!fs.existsSync(md)) return null
    const fm = parseFrontmatter(fs.readFileSync(md, 'utf8'))
    const id = path.basename(dir)
    const skill = {
      id,
      name: typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : id,
      description: typeof fm.description === 'string' ? fm.description.trim().slice(0, 1024) : '',
      path: dir,
      root
    }
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, '.petpack.json'), 'utf8'))
      if (meta && meta.from) skill.installedFrom = String(meta.from)
    } catch {}
    return skill
  } catch { return null }
}

export function listSkills (opts = {}) {
  const out = []
  const seen = new Set()
  for (const root of skillRoots(opts)) {
    let names = []
    try { names = fs.readdirSync(root) } catch { continue }
    names.sort()
    for (const name of names) {
      if (name.startsWith('.') || seen.has(name)) continue
      const s = readSkill(path.join(root, name), root)
      if (!s) continue
      seen.add(name)
      out.push(s)
    }
  }
  return out
}

export function findSkill (idOrName, opts = {}) {
  if (!idOrName) return null
  const key = String(idOrName)
  if (path.isAbsolute(key)) return readSkill(key, path.dirname(key))
  const all = listSkills(opts)
  return all.find((s) => s.id === key) || all.find((s) => s.name === key) ||
    all.find((s) => s.id.toLowerCase() === key.toLowerCase() || s.name.toLowerCase() === key.toLowerCase()) || null
}

async function walk (dir, rel, out) {
  let entries = []
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const abs = path.join(dir, e.name)
    const r = rel ? rel + '/' + e.name : e.name
    let st
    try { st = await fsp.stat(abs) } catch { continue }
    if (st.isDirectory()) {
      if (out.length < 2000) await walk(abs, r, out)
    } else if (st.isFile()) out.push({ abs, path: r, size: st.size })
  }
}

export async function packSkill (idOrName, opts = {}) {
  const skill = findSkill(idOrName, opts)
  if (!skill) throw new Error(`no skill named ${idOrName}`)
  const max = opts.maxBytes || PACK_MAX_BYTES
  const all = []
  await walk(skill.path, '', all)
  // SKILL.md first, then small files first so the most files fit
  all.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.size - b.size || a.path.localeCompare(b.path)))
  const files = []
  let bytes = 0
  let truncated = false
  for (const f of all) {
    if (bytes + f.size > max && f.path !== 'SKILL.md') { truncated = true; continue }
    try {
      const buf = await fsp.readFile(f.abs)
      files.push({ path: f.path, b64: buf.toString('base64') })
      bytes += buf.length
    } catch {}
  }
  return { id: skill.id, name: skill.name, description: skill.description, files, bytes, truncated }
}
