#!/usr/bin/env node
// `npx petpack mcp`: a dependency-free stdio MCP server (JSON-RPC 2.0, one JSON message per line).
//
// - Answers `initialize`, `tools/list` and `ping` at once, with no overlay running (Codex's startup timeout is short).
// - On the first `tools/call` it connects to the running overlay over app/mcp/ipc.js; if none is running it launches
//   one detached (bin/petpack.js --from-mcp --detach, or PETPACK_MCP_LAUNCH='["cmd", "arg", ...]') and waits up to 20 s.
// - Each call is forwarded as { tool, args } to the overlay, whose main process hands it to the page's onAgentCall.
// - Logs go to stderr only.
//
// Exports: runMcpServer(opts), main(argv), createMcpServer(opts), TOOLS, installIntoCodex(opts), codexServerCommand(platform).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connectIpc, userDataDir } from './ipc.js'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const LAUNCH_WAIT_MS = 20000
const CALL_BUDGET_MS = 56000
const ONLINE_WAIT_MS = 12000
const ONLINE_POLL_MS = 500
const TEAM_TOOLS = new Set(['petpack_search', 'petpack_get', 'petpack_install', 'petpack_ask'])
const OFFLINE_MESSAGE = 'The team is offline right now; try again in a moment. Carry on solo meanwhile.'

function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
}

const INSTRUCTIONS =
  'petpack puts your Codex agent on a shared map with your team\'s agents (the pets). Their skills, memories, ' +
  'techniques and resources are one commons: before solving something from scratch, or as soon as you are stuck, ' +
  'call petpack_search; read a hit with petpack_get; ask a teammate\'s agent with petpack_ask.'

const KINDS = ['skill', 'memory', 'technique', 'resource']

/** Tool meanings: SCOPE-backend R4. `timeoutMs` is how long the MCP waits for the overlay (Codex's own limit is 60 s). */
export const TOOLS = [
  {
    name: 'petpack_search',
    title: 'Search your team\'s agents',
    description:
      'Search everything your team\'s Codex agents know (skills, memories, techniques and resources from every ' +
      'teammate in your petpack) before solving something from scratch, and whenever you are stuck. Instant and ' +
      'local. Returns [{id, kind, title, summary, owner, online, age}]; read one with petpack_get.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you need, in a few words (e.g. "deploy to azure app service", "pdf tables").' },
        kind: { type: 'string', enum: KINDS, description: 'Only this kind of item.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 30000,
  },
  {
    name: 'petpack_get',
    title: 'Get a teammate\'s item',
    description:
      'Fetch the full text of one item found with petpack_search, by its id, from the teammate who owns it (their ' +
      'pet runs it over to yours). Skills are adopted into your own skills at once. Returns {kind, title, owner, text, installed?}.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The id from petpack_search.' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    timeoutMs: 40000,
  },
  {
    name: 'petpack_install',
    title: 'Keep a teammate\'s item',
    description:
      'Keep a memory, technique or resource from petpack_search in your own Codex for next time: memories and ' +
      'techniques become a note skill, resources an MCP server entry. Returns {installed, path}.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The id from petpack_search.' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    timeoutMs: 40000,
  },
  {
    name: 'petpack_ask',
    title: 'Ask your team\'s agents',
    description:
      'Ask your team\'s agents when petpack_search does not settle it, or you need someone who has done this before. ' +
      'petpack routes the question to the teammate whose agent knows most about it (or to `to`, a name from ' +
      'petpack_status); their agent answers and may hand over a skill or note. Usually answers within 45 s. ' +
      'Returns {answered_by, answer, dot?}.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One clear question with the context a teammate needs.' },
        to: { type: 'string', description: 'A teammate\'s name from petpack_status (optional; default: the best match).' },
        kind: { type: 'string', enum: KINDS, description: 'The kind of help you want back (optional).' },
      },
      required: ['question'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    timeoutMs: 55000,
  },
  {
    name: 'petpack_status',
    title: 'Your petpack',
    description:
      'Who is in your petpack: your team\'s agents on the shared map, where they are (left, right, far, away), what ' +
      'each is doing (idle = free to help, working, waiting = stuck on its person) and how much each knows. Your pet waves at the pack.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 30000,
  },
  {
    name: 'petpack_inbox',
    title: 'Questions for you',
    description: 'Questions your teammates\' agents have asked you that are still open: [{id, from, question}]. Answer with petpack_answer.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 20000,
  },
  {
    name: 'petpack_answer',
    title: 'Answer a teammate',
    description: 'Answer a question from petpack_inbox (the first answer wins). Optionally hand over an item (an id from petpack_search) with it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The question id from petpack_inbox.' },
        text: { type: 'string', description: 'Your answer.' },
        item: { type: 'string', description: 'Optional: an item id to hand over with the answer.' },
      },
      required: ['id', 'text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    timeoutMs: 30000,
  },
]
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]))

function publicTool({ timeoutMs, ...t }) { return t }

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const out = { content: [{ type: 'text', text }] }
  if (isError) out.isError = true
  return out
}

function pkgRoot() { return fileURLToPath(new URL('../../', import.meta.url)) }

/** Start the overlay detached. PETPACK_MCP_LAUNCH (JSON argv) overrides; default `node bin/petpack.js --from-mcp --detach`. */
export function defaultLaunch({ profile, log = () => {} } = {}) {
  let argv
  if (process.env.PETPACK_MCP_LAUNCH) argv = JSON.parse(process.env.PETPACK_MCP_LAUNCH)
  else {
    const bin = path.join(pkgRoot(), 'bin', 'petpack.js')
    if (!fs.existsSync(bin)) throw new Error(`petpack launcher not found at ${bin}`)
    argv = [process.execPath, bin, '--from-mcp', '--detach']
    if (profile) argv.push('--profile', profile)
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  log(`petpack mcp: launching overlay: ${argv.join(' ')}`)
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, env, cwd: os.homedir() })
  child.on('error', (e) => log(`petpack mcp: launch failed: ${e.message}`))
  child.unref()
}

/**
 * The MCP server over any line streams. Options:
 *   input, output     readable / writable streams (default process.stdin / stdout)
 *   profile, userData where the overlay's ipc.json lives (default userDataDir(profile))
 *   launch()          start the overlay (default defaultLaunch)
 *   launchWaitMs      how long the first call waits for the overlay (default 20 s)
 *   onlineWaitMs      how long team tools wait for the overlay to report online (default 12 s;
 *                     env PETPACK_MCP_ONLINE_WAIT_MS). Status polls carry { quiet: true } (no wave, for the brain).
 */
export function createMcpServer({
  input = process.stdin, output = process.stdout, profile, userData, launch, launchWaitMs = LAUNCH_WAIT_MS,
  onlineWaitMs = Number(process.env.PETPACK_MCP_ONLINE_WAIT_MS) || ONLINE_WAIT_MS,
  log = (m) => process.stderr.write(m + '\n'),
} = {}) {
  userData = userData || userDataDir(profile)
  launch = launch || (() => defaultLaunch({ profile, log }))
  const version = pkgVersion()
  let client = null
  let connecting = null
  let launchedAt = 0

  const write = (msg) => { if (output.writable !== false) output.write(JSON.stringify(msg) + '\n') }

  async function tryConnect() {
    try { return await connectIpc({ userData }) } catch (e) { return null }
  }

  function getClient() {
    if (client && !client.closed) return Promise.resolve(client)
    if (connecting) return connecting
    connecting = (async () => {
      let c = await tryConnect()
      if (c) return c
      if (Date.now() - launchedAt > 60000) {
        launchedAt = Date.now()
        try { await launch() } catch (e) {
          throw Object.assign(new Error(`petpack could not start: ${e.message}. Run \`npx petpack\` in a terminal.`), { code: 'ELAUNCH' })
        }
      }
      const deadline = Date.now() + launchWaitMs
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250))
        c = await tryConnect()
        if (c) return c
      }
      throw Object.assign(
        new Error('petpack is starting (the first run downloads Electron, about 120 MB). Call this tool again in a minute.'),
        { code: 'ESTARTING' })
    })().then((c) => {
      client = c
      c.onClose(() => { if (client === c) client = null })
      return c
    }).finally(() => { connecting = null })
    return connecting
  }

  // A cold overlay answers `room: 'solo', online: false` for its first seconds, until the relay connects. Team tools
  // wait (polling status every 500 ms, up to onlineWaitMs) for `me.online`, once per connection. A wait that just
  // timed out isn't repeated for a minute, so an unreachable relay costs one wait, not one per call.
  let onlineClient = null
  let teamWait = null
  let offlineSince = 0
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const isOnline = (st) => !!(st && typeof st === 'object' && st.me && st.me.online === true)

  function waitForTeam(c, deadline) {
    if (onlineClient === c) return Promise.resolve({ online: true })
    if (teamWait && teamWait.c === c) return teamWait.p
    const p = (async () => {
      const skipWait = Date.now() - offlineSince < 60000
      let waitUntil = 0 // starts at the first status reply, so a page that is still loading doesn't eat the wait
      let st = null
      for (;;) {
        const left = deadline - Date.now() - 2000
        if (left <= 0) break
        try {
          st = await c.call('petpack_status', { quiet: true }, { timeoutMs: Math.max(1000, Math.min(left, 30000)) })
        } catch (e) {
          if (e.code === 'ECLOSED') throw e
          st = null
        }
        if (isOnline(st)) { onlineClient = c; return { online: true, status: st } }
        if (!waitUntil) waitUntil = Date.now() + (skipWait ? 0 : onlineWaitMs)
        const until = Math.min(waitUntil, deadline - 2000)
        if (Date.now() >= until) break
        await sleep(Math.min(ONLINE_POLL_MS, until - Date.now())) // the last poll lands at the end of the wait
      }
      offlineSince = Date.now()
      return { online: false, status: st }
    })()
    teamWait = { c, p }
    p.finally(() => { if (teamWait && teamWait.p === p) teamWait = null }).catch(() => {})
    return p
  }

  async function callTool(name, args) {
    const tool = TOOL_MAP.get(name)
    if (!tool) return textResult(`Unknown tool: ${name}`, true)
    args = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    for (const k of tool.inputSchema.required || []) {
      if (args[k] === undefined || args[k] === null || args[k] === '') return textResult(`Missing required argument: ${k}`, true)
    }
    // Always answer inside Codex's 60 s tool timeout, launch and online waits included.
    const deadline = Date.now() + CALL_BUDGET_MS
    for (let attempt = 0; attempt < 2; attempt++) {
      let c
      try { c = await getClient() } catch (e) { return textResult(e.message, true) }
      try {
        if (TEAM_TOOLS.has(name)) {
          const team = await waitForTeam(c, deadline)
          // Still offline: with no peers at all (`offline: true`, or no status) say so plainly. Solo with demo bots
          // still answers from the bots, so the offline `--demo` fallback keeps working.
          if (!team.online && (!team.status || team.status.offline === true)) {
            return textResult({ offline: true, message: OFFLINE_MESSAGE })
          }
        }
        const timeoutMs = Math.max(3000, Math.min(tool.timeoutMs, deadline - Date.now()))
        const result = await c.call(name, args, { timeoutMs })
        if (name === 'petpack_status' && isOnline(result)) onlineClient = c
        return textResult(result ?? { ok: true })
      } catch (e) {
        if (e.code === 'ECLOSED' && attempt === 0) continue // overlay restarted under us: reconnect once
        return textResult(e.message || String(e), true)
      }
    }
    return textResult('petpack connection lost', true)
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return null // responses / junk: ignore
    const isRequest = msg.id !== undefined && msg.id !== null
    const { method, params = {} } = msg
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result })
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
    if (!isRequest) return null // notifications (initialized, cancelled, ...)
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'petpack', title: 'petpack', version },
          instructions: INSTRUCTIONS,
        })
      }
      case 'ping': return reply({})
      case 'tools/list': return reply({ tools: TOOLS.map(publicTool) })
      case 'tools/call': return reply(await callTool(params.name, params.arguments))
      case 'resources/list': return reply({ resources: [] })
      case 'resources/templates/list': return reply({ resourceTemplates: [] })
      case 'prompts/list': return reply({ prompts: [] })
      case 'logging/setLevel': return reply({})
      default: return fail(-32601, `Method not found: ${method}`)
    }
  }

  async function onLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => handle(m).catch((e) => ({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: e.message } }))))).filter(Boolean)
      if (out.length) write(out)
      return
    }
    try {
      const res = await handle(msg)
      if (res) write(res)
    } catch (e) {
      write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message || String(e) } })
    }
  }

  let buf = ''
  let ended
  const done = new Promise((r) => { ended = r })
  input.setEncoding?.('utf8')
  input.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) onLine(line) // concurrent: a slow petpack_ask must not block ping or other calls
    }
  })
  input.on('end', () => {
    if (buf.trim()) onLine(buf.trim())
    ended()
  })

  return {
    done,
    close() { if (client) client.close() },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Codex registration (S1 calls installIntoCodex() on first run; `npx petpack mcp install` runs it by hand).

/** The command Codex runs. On Windows `npx` is a .cmd shim, so it needs `cmd /c`. */
// npm refused the bare name `petpack` (too close to `webpack`), so npx needs the published name from package.json.
export const PKG_NAME = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).name || 'petpack' } catch { return 'petpack' }
})()

export function codexServerCommand(platform = process.platform) {
  const base = ['npx', '-y', PKG_NAME, 'mcp']
  return platform === 'win32' ? ['cmd', '/c', ...base] : base
}

export function codexHomeDir() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex')
}

export function hasPetpackServer(configText) {
  return /^\s*\[\s*mcp_servers\s*\.\s*["']?petpack["']?\s*[\].]/m.test(configText) ||
    /^\s*mcp_servers\s*\.\s*["']?petpack["']?\s*[.=]/m.test(configText)
}

function readText(file) { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }

// Codex 0.166 per-server keys: never prompt for petpack's tools (approval modes: auto|prompt|writes|approve), and
// give a cold `npx -y petpack mcp` more than the 10 s default to start.
const EXTRA_KEYS = 'default_tools_approval_mode = "approve"\nstartup_timeout_sec = 30\n'

/**
 * Idempotently registers petpack as a Codex MCP server.
 * Uses `codex mcp add petpack -- <command>` when the Codex CLI is on PATH, else appends to config.toml.
 * Returns { status: 'already'|'added', via?: 'codex'|'config.toml', path, message }.
 */
export function installIntoCodex({ codexHome = codexHomeDir(), command = codexServerCommand(), useCli = true } = {}) {
  const cfg = path.join(codexHome, 'config.toml')
  const undo = 'undo with `codex mcp remove petpack`'
  if (hasPetpackServer(readText(cfg))) {
    return { status: 'already', path: cfg, message: 'petpack: already in Codex (MCP server "petpack")' }
  }
  fs.mkdirSync(codexHome, { recursive: true }) // codex refuses a CODEX_HOME that doesn't exist
  if (useCli) {
    const r = spawnSync('codex', ['mcp', 'add', 'petpack', '--', ...command], {
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // codex is a .cmd shim from npm on Windows
      timeout: 20000,
      windowsHide: true,
    })
    const after = readText(cfg)
    if (!r.error && r.status === 0 && hasPetpackServer(after)) {
      // A fresh add holds only command/args; keys right after the header belong to that table wherever codex put it.
      const header = /^\s*\[\s*mcp_servers\s*\.\s*["']?petpack["']?\s*\][^\n]*\n/m
      if (header.test(after)) fs.writeFileSync(cfg, after.replace(header, (h) => h + EXTRA_KEYS))
      return { status: 'added', via: 'codex', path: cfg, message: `petpack: added to Codex as an MCP server (${undo})` }
    }
  }
  fs.mkdirSync(codexHome, { recursive: true })
  const prev = readText(cfg)
  const toml = (s) => JSON.stringify(String(s))
  const snippet =
    `${prev && !prev.endsWith('\n') ? '\n' : ''}${prev ? '\n' : ''}[mcp_servers.petpack]\n` +
    `command = ${toml(command[0])}\n` +
    `args = [${command.slice(1).map(toml).join(', ')}]\n` + EXTRA_KEYS
  fs.appendFileSync(cfg, snippet, { mode: 0o600 })
  return { status: 'added', via: 'config.toml', path: cfg, message: `petpack: added to Codex in ${cfg} (${undo})` }
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Serve stdio until stdin ends, then exit. bin/petpack.js calls this as `runMcpServer({ argv, profile, ... })`
 * (it handles `mcp install` itself); `node app/mcp/server.js [--profile p]` works too.
 */
export async function runMcpServer(opts = {}) {
  const server = createMcpServer({ profile: opts.profile || profileFromArgv(opts.argv) })
  await server.done
  server.close()
  process.exit(0)
}

function profileFromArgv(argv = []) {
  const i = argv.indexOf('--profile')
  if (i >= 0) return argv[i + 1]
  const eq = argv.find((a) => typeof a === 'string' && a.startsWith('--profile='))
  return eq ? eq.slice('--profile='.length) : undefined
}

/** `node app/mcp/server.js [mcp] [install] [--profile p]`; also accepts the options object bin/petpack.js passes. */
export async function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv)) return runMcpServer(argv || {})
  const args = argv.filter((a) => a !== 'mcp')
  if (args[0] === 'install') {
    const r = installIntoCodex()
    process.stdout.write(r.message + '\n')
    return r
  }
  return runMcpServer({ argv: args })
}

function isMain() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (process.argv[1] && isMain()) {
  main().catch((e) => { process.stderr.write(`petpack mcp: ${e.stack || e}\n`); process.exit(1) })
}
