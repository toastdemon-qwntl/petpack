#!/usr/bin/env node
// `npx petpack` starts the overlay; `npx petpack mcp` is the stdio MCP server; `npx petpack mcp install` registers it.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const argv = process.argv.slice(2)

const HELP = `petpack ${VERSION}: your Codex pet, docked at the edge of your screen in one shared world.

  npx petpack [options]        start the pane (Windows PowerShell: npx.cmd petpack)
  npx petpack mcp              run the MCP server Codex talks to (stdio)
  npx petpack mcp install      register that server with Codex

Options:
  --dock left|right    screen edge to dock to (remembered; default right)
  --room <code>        join a team room (remembered; default: everyone on your network)
  --seat <n>           ask for a seat on the shared map
  --demo               add demo pets so one laptop shows the whole story
  --pet <name>         which Codex pet to bring (default: the one Codex has selected)
  --name <name>        the name shown over your pet
  --relay <url>        relay WebSocket URL (or PETPACK_RELAY)
  --top <percent>      how far down the screen the pane sits (default 20)
  --profile <name>     a separate identity and settings, to run several panes on one machine
  --no-mcp             don't register the petpack tools with Codex
  --no-install         don't install skills other pets share
  --detach             return to the shell while the pane keeps running
`

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major > 22 || (major === 22 && minor >= 12)) return
  console.error(`petpack needs Node.js 22.12 or newer (this is ${process.versions.node}). Get it from https://nodejs.org`)
  process.exit(1)
}

async function loadCli() {
  return import(pathToFileURL(path.join(ROOT, 'app', 'cli.js')).href)
}

// ---------------------------------------------------------------------------------------------------------------
// MCP

async function runMcp(args) {
  const cli = await loadCli()
  const { flags, rest } = cli.parseArgs(args)
  const profile = cli.profileName(flags)
  if (rest[0] === 'install') {
    const result = await cli.registerMcp({ root: ROOT, profile, force: true })
    process.exit(result.state === 'registered' ? 0 : 1)
  }
  const serverFile = path.join(ROOT, 'app', 'mcp', 'server.js')
  if (fs.existsSync(serverFile)) {
    const mod = await import(pathToFileURL(serverFile).href)
    await mod.runMcpServer({ argv: args, profile: profile || undefined })
    return
  }
  // S5's server isn't in this build: answer the handshake so Codex starts cleanly, with no tools.
  console.error('petpack mcp: app/mcp/server.js is missing; serving an empty tool list')
  minimalMcp()
}

function minimalMcp() {
  let buffer = ''
  const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id === undefined) continue
      if (msg.method === 'initialize') {
        reply(msg.id, { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'petpack', version: VERSION } })
      } else if (msg.method === 'tools/list') reply(msg.id, { tools: [] })
      else if (msg.method === 'ping') reply(msg.id, {})
      else process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })}\n`)
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Overlay

function electronDir() {
  return path.dirname(require.resolve('electron/package.json'))
}

/** Windows 11 Smart App Control can block the unzip binding (electron#52481): unzip the cached zip with tar.exe. */
function unzipWithTar() {
  const dir = electronDir()
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const name = `electron-v${version}-win32-${process.arch}.zip`
  const roots = [process.env.electron_config_cache,
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache')].filter(Boolean)
  for (const root of roots) {
    let entries = []
    try { entries = fs.readdirSync(root) } catch { continue }
    for (const sub of ['', ...entries]) {
      const zip = path.join(root, sub, name)
      if (!fs.existsSync(zip)) continue
      const dist = path.join(dir, 'dist')
      fs.mkdirSync(dist, { recursive: true })
      const result = spawnSync('tar.exe', ['-xf', zip, '-C', dist], { stdio: 'inherit', windowsHide: true })
      if (result.status !== 0) return null
      fs.writeFileSync(path.join(dir, 'path.txt'), 'electron.exe')
      return path.join(dist, 'electron.exe')
    }
  }
  return null
}

function resolveElectron() {
  let firstRun = false
  try { firstRun = !fs.existsSync(path.join(electronDir(), 'path.txt')) } catch {}
  if (firstRun) console.log('petpack: first run, fetching Electron (about 120-160 MB, once)...')
  try {
    return require('electron')
  } catch (error) {
    if (process.platform === 'win32') {
      const exe = unzipWithTar()
      if (exe) return exe
    }
    console.error(`petpack: couldn't get Electron: ${error.message}`)
    process.exit(1)
  }
}

/** Linux only: Chromium's setuid sandbox helper is unusable from an npm install, so run without it. */
function needsNoSandbox(electronPath) {
  if (process.platform !== 'linux') return false
  try {
    const helper = fs.statSync(path.join(path.dirname(electronPath), 'chrome-sandbox'))
    return !(helper.uid === 0 && (helper.mode & 0o4000))
  } catch { return true }
}

async function launch(args) {
  const cli = await loadCli()
  const { flags } = cli.parseArgs(args)
  delete process.env.ELECTRON_RUN_AS_NODE
  const electronPath = resolveElectron()
  const extra = needsNoSandbox(electronPath) ? ['--no-sandbox'] : []
  const detach = Boolean(flags.detach)
  const child = spawn(electronPath, [ROOT, ...args, ...extra], {
    stdio: detach ? 'ignore' : 'inherit',
    detached: detach,
    windowsHide: false,
    env: { ...process.env, PETPACK_NODE: process.execPath, PETPACK_ROOT: ROOT },
  })
  const register = flags['no-mcp'] || flags['from-mcp'] || flags.smoke
    ? Promise.resolve()
    : cli.registerMcp({ root: ROOT, profile: cli.profileName(flags) }).catch(() => {})
  if (detach) {
    child.unref()
    await register
    console.log('petpack: running. Quit it from the petpack icon in the menu bar / system tray.')
    process.exit(0)
  }
  let closed = false
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { if (!closed) child.kill(signal) })
  }
  child.on('error', error => { console.error(`petpack: couldn't start Electron: ${error.message}`); process.exit(1) })
  child.on('close', (code, signal) => {
    closed = true
    process.exit(code ?? (signal ? 1 : 0))
  })
}

checkNode()
if (argv[0] === 'mcp') await runMcp(argv.slice(1))
else if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') console.log(HELP)
else if (argv[0] === '--version' || argv[0] === '-v') console.log(VERSION)
else await launch(argv)
