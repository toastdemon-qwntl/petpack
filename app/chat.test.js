// Ask your pet: codex exec (stub `codex` on PATH), the prompt, and voice token minting / SDP exchange (fake fetch).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REALTIME_MODEL, codexArgs, exchangeSdp, findApiKey, mintClientSecret, parseEvent, petPrompt, realtimeSession,
  resolveCodex, runCodex, setupChat, voiceTools } from './chat-main.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

// A stub `codex`: writes its argv and stdin to $STUB_LOG, then behaves as $STUB_MODE says.
const STUB = `#!/usr/bin/env node
const fs = require('fs')
let input = ''
process.stdin.on('data', d => { input += d })
process.stdin.on('end', () => {
  if (process.env.STUB_LOG) fs.writeFileSync(process.env.STUB_LOG, JSON.stringify({ args: process.argv.slice(2), input }))
  const mode = process.env.STUB_MODE || 'answer'
  const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
  if (mode === 'hang') { setTimeout(() => {}, 60000); return }
  if (mode === 'fail') { process.stderr.write('Error: not logged in\\n'); process.exit(1) }
  out({ type: 'thread.started', thread_id: 't1' })
  out({ type: 'turn.started' })
  if (mode === 'tool') {
    out({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'petpack', tool: 'petpack_search', arguments: { query: 'azure' }, status: 'in_progress' } })
    out({ type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'petpack', tool: 'petpack_search', status: 'completed' } })
  }
  out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: mode === 'tool' ? 'Cleo knows Azure deploys!' : 'Hi! I am right here.' } })
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
})
`

function stubDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-chat-test-'))
  fs.writeFileSync(path.join(dir, 'codex'), STUB, { mode: 0o755 })
  return dir
}
const envFor = (dir, mode, log) => ({ ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, STUB_MODE: mode, STUB_LOG: log })

test('codex exec runs read-only, ephemeral, low effort, JSON, prompt on stdin; the answer is parsed', { skip: process.platform === 'win32' }, async () => {
  const dir = stubDir()
  const log = path.join(dir, 'log.json')
  const events = []
  const r = await runCodex({ question: 'who knows azure?', petName: 'Dewey', userName: 'Ana', cwd: dir, env: envFor(dir, 'answer', log),
    history: [{ role: 'you', text: 'hello' }, { role: 'pet', text: 'hi there' }], onEvent: e => events.push(e),
    mcp: { command: ['/usr/bin/node', '/x/bin/petpack.js', 'mcp', '--profile', 'p1'], pathEnv: '/usr/bin:/bin' } })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.text, 'Hi! I am right here.')
  const { args, input } = JSON.parse(fs.readFileSync(log, 'utf8'))
  assert.equal(args[0], 'exec')
  for (const flag of ['--json', '--ephemeral', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag)
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
  assert.ok(args.includes('model_reasoning_effort="low"'))
  assert.ok(args.includes('approval_policy="never"'))
  assert.ok(args.includes('mcp_servers.petpack.command="/usr/bin/node"'))
  assert.ok(args.includes('mcp_servers.petpack.args=["/x/bin/petpack.js", "mcp", "--profile", "p1"]'))
  assert.equal(args.at(-1), '-')
  assert.match(input, /You are Dewey, Ana's pet/)
  assert.match(input, /Them: hello\nDewey: hi there/)
  assert.match(input, /Them: who knows azure\?\nDewey:$/)
  assert.deepEqual(events.map(e => e.type), ['partial'])
})

test('MCP tool calls stream as events and are reported', { skip: process.platform === 'win32' }, async () => {
  const dir = stubDir()
  const events = []
  const r = await runCodex({ question: 'who on my team knows Azure deploys?', cwd: dir, env: envFor(dir, 'tool'), onEvent: e => events.push(e) })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'Cleo knows Azure deploys!')
  assert.deepEqual(r.tools, ['petpack_search'])
  assert.deepEqual(events.map(e => e.type), ['tool', 'tool-done', 'partial'])
  assert.equal(events[0].tool, 'petpack_search')
})

test('a hung codex times out and is killed', { skip: process.platform === 'win32' }, async () => {
  const dir = stubDir()
  const t0 = Date.now()
  const r = await runCodex({ question: 'hi', cwd: dir, env: envFor(dir, 'hang'), timeoutMs: 400 })
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.equal(r.error, 'timeout')
  assert.ok(Date.now() - t0 < 3000)
})

test('codex failing or missing gives an error, never a throw', { skip: process.platform === 'win32' }, async () => {
  const dir = stubDir()
  const failed = await runCodex({ question: 'hi', cwd: dir, env: envFor(dir, 'fail') })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /not logged in/)
  const missing = await runCodex({ question: 'hi', cwd: dir, codexBin: path.join(dir, 'nope', 'codex'), env: { PATH: '/nonexistent' } })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /not found|ENOENT/)
})

test('Windows: codex.exe, else the npm shim\'s script without a shell, else a shell', () => {
  const env = { PATH: 'C:\\bin;C:\\npm' }
  const exe = resolveCodex('codex', env, 'win32', f => f === path.join('C:\\bin', 'codex.exe'))
  assert.equal(exe.shell, false)
  assert.equal(exe.command, path.join('C:\\bin', 'codex.exe'))
  const script = path.join('C:\\npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  const shim = resolveCodex('codex', env, 'win32', f => f === path.join('C:\\npm', 'codex.cmd') || f === script)
  assert.deepEqual([shim.command, shim.pre, shim.shell], [process.execPath, [script], false])
  assert.equal(resolveCodex('codex', env, 'win32', () => false).shell, true)
  assert.deepEqual(resolveCodex('codex', env, 'darwin'), { command: 'codex', pre: [], env: {}, shell: false })
})

test('parseEvent ignores junk and records failures', () => {
  const state = { text: '', messages: [], tools: [], error: null }
  assert.equal(parseEvent('not json', state).event, null)
  parseEvent(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }), state)
  assert.equal(state.error, 'quota')
  assert.ok(codexArgs({}).includes('--ephemeral'))
  assert.match(petPrompt({ question: 'x', petName: 'Pip' }), /Them: x\nPip:$/)
})

test('voice: the client secret is minted with the realtime model, pet instructions and team tools', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ value: 'ek_test', expires_at: 123, session: JSON.parse(init.body).session }) }
  }
  const tools = await voiceTools({ root: ROOT })
  assert.ok(tools.some(t => t.name === 'petpack_search' && t.type === 'function' && t.parameters))
  const session = realtimeSession({ instructions: 'be a pet', tools })
  const secret = await mintClientSecret({ apiKey: 'sk-fake', session, fetchImpl, base: 'https://example.test/v1' })
  assert.deepEqual(secret, { value: 'ek_test', expiresAt: 123, model: REALTIME_MODEL })
  assert.equal(calls[0].url, 'https://example.test/v1/realtime/client_secrets')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-fake')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.session.type, 'realtime')
  assert.equal(body.session.model, REALTIME_MODEL)
  assert.equal(body.session.audio.input.turn_detection, null)
  await assert.rejects(mintClientSecret({ apiKey: 'sk-bad', session, base: 'https://example.test/v1',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Incorrect API key provided' } }) }) }), /Incorrect API key/)
  await assert.rejects(mintClientSecret({ apiKey: '', session, fetchImpl }), /no OpenAI API key/)
})

test('voice: the SDP offer goes to /realtime/calls with the ephemeral secret', async () => {
  let seen
  const sdp = await exchangeSdp({ secret: 'ek_test', sdp: 'v=0 offer', base: 'https://example.test/v1',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 201, text: async () => 'v=0 answer' } } })
  assert.equal(sdp, 'v=0 answer')
  assert.equal(seen.url, 'https://example.test/v1/realtime/calls')
  assert.equal(seen.init.headers.Authorization, 'Bearer ek_test')
  assert.equal(seen.init.headers['Content-Type'], 'application/sdp')
})

test('the API key comes from the environment, else petpack settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-key-'))
  const file = path.join(dir, 'settings.json')
  assert.equal(findApiKey({ env: {}, settingsFile: file }), null)
  fs.writeFileSync(file, JSON.stringify({ openaiApiKey: 'sk-settings' }))
  assert.deepEqual(findApiKey({ env: {}, settingsFile: file }), { key: 'sk-settings', from: 'settings' })
  assert.deepEqual(findApiKey({ env: { OPENAI_API_KEY: 'sk-env' }, settingsFile: file }), { key: 'sk-env', from: 'env' })
})

test('setupChat: IPC from our page only; text asks, voice without and with a key', { skip: process.platform === 'win32' }, async () => {
  const handlers = new Map()
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) }
  const sent = []
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } }
  const dir = stubDir()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-ud-'))
  const ours = { senderFrame: { url: 'petpack://local/app/renderer/index.html' } }
  const theirs = { senderFrame: { url: 'https://evil.example/' } }
  const fetchImpl = async url => url.endsWith('/client_secrets')
    ? { ok: true, status: 200, json: async () => ({ value: 'ek_1', expires_at: 1, session: { model: REALTIME_MODEL } }) }
    : { ok: true, status: 201, text: async () => 'v=0 answer' }
  let permission = null
  const session = { setPermissionRequestHandler: fn => { permission = fn }, setPermissionCheckHandler: () => {} }
  await setupChat({ ipcMain, win: () => win, userData, env: envFor(dir, 'tool'), fetchImpl, session })

  await assert.rejects(handlers.get('petpack:chat-ask')(theirs, { question: 'hi' }), /not allowed/)
  const r = await handlers.get('petpack:chat-ask')(ours, { question: 'who knows azure?', petName: 'Dewey', id: 'q1' })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'Cleo knows Azure deploys!')
  assert.ok(sent.some(s => s.channel === 'petpack:chat-event' && s.payload.id === 'q1' && s.payload.type === 'tool'))

  assert.deepEqual(await handlers.get('petpack:voice-prepare')(ours), { available: false, reason: 'no-key' })
  assert.deepEqual(await handlers.get('petpack:voice-connect')(ours, 'v=0 offer'), { ok: false, reason: 'no-key' })
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ openaiApiKey: 'sk-fake' }))
  assert.equal((await handlers.get('petpack:voice-prepare')(ours)).available, true)
  const v = await handlers.get('petpack:voice-connect')(ours, 'v=0 offer', { petName: 'Dewey' })
  assert.deepEqual(v, { ok: true, sdp: 'v=0 answer', model: REALTIME_MODEL, expiresAt: 1 })

  let allowed
  permission({ getURL: () => 'petpack://local/app/renderer/index.html' }, 'media', ok => { allowed = ok }, { mediaTypes: ['audio'], requestingUrl: 'petpack://local/app/renderer/index.html' })
  assert.equal(allowed, true)
  permission({ getURL: () => 'petpack://local/' }, 'geolocation', ok => { allowed = ok }, {})
  assert.equal(allowed, false)
})
