// What your pet may share (TRAY lane). Plain Node, no Electron: main, the tray popover and the catalog (L3b) read it.
//
// File: <userData>/sharing.json
//   { "mode": "free" | "ask" | "off",   free: share anything not hidden (default); ask: ask the person first; off: nothing
//     "hidden": ["skill:foo", ...],     catalog refs the person switched off in the popover
//     "dnd": false }                    Do Not Disturb: pane tucked, pet stays home, asks go unanswered, sounds off
//
// readSharing(userData) -> { mode, hidden, dnd }       never throws; defaults when the file is missing or broken
// writeSharing(userData, patch) -> the merged value    writes atomically
// shareable(items, sharing) -> items the room may see  (mode 'off' -> []; hidden refs dropped; 'ask' keeps them)
// mayShare(ref, sharing) -> 'yes' | 'ask' | 'no'       per item, for an incoming request

import fs from 'node:fs'
import path from 'node:path'

export const MODES = ['free', 'ask', 'off']
export const DEFAULT_SHARING = Object.freeze({ mode: 'free', hidden: [], dnd: false })

export function sharingFile (userData) { return path.join(userData, 'sharing.json') }

export function normalizeSharing (value) {
  const v = value && typeof value === 'object' ? value : {}
  return {
    mode: MODES.includes(v.mode) ? v.mode : 'free',
    hidden: Array.isArray(v.hidden) ? [...new Set(v.hidden.filter(r => typeof r === 'string' && r))] : [],
    dnd: v.dnd === true,
  }
}

export function readSharing (userData) {
  if (!userData) return { ...DEFAULT_SHARING, hidden: [] }
  try { return normalizeSharing(JSON.parse(fs.readFileSync(sharingFile(userData), 'utf8'))) } catch { return normalizeSharing(null) }
}

export function writeSharing (userData, patch = {}) {
  const next = normalizeSharing({ ...readSharing(userData), ...patch })
  const file = sharingFile(userData)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return next
}

export function mayShare (ref, sharing = DEFAULT_SHARING) {
  const s = normalizeSharing(sharing)
  if (s.mode === 'off' || s.hidden.includes(ref)) return 'no'
  return s.mode === 'ask' ? 'ask' : 'yes'
}

export function shareable (items, sharing = DEFAULT_SHARING) {
  const s = normalizeSharing(sharing)
  if (!Array.isArray(items) || s.mode === 'off') return []
  const hidden = new Set(s.hidden)
  return items.filter(item => item && !hidden.has(item.ref))
}
