// The page the Electron window loads: one seat of the shared world, drawn as the locked glass pane,
// wired to window.petpack (the preload bridge, or mock-bridge.js in a plain browser).
import { createWorld } from './world/index.js'
import { createBrain, CHUNK_W, chunkOf } from './brain.js'
import { createNet, DEFAULT_RELAY, relayAsset } from './net.js'

if (!window.petpack) (await import('./mock-bridge.js')).installMockBridge()
const bridge = window.petpack
const config = bridge.config || {}
const demo = !!config.demo
const dock = config.dock === 'left' ? 'left' : 'right'
const relayUrl = config.relayUrl === undefined ? DEFAULT_RELAY : config.relayUrl

const sheet = new CSSStyleSheet()
sheet.replaceSync(`
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
body.petpack-app .petpack-pane { position: fixed; top: 0; width: 100vw; height: 100vh; max-width: none; aspect-ratio: auto;
  --pane-inset: 4px; --pane-radius: 22px; user-select: none; -webkit-user-select: none; }
/* The plain-browser mock shows the pane as it sits on a desktop: 416x312 at 20 % height. */
.petpack-mock body { background: radial-gradient(120% 90% at 30% 10%, #e8eef3, #c9d3dc); }
.petpack-mock body.petpack-app .petpack-pane { top: 20vh; width: min(416px, 100vw); height: min(312px, 100vh); }
.pp-badge { position: absolute; z-index: 8; top: 10px; left: 50%; transform: translateX(-50%); padding: 3px 10px; border-radius: 999px;
  font: 600 11px/16px ui-rounded, system-ui, sans-serif; color: #24323d; background: #ffffffd9; box-shadow: 0 2px 8px #0c1d3326;
  opacity: 0; transition: opacity .25s; pointer-events: none; white-space: nowrap; }
.pp-badge.on { opacity: 1; }
.pp-edge { position: absolute; z-index: 7; top: 50%; transform: translateY(-50%); padding: 3px 7px; border-radius: 999px;
  font: 600 10px/14px ui-rounded, system-ui, sans-serif; color: #fff; opacity: 0; transition: opacity .3s; pointer-events: none; }
.pp-edge.on { opacity: .92; }
.pp-edge[data-side='left'] { left: 6px; }
.pp-edge[data-side='right'] { right: 6px; }
`)
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
document.body.classList.add('petpack-app')

const pane = document.querySelector('.petpack-pane')
pane.dataset.dock = dock
const viewport = pane.querySelector('.world-viewport')
const badge = Object.assign(document.createElement('div'), { className: 'pp-badge' })
const edge = Object.assign(document.createElement('div'), { className: 'pp-edge' })
viewport.append(badge, edge)

let me = {}
try { me = (await bridge.getMe?.()) || {} } catch (error) { console.warn('petpack getMe', error) }
let catalog = []
try { catalog = (await bridge.getCatalog?.()) || [] } catch { catalog = [] }
const myId = me.id || `pet-${Math.random().toString(36).slice(2, 10)}`
const sprite = await spriteUpload(me.spriteUrl)

const startSeat = Number.isInteger(config.seat) ? config.seat : 0
const world = createWorld(viewport, { seat: startSeat, dock, pixelScale: 2, autoRender: false })
let net = null
const brain = createBrain({
  bridge,
  net: { send: msg => net?.send(msg) ?? false },
  me: { id: myId, name: config.name || me.displayName || me.petName || 'Pip', spriteUrl: me.spriteUrl || null,
    skills: Array.isArray(me.skills) ? me.skills : [], catalog, sprite },
  config: { demo, seat: config.seat, dock, room: config.room || null },
  view: {
    ask: (a, b, o) => world.ask(a, b, o),
    gift: (a, b, o) => world.gift(a, b, o),
    collab: (a, b, o) => world.collab(a, b, o),
    say: (id, text) => world.say(id, text),
    seat: seat => { world.setSeat(seat); flash(`seat ${seat + 1}`) },
    seats: ({ seat }) => flash(`seat ${seat + 1}`),
  },
})
if (demo) brain.addBots()
if (relayUrl) {
  net = createNet({ url: relayUrl, hello: () => brain.hello(), onMessage: msg => brain.handle(msg), onStatus: s => brain.netStatus(s) })
  net.connect()
} else brain.netStatus('solo')

bridge.onStatus?.(s => brain.setStatus(typeof s === 'string' ? s : s?.status))
bridge.onAgentCall?.(async (a, b) => {
  const request = a && typeof a === 'object' && 'tool' in a ? a : { tool: a, args: b }
  return brain.call(request.tool, request.args || {})
})

// ---- draw loop: the brain advances on every frame; a slow timer keeps it alive when hidden ----
const shown = new Map()
let last = performance.now()
let lastTick = last
function advance(now) {
  const dt = Math.min(0.25, Math.max(0, (now - last) / 1000))
  last = now
  lastTick = now
  brain.tick(dt)
  return dt
}
function syncPets() {
  const seen = new Set()
  for (const p of brain.pets()) {
    seen.add(p.id)
    const spriteUrl = p.spriteUrl && !p.spriteUrl.startsWith('data:') ? relayAsset(relayUrl || DEFAULT_RELAY, p.spriteUrl) : p.spriteUrl
    const info = { displayName: p.displayName, color: p.color, kind: p.kind, spriteUrl: spriteUrl || null, skillCount: p.skillCount, isMe: p.isMe }
    const key = JSON.stringify(info)
    if (shown.get(p.id) !== key) { world.upsertPet(p.id, info); shown.set(p.id, key) }
    world.updatePet(p.id, { x: p.x, z: p.z, facing: p.facing, anim: p.anim, status: p.status, speed: p.speed, snap: true })
  }
  for (const id of [...shown.keys()]) if (!seen.has(id)) { world.removePet(id); shown.delete(id) }
}
function frame(now) {
  const dt = advance(now)
  syncPets()
  world.renderFrame(dt, now / 1000)
  edgeMarker()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
setInterval(() => { const now = performance.now(); if (now - lastTick > 250) advance(now) }, 100)

// ---- pane chrome: seat flash and the edge marker toward our own roaming pet ----
let flashTimer = 0
function flash(text) {
  badge.textContent = text
  badge.classList.add('on')
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => badge.classList.remove('on'), 2000)
}
function edgeMarker() {
  const mine = brain.me
  const off = chunkOf(mine.x) !== brain.seat || Math.abs(mine.x - brain.seat * CHUNK_W) > CHUNK_W / 2
  if (!off) { edge.classList.remove('on'); return }
  const side = mine.x < brain.seat * CHUNK_W ? 'left' : 'right'
  edge.dataset.side = side
  edge.style.background = mine.color
  edge.textContent = side === 'left' ? `◀ ${mine.name}` : `${mine.name} ▶`
  edge.classList.add('on')
}

// ---- input: pets catch the cursor, empty glass passes clicks through ----
let interactive = null
let selectedUntil = 0
let hoverSaid = 0
window.addEventListener('mousemove', event => {
  const id = world.pick(event.clientX, event.clientY)
  const want = !!id
  if (want !== interactive) { interactive = want; try { bridge.setInteractive?.(want) } catch { /* bridge gone */ } }
  if (id === myId && performance.now() - hoverSaid > 6000) {
    hoverSaid = performance.now()
    world.say(myId, brain.room ? `room ${brain.room}` : 'solo')
  }
})
window.addEventListener('mouseleave', () => { if (interactive) { interactive = false; try { bridge.setInteractive?.(false) } catch { /* ignore */ } } })
window.addEventListener('click', event => {
  if (world.pick(event.clientX, event.clientY) === myId) { selectedUntil = performance.now() + 6000; world.say(myId, '← → to move seat') }
})
window.addEventListener('keydown', event => {
  if (performance.now() > selectedUntil) return
  if (event.key === 'ArrowLeft') brain.moveSeatRequest(-1)
  else if (event.key === 'ArrowRight') brain.moveSeatRequest(1)
})

async function spriteUpload(url) {
  if (!url || typeof url !== 'string') return null
  try {
    let b64
    if (url.startsWith('data:')) b64 = url.slice(url.indexOf(',') + 1)
    else {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      b64 = btoa(bin)
    }
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
    const sha = [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
    return { sha, b64 }
  } catch { return null }
}

window.addEventListener('pagehide', () => { net?.close() })
window.petpackApp = { brain, world, get net() { return net }, call: (tool, args) => brain.call(tool, args), ready: true }
