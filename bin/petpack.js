#!/usr/bin/env node
// `npx petpack` starts the pane; `npx petpack mcp` is the stdio MCP server (plain Node, no Electron);
// `npx petpack uninstall` takes petpack back out of Codex and deletes its settings and cache.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = PKG.version
const NPX = `npx ${PKG.name || 'petpack'}` // npm refused the bare name, so people run the scoped one
const DEBUG = Boolean(process.env.PETPACK_DEBUG)
const WIN = process.platform === 'win32'
const argv = process.argv.slice(2)

const HELP = `petpack ${VERSION}: your Codex pet, docked at the edge of your screen in one shared world.

  ${NPX} [options]        start the pane (Windows PowerShell: npx.cmd ${PKG.name})
  ${NPX} mcp              run the MCP server Codex talks to (stdio)
  ${NPX} mcp install      register that server with Codex
  ${NPX} uninstall        remove petpack from Codex and delete its settings (skills it installed stay)

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

const importRoot = rel => import(pathToFileURL(path.join(ROOT, rel)).href)
const loadCli = () => importRoot('app/cli.js')

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
  const mod = await importRoot('app/mcp/server.js')
  await mod.runMcpServer({ argv: args, profile: profile || undefined })
}

// ---------------------------------------------------------------------------------------------------------------
// Uninstall: Codex's MCP entry, the settings folder and the runtime cache. Skills petpack installed stay.

/** config.toml without petpack's tables ([mcp_servers.petpack] and its sub-tables) or dotted keys. */
function withoutPetpackServer(text) {
  const own = /^\s*mcp_servers\s*\.\s*["']?petpack["']?\s*(\.|$)/
  let skipping = false
  const kept = []
  for (const line of text.split('\n')) {
    const header = line.match(/^\s*\[\[?([^\]]*)\]\]?\s*(#.*)?$/)
    if (header) skipping = own.test(header[1])
    else if (!skipping && /^\s*mcp_servers\s*\.\s*["']?petpack["']?\s*[.=]/.test(line)) continue
    if (!skipping) kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}

async function uninstall(args) {
  const cli = await loadCli()
  const { cacheDir } = await import('./runtime.js')
  const server = await importRoot('app/mcp/server.js')
  const { flags } = cli.parseArgs(args)
  const userData = cli.userDataDir(cli.profileName(flags))
  const done = []

  // A running pane would rewrite its settings: quit it first (its pid is in ipc.json).
  const pid = Number(cli.readJson(path.join(userData, 'ipc.json'), {})?.pid)
  if (pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 'SIGTERM')
      for (let i = 0; i < 30; i++) { process.kill(pid, 0); await new Promise(r => setTimeout(r, 100)) }
    } catch {}
  }

  const config = path.join(server.codexHomeDir(), 'config.toml')
  const read = () => { try { return fs.readFileSync(config, 'utf8') } catch { return '' } }
  if (server.hasPetpackServer(read())) {
    spawnSync('codex', ['mcp', 'remove', 'petpack'], { stdio: 'ignore', shell: WIN, timeout: 20000, windowsHide: true })
    if (server.hasPetpackServer(read())) fs.writeFileSync(config, withoutPetpackServer(read()))
    if (server.hasPetpackServer(read())) console.error(`petpack: couldn't remove the petpack entry from ${config}`)
    else done.push('removed petpack from Codex')
  }
  for (const dir of [userData, cacheDir()]) {
    if (!fs.existsSync(dir)) continue
    fs.rmSync(dir, { recursive: true, force: true })
    done.push(`deleted ${dir}`)
  }
  console.log(done.length ? `petpack: ${done.join(', ')}. Skills it installed stay in Codex.` : 'petpack: nothing to remove.')
}

// ---------------------------------------------------------------------------------------------------------------
// The pane

/** Linux only: Chromium's setuid sandbox helper is unusable from an npm install, so run without it. */
function needsNoSandbox(electronPath) {
  if (process.platform !== 'linux') return false
  try {
    const helper = fs.statSync(path.join(path.dirname(electronPath), 'chrome-sandbox'))
    return !(helper.uid === 0 && (helper.mode & 0o4000))
  } catch { return true }
}

async function getRuntime(log) {
  const { resolveRuntime } = await import('./runtime.js')
  try {
    return resolveRuntime({ log })
  } catch (error) {
    console.error(`petpack: couldn't get Electron: ${error.message}`)
    process.exit(1)
  }
}

/** `petpack runtime`: print the Electron executable petpack would run (fetching or unpacking it first if needed). */
async function printRuntime() {
  const runtime = await getRuntime(line => console.error(line))
  console.log(runtime.path)
}

/** Chromium's own chatter goes to stderr; show petpack's lines, and the rest only when the pane fails or PETPACK_DEBUG. */
function filterStderr(stream) {
  const tail = []
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (DEBUG || /^(petpack|\[petpack|\[renderer|Error|TypeError|SyntaxError|ReferenceError)/.test(line)) process.stderr.write(`${line}\n`)
      else { tail.push(line); if (tail.length > 40) tail.shift() }
    }
  })
  return () => { if (buffer) tail.push(buffer); return tail }
}

async function launch(args) {
  const cli = await loadCli()
  const { flags } = cli.parseArgs(args)
  const profile = cli.profileName(flags)
  delete process.env.ELECTRON_RUN_AS_NODE
  const quiet = Boolean(flags.smoke || flags['from-mcp'])
  const detach = Boolean(flags.detach)
  const where = process.platform === 'darwin' ? 'menu bar' : 'system tray'
  if (!quiet && !detach) {
    const saved = cli.readJson(path.join(cli.userDataDir(profile), 'settings.json'), {})?.dock
    const dock = flags.dock === 'left' || flags.dock === 'right' ? flags.dock : saved || 'right'
    console.log(`petpack ${VERSION}: docked ${dock}. Quit from the petpack icon in the ${where}.`)
  }

  const runtime = await getRuntime(line => console.log(line))
  if (flags.smoke || DEBUG) console.log(`petpack: runtime ${runtime.source} (Electron ${runtime.electron || '?'}) ${runtime.path}`)
  const extra = needsNoSandbox(runtime.path) ? ['--no-sandbox'] : []
  const child = spawn(runtime.path, [ROOT, ...args, ...extra], {
    stdio: detach ? 'ignore' : ['inherit', 'inherit', 'pipe'],
    detached: detach,
    windowsHide: false,
    env: { ...process.env, PETPACK_NODE: process.execPath, PETPACK_ROOT: ROOT },
  })
  const register = flags['no-mcp'] || flags['from-mcp'] || flags.smoke
    ? Promise.resolve()
    : cli.registerMcp({ root: ROOT, profile, log: () => {} })
      .then(result => {
        if (result.status === 'added') console.log(`petpack: added to Codex as the MCP server "petpack" (${NPX} uninstall removes it).`)
        else if (result.error) console.log(`petpack: couldn't add petpack to Codex (${result.error}).`)
      })
      .catch(() => {})
  if (detach) {
    child.unref()
    await register
    if (!flags['from-mcp']) console.log(`petpack ${VERSION}: running. Quit from the petpack icon in the ${where}.`)
    process.exit(0)
  }
  const stderrTail = filterStderr(child.stderr)
  let closed = false
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { stopping = true; if (!closed) child.kill(signal) })
  }
  child.on('error', error => { console.error(`petpack: couldn't start Electron: ${error.message}`); process.exit(1) })
  child.on('close', async (code, signal) => {
    closed = true
    const status = code ?? (signal ? 1 : 0)
    if (status !== 0 && !stopping && !signal && !DEBUG) { // a crash, not Ctrl+C: show what Electron said
      const tail = stderrTail()
      if (tail.length) console.error(tail.join('\n'))
    }
    await register
    process.exit(status)
  })
}

checkNode()
if (argv[0] === 'mcp') await runMcp(argv.slice(1))
else if (argv[0] === 'uninstall') await uninstall(argv.slice(1))
else if (argv[0] === 'runtime') await printRuntime()
else if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') console.log(HELP)
else if (argv[0] === '--version' || argv[0] === '-v') console.log(VERSION)
else await launch(argv)
