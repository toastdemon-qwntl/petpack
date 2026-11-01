// Ask your pet (main process). Text: a read-only, ephemeral `codex exec` on this machine, signed in with the person's
// own Codex login, speaking as their pet, with petpack's MCP tools on so it can search and ask the team. Voice: an
// OpenAI Realtime session over WebRTC; main mints the short-lived client secret and does the SDP exchange, so the key
// never reaches the page and the page's CSP stays as it is.
//
// main.js: import('./chat-main.js').then(m => m.setupChat({ ipcMain, session: session.defaultSession, win: () => win, root: ROOT, profile: PROFILE, userData: USER_DATA, log }))
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const REALTIME_MODEL = process.env.PETPACK_REALTIME_MODEL || 'gpt-realtime-2.1'
export const REALTIME_VOICE = process.env.PETPACK_REALTIME_VOICE || 'marin'
export const OPENAI_BASE = (process.env.PETPACK_OPENAI_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '')
const ORIGIN = 'petpack://local/'
const HISTORY_TURNS = 6
const DEFAULT_TIMEOUT_MS = 90000
const VOICE_TOOLS = ['petpack_search', 'petpack_get', 'petpack_ask', 'petpack_status']

// ---------------------------------------------------------------------------------------------------------------
// Text: codex exec

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s }

/** The prompt: who the pet is, the tools, the last few turns, then the new line. */
export function petPrompt({ question, petName = 'Pip', userName = '', history = [] } = {}) {
  const who = userName ? `${userName}'s` : 'your person\'s'
  const lines = [
    `You are ${petName}, ${who} pet in petpack: a tiny pixel creature living in a shared little world with the pets of the rest of their team.`,
    'You talk with your person through a small speech bubble on their screen.',
    'Speak as the pet: warm, short and genuinely helpful. Usually one to three short sentences, under 60 words, unless they ask for detail. Plain text: no markdown, headings or lists; code only when they ask for code.',
    'You have the petpack tools: petpack_search finds who on the team knows something (their skills, memories, techniques, resources), petpack_get reads one, petpack_ask asks a teammate\'s agent, petpack_status says who is around.',
    'When they ask about the team, who knows what, or something a teammate may already have done, call petpack_search first and answer with names and what they have. If the tools say the team is offline, say so kindly and help from what you know.',
    'You are read-only here: never change files or run anything that writes.',
  ]
  const turns = history.slice(-HISTORY_TURNS)
  if (turns.length) {
    lines.push('', 'The conversation so far:')
    for (const t of turns) lines.push(`${t.role === 'pet' ? petName : 'Them'}: ${clip(t.text, 600)}`)
  }
  lines.push('', `Them: ${String(question ?? '').trim()}`, `${petName}:`)
  return lines.join('\n')
}

const toml = s => JSON.stringify(String(s))

/** `codex exec` arguments: JSON events, no session files, read-only sandbox, never asks, low effort, petpack MCP on. */
export function codexArgs({ cwd, mcp = null, effort = 'low', model = null } = {}) {
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-c', `model_reasoning_effort=${toml(effort)}`, '-c', 'approval_policy="never"']
  if (model) args.push('-m', model)
  if (cwd) args.push('--cd', cwd)
  if (mcp?.command?.length) {
    const [command, ...rest] = mcp.command
    args.push('-c', `mcp_servers.petpack.command=${toml(command)}`,
      '-c', `mcp_servers.petpack.args=[${rest.map(toml).join(', ')}]`,
      '-c', 'mcp_servers.petpack.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.petpack.startup_timeout_sec=30')
    // Codex starts MCP servers with a trimmed environment: hand over PATH (GUI apps) and a custom userData folder.
    const env = { ...(mcp.pathEnv ? { PATH: mcp.pathEnv } : {}), ...(mcp.env || {}) }
    const pairs = Object.entries(env).filter(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && v)
    if (pairs.length) args.push('-c', `mcp_servers.petpack.env={ ${pairs.map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`)
  }
  args.push('-') // the prompt comes on stdin (no shell quoting, any length)
  return args
}

/** Fold `codex exec --json` lines into { text, messages, tools, error, usage }. Unknown lines are ignored. */
export function parseEvent(line, state = { text: '', messages: [], tools: [], error: null, usage: null }) {
  let ev
  try { ev = JSON.parse(line) } catch { return { state, event: null } }
  const item = ev?.item || {}
  let event = null
  if (ev.type === 'thread.started') state.threadId = ev.thread_id || null
  else if ((ev.type === 'item.started' || ev.type === 'item.completed') && item.type === 'mcp_tool_call') {
    const tool = item.tool || item.name || ''
    if (ev.type === 'item.started') { state.tools.push(tool); event = { type: 'tool', tool, server: item.server || null } }
    else event = { type: 'tool-done', tool, ok: item.status !== 'failed' }
  } else if (ev.type === 'item.completed' && item.type === 'agent_message' && item.text) {
    state.messages.push(item.text)
    state.text = item.text
    event = { type: 'partial', text: item.text }
  } else if (ev.type === 'item.completed' && item.type === 'reasoning') event = { type: 'thinking' }
  else if (ev.type === 'turn.completed') state.usage = ev.usage || null
  else if (ev.type === 'turn.failed') state.error = ev.error?.message || 'codex turn failed'
  else if (ev.type === 'error') state.error = ev.message || 'codex error'
  return { state, event }
}

/** Where `codex` might live when a GUI app starts with a bare PATH. */
export function codexPath(env = process.env, platform = process.platform) {
  const home = os.homedir()
  const extra = platform === 'win32'
    ? [env.APPDATA && path.join(env.APPDATA, 'npm')]
    : [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
      env.PETPACK_NODE && path.dirname(env.PETPACK_NODE)]
  const sep = platform === 'win32' ? ';' : ':'
  return [...new Set([...(env.PATH || '').split(sep), ...extra].filter(Boolean))].join(sep)
}

/**
 * One answer from Codex. Resolves (never rejects) with { ok, text, ms, tools, error, timedOut }.
 * onEvent gets { type: 'tool' | 'tool-done' | 'partial' | 'thinking', ... } as Codex works.
 */
export function runCodex({ question, history = [], petName, userName, cwd = os.tmpdir(), mcp = null, effort = 'low', model = null,
  timeoutMs = DEFAULT_TIMEOUT_MS, codexBin = process.env.PETPACK_CODEX || 'codex', env = process.env, onEvent = () => {},
  spawnImpl = spawn, signal = null } = {}) {
  const started = Date.now()
  const args = codexArgs({ cwd, mcp, effort, model })
  return new Promise(resolve => {
    let child
    try {
      child = spawnImpl(codexBin, args, { cwd, env: { ...env, PATH: codexPath(env) }, stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, shell: process.platform === 'win32' && !/\.exe$/i.test(codexBin) })
    } catch (error) {
      resolve({ ok: false, text: '', ms: 0, tools: [], error: `codex not started: ${error.message}` })
      return
    }
    const state = { text: '', messages: [], tools: [], error: null, usage: null }
    let buffer = ''
    let stderr = ''
    let finished = false
    let timedOut = false
    const finish = (code, spawnError) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', abort)
      if (buffer.trim()) parseEvent(buffer.trim(), state)
      const text = String(state.text || '').trim()
      const error = timedOut ? 'timeout' : spawnError ? `codex not found (${spawnError.message})`
        : !text ? (state.error || lastLine(stderr) || `codex exited ${code}`) : null
      resolve({ ok: Boolean(text) && !timedOut, text, ms: Date.now() - started, tools: state.tools, error, timedOut,
        code: code ?? null, usage: state.usage })
    }
    const kill = () => {
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL') } catch {} }, 2000).unref?.()
    }
    const abort = () => { if (!finished) { state.error = 'cancelled'; kill() } }
    signal?.addEventListener?.('abort', abort)
    const timer = setTimeout(() => { timedOut = true; kill(); finish(null) }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        const { event } = parseEvent(line, state)
        if (event) { try { onEvent(event) } catch {} }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
    child.on('error', error => finish(null, error))
    child.on('close', code => finish(code))
    child.stdin.on('error', () => {})
    child.stdin.end(petPrompt({ question, history, petName, userName }))
  })
}
function lastLine(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(s => s && !/^Reading (additional )?(prompt|input) from stdin/i.test(s))
  return lines.length ? clip(lines[lines.length - 1], 200) : ''
}

/** The petpack MCP server Codex should start: this app's own bin with this profile, and a PATH that finds node. */
export async function petpackMcp({ root, profile = '' } = {}) {
  if (!root) return null
  try {
    const cli = await import(pathToFileURL(path.join(root, 'app', 'cli.js')).href)
    let command = cli.mcpServerCommand(root, profile)
    let pathEnv = null
    try {
      const reg = await import(pathToFileURL(path.join(root, 'app', 'mcp', 'register.js')).href)
      const resolved = reg.resolveCommand(command)
      command = resolved.command
      pathEnv = resolved.pathEnv
    } catch {}
    const env = process.env.PETPACK_USER_DATA ? { PETPACK_USER_DATA: process.env.PETPACK_USER_DATA } : {}
    return { command, pathEnv, env }
  } catch { return null }
}

// ---------------------------------------------------------------------------------------------------------------
// Voice: OpenAI Realtime (GA): POST /v1/realtime/client_secrets, then POST /v1/realtime/calls with the SDP offer.

/** OPENAI_API_KEY from the environment, else `openaiApiKey` in petpack's settings.json. */
export function findApiKey({ env = process.env, settingsFile = null } = {}) {
  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim()) return { key: env.OPENAI_API_KEY.trim(), from: 'env' }
  if (settingsFile) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      const key = s.openaiApiKey || s.openai_api_key || s.OPENAI_API_KEY
      if (typeof key === 'string' && key.trim()) return { key: key.trim(), from: 'settings' }
    } catch {}
  }
  return null
}

export function voiceInstructions({ petName = 'Pip', userName = '' } = {}) {
  return [
    `You are ${petName}, ${userName ? `${userName}'s` : 'your person\'s'} pet in petpack, a tiny pixel creature in a shared world with their team's pets.`,
    'You are talking out loud. Be warm, playful and brief: one or two short sentences, then let them talk.',
    'When they ask about their team, who knows something, or what a teammate has done, call petpack_search first and answer with names; petpack_get reads a hit, petpack_ask asks a teammate\'s agent (it can take a little while: say you are asking).',
  ].join(' ')
}

/** petpack's MCP tools (S5's definitions when present) as Realtime function tools. */
export async function voiceTools({ root } = {}) {
  let defs = null
  if (root) {
    try { defs = (await import(pathToFileURL(path.join(root, 'app', 'mcp', 'server.js')).href)).TOOLS } catch {}
  }
  if (!Array.isArray(defs)) defs = FALLBACK_TOOLS
  return defs.filter(t => VOICE_TOOLS.includes(t.name)).map(t => ({ type: 'function', name: t.name,
    description: clip(t.description, 1000), parameters: t.inputSchema || { type: 'object', properties: {} } }))
}
const FALLBACK_TOOLS = [
  { name: 'petpack_search', description: 'Search your team\'s skills, memories, techniques and resources; returns who has what.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'petpack_get', description: 'Read one item found with petpack_search, by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'petpack_ask', description: 'Ask a teammate\'s agent a question.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, to: { type: 'string' } }, required: ['question'] } },
  { name: 'petpack_status', description: 'Who on the team is around.', inputSchema: { type: 'object', properties: {} } },
]

/** The session the ephemeral secret carries: push-to-talk (no VAD), the pet's voice and instructions, team tools. */
export function realtimeSession({ model = REALTIME_MODEL, voice = REALTIME_VOICE, instructions, tools = [] } = {}) {
  return {
    type: 'realtime', model, instructions,
    audio: { input: { turn_detection: null }, output: { voice } },
    tools, tool_choice: 'auto',
  }
}

/** Mint a short-lived Realtime client secret. Returns { value, expiresAt, model }. Throws with the API's message. */
export async function mintClientSecret({ apiKey, session, base = OPENAI_BASE, fetchImpl = globalThis.fetch, ttlSeconds = 600 } = {}) {
  if (!apiKey) throw new Error('no OpenAI API key')
  const res = await fetchImpl(`${base}/realtime/client_secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: ttlSeconds }, session }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error?.message || `client secret: HTTP ${res.status}`)
  const value = body.value || body.client_secret?.value
  if (!value) throw new Error('client secret: no value in the response')
  return { value, expiresAt: body.expires_at ?? body.client_secret?.expires_at ?? null, model: body.session?.model || session?.model || null }
}

/** The WebRTC offer goes to /realtime/calls with the ephemeral secret; the SDP answer comes back. */
export async function exchangeSdp({ secret, sdp, base = OPENAI_BASE, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(`${base}/realtime/calls`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' }, body: sdp,
  })
  const text = await res.text()
  if (!res.ok) {
    let message = text
    try { message = JSON.parse(text)?.error?.message || text } catch {}
    throw new Error(`realtime call: ${clip(message, 200) || `HTTP ${res.status}`}`)
  }
  return text
}

// ---------------------------------------------------------------------------------------------------------------
// Wiring: IPC from our own page only.

export async function setupChat({ ipcMain, session = null, win = () => null, root = null, profile = '', userData = null,
  log = () => {}, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (!ipcMain) throw new TypeError('setupChat: ipcMain is required')
  const getWin = typeof win === 'function' ? win : () => win
  const settingsFile = userData ? path.join(userData, 'settings.json') : null
  const cwd = userData ? path.join(userData, 'chat') : path.join(os.tmpdir(), 'petpack-chat')
  try { fs.mkdirSync(cwd, { recursive: true }) } catch {}
  const mcpPromise = petpackMcp({ root, profile })
  const toolsPromise = voiceTools({ root })
  const history = []
  let running = null

  const trusted = event => String(event?.senderFrame?.url || '').startsWith(ORIGIN)
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('not allowed')
    return fn(...args)
  })
  const send = payload => {
    const w = getWin()
    if (w && !w.isDestroyed?.()) w.webContents.send('petpack:chat-event', payload)
  }

  handle('petpack:chat-ask', async (request = {}) => {
    const question = String(request.question ?? '').trim().slice(0, 4000)
    if (!question) return { ok: false, error: 'empty' }
    running?.abort()
    const controller = new AbortController()
    running = controller
    const id = request.id || `c${Date.now().toString(36)}`
    const result = await runCodex({ question, history, petName: request.petName || 'Pip', userName: request.userName || '',
      cwd, mcp: await mcpPromise, signal: controller.signal, env,
      timeoutMs: Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : DEFAULT_TIMEOUT_MS,
      onEvent: event => send({ id, ...event }) })
    if (running === controller) running = null
    if (result.ok) {
      history.push({ role: 'you', text: question }, { role: 'pet', text: result.text })
      while (history.length > HISTORY_TURNS * 2) history.shift()
    }
    log('chat', { ok: result.ok, ms: result.ms, tools: result.tools, error: result.error })
    return { id, ok: result.ok, text: result.text, ms: result.ms, tools: result.tools, error: result.error }
  })
  handle('petpack:chat-reset', () => { history.length = 0; running?.abort(); return true })

  let mic = null
  handle('petpack:voice-prepare', async () => {
    const key = findApiKey({ env, settingsFile })
    if (!key) return { available: false, reason: 'no-key' }
    if (process.platform === 'darwin' && mic === null) {
      try { const { systemPreferences } = await import('electron'); mic = await systemPreferences.askForMediaAccess('microphone') } catch { mic = true }
    }
    return { available: true, model: REALTIME_MODEL, mic: mic !== false }
  })
  handle('petpack:voice-connect', async (offerSdp, opts = {}) => {
    const key = findApiKey({ env, settingsFile })
    if (!key) return { ok: false, reason: 'no-key' }
    try {
      const session = realtimeSession({ instructions: voiceInstructions({ petName: opts.petName, userName: opts.userName }),
        tools: await toolsPromise })
      const secret = await mintClientSecret({ apiKey: key.key, session, fetchImpl })
      const sdp = await exchangeSdp({ secret: secret.value, sdp: String(offerSdp || ''), fetchImpl })
      log('voice connected', { model: secret.model })
      return { ok: true, sdp, model: secret.model, expiresAt: secret.expiresAt }
    } catch (error) {
      log('voice failed', error.message)
      return { ok: false, reason: 'error', error: error.message }
    }
  })

  // The microphone for our own page only (main denies every permission by default).
  if (session?.setPermissionRequestHandler) {
    const ours = url => String(url || '').startsWith(ORIGIN)
    session.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
      const audioOnly = !(details.mediaTypes || []).includes('video')
      callback(permission === 'media' && audioOnly && ours(details.requestingUrl || wc?.getURL?.()))
    })
    session.setPermissionCheckHandler?.((wc, permission, origin) => permission === 'media' &&
      (ours(origin) || String(origin || '').startsWith('petpack://local')))
  }
  return { history, dispose: () => running?.abort() }
}
