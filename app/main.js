// Electron main: petpack:// protocol + CSP, the docked pane, tray, bridge IPC, Codex data and the MCP socket.
import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, nativeImage, net, Notification, protocol, screen, session } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_RELAY, codexMcpState, parseArgs, profileName, readJson, registerMcp, relayList, userDataDir, writeJson } from './cli.js'
import { createClickThrough, createPaneWindow, dockBounds, edgeGap, onDockSide, paneSize, placePane, raiseToTop } from './window.js'
import { createTray } from './tray.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const VERSION = readJson(path.join(ROOT, 'package.json'), {}).version || '0.0.0'
const ORIGIN = 'petpack://local'
const ENTRY = `${ORIGIN}/app/renderer/index.html`
const { flags } = parseArgs(process.argv.slice(process.defaultApp ? 2 : 1))
const PROFILE = profileName(flags)
const DEBUG = Boolean(flags.debug || process.env.PETPACK_DEBUG)
const log = (...args) => { if (DEBUG) console.log('[petpack]', ...args) }

// ---------------------------------------------------------------------------------------------------------------
// Before ready: identity, single instance, GPU, scheme.

app.setName('petpack')
app.setPath('userData', userDataDir(PROFILE)) // same folder app/mcp/ipc.js computes without Electron
app.commandLine.appendSwitch('enable-unsafe-swiftshader') // software WebGL when the GPU is missing (build B7)
if (!app.requestSingleInstanceLock({ profile: PROFILE })) {
  console.log('petpack is already running (look for its icon in the menu bar / system tray).')
  app.exit(0)
}
protocol.registerSchemesAsPrivileged([{ scheme: 'petpack',
  privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true, corsEnabled: true } }])
if (process.platform === 'darwin') app.setActivationPolicy?.('accessory') // no Dock icon, no app menu takeover

// ---------------------------------------------------------------------------------------------------------------
// Settings (userData/settings.json): dock side, align offset, room, seat. Flags win and are remembered.

const USER_DATA = app.getPath('userData')
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json')
const settings = { dock: 'right', align: 0, room: null, seat: null, ...readJson(SETTINGS_FILE, {}) }
if (flags.dock === 'left' || flags.dock === 'right') settings.dock = flags.dock
if (typeof flags.room === 'string' && flags.room.trim()) settings.room = flags.room.trim()
if (flags.seat !== undefined) settings.seat = /^\d+$/.test(String(flags.seat)) ? Number(flags.seat) : null
// Seating: 'side' (laptops side by side, one strip) or 'across' (facing each other across a table: one seat, flipped).
if (flags.sit === 'side' || flags.sit === 'across') settings.sit = flags.sit
saveSettings()
function saveSettings() {
  try { writeJson(SETTINGS_FILE, settings) } catch (error) { console.error(`petpack: settings not saved (${error.message})`) }
}

// Sharing: L3b's catalog reads settings.json `share` { mode: free|ask|never, off: [ref] }; the TRAY popover writes
// userData/sharing.json { mode: free|ask|off, hidden: [ref], dnd }. Main keeps the first in step with the second.
const SHARING_FILE = path.join(USER_DATA, 'sharing.json')
const traySharing = () => { const s = readJson(SHARING_FILE, null); return s && typeof s === 'object' ? s : null }
function setShare(patch = {}) {
  const share = { mode: 'free', off: [], ...(settings.share || {}) }
  if (['free', 'ask', 'never'].includes(patch.mode)) share.mode = patch.mode
  else if (patch.mode === 'off') share.mode = 'never'
  const list = Array.isArray(patch.off) ? patch.off : Array.isArray(patch.hidden) ? patch.hidden : null
  if (list) share.off = [...new Set(list.map(String))]
  if (typeof patch.ref === 'string') {
    const off = new Set(share.off)
    if (patch.on) off.delete(patch.ref); else off.add(patch.ref)
    share.off = [...off]
  }
  settings.share = share
  saveSettings()
  return share
}
if (traySharing()) setShare(traySharing())
/** The brain's seed: { mode, items: { ref: false } } (brain.setSharing's shape). */
function brainSharing() {
  const share = settings.share || {}
  return { mode: share.mode || 'free', items: Object.fromEntries((share.off || []).map(ref => [ref, false])) }
}

// Every relay in failover order (shared/protocol.js); --relay / PETPACK_RELAY replace it (comma-separated list).
const relays = relayList((typeof flags.relay === 'string' && flags.relay) || process.env.PETPACK_RELAY || null)
const relayUrl = relays[0] || DEFAULT_RELAY
const paneScale = Number(flags['pane-scale']) > 0 ? Number(flags['pane-scale']) : 1
const topFraction = (() => {
  const v = parseFloat(String(flags.top ?? ''))
  if (!Number.isFinite(v) || v < 0) return 0.2
  return v > 1 ? Math.min(v, 90) / 100 : v
})()

function config() {
  return {
    relays, relayUrl, relay: relayUrl, room: settings.room ?? null, seat: settings.seat ?? null, dock: settings.dock,
    demo: Boolean(flags.demo), install: !flags['no-install'], answer: !flags['no-answer'],
    name: typeof flags.name === 'string' ? flags.name : null, pet: typeof flags.pet === 'string' ? flags.pet : null,
    profile: PROFILE || null, version: VERSION, platform: process.platform,
    pane: { ...paneSize(paneScale), scale: paneScale }, debug: DEBUG,
    sharing: brainSharing(), dnd: Boolean(traySharing()?.dnd), sit: settings.sit === 'across' ? 'across' : 'side',
    nextTo: typeof flags['next-to'] === 'string' && flags['next-to'].trim() ? flags['next-to'].trim() : null,
    // Device registry fingerprint (hello.device): this machine + profile, hashed; the relay keys agents by id first.
    device: crypto.createHash('sha256').update(`${os.hostname()}|${PROFILE || ''}`).digest('hex').slice(0, 32),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// petpack:// (build B5): /app/, /shared/ and /node_modules/three/ from wherever npm put three. CSP with the
// import-map hash. Modules then resolve the same way they do in a plain browser on the repo root.

const THREE_ROOT = path.dirname(path.dirname(require.resolve('three')))
const MOUNTS = [
  ['/node_modules/three/', THREE_ROOT],
  ['/app/', path.join(ROOT, 'app')],
  ['/shared/', path.join(ROOT, 'shared')],
]

const OPTIONAL_MODULES = new Set(['/app/renderer/world/sound.js', '/app/renderer/world/play.js',
  '/app/renderer/world/mood.js', '/app/renderer/collapse.js', '/app/renderer/zoom.js', '/app/renderer/chat.js',
  '/app/renderer/life.js'])

function relayOrigins() {
  // Every relay, in both forms: wss for the socket, https for sprites and the primary health probe.
  return [...new Set(relays.flatMap(url => {
    try {
      const u = new URL(url)
      const secure = u.protocol === 'wss:' || u.protocol === 'https:'
      return [`${secure ? 'wss' : 'ws'}://${u.host}`, `${secure ? 'https' : 'http'}://${u.host}`]
    } catch { return [] }
  }))]
}

function csp(html) {
  const hashes = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]) || !m[2].trim()) continue
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[2]).digest('base64')}'`)
  }
  const relay = relayOrigins().join(' ')
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${relay}`.trim(),
    `connect-src 'self' data: blob: ${relay}`.trim(),
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

function resolveFile(pathname) {
  for (const [prefix, base] of MOUNTS) {
    if (!pathname.startsWith(prefix)) continue
    const file = path.join(base, pathname.slice(prefix.length))
    const rel = path.relative(base, file)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return file
  }
  return null
}

const notFound = () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })

function htmlResponse(html) {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp(html), 'cache-control': 'no-store' } })
}

async function serve(request) {
  const url = new URL(request.url)
  if (url.host !== 'local') return notFound()
  let pathname
  try { pathname = decodeURIComponent(url.pathname) } catch { return notFound() }
  if (pathname === '/__petpack/fallback.js') {
    return new Response(FALLBACK_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
  }
  const file = resolveFile(pathname)
  if (!file) return notFound()
  if (file.endsWith('.html')) {
    let html
    try { html = fs.readFileSync(file, 'utf8') } catch {
      if (pathname === '/app/renderer/index.html') return htmlResponse(FALLBACK_HTML)
      return notFound()
    }
    return htmlResponse(html)
  }
  // Optional plug-ins the page imports when present; until a lane lands one, it is an empty module, not a 404.
  if (OPTIONAL_MODULES.has(pathname) && !fs.existsSync(file)) {
    return new Response('export {}\n', { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
  }
  try {
    return await net.fetch(pathToFileURL(file).href)
  } catch { return notFound() }
}

// Until pack's index.html lands: a bare pane that runs the world's own story, so the shell is testable on its own.
const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>petpack</title>
<link rel="stylesheet" href="/app/renderer/world/pane.css"><link rel="stylesheet" href="/app/renderer/world/fx.css">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}
.petpack-pane,.petpack-pane[data-dock]{position:fixed;inset:0;width:100%;height:100%;max-width:none;aspect-ratio:auto}</style>
</head><body><section class="petpack-pane"><div class="world-viewport"></div></section>
<script type="module" src="/__petpack/fallback.js"></script></body></html>`
const FALLBACK_JS = `import { createWorld } from '/app/renderer/world/index.js'
import { createStory } from '/app/renderer/world/story.js'
const cfg = window.petpack?.config || {}
const pane = document.querySelector('.petpack-pane')
pane.dataset.dock = cfg.dock || 'right'
let time = 0
const world = createWorld(pane.querySelector('.world-viewport'), { seat: 0, pixelScale: 2, dock: cfg.dock, clock: () => time, autoRender: false })
const story = createStory(world.map)
let previous = 0, start = performance.now() / 1000
function frame(now) {
  time = now / 1000 - start
  for (const pet of story.sample(time)) {
    world.upsertPet(pet.id, { displayName: pet.displayName, color: pet.color, kind: pet.kind, skillCount: pet.skillCount, isMe: pet.homeSeat === 0 })
    world.updatePet(pet.id, { x: pet.x, z: pet.z, anim: pet.anim, status: pet.status, facing: pet.facing, speed: pet.speed, snap: true })
  }
  for (const e of story.events(previous, time)) {
    if (e.type === 'ask') world.ask(e.from, e.to, { question: e.question, answer: e.answer, kind: e.kind, label: e.label })
    else if (e.type === 'gift') world.gift(e.from, e.to, { color: e.color, label: e.label })
    else if (e.type === 'say') world.say(e.id, e.text)
  }
  world.renderFrame(Math.max(0, time - previous), time)
  previous = time
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
addEventListener('mousemove', e => window.petpack?.setInteractive(Boolean(world.pick(e.clientX, e.clientY))))
window.petpack?.onAgentCall(({ tool }) => ({ tool, note: 'the pack brain (app/renderer/index.html) is not in this build' }))
`

// ---------------------------------------------------------------------------------------------------------------
// Codex data (L3a app/codex/index.js, L3b app/codex/{catalog,answer}.js), looked up by name with shims.

async function importOptional(rel) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) return null
  try { return await import(pathToFileURL(file).href) } catch (error) {
    console.error(`petpack: ${rel} failed to load: ${error.stack || error.message}`)
    return null
  }
}
function pick(mods, ...names) {
  for (const mod of mods) {
    if (!mod) continue
    for (const name of names) {
      if (typeof mod[name] === 'function') return mod[name].bind(mod)
      if (typeof mod.default?.[name] === 'function') return mod.default[name].bind(mod.default)
    }
  }
  return null
}

const ctx = () => ({ userData: USER_DATA, profile: PROFILE, pet: config().pet, name: config().name, demo: config().demo,
  answersDir: path.join(USER_DATA, 'answers'), noExec: Boolean(flags['no-answer']) })
/** Stable per machine (per profile): random, never a username or email (CONTRACT). */
function myId() {
  if (!settings.id) { settings.id = crypto.randomUUID(); saveSettings() }
  return settings.id
}

let codex = null
async function loadCodex() {
  const [core, catalog, answer] = await Promise.all(['index', 'catalog', 'answer']
    .map(name => importOptional(`app/codex/${name}.js`)))
  const createCodex = pick([core], 'createCodex')
  const api = createCodex ? createCodex({ pet: config().pet, cacheDir: path.join(USER_DATA, 'pets') }) : null
  const installItem = pick([catalog], 'installItem')
  const getCatalog = pick([catalog], 'getCatalog')
  const readItem = pick([catalog], 'readItem')
  const answerAsk = pick([answer], 'answerAsk')
  const currentNeed = pick([answer], 'currentNeed')
  const listShareable = pick([catalog], 'listShareable')
  const readShareSettings = pick([catalog], 'readShareSettings')
  const unavailable = async () => { throw new Error('unavailable in this build') }
  codex = {
    loaded: { core: Boolean(api), catalog: Boolean(catalog), answer: Boolean(answer) },
    async getMe() {
      const me = api ? await api.getMe(myId()) : { id: myId(), petName: null, displayName: 'You', spriteUrl: null, skills: [] }
      if (config().name) me.displayName = config().name
      return me
    },
    packSkill: api ? id => api.packSkill(id) : unavailable,
    installSkill: api ? (pkg, fromName) => api.installSkill(pkg, fromName) : async () => ({ installed: false, reason: 'unavailable' }),
    installItem: installItem ? (item, fromName) => installItem(item, fromName, ctx()) : async () => ({ installed: false, reason: 'unavailable' }),
    getCatalog: getCatalog ? () => getCatalog(ctx()) : async () => [],
    readItem: readItem ? (ref, as) => readItem(ref, as, ctx()) : unavailable,
    answerAsk: answerAsk ? request => answerAsk(request, ctx()) : async () => ({ ok: false, text: "I can't answer that here." }),
    // Our stuck Codex session's need (L3b), or null; the brain polls it while our pet is free.
    currentNeed: currentNeed ? async () => (await currentNeed(ctx())) || null : async () => null,
    // The tray panel's sharing list and the settings.json `share` block the catalog filters by (L3b).
    listShareable: listShareable ? () => listShareable(ctx()) : async () => [],
    shareSettings: () => {
      const s = readShareSettings ? readShareSettings(ctx()) : { mode: 'free', off: new Set() }
      return { mode: s.mode, off: [...(s.off || [])] }
    },
    onStatus: api ? cb => api.onStatus(cb) : () => () => {},
    // Every pet the person could wear (custom + built-in), sprites as data URLs; demo bots wear these.
    listPets: api?.listPets ? () => api.listPets() : async () => [],
    // L3a: Codex's live task, its transitions (for notifications) and a way back into the Codex app.
    currentTask: api?.currentTask ? () => api.currentTask() : async () => null,
    onCodexEvent: api?.onCodexEvent ? cb => api.onCodexEvent(cb) : () => () => {},
    openCodex: pick([api, core], 'openCodex') || (async () => ({ ok: false })),
    // L3a: petpack wears the person's actual Codex pet while it runs and gives it back on quit.
    takeOverPet: pick([api, core], 'takeOverPet'),
    releasePet: pick([api, core], 'releasePet'),
    dispose: () => api?.dispose(),
  }
  log('codex modules', codex.loaded)
}

let lastStatus = { status: 'idle', at: Date.now() }
function startStatus() {
  try {
    return codex.onStatus(s => {
      if (!s?.status) return
      lastStatus = { ...s, at: s.at ?? Date.now() }
      if (win && !win.isDestroyed()) win.webContents.send('petpack:status', { status: lastStatus.status, at: lastStatus.at })
    })
  } catch (error) {
    console.error(`petpack: status watcher failed: ${error.message}`)
    return () => {}
  }
}

// ---------------------------------------------------------------------------------------------------------------
// MCP agent calls: S5's socket/pipe server -> page's onAgentCall handler -> result.

const pendingCalls = new Map()
let agentReady = false
const agentWaiters = []
function whenAgentReady(ms) {
  if (agentReady) return Promise.resolve(true)
  return new Promise(resolve => {
    const done = ok => { clearTimeout(timer); resolve(ok) }
    const timer = setTimeout(() => {
      const i = agentWaiters.indexOf(done)
      if (i >= 0) agentWaiters.splice(i, 1)
      resolve(false)
    }, ms)
    agentWaiters.push(done)
  })
}
async function agentCall(tool, args = {}, { timeoutMs = 58000 } = {}) {
  if (!(await whenAgentReady(20000)) || !win || win.isDestroyed()) throw new Error('petpack is still starting; try again in a moment')
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingCalls.delete(id); reject(new Error(`${tool} timed out`)) }, timeoutMs)
    pendingCalls.set(id, { resolve, reject, timer })
    win.webContents.send('petpack:agent-call', { id, tool, args })
  })
}
let ipcServer = null
async function startMcpIpc() {
  const mod = await importOptional('app/mcp/ipc.js')
  const start = pick([mod], 'startIpcServer')
  if (!start) { log('no app/mcp/ipc.js; MCP calls disabled'); return }
  try {
    ipcServer = await start({
      onCall: ({ tool, args }) => agentCall(tool, args), log,
      onClient: (...a) => codexLink?.onClient(...a),
      userData: USER_DATA, profile: PROFILE, version: VERSION,
    })
  } catch (error) { console.error(`petpack: MCP socket failed: ${error.message}`) }
}

// Codex link (S5 app/mcp/link.js): which Codex sessions are connected; "Codex connected" once, or the restart hint.
let codexLink = null
async function startCodexLink() {
  const create = pick([await importOptional('app/mcp/link.js')], 'createCodexLink')
  if (!create) return
  try {
    codexLink = create({ userData: USER_DATA,
      onEvent: ev => { if (!(ev?.type === 'hint' && flags['no-mcp'])) agentCall('codex_link', ev).catch(() => {}) },
      onChange: state => { codexState = state.status === 'unregistered' ? 'unregistered' : 'registered'; refreshTray() } })
  } catch (error) { console.error(`petpack: Codex link failed: ${error.message}`) }
}

// Ask your pet (CHAT lane, app/chat-main.js): text through codex exec, voice through OpenAI Realtime.
async function startChat() {
  const setup = pick([await importOptional('app/chat-main.js')], 'setupChat')
  if (!setup) return
  try {
    setup({ ipcMain, session: session.defaultSession, win: () => win, root: ROOT, profile: PROFILE, userData: USER_DATA, log })
  } catch (error) { console.error(`petpack: chat failed: ${error.message}`) }
}

// ---------------------------------------------------------------------------------------------------------------
// IPC (build B6): only from our own page.

function trusted(event) {
  const url = event.senderFrame?.url || ''
  return url.startsWith(`${ORIGIN}/`)
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('not allowed')
    return fn(...args)
  })
}
ipcMain.on('petpack:config', event => { event.returnValue = trusted(event) ? config() : null })
handle('petpack:getMe', () => codex.getMe())
handle('petpack:listPets', () => codex.listPets())
handle('petpack:status', () => ({ status: lastStatus.status, at: lastStatus.at }))
handle('petpack:packSkill', id => codex.packSkill(id))
handle('petpack:installSkill', (pkg, fromName) => codex.installSkill(pkg, fromName))
handle('petpack:installItem', (item, fromName) => codex.installItem(item, fromName))
handle('petpack:getCatalog', () => codex.getCatalog())
handle('petpack:readItem', (ref, as) => codex.readItem(ref, as))
handle('petpack:answerAsk', request => codex.answerAsk(request))
handle('petpack:currentNeed', () => codex.currentNeed())
handle('petpack:currentTask', () => codex.currentTask())
handle('petpack:listShareable', () => codex.listShareable())
handle('petpack:shareSettings', () => codex.shareSettings())
handle('petpack:setShare', patch => setShare(patch))
// Photo mode (P): the page hands over a PNG data URL; it lands on the Desktop.
handle('petpack:savePhoto', dataUrl => {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
  if (!m) return { saved: false, reason: 'not a PNG data URL' }
  let dir = app.getPath('desktop')
  if (!fs.existsSync(dir)) dir = app.getPath('pictures')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(dir, `petpack-${stamp}.png`)
  fs.writeFileSync(file, Buffer.from(m[1], 'base64'))
  return { saved: true, path: file }
})
ipcMain.on('petpack:interactive', (event, on) => { if (trusted(event)) clickThrough?.set(on) })
ipcMain.on('petpack:agent-ready', (event, ready) => {
  if (!trusted(event)) return
  agentReady = Boolean(ready)
  if (agentReady) for (const done of agentWaiters.splice(0)) done(true)
})
ipcMain.on('petpack:agent-result', (event, { id, ok, result, error } = {}) => {
  if (!trusted(event)) return
  const pending = pendingCalls.get(id)
  if (!pending) return
  pendingCalls.delete(id)
  clearTimeout(pending.timer)
  if (ok) pending.resolve(result)
  else pending.reject(new Error(error || 'failed'))
})

// ---------------------------------------------------------------------------------------------------------------
// The pane.

let win = null
let clickThrough = null
let tray = null
let codexState = null
const consoleLog = []

function dock() {
  if (!win || win.isDestroyed()) return null
  return placePane(win, { display: screen.getPrimaryDisplay(), dock: settings.dock, align: settings.align,
    top: topFraction, scale: paneScale })
}

function createWindow() {
  win = createPaneWindow({ preload: path.join(ROOT, 'app', 'preload.cjs'), scale: paneScale,
    vibrancy: Boolean(flags.vibrancy), debug: DEBUG })
  dock()
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', event => event.preventDefault())
  wc.on('will-redirect', event => event.preventDefault())
  wc.on('console-message', event => {
    const level = typeof event.level === 'string' ? event.level : 'info'
    const entry = { level, message: event.message, source: event.sourceId, line: event.lineNumber, at: Date.now() }
    consoleLog.push(entry)
    if (consoleLog.length > 500) consoleLog.shift()
    if (DEBUG || level === 'error') console.error(`[renderer ${level}] ${entry.message} (${entry.source}:${entry.line})`)
  })
  wc.on('preload-error', (_e, file, error) => consoleLog.push({ level: 'error', message: `preload: ${error.message}`, source: file }))
  wc.on('did-fail-load', (_e, code, desc, url) => consoleLog.push({ level: 'error', message: `load failed ${code} ${desc} ${url}` }))
  wc.on('render-process-gone', (_e, details) => {
    consoleLog.push({ level: 'error', message: `renderer gone: ${details.reason}` })
    if (!SMOKE && details.reason !== 'clean-exit') setTimeout(() => win && !win.isDestroyed() && wc.reload(), 1000)
  })
  wc.on('did-start-loading', () => { agentReady = false; clickThrough?.reset() })
  clickThrough = createClickThrough(win, { send: c => { if (!wc.isDestroyed()) wc.send('petpack:cursor', c) } })
  let shown = false
  const show = () => { if (shown || win.isDestroyed()) return; shown = true; win.showInactive(); dock() }
  win.once('ready-to-show', show)
  setTimeout(show, 4000)
  win.on('closed', () => { win = null; clickThrough?.dispose() })
  // type:'panel' already floats over full-screen apps on every Space; this is the belt-and-braces flag (build B1).
  if (process.platform === 'darwin' && flags['all-workspaces']) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }
  if (DEBUG) wc.openDevTools({ mode: 'detach' })
  wc.loadURL(ENTRY).catch(error => consoleLog.push({ level: 'error', message: `loadURL: ${error.message}` }))
}

function refreshTray() { tray?.refresh() }
function trayActions() {
  return {
    copyRoom: () => settings.room && clipboard.writeText(settings.room),
    // The popover's room field: remembered, and the page reconnects into it (config is re-read on reload).
    setRoom: room => {
      settings.room = typeof room === 'string' && room.trim() ? room.trim() : null
      saveSettings(); refreshTray(); win?.webContents.reload()
    },
    setSeat: seat => { settings.seat = seat; saveSettings(); refreshTray(); win?.webContents.reload() },
    // Sharing changes from the popover land in settings.json `share` (L3b's catalog filter reads it).
    setShare: patch => setShare(patch),
    // "Sitting: side by side / across the table": the page's brain tells the relay; no reload.
    setSit: sit => {
      settings.sit = sit === 'across' ? 'across' : 'side'
      saveSettings(); refreshTray()
      if (win && !win.isDestroyed()) win.webContents.send('petpack:panel-command', { cmd: 'sit', sit: settings.sit })
    },
    setDock: side => {
      if (side === settings.dock) return
      settings.dock = side; saveSettings(); dock(); refreshTray(); win?.webContents.reload()
    },
    nudge: dy => {
      settings.align = dy === 'reset' ? 0 : Math.max(-2000, Math.min(2000, (settings.align || 0) + dy))
      saveSettings(); dock(); refreshTray()
    },
    registerCodex: async () => {
      const result = await registerMcp({ root: ROOT, profile: PROFILE, force: true })
      codexState = result.state; refreshTray()
    },
    quit: () => app.quit(),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// --smoke <dir>: capture.png + smoke.json, exit 0 only with no console errors and a pane that drew (build B12).

const SMOKE = typeof flags.smoke === 'string' ? path.resolve(flags.smoke) : null
async function runSmoke() {
  const waitMs = Number(flags['smoke-wait']) > 0 ? Number(flags['smoke-wait']) * 1000 : 9000
  await new Promise(resolve => {
    if (!win.webContents.isLoading()) resolve()
    else win.webContents.once('did-finish-load', resolve)
  })
  await new Promise(resolve => setTimeout(resolve, waitMs))
  fs.mkdirSync(SMOKE, { recursive: true })
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(SMOKE, 'capture.png'), image.toPNG())
  if (process.platform === 'linux') { // the whole screen, to show where the pane docked (no permission prompt on X11)
    try {
      const { size } = screen.getPrimaryDisplay()
      const [source] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
      if (source) fs.writeFileSync(path.join(SMOKE, 'desktop.png'), source.thumbnail.toPNG())
    } catch (error) { log(`desktop capture failed: ${error.message}`) }
  }
  const bitmap = image.toBitmap()
  let opaque = 0
  const colours = new Set()
  for (let i = 0; i < bitmap.length; i += 4) {
    if (bitmap[i + 3] > 8) { opaque++; if (i % 64 === 0) colours.add(bitmap.readUInt32LE(i)) }
  }
  const pixels = bitmap.length / 4
  let webgl = null
  try {
    webgl = await win.webContents.executeJavaScript(`(() => { const c = document.createElement('canvas');
      const gl = c.getContext('webgl2'); if (!gl) return null; const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { version: gl.getParameter(gl.VERSION), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) } })()`)
  } catch {}
  let bridge = null
  try {
    bridge = await win.webContents.executeJavaScript(`(() => { const p = window.petpack; return p ? { keys: Object.keys(p).sort(), config: p.config } : null })()`)
  } catch {}
  let me = null
  try {
    const m = await codex.getMe()
    me = { id: m.id, petName: m.petName, displayName: m.displayName, sprite: Boolean(m.spriteUrl), atlas: m.atlas ?? null,
      skills: m.skills?.length ?? 0 }
  } catch (error) { me = { error: error.message } }
  const display = screen.getDisplayMatching(win.getBounds())
  const bounds = win.getBounds()
  const errors = consoleLog.filter(e => e.level === 'error')
  const drew = opaque > pixels * 0.2 && colours.size > 8
  const result = {
    ok: errors.length === 0 && drew,
    version: VERSION, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, arch: process.arch,
    gpu: { featureStatus: app.getGPUFeatureStatus(), webgl },
    scaleFactor: display.scaleFactor, display: { bounds: display.bounds, workArea: display.workArea },
    dock: settings.dock, align: settings.align, bounds, contentSize: win.getContentSize(),
    edgeGap: edgeGap(bounds, display.workArea, settings.dock),
    topFraction: (bounds.y - display.bounds.y) / display.bounds.height,
    expected: dockBounds({ display, dock: settings.dock, align: settings.align, top: topFraction, scale: paneScale }),
    isAlwaysOnTop: win.isAlwaysOnTop(), isVisible: win.isVisible(),
    ipc: ipcServer ? { endpoint: ipcServer.endpoint || ipcServer.path || null } : null,
    codex: codex.loaded, me, bridge,
    drew: { opaqueFraction: +(opaque / pixels).toFixed(3), sampledColours: colours.size },
    errors, warnings: consoleLog.filter(e => e.level === 'warning').slice(0, 50),
  }
  fs.writeFileSync(path.join(SMOKE, 'smoke.json'), JSON.stringify(result, null, 2))
  console.log(`petpack smoke: ${result.ok ? 'ok' : 'FAILED'} (${errors.length} console errors, drew ${result.drew.opaqueFraction}) -> ${SMOKE}`)
  app.exit(result.ok ? 0 : 1)
}

// ---------------------------------------------------------------------------------------------------------------

app.on('second-instance', () => { if (win && !win.isDestroyed()) { dock(); win.showInactive() } })
app.on('window-all-closed', () => app.quit())
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault())
})
// The person's Codex pet goes back to Codex before we exit (L3a releasePet), at most 2 s.
let petTaken = false
let releasing = false
app.on('before-quit', event => {
  if (!petTaken || !codex?.releasePet) return
  event.preventDefault()
  petTaken = false
  releasing = true
  Promise.race([Promise.resolve().then(() => codex.releasePet()), new Promise(resolve => setTimeout(resolve, 2000))])
    .catch(error => console.error(`petpack: pet not handed back (${error.message})`))
    .finally(() => { releasing = false; app.quit() })
})
app.on('before-quit', () => { if (!releasing) try { ipcServer?.close?.() } catch {} })

// ---------------------------------------------------------------------------------------------------------------
// Codex events (L3a): an OS notification with our pet's face, click -> that thread in the Codex app.

let petFace = null // nativeImage of our pet's first frame; false = none; null = not read yet
async function petIcon() {
  if (petFace === null) {
    petFace = false
    try {
      const me = await codex.getMe()
      if (typeof me.spriteUrl === 'string' && me.spriteUrl.startsWith('data:')) {
        const sheet = nativeImage.createFromDataURL(me.spriteUrl)
        const { width, height } = sheet.getSize()
        const cellW = Number(me.atlas?.cellW) || Math.floor(width / (Number(me.atlas?.cols) || 8))
        const cellH = Number(me.atlas?.cellH) || Math.floor(height / (Number(me.atlas?.rows) || 9))
        if (cellW > 0 && cellH > 0) petFace = sheet.crop({ x: 0, y: 0, width: cellW, height: cellH }).resize({ width: 128 })
      }
    } catch { petFace = false }
  }
  return petFace || undefined
}
// The page sends our pet's first frame as a PNG (it decodes WebP sheets; nativeImage can't).
ipcMain.on('petpack:face', (event, dataUrl) => {
  if (!trusted(event) || !/^data:image\/png;base64,/.test(String(dataUrl))) return
  try { const face = nativeImage.createFromDataURL(dataUrl); if (!face.isEmpty()) petFace = face } catch { /* keep the old one */ }
})
const notifications = new Set() // held until clicked or closed (a collected notification loses its click)
function startCodexEvents() {
  return codex.onCodexEvent(async ev => {
    if (!ev?.type) return
    if (win && !win.isDestroyed()) win.webContents.send('petpack:codex-event', { type: ev.type, title: ev.title || null, at: ev.at || Date.now() })
    if (SMOKE || !['done', 'waiting', 'failed'].includes(ev.type) || !Notification.isSupported()) return
    const message = ev.message || { title: 'Codex', body: ev.title || '' }
    const note = new Notification({ title: message.title, body: message.body || '', icon: await petIcon(), silent: false })
    const drop = () => notifications.delete(note)
    note.on('click', () => { drop(); Promise.resolve(codex.openCodex({ session: ev.session, threadId: ev.threadId })).catch(() => {}) })
    note.on('close', drop)
    notifications.add(note)
    note.show()
  })
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  protocol.handle('petpack', serve)
  if (process.platform === 'darwin') app.dock?.hide()
  await loadCodex()
  await startChat() // before the page loads, so its handlers exist; it also allows our page the microphone
  createWindow()
  onDockSide?.(side => trayActions().setDock(side)) // COLLAPSE: dragged onto the other edge
  const stopStatus = startStatus()
  const stopEvents = startCodexEvents()
  app.on('before-quit', () => { if (!releasing) try { stopStatus?.(); stopEvents?.(); codex.dispose(); codexLink?.close() } catch {} })
  if (!SMOKE && codex.takeOverPet) { // the actual Codex pet comes over to petpack while it runs (--no-takeover: not)
    const enabled = !flags['no-takeover']
    Promise.resolve().then(() => codex.takeOverPet({ enabled })).then(r => { petTaken = enabled && r?.ok !== false; log('takeover', r) })
      .catch(error => console.error(`petpack: couldn't take over the Codex pet (${error.message})`))
  }
  await startCodexLink()
  startMcpIpc()
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => dock())
  if (process.platform === 'win32') setInterval(() => win && raiseToTop(win), 10000)
  if (SMOKE) { runSmoke().catch(error => { console.error(error); app.exit(1) }); return }
  tray = createTray({ state: () => ({ room: settings.room, seat: settings.seat, dock: settings.dock, sit: settings.sit === 'across' ? 'across' : 'side',
    align: settings.align, codex: codexState }), actions: trayActions(), pane: () => win, userData: USER_DATA,
    // A new pet from the tray: the page re-reads getMe() and re-sends its sprite (no reload, the walk goes on).
    onPetChange: () => { petFace = null; if (win && !win.isDestroyed()) win.webContents.send('petpack:me-changed') } })
  if (codexLink) { codexState = codexLink.state().status === 'unregistered' ? 'unregistered' : 'registered'; refreshTray() }
  else codexMcpState(ROOT).then(state => { codexState = state; refreshTray() }).catch(() => {})
  log('ready', { userData: USER_DATA, profile: PROFILE, relays, os: os.release() })
})
