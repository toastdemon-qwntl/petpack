// Shell helpers shared by the npx launcher (plain Node) and the Electron main process.
// No Electron imports here: `bin/petpack.js` loads this before Electron exists.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { userDataDir } from './mcp/ipc.js'

export { userDataDir }
export const DEFAULT_RELAY = 'wss://petpack-relay.azurewebsites.net/ws'
const VALUE_FLAGS = new Set(['room', 'seat', 'dock', 'top', 'relay', 'name', 'pet', 'profile', 'smoke', 'pane-scale',
  'smoke-wait'])

/** `--flag value`, `--flag=value` and bare booleans. Unknown flags (Chromium switches) are kept but harmless. */
export function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { rest.push(arg); continue }
    const eq = arg.indexOf('=')
    const key = (eq > 0 ? arg.slice(2, eq) : arg.slice(2)).toLowerCase()
    if (eq > 0) flags[key] = arg.slice(eq + 1)
    else if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i]
    else flags[key] = true
  }
  return { flags, rest }
}

/** The raw profile name; app/mcp/ipc.js cleans it the same way for userData, socket and pipe names. */
export function profileName(flags) {
  return typeof flags.profile === 'string' ? flags.profile.trim() : ''
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------------------------------------------------------
// Codex MCP registration (build B14), on top of S5's idempotent installIntoCodex().

async function mcpServerModule(root) {
  return import(pathToFileURL(path.join(root, 'app', 'mcp', 'server.js')).href)
}

/** The command Codex should run. Under npx it is npx itself; from a checkout or a local install, this exact bin. */
export function mcpServerCommand(root, profile = '', nodePath = process.env.PETPACK_NODE || process.execPath) {
  const tail = profile ? ['--profile', profile] : []
  if (/[\\/]_npx[\\/]/.test(root)) {
    const npx = ['npx', '-y', 'petpack', 'mcp', ...tail]
    return process.platform === 'win32' ? ['cmd', '/c', ...npx] : npx
  }
  const node = /electron/i.test(path.basename(nodePath)) ? 'node' : nodePath
  return [node, path.join(root, 'bin', 'petpack.js'), 'mcp', ...tail]
}

/** 'registered' | 'unregistered', from Codex's config.toml. */
export async function codexMcpState(root) {
  const server = await mcpServerModule(root)
  let text = ''
  try { text = fs.readFileSync(path.join(server.codexHomeDir(), 'config.toml'), 'utf8') } catch {}
  return server.hasPetpackServer(text) ? 'registered' : 'unregistered'
}

/**
 * Register once. Success is remembered in `userData/codex-mcp.json`, so a person who runs `codex mcp remove petpack`
 * is not re-registered on the next launch. `force` (tray Register, `petpack mcp install`) ignores the memory.
 */
export async function registerMcp({ root, profile = '', force = false, log = console.log } = {}) {
  const stateFile = path.join(userDataDir(profile), 'codex-mcp.json')
  if (!force && readJson(stateFile, {}).registered) return { state: 'registered', skipped: true }
  const server = await mcpServerModule(root)
  const command = mcpServerCommand(root, profile)
  let result
  try {
    result = server.installIntoCodex({ command })
  } catch (error) {
    log(`petpack: couldn't add the petpack tools to Codex (${error.message}).`)
    return { state: 'unregistered', error: error.message }
  }
  if (result.status === 'added' || force) log(result.message)
  writeJson(stateFile, { registered: true, at: new Date().toISOString(), command, via: result.via || null })
  return { state: 'registered', ...result }
}
