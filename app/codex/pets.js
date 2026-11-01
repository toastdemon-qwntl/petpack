// The user's Codex pet (main-process Node only; no Electron imports).
//
// getPet(opts) -> Promise<{ petName, displayName, spriteUrl, source, path, atlas }>   never throws
//   petName     stable id: the custom pet's folder name, or a built-in id ('codex', 'dewey', ...); 'dot' when none
//   displayName human name from pet.json (or the built-in's name)
//   spriteUrl   'data:image/webp;base64,...' | 'data:image/png;base64,...' | null (null: the world draws Dot)
//   source      'override' | 'chosen' | 'selected' | 'custom' | 'default' | 'builtin' | 'none'
//   path        file the sheet came from (or null)
//   atlas       { width, height, cols: 8, rows, cellW, cellH, version } (rows 9 for v1 sheets, 11 for v2 sheets)
// opts: { homes?: string[], home?, env?, pet?: '<dir|name|image file>' (the --pet override), cacheDir?, fetch?: bool,
//         appAsars?: string[] (override where to look for the Codex desktop app), timeoutMs? }
//
// Lookup order (first usable sheet wins; a malformed candidate is skipped, never thrown):
//   1. --pet override: a pet folder, a sheet file, a custom pet's folder/id/displayName, or a built-in id
//   1b. the pet chosen in petpack's tray (opts.choice, same forms)
//   2. the pet selected in Codex: the desktop app's `[desktop] selected-avatar-id` in <home>/config.toml (accepted
//      from any table, openai/codex#32685; legacy: .codex-global-state.json electron-persisted-atom-state), then the
//      CLI's `[tui] pet`. Values: 'custom:<folder>', a bare folder, a folder path, a built-in id, a cloud 'pet_...'
//      id (sheet URL from the app's cloud-pet-artwork-cache, when it downloads); 'disabled' is skipped.
//   3. custom pets in <home>/pets/<folder>/pet.json and <home>/avatars/<folder>/avatar.json (codex-pets.net zips and
//      Pet Drop pets unzip to the same layout, incl. v2 8x11 sheets); the most recently updated one.
//      pet.json `frame: { columns, rows }` is honoured when it covers the sheet exactly.
//   4. the Codex app's default pet ('codex') when the desktop app is installed or has run: an unset selection
//      means the app shows Codex
//   5. none: spriteUrl null (the world's built-in pixel pet)
// Built-in sheets come from the installed Codex desktop app (app.asar webview/assets/<id>-spritesheet-v*.webp), then
// the CLI's cache (<home>/cache/tui-pets), then the same CDN the CLI uses, cached under cacheDir.
//
// listPets(opts) -> Array<{ petName, displayName, dir, sheet, source }> every custom pet folder found (metadata only).
// imageInfo(buf) -> { width, height, mime } | null   PNG / WebP (VP8, VP8L, VP8X) header parser.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { codexHomes, isDir } from './home.js'
import { heldTuiPets } from './takeover.js'

// Inside Electron, `fs` treats *.asar files as folders, so reading the Codex app's app.asar as bytes needs the
// unpatched 'original-fs'. Plain Node has no such patch.
const rawFs = (() => {
  if (process.versions && process.versions.electron) { try { return createRequire(import.meta.url)('original-fs') } catch {} }
  return fs
})()

export const BUILTIN_PETS = {
  codex: 'Codex',
  dewey: 'Dewey',
  fireball: 'Fireball',
  rocky: 'Rocky',
  seedy: 'Seedy',
  stacky: 'Stacky',
  bsod: 'BSOD',
  'null-signal': 'Null Signal',
  hoots: 'Hoots'
}
export const PET_CDN = 'https://persistent.oaistatic.com/codex/pets/v1'
const COLS = 8
const MAX_SHEET_BYTES = 24 * 1024 * 1024

// ---------- image headers ----------

export function imageInfo (buf) {
  try {
    if (!buf || buf.length < 24) return null
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG' && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' }
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      let off = 12
      while (off + 8 <= buf.length) {
        const tag = buf.toString('ascii', off, off + 4)
        const size = buf.readUInt32LE(off + 4)
        const d = off + 8
        if (d + Math.min(size, 10) > buf.length) return null
        if (tag === 'VP8X' && size >= 10) {
          return { width: buf.readUIntLE(d + 4, 3) + 1, height: buf.readUIntLE(d + 7, 3) + 1, mime: 'image/webp' }
        }
        if (tag === 'VP8L' && size >= 5 && buf[d] === 0x2f) {
          const b = buf.readUInt32LE(d + 1)
          return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1, mime: 'image/webp' }
        }
        if (tag === 'VP8 ' && size >= 10 && buf[d + 3] === 0x9d && buf[d + 4] === 0x01 && buf[d + 5] === 0x2a) {
          return { width: buf.readUInt16LE(d + 6) & 0x3fff, height: buf.readUInt16LE(d + 8) & 0x3fff, mime: 'image/webp' }
        }
        off = d + size + (size % 2)
      }
    }
  } catch {}
  return null
}

// An atlas is usable when it's an 8-column grid of whole cells with 9 rows (v1) or 11 rows (v2), any cell size.
export function atlasOf (info) {
  if (!info || !info.width || !info.height || info.width % COLS !== 0) return null
  const cellW = info.width / COLS
  for (const rows of [9, 11]) {
    if (info.height % rows !== 0) continue
    const cellH = info.height / rows
    // cells are taller than wide (192x208 reference); accept anything within a sane aspect band
    if (cellH / cellW < 0.6 || cellH / cellW > 1.8) continue
    return { width: info.width, height: info.height, cols: COLS, rows, cellW, cellH, version: rows === 11 ? 2 : 1 }
  }
  return null
}

// pet.json may declare its grid: `frame: { width, height, columns, rows }` (Codex PetFile). Used when it covers the
// image exactly; otherwise the 8x9 / 8x11 detection applies.
function atlasFromFrame (info, frame) {
  if (!info || !frame || typeof frame !== 'object') return null
  const cols = Number(frame.columns); const rows = Number(frame.rows)
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols * rows > 256) return null
  if (info.width % cols || info.height % rows) return null
  return { width: info.width, height: info.height, cols, rows, cellW: info.width / cols, cellH: info.height / rows, version: rows === 11 ? 2 : 1 }
}

function sheetFromBuffer (buf, frame) {
  if (!buf || buf.length > MAX_SHEET_BYTES) return null
  const info = imageInfo(buf)
  const atlas = atlasFromFrame(info, frame) || atlasOf(info)
  if (!atlas) return null
  return { spriteUrl: `data:${info.mime};base64,${buf.toString('base64')}`, atlas }
}

async function readSheetFile (file, frame) {
  try {
    const st = await fsp.stat(file)
    if (!st.isFile() || st.size > MAX_SHEET_BYTES) return null
    return sheetFromBuffer(await fsp.readFile(file), frame)
  } catch { return null }
}

// ---------- custom pets ----------

function readJsonLoose (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

// One pet folder -> candidate description (no image read yet), or null when there's no sheet to try.
function describeFolder (dir, source = 'custom') {
  try {
    if (!isDir(dir)) return null
    const folder = path.basename(dir)
    const manifestFile = ['pet.json', 'avatar.json'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f))
    const meta = (manifestFile && readJsonLoose(manifestFile)) || {}
    const m = typeof meta === 'object' && meta && !Array.isArray(meta) ? meta : {}
    const sheets = []
    if (typeof m.spritesheetPath === 'string' && m.spritesheetPath.trim()) sheets.push(path.resolve(dir, m.spritesheetPath.trim()))
    for (const f of ['spritesheet.webp', 'spritesheet.png']) sheets.push(path.join(dir, f))
    // any other image in the folder, as a last resort (gallery downloads sometimes keep the original file name)
    try {
      for (const f of fs.readdirSync(dir)) if (/\.(webp|png)$/i.test(f)) sheets.push(path.join(dir, f))
    } catch {}
    const uniq = [...new Set(sheets)].filter((f) => { try { return fs.statSync(f).isFile() } catch { return false } })
    if (!uniq.length) return null
    let updatedAt = 0
    for (const f of [manifestFile, uniq[0]].filter(Boolean)) {
      try { updatedAt = Math.max(updatedAt, fs.statSync(f).mtimeMs) } catch {}
    }
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    return {
      petName: folder,
      id: str(m.id) || folder,
      displayName: str(m.displayName) || str(m.name) || str(m.id) || folder,
      dir,
      sheets: uniq,
      frame: m.frame && typeof m.frame === 'object' ? m.frame : null,
      updatedAt,
      source
    }
  } catch { return null }
}

export function listPets (opts = {}) {
  const homes = opts.homes || codexHomes(opts)
  const out = []
  for (const home of homes) {
    for (const sub of ['pets', 'avatars']) {
      const root = path.join(home, sub)
      let names = []
      try { names = fs.readdirSync(root) } catch { continue }
      for (const name of names) {
        if (name.startsWith('.')) continue
        const d = describeFolder(path.join(root, name))
        if (d) out.push(d)
      }
    }
  }
  return out
}

async function loadCandidate (c, source) {
  if (!c) return null
  for (const file of c.sheets) {
    const s = await readSheetFile(file, c.frame)
    if (s) return { petName: c.petName, displayName: c.displayName, spriteUrl: s.spriteUrl, source, path: file, atlas: s.atlas }
  }
  return null
}

function findCustom (pets, key) {
  if (!key) return []
  const k = String(key).toLowerCase()
  const by = (f) => pets.filter((p) => String(f(p) || '').toLowerCase() === k)
  return [...by((p) => p.petName), ...by((p) => p.id), ...by((p) => p.displayName)]
}

// ---------- the selection recorded by Codex ----------

function deepFind (obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
  for (const v of Object.values(obj)) {
    const r = deepFind(v, key, depth + 1)
    if (r !== undefined) return r
  }
  return undefined
}

// Minimal TOML read: string values by dotted key (`[tui] pet = "x"` -> 'tui.pet'). Enough for the two pet keys.
export function tomlStrings (text) {
  const out = []
  if (!text) return out
  let table = ''
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const t = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/)
    if (t) { table = t[1].replace(/\s+/g, '').replace(/"/g, ''); continue }
    const kv = line.match(/^([A-Za-z0-9_.\-"]+)\s*=\s*("((?:[^"\\]|\\.)*)"|'([^']*)')/)
    if (!kv) continue
    let v = kv[4]
    if (kv[3] !== undefined) { try { v = JSON.parse(`"${kv[3]}"`) } catch { v = kv[3] } }
    out.push({ key: (table ? table + '.' : '') + kv[1].replace(/"/g, ''), value: v })
  }
  return out
}

// The CLI's choice: `[tui] pet = "<built-in id>" | "custom:<dir>" | "<dir>" | "<path>" | "disabled"`.
export function tuiPetFromToml (text) {
  const hit = tomlStrings(text).find((e) => e.key === 'tui.pet')
  return hit ? hit.value : null
}

// The desktop app's choice: top-level `selected-avatar-id = "custom:<dir>" | "<built-in id>"` in config.toml. A known
// app bug appends it inside the last table (openai/codex#32685), so it's accepted from any table.
export function appPetFromToml (text) {
  const hit = tomlStrings(text).find((e) => e.key === 'selected-avatar-id' || e.key.endsWith('.selected-avatar-id'))
  return hit ? hit.value : null
}

export function selectedPetIds (opts = {}) {
  const homes = opts.homes || codexHomes(opts)
  const ids = []
  const tomls = homes.map((home) => {
    try { return { home, text: fs.readFileSync(path.join(home, 'config.toml'), 'utf8') } } catch { return { home, text: '' } }
  })
  for (const { home, text } of tomls) {
    const v = appPetFromToml(text)
    if (v) ids.push({ id: v, from: 'app', home })
  }
  for (const home of homes) {
    const gs = readJsonLoose(path.join(home, '.codex-global-state.json'))
    const v = gs && deepFind(gs, 'selected-avatar-id')
    if (typeof v === 'string' && v) ids.push({ id: v, from: 'app-state', home })
  }
  // while petpack holds the pet, the CLI's own [tui] pet reads "disabled"; the original is in the takeover marker
  const held = opts.takeoverFile ? heldTuiPets(opts.takeoverFile) : {}
  for (const { home, text } of tomls) {
    const v = tuiPetFromToml(text)
    const id = v === 'disabled' && held[home] ? held[home] : v
    if (id) ids.push({ id, from: 'tui', home })
  }
  return ids
}

// ---------- built-in pets ----------

// Where the Codex desktop app may be installed, per platform. Missing paths are fine.
export function appAsarCandidates ({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const out = []
  if (platform === 'darwin') {
    for (const base of ['/Applications', path.join(homedir, 'Applications')]) {
      for (const app of ['Codex.app', 'ChatGPT.app', 'Codex (Beta).app']) out.push(path.join(base, app, 'Contents', 'Resources', 'app.asar'))
    }
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local')
    for (const app of ['Codex', 'codex', 'ChatGPT', 'OpenAI Codex']) out.push(path.join(local, 'Programs', app, 'resources', 'app.asar'))
    for (const root of [env.ProgramFiles || 'C:\\Program Files']) {
      for (const app of ['Codex', 'ChatGPT', 'OpenAI\\Codex']) out.push(path.join(root, app, 'resources', 'app.asar'))
      // MSIX installs; the WindowsApps folder is often unlistable, so this is best effort
      try {
        const wa = path.join(root, 'WindowsApps')
        for (const d of fs.readdirSync(wa)) {
          if (/^OpenAI\.(Codex|ChatGPT)/i.test(d)) out.push(path.join(wa, d, 'app', 'resources', 'app.asar'))
        }
      } catch {}
    }
  } else {
    for (const p of ['/usr/lib/chatgpt', '/opt/chatgpt', '/usr/lib/codex', '/opt/codex', '/opt/Codex']) out.push(path.join(p, 'resources', 'app.asar'))
  }
  return out
}

// Read a file out of an Electron asar archive without Electron (header is a pickled JSON index).
const asarCache = new Map()
function asarIndex (file) {
  if (asarCache.has(file)) return asarCache.get(file)
  let idx = null
  try {
    const fd = rawFs.openSync(file, 'r')
    try {
      const head = Buffer.alloc(16)
      rawFs.readSync(fd, head, 0, 16, 0)
      const pickle = head.readUInt32LE(4)
      const len = head.readUInt32LE(12)
      if (len > 0 && len < 256 * 1024 * 1024) {
        const json = Buffer.alloc(len)
        rawFs.readSync(fd, json, 0, len, 16)
        const header = JSON.parse(json.toString('utf8'))
        const assets = header?.files?.webview?.files?.assets?.files || {}
        const sheets = {}
        for (const [name, node] of Object.entries(assets)) {
          const m = name.match(/^([a-z0-9-]+?)-spritesheet-v(\d+)(?:-[0-9a-f]+)?\.(webp|png)$/i)
          if (!m || node.files || node.unpacked) continue
          const prev = sheets[m[1]]
          if (!prev || Number(m[2]) > prev.v) sheets[m[1]] = { v: Number(m[2]), offset: Number(node.offset), size: node.size }
        }
        idx = { base: 8 + pickle, sheets }
      }
    } finally { rawFs.closeSync(fd) }
  } catch { idx = null }
  asarCache.set(file, idx)
  return idx
}

function readFromAsar (file, id) {
  const idx = asarIndex(file)
  const s = idx && idx.sheets[id]
  if (!s || s.size > MAX_SHEET_BYTES) return null
  try {
    const fd = rawFs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(s.size)
      rawFs.readSync(fd, buf, 0, s.size, idx.base + s.offset)
      return buf
    } finally { rawFs.closeSync(fd) }
  } catch { return null }
}

export function builtinIdsInApp (opts = {}) {
  const asars = opts.appAsars || appAsarCandidates(opts)
  const ids = new Set()
  for (const a of asars) { const idx = rawFs.existsSync(a) && asarIndex(a); if (idx) for (const k of Object.keys(idx.sheets)) ids.add(k) }
  return [...ids]
}

function findInDir (root, rx, depth = 0) {
  if (depth > 4) return null
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return null }
  for (const e of entries) if (e.isFile() && rx.test(e.name)) return path.join(root, e.name)
  for (const e of entries) if (e.isDirectory()) { const r = findInDir(path.join(root, e.name), rx, depth + 1); if (r) return r }
  return null
}

async function fetchWithTimeout (url, ms) {
  if (typeof fetch !== 'function') return null
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch { return null } finally { clearTimeout(t) }
}

export async function loadBuiltin (id, opts = {}) {
  const key = String(id || '').toLowerCase().replace(/^builtin:/, '')
  if (!/^[a-z0-9-]{1,64}$/.test(key)) return null
  const displayName = BUILTIN_PETS[key] || key.replace(/(^|-)([a-z])/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase())
  const done = (buf, file) => {
    const s = sheetFromBuffer(buf)
    return s ? { petName: key, displayName, spriteUrl: s.spriteUrl, source: 'builtin', path: file, atlas: s.atlas } : null
  }
  // 1. the CLI's download cache, then ours (8x9 sheets)
  const rx = new RegExp(`^${key}-spritesheet(-v\\d+)?(-[0-9a-f]+)?\\.(webp|png)$`, 'i')
  const homes = opts.homes || codexHomes(opts)
  const cacheDir = opts.cacheDir || path.join(os.tmpdir(), 'petpack-pets')
  for (const root of [...homes.map((h) => path.join(h, 'cache', 'tui-pets')), cacheDir]) {
    const f = findInDir(root, rx)
    if (!f) continue
    const r = done(await fsp.readFile(f).catch(() => null), f)
    if (r) return r
  }
  // 2. the installed desktop app (offline; 8x11 sheets, which the world and the upload crop to 8x9)
  for (const a of opts.appAsars || appAsarCandidates(opts)) {
    if (!rawFs.existsSync(a)) continue
    const r = done(readFromAsar(a, key), a)
    if (r) return r
  }
  // 3. the CDN the CLI downloads from
  if (opts.fetch !== false && Object.prototype.hasOwnProperty.call(BUILTIN_PETS, key)) {
    const buf = await fetchWithTimeout(`${PET_CDN}/${key}-spritesheet-v4.webp`, opts.timeoutMs || 4000)
    const file = path.join(cacheDir, `${key}-spritesheet-v4.webp`)
    const r = buf && done(buf, file)
    if (r) {
      try { await fsp.mkdir(cacheDir, { recursive: true }); await fsp.writeFile(file, buf) } catch {}
      return r
    }
  }
  return null
}

// ---------- resolution ----------

// A cloud pet ('pet_...', Pet Drop adoptions when the app's cloud pets are on) has no local folder. The app's state
// keeps its sheet URL in `cloud-pet-artwork-cache`; try it once (it may need a signature) and keep a copy.
async function loadCloudPet (id, opts, source) {
  try {
    const cacheDir = opts.cacheDir || path.join(os.tmpdir(), 'petpack-pets')
    const safe = id.replace(/[^A-Za-z0-9_-]/g, '')
    const cached = path.join(cacheDir, `${safe}.sheet`)
    let buf = await fsp.readFile(cached).catch(() => null)
    let file = cached
    if (!buf && opts.fetch !== false) {
      for (const home of opts.homes || []) {
        const gs = readJsonLoose(path.join(home, '.codex-global-state.json'))
        const cache = gs && deepFind(gs, 'cloud-pet-artwork-cache')
        const hit = cache && Array.isArray(cache.pets) && cache.pets.find((p) => p && p.id === id && p.spritesheetUrl)
        if (!hit) continue
        buf = await fetchWithTimeout(hit.spritesheetUrl, opts.timeoutMs || 4000)
        file = hit.spritesheetUrl
        if (buf && sheetFromBuffer(buf)) { try { await fsp.mkdir(cacheDir, { recursive: true }); await fsp.writeFile(cached, buf) } catch {} ; break }
      }
    }
    const s = buf && sheetFromBuffer(buf)
    return s ? { petName: safe, displayName: 'My pet', spriteUrl: s.spriteUrl, source, path: file, atlas: s.atlas } : null
  } catch { return null }
}

const looksLikePath = (v) => /[/\\]/.test(v) || /^~|^\.\.?$/.test(v) || path.isAbsolute(v)

async function resolveId (id, pets, opts, source, base) {
  if (!id || typeof id !== 'string') return null
  const v = id.trim()
  if (!v || /^(none|off|disabled|false)$/i.test(v)) return null
  if (looksLikePath(v)) {
    // the CLI loads a path value as a pet folder (relative to the Codex home it came from)
    const p = path.resolve(base || process.cwd(), v.replace(/^~(?=$|[/\\])/, os.homedir()))
    const r = await loadCandidate(describeFolder(p), source)
    if (r) return r
  }
  const custom = v.replace(/^custom:/i, '')
  for (const c of findCustom(pets, custom)) {
    const r = await loadCandidate(c, source)
    if (r) return r
  }
  if (/^custom:/i.test(v)) return null
  if (/^pet_/i.test(v)) return loadCloudPet(v, opts, source)
  const b = await loadBuiltin(v, opts)
  return b ? { ...b, source } : null
}

async function resolveOverride (spec, pets, opts) {
  const s = String(spec).trim()
  if (!s) return null
  const p = path.resolve(s.replace(/^~(?=$|[/\\])/, os.homedir()))
  try {
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      const r = await loadCandidate(describeFolder(p), 'override')
      if (r) return r
    } else if (st.isFile()) {
      const sheet = await readSheetFile(p)
      if (sheet) {
        const dir = path.dirname(p)
        const meta = describeFolder(dir)
        const name = meta?.petName || path.basename(p).replace(/\.[^.]+$/, '')
        return { petName: name, displayName: meta?.displayName || name, spriteUrl: sheet.spriteUrl, source: 'override', path: p, atlas: sheet.atlas }
      }
    }
  } catch {}
  return resolveId(s, pets, opts, 'override')
}

export const NO_PET = Object.freeze({ petName: 'dot', displayName: 'Dot', spriteUrl: null, source: 'none', path: null, atlas: null })

// Is the Codex desktop app here (installed, or has it run with one of these homes)?
export function desktopAppPresent (opts = {}) {
  const homes = opts.homes || codexHomes(opts)
  if (homes.some((h) => fs.existsSync(path.join(h, '.codex-global-state.json')))) return true
  return (opts.appAsars || appAsarCandidates(opts)).some((a) => rawFs.existsSync(a))
}

// opts.choice: the pet picked in petpack's tray (saved by index.js), between --pet and Codex's own selection.
// opts.trace: an array that receives one { step, value, result } entry per lookup step (for `petpack pets`).
export async function getPet (opts = {}) {
  const trace = Array.isArray(opts.trace) ? opts.trace : null
  const note = (step, value, r, why) => { if (trace) trace.push({ step, value: value ?? null, result: r ? `${r.displayName} (${r.path})` : (why || 'not usable') }) ; return r }
  try {
    const homes = opts.homes || codexHomes(opts)
    const o = { ...opts, homes }
    const pets = listPets(o)
    if (opts.pet) {
      const r = note('--pet', opts.pet, await resolveOverride(opts.pet, pets, o))
      if (r) return r
    }
    if (opts.choice) {
      const r = note('petpack choice (tray)', opts.choice, await resolveOverride(opts.choice, pets, o))
      if (r) return { ...r, source: 'chosen' }
    }
    const sels = selectedPetIds(o)
    if (!sels.length) note('Codex selection', null, null, 'none recorded (app selected-avatar-id, CLI [tui] pet)')
    for (const sel of sels) {
      const r = note(`Codex selection (${sel.from})`, sel.id, await resolveId(sel.id, pets, o, 'selected', sel.home))
      if (r) return r
    }
    const newest = [...pets].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!newest.length) note('custom pets', null, null, 'no pet folders with a sheet')
    for (const c of newest) {
      const r = note('custom pet (newest first)', c.dir, await loadCandidate(c, 'custom'))
      if (r) return r
    }
    // The Codex app shows its default pet ('codex') until you pick another, so that is this person's pet too.
    if (desktopAppPresent(o)) {
      const r = note('Codex app default pet', 'codex', await loadBuiltin('codex', o))
      if (r) return { ...r, source: 'default' }
    } else note('Codex app default pet', null, null, 'Codex desktop app not found')
  } catch {}
  return { ...NO_PET }
}

async function headerAtlas (file, frame) {
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const buf = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const info = imageInfo(buf.subarray(0, bytesRead))
    return atlasFromFrame(info, frame) || atlasOf(info)
  } catch { return null } finally { await fh?.close().catch(() => {}) }
}

// Every pet petpack could show, for the tray picker, `petpack pets` and the demo bots. Never throws.
// -> [{ id, displayName, source: 'custom'|'builtin', path, atlas, available: 'yes'|'download'|'no', why,
//       spriteUrl? }]
//   id is what choosePet()/--pet accept: a custom pet's folder path, or a built-in id.
//   opts.sprites: also load each usable pet's sheet as `spriteUrl` (data URL). Built-ins missing locally are then
//   downloaded from the CDN (opts.fetch !== false) and kept in cacheDir, so the next run is offline.
export async function listPetCandidates (opts = {}) {
  const out = await listPetMeta(opts)
  if (!opts.sprites) return out
  const homes = opts.homes || codexHomes(opts)
  const o = { ...opts, homes }
  await Promise.all(out.map(async (c) => {
    try {
      const r = c.source === 'custom'
        ? await loadCandidate(describeFolder(c.id), 'custom')
        : (c.available !== 'no' ? await loadBuiltin(c.id, o) : null)
      if (r) Object.assign(c, { spriteUrl: r.spriteUrl, atlas: r.atlas, path: r.path, available: 'yes', why: '' })
      else c.spriteUrl = null
    } catch { c.spriteUrl = null }
  }))
  return out
}

async function listPetMeta (opts = {}) {
  const out = []
  try {
    const homes = opts.homes || codexHomes(opts)
    const o = { ...opts, homes }
    for (const c of listPets(o)) {
      let atlas = null; let sheet = null
      for (const f of c.sheets) { atlas = await headerAtlas(f, c.frame); if (atlas) { sheet = f; break } }
      out.push({ id: c.dir, displayName: c.displayName, source: 'custom', path: sheet || c.sheets[0], atlas,
        available: atlas ? 'yes' : 'no', why: atlas ? '' : 'sheet is not an 8x9 or 8x11 grid' })
    }
    const asars = (o.appAsars || appAsarCandidates(o)).filter((a) => rawFs.existsSync(a))
    const cacheDir = o.cacheDir || path.join(os.tmpdir(), 'petpack-pets')
    const ids = new Set([...Object.keys(BUILTIN_PETS), ...builtinIdsInApp({ ...o, appAsars: asars })])
    for (const id of ids) {
      const rx = new RegExp(`^${id}-spritesheet(-v\\d+)?(-[0-9a-f]+)?\\.(webp|png)$`, 'i')
      let where = null
      for (const root of [...homes.map((h) => path.join(h, 'cache', 'tui-pets')), cacheDir]) { where = findInDir(root, rx); if (where) break }
      if (!where) where = asars.find((a) => asarIndex(a)?.sheets[id]) || null
      const display = BUILTIN_PETS[id] || id
      if (where) {
        let atlas = null
        if (where.endsWith('.asar')) { const buf = readFromAsar(where, id); atlas = buf && atlasOf(imageInfo(buf)) } else atlas = await headerAtlas(where)
        out.push({ id, displayName: display, source: 'builtin', path: where, atlas, available: atlas ? 'yes' : 'no', why: '' })
      } else {
        out.push({ id, displayName: display, source: 'builtin', path: `${PET_CDN}/${id}-spritesheet-v4.webp`, atlas: null,
          available: Object.prototype.hasOwnProperty.call(BUILTIN_PETS, id) && id !== 'hoots' && opts.fetch !== false ? 'download' : 'no',
          why: 'not on this machine; downloads from the CDN when chosen' })
      }
    }
  } catch {}
  return out
}

// Every place petpack looks, and whether it exists (for `petpack pets`).
export function checkedPaths (opts = {}) {
  const homes = opts.homes || codexHomes(opts)
  const rows = []
  const add = (p, what) => { let exists = false; try { fs.statSync(p); exists = true } catch {} ; rows.push({ path: p, what, exists }) }
  for (const h of homes) {
    add(h, 'Codex home')
    add(path.join(h, 'config.toml'), 'selection: selected-avatar-id (app), [tui] pet (CLI)')
    add(path.join(h, '.codex-global-state.json'), 'desktop app state (selected-avatar-id)')
    add(path.join(h, 'pets'), 'custom pets: <dir>/pet.json + sheet')
    add(path.join(h, 'avatars'), 'custom pets: <dir>/avatar.json + sheet')
    add(path.join(h, 'cache', 'tui-pets'), 'CLI built-in sheet cache')
  }
  if (opts.cacheDir) add(opts.cacheDir, 'petpack built-in sheet cache')
  for (const a of opts.appAsars || appAsarCandidates(opts)) add(a, 'Codex desktop app bundle (built-in sheets)')
  return rows
}
