// Automatic Codex registration: every launch makes sure each Codex config petpack can see lists the petpack MCP
// server, for the Codex CLI and the Codex desktop app alike (the app users often have no `codex` on PATH).
//
// - Targets: ${CODEX_HOME}, %USERPROFILE%\.codex (Windows) and ~/.codex, each `<home>/config.toml`.
// - Writes `[mcp_servers.petpack]` by appending a block: every byte already in the file stays as it was.
// - When the `codex` CLI is on PATH, it checks Codex reads the result (`codex mcp get petpack --json`); if not, it
//   puts the file back and lets `codex mcp add` write it instead.
// - A marker (`<userData>/codex-register.json`) remembers which files petpack wrote. If one of those later lacks the
//   entry, the person ran `codex mcp remove petpack`, and that sticks; `force` (tray Register, `mcp install`) re-adds.
// - A block petpack wrote earlier that is still byte-identical is upgraded in place when the command changes.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const SERVER_NAME = 'petpack'
const MARKER = 'codex-register.json'

export function hasPetpackServer(configText) {
  return /^\s*\[\s*mcp_servers\s*\.\s*["']?petpack["']?\s*[\].]/m.test(configText || '') ||
    /^\s*mcp_servers\s*\.\s*["']?petpack["']?\s*[.=]/m.test(configText || '')
}

/** Codex homes petpack registers in, primary first (same order as app/codex/home.js codexHomes). */
export function codexConfigTargets({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const out = []
  const push = (p, primary) => {
    if (!p) return
    const abs = path.resolve(p.replace(/^~(?=$|[\\/])/, homedir))
    const key = platform === 'win32' ? abs.toLowerCase() : abs
    if (out.some((o) => (platform === 'win32' ? o.home.toLowerCase() : o.home) === key)) return
    out.push({ home: abs, file: path.join(abs, 'config.toml'), primary: primary && !out.length })
  }
  push(env.CODEX_HOME, true)
  if (platform === 'win32' && env.USERPROFILE) push(path.join(env.USERPROFILE, '.codex'), true)
  push(path.join(homedir, '.codex'), true)
  return out
}

function readText(file) { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

/**
 * The node the MCP command will need: PETPACK_NODE (set by bin for Electron), else this process when it is node.
 * GUI apps on macOS start with PATH=/usr/bin:/bin:..., so the entry carries PATH and an absolute npx.
 */
function nodeDir(env = process.env) {
  const p = env.PETPACK_NODE || (/electron/i.test(path.basename(process.execPath)) ? '' : process.execPath)
  return p ? path.dirname(p) : ''
}

export function resolveCommand(command, { platform = process.platform, env = process.env } = {}) {
  const cmd = [...command]
  let pathEnv = null
  if (platform !== 'win32') {
    const dir = nodeDir(env)
    if (dir && cmd[0] === 'npx' && fs.existsSync(path.join(dir, 'npx'))) cmd[0] = path.join(dir, 'npx')
    if (dir && cmd[0] === 'node' && fs.existsSync(path.join(dir, 'node'))) cmd[0] = path.join(dir, 'node')
    const dirs = [dir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean)
    pathEnv = [...new Set(dirs)].join(':')
  }
  return { command: cmd, pathEnv }
}

export function blockFor(command, pathEnv, eol = '\n') {
  const toml = (s) => JSON.stringify(String(s))
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${toml(command[0])}`,
    `args = [${command.slice(1).map(toml).join(', ')}]`,
    'default_tools_approval_mode = "approve"',
    'startup_timeout_sec = 30',
  ]
  if (pathEnv) lines.push(`env = { PATH = ${toml(pathEnv)} }`)
  return lines.join(eol) + eol
}

function codexCli(args, home) {
  const r = spawnSync('codex', args, {
    env: { ...process.env, CODEX_HOME: home },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, windowsHide: true,
    shell: process.platform === 'win32', // npm's codex is a .cmd shim
  })
  return { ok: !r.error && r.status === 0, out: r.stdout || '', err: r.stderr || (r.error && r.error.message) || '' }
}

export function codexOnPath() {
  const r = spawnSync('codex', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, shell: process.platform === 'win32', windowsHide: true })
  return !r.error && r.status === 0 ? (r.stdout || '').trim() || 'codex' : null
}

/**
 * Make every target list petpack. Returns
 *   { state: 'registered'|'unregistered', added: bool, results: [{ file, status, via? }], message }
 * status: 'present' | 'added' | 'updated' | 'removed-by-user' | 'skipped' (home missing) | 'error'.
 */
export function ensureCodexRegistration({
  command, userData, force = false, useCli = true, targets = codexConfigTargets(), log = () => {},
  platform = process.platform, env = process.env,
} = {}) {
  if (!Array.isArray(command) || !command.length) throw new TypeError('ensureCodexRegistration: command is required')
  const markerFile = userData ? path.join(userData, MARKER) : null
  const marker = (markerFile && readJson(markerFile)) || { files: {} }
  marker.files = marker.files || {}
  const resolved = resolveCommand(command, { platform, env })
  const cli = useCli ? codexOnPath() : null
  const results = []

  targets.forEach((t, i) => {
    try {
      const text = readText(t.file)
      const homeExists = fs.existsSync(t.home)
      if (!homeExists && i > 0) { results.push({ file: t.file, status: 'skipped' }); return }
      const eol = text && text.includes('\r\n') ? '\r\n' : '\n'
      const block = blockFor(resolved.command, resolved.pathEnv, eol)
      const mine = marker.files[t.file]

      if (hasPetpackServer(text)) {
        if (mine && mine.block && mine.block !== block && text.includes(mine.block)) {
          fs.writeFileSync(t.file, text.replace(mine.block, block))
          marker.files[t.file] = { block, at: new Date().toISOString() }
          results.push({ file: t.file, status: 'updated', via: 'config.toml' })
        } else {
          results.push({ file: t.file, status: 'present' })
        }
        return
      }
      if (mine && text !== null && !force) { results.push({ file: t.file, status: 'removed-by-user' }); return }

      fs.mkdirSync(t.home, { recursive: true })
      const sep = text ? (text.endsWith('\n') ? (text.endsWith(eol + eol) ? '' : eol) : eol + eol) : ''
      fs.appendFileSync(t.file, sep + block, { mode: 0o600 })
      let via = 'config.toml'
      let wrote = block
      if (cli && !codexCli(['mcp', 'get', SERVER_NAME, '--json'], t.home).ok) {
        // Codex can't read what we appended: restore the file byte for byte and let the CLI write the entry.
        if (text === null) fs.rmSync(t.file, { force: true }); else fs.writeFileSync(t.file, text)
        const envArgs = resolved.pathEnv ? ['--env', `PATH=${resolved.pathEnv}`] : []
        if (codexCli(['mcp', 'add', SERVER_NAME, ...envArgs, '--', ...resolved.command], t.home).ok) {
          via = 'codex'
          wrote = null
        } else {
          fs.appendFileSync(t.file, sep + block, { mode: 0o600 }) // the config was unreadable before us; keep ours
        }
      }
      marker.files[t.file] = { block: wrote, at: new Date().toISOString() }
      results.push({ file: t.file, status: 'added', via })
    } catch (e) {
      results.push({ file: t.file, status: 'error', error: e.message })
    }
  })

  if (markerFile) {
    try { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2)) } catch {}
  }
  const registered = results.some((r) => ['present', 'added', 'updated'].includes(r.status))
  const added = results.some((r) => r.status === 'added' || r.status === 'updated')
  const message = added
    ? 'petpack: connected to Codex (new Codex sessions load it; restart the Codex app if it is open). `codex mcp remove petpack` undoes it.'
    : registered ? '' : results.some((r) => r.status === 'removed-by-user')
      ? 'petpack: not in Codex (you removed it; `npx @qwntllabs/petpack mcp install` adds it back).'
      : `petpack: couldn't add itself to Codex (${results.map((r) => r.error).filter(Boolean).join('; ') || 'no Codex config'}).`
  if (message) log(message)
  return { state: registered ? 'registered' : 'unregistered', added, results, message }
}

/** Per-file registration status for doctor/tray, without writing anything. */
export function registrationStatus({ userData, targets = codexConfigTargets() } = {}) {
  const marker = (userData && readJson(path.join(userData, MARKER))) || { files: {} }
  return targets.map((t) => {
    const text = readText(t.file)
    const status = hasPetpackServer(text) ? 'registered'
      : marker.files?.[t.file] && text !== null ? 'removed-by-user'
        : fs.existsSync(t.home) ? 'missing' : 'no-codex-home'
    return { home: t.home, file: t.file, status }
  })
}
