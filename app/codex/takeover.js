// One pet on screen: while petpack runs, Codex's own floating pet is switched off and petpack shows that same pet.
// Plain Node, no Electron.
//
// takeOverPet({ homes?, markerFile }) -> { ok, changed: [..], marker }
//   Remembers the person's settings in markerFile (first takeover wins, so repeats and crashes never overwrite the
//   originals), then per Codex home with a config.toml:
//     desktop app: [desktop] avatar-overlay-pet-visible = false  (config.toml; the app's settings store reads the
//                  [desktop] table) and "electron-avatar-overlay-open": false in .codex-global-state.json (the app
//                  re-opens the overlay at launch when this is true)
//     CLI:         [tui] pet = "disabled", only when a CLI pet was set
//   The selected pet ids are left alone ([desktop] selected-avatar-id untouched; the CLI's [tui] pet is kept in the
//   marker, and selectedPetIds() reads it from there while petpack holds the pet).
// releasePet({ markerFile }) -> { ok, restored: [..] }   puts back exactly what was there and deletes the marker.
//   Idempotent; no marker means nothing to do. A marker left by a crash is restored by the next releasePet() (or
//   kept as the originals by the next takeOverPet()).
// takeoverState(markerFile) -> marker | null
// The Codex app reads these when it starts; a running app may keep its overlay until it restarts or rewrites the
// state file.

import fs from 'node:fs'
import path from 'node:path'
import { codexHomes } from './home.js'

const DESKTOP_KEY = 'avatar-overlay-pet-visible'
const OVERLAY_OPEN = 'electron-avatar-overlay-open'

function readText (file) { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
function writeAtomic (file, text) {
  const tmp = `${file}.petpack-${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

// Locate `key = ...` inside `[table]` (exact header). -> { lines, header (index|-1), at (index|-1), end (index) }
function findKey (text, table, key) {
  const lines = text.split('\n')
  let header = -1; let end = lines.length; let at = -1
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    const h = t.match(/^\[\s*([^\][]+?)\s*\]\s*(#.*)?$/)
    if (h) {
      if (header >= 0) { end = i; break }
      if (h[1].replace(/"/g, '') === table) header = i
      continue
    }
    if (header >= 0 && at < 0) {
      const k = t.match(/^("?)([A-Za-z0-9_-]+)\1\s*=/)
      if (k && k[2] === key) at = i
    }
  }
  return { lines, header, at, end }
}

// Set key in table; returns { text, original: raw line | null, createdTable }
export function setTomlKey (text, table, key, valueToml) {
  const src = text ?? ''
  const { lines, header, at, end } = findKey(src, table, key)
  const line = `${key} = ${valueToml}`
  if (at >= 0) {
    const original = lines[at]
    lines[at] = line
    return { text: lines.join('\n'), original, createdTable: false }
  }
  if (header >= 0) {
    lines.splice(header + 1, 0, line)
    return { text: lines.join('\n'), original: null, createdTable: false }
  }
  const base = src.length && !src.endsWith('\n') ? src + '\n' : src
  return { text: `${base}${base.trim() ? '\n' : ''}[${table}]\n${line}\n`, original: null, createdTable: true }
}

// Undo setTomlKey: restore the original line, or remove ours (and the table if we made it and it's now empty).
export function restoreTomlKey (text, table, key, original, createdTable) {
  if (text == null) return text
  const { lines, header, at, end } = findKey(text, table, key)
  if (at < 0) return text
  if (original != null) { lines[at] = original; return lines.join('\n') }
  lines.splice(at, 1)
  if (createdTable && header >= 0) {
    const body = lines.slice(header + 1, end - 1).filter((l) => l.trim() && !l.trim().startsWith('#'))
    if (!body.length) {
      lines.splice(header, end - 1 - header)
    }
  }
  return lines.join('\n')
}

function tuiPetValue (text) {
  const { lines, at } = findKey(text || '', 'tui', 'pet')
  if (at < 0) return null
  const m = lines[at].match(/=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/)
  return m ? (m[1] ?? m[2]) : null
}

export function takeoverState (markerFile) {
  try { return JSON.parse(fs.readFileSync(markerFile, 'utf8')) } catch { return null }
}

export function takeOverPet (opts = {}) {
  const markerFile = opts.markerFile
  if (!markerFile) return { ok: false, changed: [], reason: 'no marker file' }
  const homes = (opts.homes || codexHomes(opts)).filter((h) => fs.existsSync(path.join(h, 'config.toml')) || fs.existsSync(path.join(h, '.codex-global-state.json')))
  const marker = takeoverState(markerFile) || { version: 1, at: new Date().toISOString(), homes: {} }
  marker.pid = process.pid
  const changed = []
  try {
    for (const home of homes) {
      const saved = marker.homes[home] || (marker.homes[home] = {})
      const cfgFile = path.join(home, 'config.toml')
      let cfg = readText(cfgFile)
      if (cfg != null) {
        if (!saved.desktop) {
          const r = setTomlKey(cfg, 'desktop', DESKTOP_KEY, 'false')
          saved.desktop = { original: r.original, createdTable: r.createdTable }
          cfg = r.text
        } else cfg = setTomlKey(cfg, 'desktop', DESKTOP_KEY, 'false').text
        const pet = tuiPetValue(cfg)
        if (!saved.tui && pet && pet !== 'disabled') {
          const r = setTomlKey(cfg, 'tui', 'pet', '"disabled"')
          saved.tui = { original: r.original, createdTable: r.createdTable, pet }
          cfg = r.text
        } else if (saved.tui) cfg = setTomlKey(cfg, 'tui', 'pet', '"disabled"').text
        if (cfg !== readText(cfgFile)) { writeAtomic(cfgFile, cfg); changed.push(cfgFile) }
      }
      const gsFile = path.join(home, '.codex-global-state.json')
      const gsText = readText(gsFile)
      if (gsText != null) {
        let gs = null
        try { gs = JSON.parse(gsText) } catch {}
        if (gs && typeof gs === 'object') {
          if (!saved.overlay) saved.overlay = { present: Object.prototype.hasOwnProperty.call(gs, OVERLAY_OPEN), value: gs[OVERLAY_OPEN] ?? null }
          if (gs[OVERLAY_OPEN] !== false) { gs[OVERLAY_OPEN] = false; writeAtomic(gsFile, JSON.stringify(gs)); changed.push(gsFile) }
        }
      }
    }
    fs.mkdirSync(path.dirname(markerFile), { recursive: true })
    writeAtomic(markerFile, JSON.stringify(marker, null, 2) + '\n')
    return { ok: true, changed, marker }
  } catch (err) {
    return { ok: false, changed, reason: String(err && err.message ? err.message : err) }
  }
}

export function releasePet (opts = {}) {
  const markerFile = opts.markerFile
  const marker = markerFile && takeoverState(markerFile)
  if (!marker) return { ok: true, restored: [] }
  const restored = []
  try {
    for (const [home, saved] of Object.entries(marker.homes || {})) {
      const cfgFile = path.join(home, 'config.toml')
      let cfg = readText(cfgFile)
      if (cfg != null) {
        const before = cfg
        if (saved.desktop) cfg = restoreTomlKey(cfg, 'desktop', DESKTOP_KEY, saved.desktop.original, saved.desktop.createdTable)
        if (saved.tui && tuiPetValue(cfg) === 'disabled') cfg = restoreTomlKey(cfg, 'tui', 'pet', saved.tui.original, saved.tui.createdTable)
        if (cfg !== before) { writeAtomic(cfgFile, cfg); restored.push(cfgFile) }
      }
      const gsFile = path.join(home, '.codex-global-state.json')
      const gsText = readText(gsFile)
      if (gsText != null && saved.overlay) {
        try {
          const gs = JSON.parse(gsText)
          if (saved.overlay.present) gs[OVERLAY_OPEN] = saved.overlay.value
          else delete gs[OVERLAY_OPEN]
          writeAtomic(gsFile, JSON.stringify(gs))
          restored.push(gsFile)
        } catch {}
      }
    }
    fs.rmSync(markerFile, { force: true })
    return { ok: true, restored }
  } catch (err) {
    return { ok: false, restored, reason: String(err && err.message ? err.message : err) }
  }
}

// The CLI pet petpack set aside, per home: { [home]: '<original [tui] pet value>' }
export function heldTuiPets (markerFile) {
  const m = markerFile && takeoverState(markerFile)
  const out = {}
  for (const [home, saved] of Object.entries(m?.homes || {})) if (saved.tui?.pet) out[home] = saved.tui.pet
  return out
}
