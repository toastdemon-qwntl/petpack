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
const sprite = await spriteUpload(me.spriteUrl, me.atlas)

const startSeat = Number.isInteger(config.seat) ? config.seat : 0
const world = createWorld(viewport, { seat: startSeat, dock, pixelScale: 2, autoRender: false })
// Joy decorators (sound, play, mood) attach before any pet is upserted, and only once this world
// build has the joy moments; a world without them never requests the modules (no 404s).
const joy = { muted: false }
if (['celebrate', 'knock', 'handshake'].some(name => typeof world[name] === 'function')) {
  const attach = async (file, name, ...args) => {
    try {
      const module = await import(file)
      if (typeof module[name] === 'function') return (await module[name](world, ...args)) || world
    } catch (error) { console.warn(`petpack: ${file} unavailable`, error?.message || error) }
    return null
  }
  joy.sound = await attach('./world/sound.js', 'attachSound')
  joy.play = await attach('./world/play.js', 'attachPlay', { container: viewport })
  joy.mood = await attach('./world/mood.js', 'attachMood')
}
joy.mute = () => { joy.muted = !joy.muted; world.setMuted?.(joy.muted); flash(joy.muted ? 'sound off' : 'sound on') }
let net = null
// Render-side state the brain's view callbacks touch (declared before the brain exists).
const shown = new Map() // id -> upserted info key
const shownX = new Map() // id -> displayed x
const textQueue = []
let textBusyUntil = 0
let shownMe = null
const brain = createBrain({
  bridge,
  net: { send: msg => net?.send(msg) ?? false },
  me: { id: myId, name: config.name || me.displayName || me.petName || 'Pip', spriteUrl: me.spriteUrl || null, atlas: me.atlas || null,
    skills: Array.isArray(me.skills) ? me.skills : [], catalog, sprite },
  config: { demo, seat: config.seat, dock, room: config.room || null },
  view: {
    // One text bubble per pane at a time, and only for pets this pane shows.
    ask: (a, b, o) => queueText({ ids: [a, b], hold: 4800, first: true, run: () => world.ask(a, b, o) }),
    gift: (a, b, o) => world.gift(a, b, { ...o, label: '' }),
    collab: (a, b, o) => world.collab(a, b, o),
    say: (id, text) => queueText({ ids: [id], hold: 2800, run: () => world.say(id, text) }),
    seat: seat => { world.setSeat(seat); flash(`seat ${seat + 1}`) },
    seats: ({ seat }) => flash(`seat ${seat + 1}`),
    // Joy (world lanes; every call optional until they land).
    knock: (id, on) => withPet(id, () => world.knock?.(id, on)),
    weather: (id, kind) => withPet(id, () => world.weather?.(id, kind)),
    celebrate: id => withPet(id, () => world.celebrate?.(id)),
    sleep: (id, on) => withPet(id, () => world.sleep?.(id, on)),
    hat: (id, level) => withPet(id, () => world.setHat?.(id, level)),
    arrive: id => withPet(id, () => world.arrive?.(id, 'balloon')),
    throwPet: (id, v) => withPet(id, () => world.throwPet?.(id, v)),
    bloom: bloom => world.bloom?.(bloom),
    garden: list => world.setGarden?.(list),
    // The link reaches both panes together (welcome + seat broadcast); a fixed beat lets both pets arrive first.
    handshake: info => setTimeout(() => withPet(myId, () => world.handshake?.(info)), 1200),
    conga: (ids, startAt) => world.conga?.(ids, { startAt: worldTimeOf(startAt) }),
  },
})
// Per-pet effects wait until that pet is in this pane's world.
const petWaiters = new Map()
function withPet(id, fn) {
  if (shown?.has(id)) { try { fn() } catch (error) { console.warn('petpack joy', error) } return }
  const list = petWaiters.get(id) || []
  list.push(fn)
  petWaiters.set(id, list.slice(-6))
}
// Shared moments carry wall-clock times; the world runs on this page's frame clock (seconds).
const worldTimeOf = epochMs => (Number.isFinite(epochMs) ? performance.now() + (epochMs - Date.now()) : performance.now()) / 1000
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

// ---- text bubbles: one at a time per pane; asks first; stale lines dropped ----



function inView(id) {
  const x = shownX.get(id)
  return x != null && Math.abs(x - brain.seat * CHUNK_W) <= CHUNK_W / 2 + 0.4
}
function queueText(entry) {
  if (!entry.ids.some(inView)) return Promise.resolve(false)
  entry.at = performance.now()
  if (entry.first) textQueue.unshift(entry)
  else { textQueue.push(entry); if (textQueue.length > 3) textQueue.splice(textQueue.findIndex(e => !e.first), 1) }
  return new Promise(resolve => { entry.resolve = resolve; pumpText() })
}
function pumpText() {
  const now = performance.now()
  while (textQueue.length && now >= textBusyUntil) {
    const entry = textQueue.shift()
    if (now - entry.at > (entry.first ? 6000 : 4000) || !entry.ids.some(inView)) { entry.resolve(false); continue }
    textBusyUntil = now + entry.hold
    Promise.resolve(entry.run()).then(entry.resolve, () => entry.resolve(false))
  }
}

// ---- draw loop: the brain advances on every frame; a slow timer keeps it alive when hidden ----

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
    shownX.set(p.id, p.x)
    if (p.isMe) shownMe = p
    // Only peers' sprites live on the relay; our own sheet is local (data: or petpack://).
    const spriteUrl = p.spriteUrl && !p.local ? relayAsset(relayUrl || DEFAULT_RELAY, p.spriteUrl) : p.spriteUrl
    const info = { displayName: p.displayName, color: p.color, kind: p.kind, spriteUrl: spriteUrl || null, skillCount: p.skillCount, isMe: p.isMe }
    if (p.atlas) info.atlas = p.atlas
    const key = JSON.stringify(info)
    if (shown.get(p.id) !== key) { world.upsertPet(p.id, info); shown.set(p.id, key) }
    world.updatePet(p.id, { x: p.x, z: p.z, facing: p.facing, anim: p.anim, status: p.status, speed: p.speed, snap: true })
    const waiting = petWaiters.get(p.id)
    if (waiting) { petWaiters.delete(p.id); for (const fn of waiting) { try { fn() } catch (error) { console.warn('petpack joy', error) } } }
  }
  for (const id of [...shown.keys()]) if (!seen.has(id)) { world.removePet(id); shown.delete(id); shownX.delete(id) }
}

function frame(now) {
  const dt = advance(now)
  syncPets()
  pumpText()
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
  // Only when our pet is on no screen beside ours: in our chunk or on a seated neighbour, you can see it.
  const mine = brain.me
  const x = shownMe ? shownMe.x : mine.x
  const chunk = chunkOf(x)
  const visible = chunk === brain.seat || (Math.abs(chunk - brain.seat) === 1 && brain.isSeated(chunk))
  if (visible) { edge.classList.remove('on'); return }
  const side = x < brain.seat * CHUNK_W ? 'left' : 'right'
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
  const id = world.playHitTest?.(event.clientX, event.clientY) ?? world.pick(event.clientX, event.clientY)
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
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 'p' && !event.shiftKey) { takePhoto(); return }
  if (key === 'm') { joy.mute?.(); return }
  if (key === 'c' || (key === 'p' && event.shiftKey)) { brain.party(); return }
  if (performance.now() > selectedUntil) return
  if (event.key === 'ArrowLeft') brain.moveSeatRequest(-1)
  else if (event.key === 'ArrowRight') brain.moveSeatRequest(1)
})

// Throwing: our own pet (and local demo bots) land where they're thrown; other panes replay the throw.
world.onThrow?.((event = {}) => {
  const to = event.to && Number.isFinite(event.to.x) ? { x: event.to.x, z: event.to.z } : null
  brain.throwPet(event.id, to, event)
})
if (typeof world.setGarden === 'function') world.setGarden(brain.garden)
async function takePhoto() {
  try {
    let shot = await world.photo?.()
    if (!shot) return
    if (shot instanceof Blob) shot = await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(shot) })
    if (typeof shot !== 'string') shot = shot.toDataURL?.('image/png') || shot.dataUrl || shot.url
    if (typeof shot !== 'string') return
    if (bridge.savePhoto) { const saved = await bridge.savePhoto(shot); if (saved?.saved) flash('photo saved to Desktop') }
    else Object.assign(document.createElement('a'), { href: shot, download: `petpack-${Date.now()}.png` }).click()
  } catch (error) { console.warn('petpack photo', error?.message || error) }
}

/** Peers always get a plain 8x9 sheet: crop the top 9 rows of our atlas and re-encode as WebP (~1 MB). */
async function spriteUpload(url, atlas) {
  if (!url || typeof url !== 'string') return null
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    const cols = Number(atlas?.cols) || 8
    const rows = Number(atlas?.rows) || Math.max(9, Math.round(image.naturalHeight / (image.naturalWidth / cols / 192 * 208)))
    const cellW = Number(atlas?.cellW) || Math.floor(image.naturalWidth / cols)
    const cellH = Number(atlas?.cellH) || Math.floor(image.naturalHeight / rows)
    const canvas = document.createElement('canvas')
    canvas.width = cellW * 8
    canvas.height = cellH * 9
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9))
    if (!blob) return null
    const raw = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < raw.length; i += 0x8000) bin += String.fromCharCode(...raw.subarray(i, i + 0x8000))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
    const sha = [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
    return { sha, b64: btoa(bin) }
  } catch (error) { console.warn('petpack sprite upload skipped', error?.message || error); return null }
}

window.addEventListener('pagehide', () => { net?.close() })
window.petpackApp = { brain, world, get net() { return net }, call: (tool, args) => brain.call(tool, args), ready: true }
