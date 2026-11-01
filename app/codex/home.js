// Codex home resolution (main-process Node only; no Electron imports).
//
// codexHomes(opts) -> string[]  every place this machine's Codex may keep its data, most authoritative first:
//   1. $CODEX_HOME (when set; `~` expanded)
//   2. on Windows, %USERPROFILE%\.codex (the Windows Codex app ignores CODEX_HOME, openai/codex#34070)
//   3. <os.homedir()>/.codex
// codexHome(opts)  -> string    the primary home: the first candidate that exists, else the first candidate.
//                                Installs go here; readers (pets, skills, status) look at every existing candidate.
// existingHomes(opts) -> string[] the candidates that exist on disk (may be empty).
//
// opts: { env = process.env, platform = process.platform, homedir = os.homedir(), home } (`home` pins one path,
// used by tests and by `--codex-home`).

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

function expand (p, homedir) {
  if (!p) return null
  let s = String(p).trim()
  if (!s) return null
  if (s === '~') s = homedir
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(homedir, s.slice(2))
  return path.resolve(s)
}

export function codexHomes (opts = {}) {
  const env = opts.env || process.env
  const platform = opts.platform || process.platform
  const homedir = opts.homedir || safeHomedir()
  if (opts.home) return [path.resolve(opts.home)]
  const out = []
  const push = (p) => {
    const e = expand(p, homedir)
    if (!e) return
    const key = platform === 'win32' ? e.toLowerCase() : e
    if (!out.some((o) => (platform === 'win32' ? o.toLowerCase() : o) === key)) out.push(e)
  }
  push(env.CODEX_HOME)
  if (platform === 'win32' && env.USERPROFILE) push(path.join(env.USERPROFILE, '.codex'))
  if (homedir) push(path.join(homedir, '.codex'))
  return out
}

export function existingHomes (opts = {}) {
  return codexHomes(opts).filter(isDir)
}

export function codexHome (opts = {}) {
  const all = codexHomes(opts)
  return all.find(isDir) || all[0]
}

export function isDir (p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function safeHomedir () {
  try { return os.homedir() } catch { return process.env.HOME || process.env.USERPROFILE || '.' }
}

// ~/.agents/skills is the cross-agent skills folder Codex also reads.
export function agentsSkillsDir (opts = {}) {
  const homedir = opts.homedir || safeHomedir()
  return path.join(homedir, '.agents', 'skills')
}
