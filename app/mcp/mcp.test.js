// node --test app/mcp/mcp.test.js
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startIpcServer, connectIpc, endpointFor, readIpcInfo, ipcInfoPath, pidAlive } from './ipc.js'
import { createMcpServer, installIntoCodex, TOOLS, PKG_NAME } from './server.js'
import { ensureCodexRegistration, registrationStatus, hasPetpackServer, codexOnPath } from './register.js'
import { createCodexLink, lastCodexConnection } from './link.js'
import { runDoctor } from './doctor.js'
import { PassThrough } from 'node:stream'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(here, 'server.js')
const FAKE = path.join(here, 'fake-overlay.js')
const cleanups = []
after(async () => { for (const c of cleanups.reverse()) { try { await c() } catch {} } })

let n = 0
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-mcp-test-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { userData: path.join(dir, 'ud'), profile: `t${process.pid}x${++n}`, dir }
}

/** A JSON-RPC client over a child `node server.js` (the real stdio entry), or any other argv (e.g. the bin). */
function mcpChild({ userData, profile, env = {}, argv = [SERVER] }) {
  const child = spawn(process.execPath, argv, {
    env: { ...process.env, PETPACK_USER_DATA: userData, PETPACK_PROFILE: profile, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  cleanups.push(() => child.kill())
  const waiting = new Map()
  let buf = ''
  let id = 0
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      waiting.get(msg.id)?.(msg)
      waiting.delete(msg.id)
    }
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const request = (method, params) => new Promise((resolve) => {
    const rid = ++id
    waiting.set(rid, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
  })
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  const callTool = async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result
  return { child, request, notify, callTool, stderr: () => stderr }
}

async function init(c) {
  const r = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  c.notify('notifications/initialized')
  return r
}

const parse = (res) => JSON.parse(res.content[0].text)

test('initialize and tools/list answer at once with no overlay running', async () => {
  const { userData, profile } = fixture()
  const c = mcpChild({ userData, profile, env: { PETPACK_MCP_LAUNCH: JSON.stringify(['false']) } })
  const t0 = Date.now()
  const r = await init(c)
  const ms = Date.now() - t0
  assert.ok(ms < 1000, `initialize took ${ms} ms`)
  assert.equal(r.result.serverInfo.name, 'petpack')
  assert.equal(r.result.protocolVersion, '2025-06-18')
  assert.ok(r.result.capabilities.tools)
  const list = await c.request('tools/list', {})
  const names = list.result.tools.map((t) => t.name)
  for (const t of ['petpack_status', 'petpack_search', 'petpack_get', 'petpack_install', 'petpack_ask']) assert.ok(names.includes(t), t)
  for (const t of list.result.tools) {
    assert.equal(t.inputSchema.type, 'object')
    assert.equal(t.timeoutMs, undefined)
  }
  assert.match(list.result.tools.find((t) => t.name === 'petpack_search').description, /before solving something from scratch/)
  assert.deepEqual((await c.request('ping', {})).result, {})
  assert.equal((await c.request('nope/nope', {})).error.code, -32601)
})

test('tools/call round trips through the IPC to the overlay (fake onAgentCall)', async () => {
  const { userData, profile } = fixture()
  const calls = []
  const ipc = await startIpcServer({
    userData, profile, version: 'test',
    onCall: async ({ tool, args }) => {
      calls.push({ tool, args })
      if (tool === 'petpack_status') return { room: 'r1', me: { name: 'me', online: true }, peers: [{ name: 'Rex', where: 'right', status: 'idle' }] }
      if (tool === 'petpack_search') return [{ id: 'rex/skill:pdf', kind: 'skill', title: 'pdf', owner: 'Rex', online: true }]
      throw new Error('Rex is away (last seen 14:02)')
    },
  })
  cleanups.push(() => ipc.close())
  const info = readIpcInfo(userData)
  assert.equal(info.endpoint, ipc.endpoint)
  if (process.platform !== 'win32') assert.equal(fs.statSync(ipcInfoPath(userData)).mode & 0o777, 0o600)

  const c = mcpChild({ userData, profile })
  await init(c)
  await c.request('tools/list', {})
  const status = await c.callTool('petpack_status')
  assert.equal(status.isError, undefined)
  assert.equal(parse(status).peers[0].name, 'Rex')
  const search = await c.callTool('petpack_search', { query: 'pdf tables', limit: 2 })
  assert.equal(parse(search)[0].id, 'rex/skill:pdf')
  const get = await c.callTool('petpack_get', { id: 'rex/skill:pdf' })
  assert.equal(get.isError, true)
  assert.match(get.content[0].text, /Rex is away/)
  const missing = await c.callTool('petpack_ask', {})
  assert.equal(missing.isError, true)
  assert.deepEqual(calls, [
    { tool: 'petpack_status', args: {} },
    { tool: 'petpack_search', args: { query: 'pdf tables', limit: 2 } },
    { tool: 'petpack_get', args: { id: 'rex/skill:pdf' } },
  ])
})

const BIN = path.join(here, '..', '..', 'bin', 'petpack.js')
test('`petpack mcp` through bin/petpack.js reaches the overlay', { skip: !fs.existsSync(BIN) && 'no bin yet' }, async () => {
  const { userData, profile } = fixture()
  const ipc = await startIpcServer({ userData, profile, onCall: ({ tool, args }) => (tool === 'petpack_status' ? { me: { online: true } } : { via: 'bin', tool, args }) })
  cleanups.push(() => ipc.close())
  const c = mcpChild({ userData, profile, argv: [BIN, 'mcp'] })
  const r = await init(c)
  assert.equal(r.result.serverInfo.name, 'petpack')
  const res = await c.callTool('petpack_search', { query: 'pdf' })
  assert.deepEqual(parse(res), { via: 'bin', tool: 'petpack_search', args: { query: 'pdf' } })
})

function rawFrames(endpoint) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint)
    const got = []
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
    })
    sock.on('connect', () => resolve({ sock, got, send: (o) => sock.write(JSON.stringify(o) + '\n'),
      closed: new Promise((r) => sock.on('close', r)) }))
    sock.on('error', reject)
  })
}

test('the token is required: calls without it or with a wrong one are refused', async () => {
  const { userData, profile } = fixture()
  let called = 0
  const ipc = await startIpcServer({ userData, profile, onCall: () => { called++; return { ok: true } } })
  cleanups.push(() => ipc.close())

  const a = await rawFrames(ipc.endpoint)
  a.send({ t: 'call', id: 1, tool: 'petpack_status', args: {} })
  await a.closed
  assert.equal(a.got[0].t, 'denied')
  assert.equal(a.got.some((f) => f.t === 'result'), false)

  const b = await rawFrames(ipc.endpoint)
  b.send({ t: 'hello', token: 'f'.repeat(64) })
  b.send({ t: 'call', id: 2, tool: 'petpack_status', args: {} })
  await b.closed
  assert.equal(b.got[0].t, 'denied')
  assert.equal(called, 0)

  const ok = await rawFrames(ipc.endpoint)
  ok.send({ t: 'hello', token: readIpcInfo(userData).token })
  ok.send({ t: 'call', id: 3, tool: 'petpack_status', args: {} })
  await new Promise((r) => setTimeout(r, 200))
  ok.sock.destroy()
  assert.equal(ok.got[0].t, 'welcome')
  assert.deepEqual(ok.got[1], { t: 'result', id: 3, ok: true, result: { ok: true } })
  assert.equal(called, 1)
})

test('a stale socket and a stale ipc.json are recovered', { skip: process.platform === 'win32' }, async () => {
  const { userData, profile } = fixture()
  const endpoint = endpointFor(profile)
  // A crashed overlay: a process that listened on the endpoint and was SIGKILLed leaves the socket file behind.
  const crashed = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(endpoint)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((r) => crashed.stdout.once('data', r))
  crashed.kill('SIGKILL')
  await new Promise((r) => crashed.once('exit', r))
  assert.ok(fs.existsSync(endpoint), 'stale socket file left behind')
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(ipcInfoPath(userData), JSON.stringify({ endpoint, token: 'old', pid: crashed.pid }))
  // The MCP side sees "not running" (no hang, no crash).
  await assert.rejects(connectIpc({ userData }), (e) => e.code === 'ENOOVERLAY')

  // A fresh overlay removes the stale socket and takes over; the MCP's first call reaches it.
  let launches = 0
  let ipc
  const input = new PassThrough()
  const output = new PassThrough()
  const server = createMcpServer({
    input, output, userData, log: () => {},
    launch: async () => {
      launches++
      ipc = await startIpcServer({ userData, profile, onCall: ({ tool }) => ({ tool, fresh: true }) })
      cleanups.push(() => ipc.close())
    },
  })
  cleanups.push(() => server.close())
  const reply = new Promise((resolve) => output.once('data', (d) => resolve(JSON.parse(d))))
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'petpack_status', arguments: {} } }) + '\n')
  const res = await reply
  assert.deepEqual(JSON.parse(res.result.content[0].text), { tool: 'petpack_status', fresh: true })
  assert.equal(launches, 1)
  assert.notEqual(readIpcInfo(userData).token, 'old')

  // A live overlay is never stolen from.
  await assert.rejects(startIpcServer({ userData, profile, onCall: () => 1 }), (e) => e.code === 'EADDRINUSE')
})

test('the first tool call launches the overlay; two MCP processes share it', async () => {
  const { userData, profile } = fixture()
  const env = { PETPACK_MCP_LAUNCH: JSON.stringify([process.execPath, FAKE, '--profile', profile]) }
  const a = mcpChild({ userData, profile, env })
  const b = mcpChild({ userData, profile, env })
  await Promise.all([init(a), init(b)])
  assert.equal(readIpcInfo(userData), null)
  const [ra, rb] = await Promise.all([a.callTool('petpack_status'), b.callTool('petpack_search', { query: 'azure deploy' })])
  const info = readIpcInfo(userData)
  assert.ok(info, 'overlay wrote ipc.json')
  cleanups.push(() => { if (pidAlive(info.pid)) process.kill(info.pid) })
  assert.equal(ra.isError, undefined, ra.content[0].text)
  assert.equal(parse(ra).room, 'demo')
  assert.equal(parse(rb)[0].title, 'azure-app-service-deploy')
  // Still one overlay: a second round of calls from both reaches the same pid.
  await Promise.all([a.callTool('petpack_status'), b.callTool('petpack_status')])
  assert.equal(readIpcInfo(userData).pid, info.pid)
  assert.ok(pidAlive(info.pid))
})

test('installIntoCodex is idempotent (config.toml fallback and the codex CLI)', async () => {
  const { dir } = fixture()
  const home1 = path.join(dir, 'codex1')
  fs.mkdirSync(home1)
  fs.writeFileSync(path.join(home1, 'config.toml'), 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n')
  const r1 = installIntoCodex({ codexHome: home1, useCli: false, command: ['npx', '-y', 'petpack', 'mcp'] })
  assert.equal(r1.status, 'added')
  assert.equal(r1.via, 'config.toml')
  const r2 = installIntoCodex({ codexHome: home1, useCli: false })
  assert.equal(r2.status, 'already')
  const text = fs.readFileSync(path.join(home1, 'config.toml'), 'utf8')
  assert.equal(text.match(/\[mcp_servers\.petpack\]/g).length, 1)
  assert.match(text, /args = \["-y", "petpack", "mcp"\]/)
  assert.match(text, /\[mcp_servers\.other\]/)

  const hasCodex = spawnSync('codex', ['--version'], { shell: process.platform === 'win32' }).status === 0
  if (!hasCodex) return
  const home2 = path.join(dir, 'codex2')
  const c1 = installIntoCodex({ codexHome: home2 })
  assert.equal(c1.status, 'added')
  assert.equal(c1.via, 'codex')
  assert.equal(installIntoCodex({ codexHome: home2 }).status, 'already')
  const got = spawnSync('codex', ['mcp', 'get', 'petpack', '--json'], { env: { ...process.env, CODEX_HOME: home2 }, encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(got.status, 0, got.stderr)
  const cfg = JSON.parse(got.stdout)
  assert.deepEqual([cfg.transport.command, ...cfg.transport.args].slice(-4), ['npx', '-y', PKG_NAME, 'mcp'])
  assert.equal(cfg.startup_timeout_sec, 30)
})

/** An in-process MCP server over streams, against an overlay whose status the test controls. */
async function coldOverlay({ statusAt, onlineWaitMs = 1200 }) {
  const { userData, profile } = fixture()
  const calls = []
  const t0 = Date.now()
  const ipc = await startIpcServer({
    userData, profile,
    onCall: ({ tool, args }) => {
      calls.push({ tool, args, at: Date.now() - t0 })
      return tool === 'petpack_status' ? statusAt(Date.now() - t0) : { forwarded: tool }
    },
  })
  cleanups.push(() => ipc.close())
  const input = new PassThrough()
  const output = new PassThrough()
  const server = createMcpServer({ input, output, userData, onlineWaitMs, log: () => {}, launch: () => {} })
  cleanups.push(() => server.close())
  const waiting = new Map()
  let buf = ''
  output.setEncoding('utf8')
  output.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m) }
  })
  let id = 0
  const call = (name, args = {}) => new Promise((resolve) => {
    const rid = ++id
    const started = Date.now()
    waiting.set(rid, (m) => resolve({ ...m.result, ms: Date.now() - started }))
    input.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args } }) + '\n')
  })
  return { call, calls }
}

test('after a cold start, team tools wait for the overlay to come online; status stays instant', async () => {
  const solo = { room: 'solo', me: { name: 'Dot', online: false }, peers: [] }
  const live = { room: 'r1', me: { name: 'Dot', online: true }, peers: [{ name: 'Rex' }] }
  const o = await coldOverlay({ statusAt: (ms) => (ms < 900 ? solo : live), onlineWaitMs: 5000 })
  const status = await o.call('petpack_status')
  assert.ok(status.ms < 300, `status took ${status.ms} ms`)
  assert.equal(parse(status).me.online, false)
  const search = await o.call('petpack_search', { query: 'pdf' })
  assert.equal(search.isError, undefined)
  assert.deepEqual(parse(search), { forwarded: 'petpack_search' })
  const forwarded = o.calls.find((c) => c.tool === 'petpack_search')
  assert.ok(forwarded.at >= 900, `forwarded at ${forwarded.at} ms, before the overlay was online`)
  const polls = o.calls.filter((c) => c.tool === 'petpack_status' && c.args.quiet === true)
  assert.ok(polls.length >= 1)
  // Online once: the next team call goes straight through.
  const n = o.calls.length
  const get = await o.call('petpack_get', { id: 'rex/skill:pdf' })
  assert.deepEqual(parse(get), { forwarded: 'petpack_get' })
  assert.deepEqual(o.calls.slice(n).map((c) => c.tool), ['petpack_get'])
})

test('a team that stays offline gets a clear offline result, not an error, and only one wait', async () => {
  const offline = { room: null, offline: true, me: { name: 'Dot', online: false }, peers: [] }
  const o = await coldOverlay({ statusAt: () => offline, onlineWaitMs: 800 })
  const ask = await o.call('petpack_ask', { question: 'how?' })
  assert.equal(ask.isError, undefined)
  assert.equal(parse(ask).offline, true)
  assert.match(parse(ask).message, /team is offline right now, try again|team is offline right now; try again/)
  assert.ok(ask.ms >= 700, `answered after ${ask.ms} ms without waiting`)
  assert.equal(o.calls.some((c) => c.tool === 'petpack_ask'), false)
  const again = await o.call('petpack_search', { query: 'x' })
  assert.equal(parse(again).offline, true)
  assert.ok(again.ms < 400, `second offline call waited ${again.ms} ms`)
})

test('solo with demo bots (online:false, not offline) still forwards after the wait', async () => {
  const soloBots = { room: 'solo', me: { name: 'Dot', online: false }, peers: [{ name: 'Cleo', bot: true }] }
  const o = await coldOverlay({ statusAt: () => soloBots, onlineWaitMs: 600 })
  const search = await o.call('petpack_search', { query: 'azure' })
  assert.deepEqual(parse(search), { forwarded: 'petpack_search' })
})

test('ensureCodexRegistration: appends byte for byte, idempotent, a removal sticks, force re-adds, upgrades its own block', async () => {
  const { dir } = fixture()
  const a = path.join(dir, 'codexA')
  const b = path.join(dir, 'codexB')
  fs.mkdirSync(a)
  fs.mkdirSync(b)
  const original = '# my settings\r\nmodel = "x"\r\n\r\n[mcp_servers.other]\r\ncommand = "y"' // CRLF, no final newline
  fs.writeFileSync(path.join(a, 'config.toml'), original)
  const targets = [{ home: a, file: path.join(a, 'config.toml') }, { home: b, file: path.join(b, 'config.toml') }]
  const userData = path.join(dir, 'ud')
  const cmd = ['npx', '-y', '@qwntllabs/petpack', 'mcp']
  const r1 = ensureCodexRegistration({ command: cmd, userData, targets, useCli: false })
  assert.equal(r1.state, 'registered')
  assert.deepEqual(r1.results.map((r) => r.status), ['added', 'added'])
  const textA = fs.readFileSync(targets[0].file, 'utf8')
  assert.ok(textA.startsWith(original), 'existing bytes untouched')
  assert.match(textA, /\r\n\[mcp_servers\.petpack\]\r\n/)
  assert.match(textA, /default_tools_approval_mode = "approve"\r\nstartup_timeout_sec = 30\r\n/)
  assert.ok(hasPetpackServer(fs.readFileSync(targets[1].file, 'utf8')))

  // Every launch re-checks; nothing changes when it is there.
  const r2 = ensureCodexRegistration({ command: cmd, userData, targets, useCli: false })
  assert.deepEqual(r2.results.map((r) => r.status), ['present', 'present'])
  assert.equal(fs.readFileSync(targets[0].file, 'utf8'), textA)

  // `codex mcp remove petpack` (simulated) sticks; force re-adds.
  fs.writeFileSync(targets[1].file, '')
  const r3 = ensureCodexRegistration({ command: cmd, userData, targets, useCli: false })
  assert.deepEqual(r3.results.map((r) => r.status), ['present', 'removed-by-user'])
  assert.equal(fs.readFileSync(targets[1].file, 'utf8'), '')
  assert.deepEqual(registrationStatus({ userData, targets }).map((r) => r.status), ['registered', 'removed-by-user'])
  const r4 = ensureCodexRegistration({ command: cmd, userData, targets, useCli: false, force: true })
  assert.equal(r4.results[1].status, 'added')

  // A new command upgrades petpack's own untouched block in place, keeping the rest.
  const r5 = ensureCodexRegistration({ command: ['npx', '-y', '@qwntllabs/petpack@0.3.0', 'mcp'], userData, targets, useCli: false })
  assert.equal(r5.results[0].status, 'updated')
  const upgraded = fs.readFileSync(targets[0].file, 'utf8')
  assert.ok(upgraded.startsWith(original))
  assert.match(upgraded, /petpack@0\.3\.0/)
  assert.equal(upgraded.match(/\[mcp_servers\.petpack\]/g).length, 1)

  // A missing secondary Codex home is left alone; the primary is created.
  const fresh = path.join(dir, 'fresh')
  const r6 = ensureCodexRegistration({ command: cmd, userData: path.join(dir, 'ud2'), useCli: false,
    targets: [{ home: fresh, file: path.join(fresh, 'config.toml') }, { home: path.join(dir, 'nope'), file: path.join(dir, 'nope', 'config.toml') }] })
  assert.deepEqual(r6.results.map((r) => r.status), ['added', 'skipped'])

  // With the codex CLI on PATH, Codex itself reads what petpack wrote (approval mode, timeout, PATH env).
  if (!codexOnPath()) return
  const c = path.join(dir, 'codexC')
  fs.mkdirSync(c)
  fs.writeFileSync(path.join(c, 'config.toml'), 'model = "x"\n')
  const r7 = ensureCodexRegistration({ command: cmd, userData: path.join(dir, 'ud3'), targets: [{ home: c, file: path.join(c, 'config.toml') }] })
  assert.equal(r7.results[0].via, 'config.toml')
  const got = spawnSync('codex', ['mcp', 'get', 'petpack', '--json'], { env: { ...process.env, CODEX_HOME: c }, encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(got.status, 0, got.stderr)
  const cfg = JSON.parse(got.stdout)
  assert.equal(cfg.startup_timeout_sec, 30)
  assert.deepEqual(cfg.transport.args, ['-y', '@qwntllabs/petpack', 'mcp'])
  if (process.platform !== 'win32') assert.ok(cfg.transport.env.PATH.includes('/usr/bin'))
})

test('Codex link: a hint until a Codex session connects, then one "Codex connected"', async () => {
  const { userData, profile } = fixture()
  const events = []
  const link = createCodexLink({ userData, hintAfterMs: 250, onEvent: (ev) => events.push(ev),
    targets: [{ home: path.join(userData, 'nohome'), file: path.join(userData, 'nohome', 'config.toml') }] })
  cleanups.push(() => link.close())
  const ipc = await startIpcServer({ userData, profile, onCall: () => ({ me: { online: true } }), onClient: link.onClient })
  cleanups.push(() => ipc.close())
  await new Promise((r) => setTimeout(r, 350))
  assert.deepEqual(events.map((e) => e.type), ['hint'])
  assert.equal(events[0].text, 'restart Codex to connect me')
  assert.equal(link.state().status, 'unregistered')

  // A probe (doctor) doesn't count; a Codex session connects right after initialize, before any tool call.
  const probe = await connectIpc({ userData })
  probe.close()
  assert.equal(link.state().sessions, 0)
  const a = mcpChild({ userData, profile })
  await init(a)
  for (let i = 0; i < 40 && link.state().sessions < 1; i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(link.state().status, 'connected')
  const b = mcpChild({ userData, profile })
  await init(b)
  for (let i = 0; i < 40 && link.state().sessions < 2; i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(link.state().sessions, 2)
  assert.deepEqual(events.map((e) => e.type), ['hint', 'connected'])
  assert.equal(events[1].text, 'Codex connected')
  assert.equal(events[1].dismissHint, true)
  assert.equal(events[1].client.name, 'test')
  a.child.kill()
  for (let i = 0; i < 40 && link.state().sessions > 1; i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(link.state().sessions, 1)
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(lastCodexConnection(userData).lastSeen)
})

test('an MCP started before the overlay joins it once the overlay is up (no tool call needed)', async () => {
  const { userData, profile } = fixture()
  const c = mcpChild({ userData, profile, env: { PETPACK_MCP_LAUNCH: JSON.stringify(['false']) } })
  await init(c)
  await new Promise((r) => setTimeout(r, 400)) // the first quiet connect after initialize has already missed
  let sessions = 0
  const ipc = await startIpcServer({ userData, profile, onCall: () => null,
    onClient: (ev, client) => { if (client.kind === 'codex-mcp') sessions += ev === 'connect' ? 1 : ev === 'disconnect' ? -1 : 0 } })
  cleanups.push(() => ipc.close())
  for (let i = 0; i < 160 && sessions < 1; i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(sessions, 1)
})

test('doctor prints a PASS/FIX line per item', async () => {
  const { userData, dir } = fixture()
  const lines = []
  const prev = { ud: process.env.PETPACK_USER_DATA, ch: process.env.CODEX_HOME }
  process.env.PETPACK_USER_DATA = userData
  process.env.CODEX_HOME = path.join(dir, 'codex-home')
  try {
    const r = await runDoctor(['doctor', '--no-network'], { print: (l) => lines.push(l) })
    const text = lines.join('\n')
    assert.match(text, /^PASS {2}Node/m)
    assert.match(text, /^(PASS|FIX ) {2}Codex config +.*codex-home/m)
    assert.match(text, /^FIX {3}Codex link/m)
    assert.match(text, /^(PASS|FIX ) {2}Pet/m)
    assert.equal(r.ok, false)
  } finally {
    if (prev.ud === undefined) delete process.env.PETPACK_USER_DATA; else process.env.PETPACK_USER_DATA = prev.ud
    if (prev.ch === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev.ch
  }
})

test('petpack_find returns at once; petpack_errand reports findings; petpack_recall (fake overlay)', async () => {
  const { userData, profile } = fixture()
  const c = mcpChild({ userData, profile, env: { PETPACK_MCP_LAUNCH: JSON.stringify([process.execPath, FAKE, '--profile', profile]) } })
  await init(c)
  const names = (await c.request('tools/list', {})).result.tools.map((t) => t.name)
  for (const t of ['petpack_find', 'petpack_errand', 'petpack_recall']) assert.ok(names.includes(t), t)
  const find = await c.callTool('petpack_find', { question: 'how do we deploy the relay?' })
  cleanups.push(() => { const info = readIpcInfo(userData); if (info && pidAlive(info.pid)) process.kill(info.pid) })
  assert.equal(find.isError, undefined, find.content[0].text)
  const { errand_id: id, message } = parse(find)
  assert.ok(id)
  assert.match(message, /off to find out/)
  assert.equal(parse(await c.callTool('petpack_errand', { errand_id: id })).status, 'walking')
  await new Promise((r) => setTimeout(r, 350))
  const done = parse(await c.callTool('petpack_errand', { errand_id: id }))
  assert.equal(done.status, 'done')
  assert.equal(done.findings[0].from, 'Rex')
  assert.equal(done.installed.length, 1)
  assert.equal((await c.callTool('petpack_errand', {})).isError, true)
  assert.match(parse(await c.callTool('petpack_recall')).message, /coming home/)
})

test('TOOLS carry R4 names and required args', () => {
  const req = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema.required || []]))
  assert.deepEqual(req.petpack_search, ['query'])
  assert.deepEqual(req.petpack_get, ['id'])
  assert.deepEqual(req.petpack_install, ['id'])
  assert.deepEqual(req.petpack_ask, ['question'])
  assert.deepEqual(req.petpack_answer, ['id', 'text'])
  assert.deepEqual(req.petpack_find, ['question'])
  assert.deepEqual(req.petpack_errand, ['errand_id'])
  assert.deepEqual(req.petpack_recall, [])
})
