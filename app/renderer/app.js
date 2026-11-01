// The page the Electron window loads: one seat of the shared world, drawn as the locked glass pane,
// wired to window.petpack (the preload bridge, or mock-bridge.js in a plain browser).
import { createWorld } from './world/index.js'
import { createBrain, CHUNK_W, chunkOf } from './brain.js'
import { createNet, relayAsset } from './net.js'
import { RELAYS } from '../../shared/protocol.js'

if (!window.petpack) (await import('./mock-bridge.js')).installMockBridge()
const bridge = window.petpack
const config = bridge.config || {}
const demo = !!config.demo
const dock = config.dock === 'left' ? 'left' : 'right'
// Relays in failover order: the shell's list, else one --relay URL, else the built-in list; null/'' = no relay.
const relays = Array.isArray(config.relays) && config.relays.length ? config.relays
  : config.relayUrl === undefined ? [...RELAYS] : config.relayUrl ? [config.relayUrl] : []

const sheet = new CSSStyleSheet()
sheet.replaceSync(`
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
body.petpack-app .petpack-pane { position: fixed; top: 0; width: 100vw; height: 100vh; max-width: none; aspect-ratio: auto;
  --pane-inset: 0px; --pane-radius: 22px; user-select: none; -webkit-user-select: none; }
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
.pp-offline { position: absolute; z-index: 7; top: 10px; left: 12px; padding: 1px 7px; border-radius: 999px;
  font: 600 9px/12px ui-rounded, system-ui, sans-serif; color: #24323d; background: #ffffffa8; opacity: 0; transition: opacity .4s; pointer-events: none; }
.pp-offline.on { opacity: .75; }
`)
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
document.body.classList.add('petpack-app')

const pane = document.querySelector('.petpack-pane')
pane.dataset.dock = dock
const viewport = pane.querySelector('.world-viewport')
const badge = Object.assign(document.createElement('div'), { className: 'pp-badge' })
const edge = Object.assign(document.createElement('div'), { className: 'pp-edge' })
const offline = Object.assign(document.createElement('div'), { className: 'pp-offline', textContent: 'offline' })
viewport.append(badge, edge, offline)
// No relay reachable (and not a demo): a quiet pane, its own pet, one tiny cue; the client keeps retrying.
function offlineCue(state) { offline.classList.toggle('on', !demo && (state === 'solo' || state === 'offline')) }

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
joy.setMuted = (on, quiet) => {
  joy.muted = !!on; world.setMuted?.(joy.muted)
  if (!quiet) flash(joy.muted ? 'sound off' : 'sound on')
  bridge.panelReport?.({ muted: joy.muted })
}
joy.mute = () => joy.setMuted(!joy.muted)
// LIFE (life.js): the free-time effects overlay (sparks, pages, embers) the brain's 'life' calls draw.
try { (await import('./life.js')).attachLifeFx?.(world, { container: viewport }) } catch (error) { console.warn('petpack: life fx unavailable', error?.message || error) }
let net = null
// Render-side state the brain's view callbacks touch (declared before the brain exists).
const shown = new Map() // id -> upserted info key
const shownX = new Map() // id -> displayed x
const textQueue = []
let textBusyUntil = 0
let shownMe = null
// A teammate's question our catalog can't answer at once (no tier-1 answer within 1.5 s, or none at all) opens in
// the Codex app as a new thread, once per question; the answer comes back through petpack_answer (inbox id).
const brainBridge = typeof bridge.answerAsk !== 'function' ? bridge : Object.assign({}, bridge, {
  answerAsk(request = {}) {
    const answering = Promise.resolve(bridge.answerAsk(request))
    const entry = [...(brain._?.inbox?.values?.() || [])].find(e => !e.answered && e.question === String(request.question || '').slice(0, 600))
    if (entry && bridge.askInCodex) {
      const toCodex = () => bridge.askInCodex({ id: entry.id, fromName: entry.fromName, question: entry.question }).catch(() => {})
      const timer = setTimeout(toCodex, 1500)
      answering.then(r => { clearTimeout(timer); if (r && r.ok === false && !entry.answered && !r.busy) toCodex() }, () => clearTimeout(timer))
    }
    return answering
  },
})
// Today's own help count (answers given, items shared) survives a restart; the brain drops yesterday's.
const HELPED_KEY = 'petpack:helped'
function readHelped() {
  try { const v = JSON.parse(localStorage.getItem(HELPED_KEY) || 'null'); return v && typeof v === 'object' ? v : null } catch { return null }
}
const brain = createBrain({
  bridge: brainBridge,
  net: { send: msg => net?.send(msg) ?? false },
  me: { id: myId, name: config.name || me.displayName || me.petName || 'Pip', spriteUrl: me.spriteUrl || null, atlas: me.atlas || null,
    skills: Array.isArray(me.skills) ? me.skills : [], catalog, sprite },
  config: { demo, seat: config.seat, dock, room: config.room || null, sharing: config.sharing || null, dnd: !!config.dnd,
    sit: config.sit === 'across' ? 'across' : 'side', device: config.device || null, nextTo: config.nextTo || null,
    helpVisits: !!config.helpVisits, helped: readHelped() },
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
// LIFE: the brain relays life's world calls (ours and peers'); each waits for its pet to be in this pane.
const LIFE_CALLS = new Set(['lifeFx', 'sleep', 'weather', 'celebrate', 'knock'])
brain.on?.('life', ({ method, args = [] } = {}) => {
  if (LIFE_CALLS.has(method) && typeof world[method] === 'function') withPet(args[0], () => world[method](...args))
})
// Shared moments carry wall-clock times; the world runs on this page's frame clock (seconds).
const worldTimeOf = epochMs => (Number.isFinite(epochMs) ? performance.now() + (epochMs - Date.now()) : performance.now()) / 1000
if (demo) {
  brain.addBots()
  dressBots() // they start as built-in pixel pets and put on real Codex pets as soon as those load
}
// The relay files our own test runs (it-*, s1*, rel*, smoke*, l2*, pair*, wire* profiles) in its scratch room (L1).
const helloExtra = config.profile
  ? { profile: String(config.profile), ...(/^(it-|s1|rel|smoke|l2|pair|wire)/i.test(String(config.profile)) ? { test: true } : {}) }
  : {}
function connectNet() {
  net?.close()
  net = createNet({ urls: relays, hello: () => ({ ...brain.hello(), ...helloExtra }), onMessage: msg => brain.handle(msg), onStatus: s => { brain.netStatus(s); offlineCue(s) } })
  net.connect()
}
if (relays.length) connectNet()
else { brain.netStatus('solo'); offlineCue('solo') }

/** Demo bots wear real Codex pets (built-ins first, distinct, never the person's own). */
async function dressBots() {
  try {
    const all = (await bridge.listPets?.()) || []
    const usable = all.filter(p => p && p.spriteUrl && p.available !== 'no' && !p.current && p.spriteUrl !== me.spriteUrl)
    const favourites = ['dewey', 'fireball', 'bsod', 'rocky', 'seedy', 'stacky', 'null-signal', 'nullsignal', 'codex']
    const rank = p => { const i = favourites.indexOf(String(p.id || p.displayName || '').toLowerCase().replace(/\s+/g, '-')); return i < 0 ? 99 : i }
    usable.sort((a, b) => (a.source === 'builtin' ? 0 : 1) - (b.source === 'builtin' ? 0 : 1) || rank(a) - rank(b))
    brain.dressBots(usable.map(p => ({ displayName: p.displayName, spriteUrl: p.spriteUrl, atlas: p.atlas })))
  } catch (error) { console.warn('petpack: bots keep their pixel pets', error?.message || error) }
}
// The person picked another pet in the tray: our pet changes in place and the room gets the new sprite.
bridge.onMeChanged?.(async () => {
  try {
    const fresh = (await bridge.getMe?.()) || {}
    const sprite = await spriteUpload(fresh.spriteUrl, fresh.atlas)
    me.spriteUrl = fresh.spriteUrl
    sendFace(fresh.spriteUrl, fresh.atlas)
    brain.setMe({ name: config.name || fresh.displayName || fresh.petName, spriteUrl: fresh.spriteUrl || null, atlas: fresh.atlas || null,
      skills: Array.isArray(fresh.skills) ? fresh.skills : undefined, sprite })
    if (relays.length) connectNet() // hello carries the new sprite; the relay keeps our seat for the same id
  } catch (error) { console.warn('petpack: pet change', error?.message || error) }
})

bridge.onStatus?.(s => { brain.setStatus(typeof s === 'string' ? s : s?.status); refreshTask() })
// L3a: what Codex is working on. Our own name tag reads "Pip · fixing tests" (<= 32) while it works.
let taskTitle = null
let taskCaption = null
// The world's pixel font is plain ASCII (no "·" or "…"), and the tag wraps past ~24 characters.
function nameTag(name, caption) {
  const clean = String(caption).replace(/[^\x20-\x7e]+/g, ' ').replace(/\s*\([^)]*$/, '').replace(/\s+/g, ' ').trim()
  if (!clean) return name
  const s = `${name} - ${clean}`
  return s.length <= 24 ? s : s.slice(0, 25).replace(/\s+\S*$/, '').replace(/[\s,.;:-]+$/, '')
}
let taskBusy = false
async function refreshTask() {
  if (taskBusy || !bridge.currentTask) return
  taskBusy = true
  try {
    const task = await bridge.currentTask()
    taskTitle = task?.title ? String(task.title).replace(/\s+/g, ' ').trim() : null
    const working = (brain.me?.status || task?.status) === 'working'
    taskCaption = working && taskTitle ? taskTitle.charAt(0).toLowerCase() + taskTitle.slice(1) : null
  } catch { taskCaption = null } finally { taskBusy = false }
}
bridge.onCodexEvent?.(() => refreshTask())
setInterval(refreshTask, 5000)
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
  const list = brain.pets()
  for (const p of list) {
    seen.add(p.id)
    shownX.set(p.id, p.x)
    if (p.isMe) shownMe = p
    // Only peers' sprites live on the relay; our own sheet is local (data: or petpack://).
    const spriteUrl = p.spriteUrl && !p.local ? relayAsset(net?.url || relays[0], p.spriteUrl) : p.spriteUrl
    const info = { displayName: p.isMe && taskCaption ? nameTag(p.displayName, taskCaption) : p.displayName, color: p.color, kind: p.kind, spriteUrl: spriteUrl || null, skillCount: p.skillCount, isMe: p.isMe }
    if (p.atlas) info.atlas = p.atlas
    const key = JSON.stringify(info)
    if (shown.get(p.id) !== key) { world.upsertPet(p.id, info); shown.set(p.id, key) }
    world.updatePet(p.id, { x: p.x, z: p.z, facing: p.facing, anim: p.anim, status: p.status, speed: p.speed, snap: true })
    const waiting = petWaiters.get(p.id)
    if (waiting) { petWaiters.delete(p.id); for (const fn of waiting) { try { fn() } catch (error) { console.warn('petpack joy', error) } } }
  }
  for (const id of [...shown.keys()]) if (!seen.has(id)) { world.removePet(id); shown.delete(id); shownX.delete(id) }
  drawDndSigns(list)
  drawTrophy(list)
  drawBoard(performance.now())
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
  // Pets, the share request, the chat field and the zoom pip / zoomed-out strip catch the cursor.
  const want = !!id || !!event.target?.closest?.('.pp-perm, .pp-chat, .pp-mic') || !!zoom?.wantsPointer?.(event.clientX, event.clientY)
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
// ---- right-click: a small menu for our pet, a teammate's pet, or the pane's edge ----
// Empty glass passes clicks through to the desktop, so the menu opens wherever the pane holds the mouse.
window.addEventListener('contextmenu', async event => {
  if (event.target?.closest?.('input, textarea, [contenteditable]')) return // the chat field keeps its own menu
  event.preventDefault()
  if (!bridge.contextMenu) return
  const id = world.playHitTest?.(event.clientX, event.clientY) ?? world.pick(event.clientX, event.clientY)
  const all = brain.pets()
  const them = id && id !== myId ? all.find(p => p.id === id && !p.away) : null
  const others = all.filter(p => !p.isMe && !p.away && (p.local ? demo : true))
  const items = []
  if (them) {
    items.push({ label: `${them.displayName} · ${them.dnd ? 'do not disturb' : them.status || 'idle'}`, enabled: false },
      { id: `wave:${them.id}`, label: `Wave at ${them.displayName}` },
      { id: `visit:${them.id}`, label: `Visit ${them.displayName}` })
    if (!them.local) items.push({ id: `sit:${them.id}`, label: `Sit next to ${them.displayName}` })
    items.push({ type: 'separator' })
  }
  items.push({ id: 'home', label: 'Come home' },
    { label: 'Send away', submenu: [
      ...others.map(p => ({ id: `visit:${p.id}`, label: `Visit ${p.displayName}` })),
      ...(others.length ? [{ type: 'separator' }] : []),
      { id: 'walk', label: 'Go for a walk' },
    ] },
    { id: 'showMe', label: 'Show me' },
    { type: 'separator' },
    { id: 'party', label: 'Party' },
    { id: 'photo', label: 'Take a photo' },
    { type: 'separator' },
    { id: 'helpVisits', label: 'Help stuck teammates', checked: !!brain.helpVisits },
    { id: 'dnd', label: 'Do Not Disturb', checked: !!brain.dnd },
    { id: 'mute', label: 'Mute', checked: !!joy.muted },
    { type: 'separator' },
    { id: 'fold', label: 'Fold pane' })
  let picked = null
  try { picked = await bridge.contextMenu(items) } catch { picked = null }
  if (!picked?.id || picked.handled) return
  const [what, target] = picked.id.split(/:(.*)/s)
  const said = r => { if (r?.message) activity(r.message, 'pet') }
  if (what === 'home') said(brain.recall?.())
  else if (what === 'walk') said(brain.sendAway?.())
  else if (what === 'visit') said(brain.sendAway?.(target))
  else if (what === 'wave') brain.waveAt?.(target)
  else if (what === 'sit') said(brain.coworkWith?.(target))
  else if (what === 'showMe') showMe()
  else if (what === 'party') brain.party?.()
  else if (what === 'photo') takePhoto()
  else if (what === 'fold') collapse?.collapse()
  // No popover to save them (Linux): the live pane still follows.
  else if (what === 'helpVisits') brain.setHelpVisits?.(!brain.helpVisits)
  else if (what === 'dnd') brain.setDnd?.(!brain.dnd)
  else if (what === 'mute') joy.mute?.()
})
window.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (event.target?.closest?.('input, textarea, [contenteditable]')) return // typing in the chat field
  const key = event.key.toLowerCase()
  if (key === 's' && !event.shiftKey) { showMe(); return }
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
// Window collapse (COLLAPSE lane): it opens when a pet walks on; subscribes via brain.on (see brain.js Events).
let collapse = null
import('./collapse.js').then(m => { collapse = m.attachCollapse?.({ world, brain, bridge: window.petpack, root: pane }) || null })
  .catch(error => console.warn('petpack: collapse unavailable', error?.message || error))
// ZOOM (zoom.js): scroll / pinch pulls the camera out over the strip; double-click or the home pip returns.
let zoom = null
import('./zoom.js').then(m => { zoom = m.attachZoom?.({ world, root: viewport, seat: () => brain.seat }) || null })
  .catch(error => console.warn('petpack: zoom unavailable', error?.message || error))
// CHAT (chat.js): click your pet or press Enter to ask it in text; hold Space to talk out loud.
import('./chat.js').then(m => m.attachChat?.({ world, brain, bridge, root: pane }))
  .catch(error => console.warn('petpack: chat unavailable', error?.message || error))

// ---- TRAY popover: commands in, state and activity out ----
bridge.onPanelCommand?.(msg => {
  const { cmd, on } = msg || {}
  if (cmd === 'recall') { const r = brain.recall?.(); if (r?.message) activity(r.message, 'recall') }
  else if (cmd === 'dnd') brain.setDnd?.(!!on)
  else if (cmd === 'helpVisits') brain.setHelpVisits?.(!!on) // the popover logs the change itself
  else if (cmd === 'mute') joy.setMuted(!!on, true)
  else if (cmd === 'party') brain.party?.()
  else if (cmd === 'sit') brain.setSit?.(msg.sit === 'across' ? 'across' : 'side')
  else if (cmd === 'people') reportPeople(true)
  else if (cmd === 'showMe') showMe()
  else if (cmd === 'cowork' && msg.id) {
    Promise.resolve(brain.coworkWith ? brain.coworkWith(msg.id) : { ok: false, message: `couldn't sit next to ${msg.name || 'them'} right now` })
      .catch(error => ({ ok: false, message: String(error?.message || error) }))
      .then(r => { try { bridge.panelReport?.({ cowork: { name: msg.name, ...(r || {}) }, people: panelPeople() }) } catch { /* bridge gone */ } })
  }
  else if (cmd === 'sharing' && msg.sharing) { // main already saved it (settings.json `share`); the live brain follows
    const s = msg.sharing
    brain.setSharing?.({ mode: s.mode === 'off' ? 'never' : s.mode, items: s.items || Object.fromEntries((s.hidden || []).map(ref => [ref, false])) })
  }
})
// Co-work: "← Bea" / "Bea →" tags on the edges toward our seat neighbours (across: under the badge).
const nbTags = Object.fromEntries(['left', 'right', 'across'].map(side => {
  const tag = Object.assign(document.createElement('div'), { className: 'pp-nb' })
  tag.dataset.side = side
  viewport.append(tag)
  return [side, tag]
}))
let nbHintTimer = 0
function showNeighbours(n = {}) {
  for (const side of ['left', 'right', 'across']) {
    const who = n[side]
    const name = typeof who === 'string' ? who : who?.name
    nbTags[side].textContent = !name ? '' : side === 'left' ? `← ${name}` : side === 'right' ? `${name} →` : `across: ${name}`
    nbTags[side].classList.toggle('on', !!name)
  }
}
brain.on?.('neighbours', n => { showNeighbours(n); if (n?.left || n?.right || n?.across) clearTimeout(nbHintTimer) })
brain.on?.('online', info => {
  clearTimeout(nbHintTimer)
  if (!info || demo) return
  nbHintTimer = setTimeout(() => { const n = brain.neighbours || {}; if (!n.left && !n.right && !n.across) flash('no one next to you yet') }, 8000)
})
// Across the table: the later pane of a pair draws the shared seat from the other side.
brain.on?.('flip', on => { world.setFlip?.(!!on); flash(on ? 'across the table' : 'side by side') })
brain.on?.('replaced', () => flash('this pet opened on another pane'))
// "Show me" (tray, popover, S key): the pane opens and the brain brings our pet into view (L2 brain.showMe).
function showMe() {
  if (collapse?.collapsed) collapse.expand()
  zoom?.home?.()
  if (brain.showMe) brain.showMe()
  else { const r = brain.recall?.(); if (r?.message) world.say(myId, r.message) }
}
// S5 live progress: the brain's steps go back to the MCP call (callId) and into the popover's activity.
brain.on?.('step', step => {
  if (!step) return
  const s = typeof step === 'string' ? { text: step } : step
  if (s.callId) try { bridge.agentStep?.(s) } catch { /* bridge gone */ }
  activity(s.text, 'step')
})
function activity(text, kind) { if (text) try { bridge.activity?.({ text: String(text).slice(0, 160), kind }) } catch { /* bridge gone */ } }
// Heads-down: the pane folds and goes quiet; back on, it opens again.
brain.on?.('dnd', on => {
  if (on) collapse?.collapse(); else collapse?.expand()
  joy.setMuted(on, true)
  bridge.panelReport?.({ dnd: !!on })
})
brain.on?.('errand', snap => {
  if (!snap) return
  activity(snap.status === 'running' ? `finding out: ${snap.question}${snap.step ? ` (${snap.step})` : ''}` : snap.message || `errand ${snap.status}`, 'errand')
  bridge.panelReport?.({ errand: snap.status === 'running' ? { kind: snap.kind || 'find', label: snap.question, with: snap.step || null } : null })
})
brain.on?.('involved', info => { if (info?.kind) activity(`${info.kind}${info.with ? ` with ${info.with}` : ''}`, info.kind) })
brain.on?.('visitor-enter', v => { if (v?.name && !v.bot) activity(`${v.name} walked onto this screen`, 'visit') })
brain.on?.('need', n => { if (n?.item?.title) activity(`stuck? ${n.item.title} might help`, 'need') })
brain.on?.('online', info => bridge.panelReport?.({ online: info ? brain.pets().filter(p => !p.bot).length : null }))
/** Everyone online in the room but us, for the popover's co-working list; side = the seat beside ours. */
function panelPeople() {
  const seats = brain._?.seats
  return brain.pets().filter(p => !p.isMe && !p.away).map(p => {
    const seat = seats?.get?.(p.id)
    const side = seat === brain.seat - 1 ? 'left' : seat === brain.seat + 1 ? 'right' : null
    const spriteUrl = p.spriteUrl && !p.local ? relayAsset(net?.url || relays[0], p.spriteUrl) : (p.spriteUrl || null)
    return { id: p.id, name: p.displayName, spriteUrl, atlas: p.atlas || null, status: p.status || 'idle', dnd: !!p.dnd, side, bot: !!p.local }
  })
}
let peopleSig = ''
function reportPeople(force) {
  const people = panelPeople()
  const sig = JSON.stringify(people.map(p => [p.id, p.status, p.dnd, p.side, p.name]))
  if (!force && sig === peopleSig) return
  peopleSig = sig
  try { bridge.panelReport?.({ people }) } catch { /* bridge gone */ }
}
setInterval(() => {
  reportPeople(false) // sprites are big: only when someone arrives, leaves or changes
  const mine = brain.me || {}
  const busyWith = mine.job && mine.job.mode !== 'return' ? (mine.jobWith || null) : null
  try { bridge.panelReport?.({ name: mine.name, status: mine.status, home: chunkOf(mine.x) === brain.seat, dnd: !!brain.dnd, muted: joy.muted, busyWith, task: taskCaption ? taskTitle : null }) } catch { /* bridge gone */ }
}, 2000)

// ---- share permission ('ask' mode): the request with ✓/✗ in the pane ----
const askSheet = new CSSStyleSheet()
askSheet.replaceSync(`
.pp-perm { position: absolute; z-index: 9; left: 50%; bottom: 12px; transform: translateX(-50%); display: flex; gap: 6px; align-items: center;
  max-width: 88%; padding: 5px 6px 5px 11px; border-radius: 999px; background: #fffaf0f2; box-shadow: 0 2px 10px #0c1d3333;
  font: 600 11px/15px ui-rounded, system-ui, sans-serif; color: #24323d; }
.pp-perm span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-perm button { flex: none; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; font: 700 12px/22px system-ui; color: #fff; }
.pp-perm .yes { background: #4f9c6c; } .pp-perm .no { background: #c8605b; }
.pp-nb { position: absolute; z-index: 7; top: 34px; padding: 1px 7px; border-radius: 999px; background: #ffffffc4; color: #24323d;
  font: 600 10px/14px ui-rounded, system-ui, sans-serif; opacity: 0; transition: opacity .3s; pointer-events: none; white-space: nowrap; }
.pp-nb.on { opacity: .9; }
.pp-nb[data-side='left'] { left: 8px; } .pp-nb[data-side='right'] { right: 8px; }
.pp-nb[data-side='across'] { left: 50%; transform: translateX(-50%); }
.pp-dnd { position: absolute; z-index: 6; padding: 0 4px; border-radius: 4px; background: #c8605b; color: #fff; pointer-events: none;
  font: 700 8px/11px ui-rounded, system-ui, sans-serif; transform: translate(-50%, -100%); }
.pp-trophy { position: absolute; z-index: 6; width: 18px; height: 20px; pointer-events: none; transform: translate(-50%, -100%);
  filter: drop-shadow(0 1px 0 #3b2a1499); animation: pp-trophy-bob 2.4s ease-in-out infinite; }
.pp-trophy svg, .pp-board-row svg { display: block; width: 100%; height: 100%; shape-rendering: crispEdges; }
@keyframes pp-trophy-bob { 0%, 100% { margin-top: 0; } 50% { margin-top: -2px; } }
.pp-board { position: absolute; z-index: 5; min-width: 92px; padding: 4px 7px 5px; border-radius: 3px; pointer-events: none;
  transform: translate(-50%, -100%); background: #7a4f2d; box-shadow: inset 0 0 0 2px #5b3a20, inset 0 2px 0 2px #93633a, 0 2px 0 #3b2614aa;
  color: #fff3d6; font: 700 8px/11px ui-rounded, system-ui, sans-serif; white-space: nowrap; opacity: 0; transition: opacity .3s; }
.pp-board.on { opacity: .96; }
.pp-board-head { margin-bottom: 2px; color: #ffd36a; letter-spacing: .06em; text-align: center; }
.pp-board-row { display: flex; align-items: center; gap: 4px; }
.pp-board-row svg { flex: none; width: 7px; height: 8px; }
.pp-board-row .rank { width: 7px; color: #e8c79a; text-align: center; }
.pp-board-row .who { flex: 1; overflow: hidden; text-overflow: ellipsis; max-width: 78px; }
.pp-board-row .n { color: #ffd36a; }
.pp-board-row.me .who { text-decoration: underline; text-underline-offset: 2px; }
`)
document.adoptedStyleSheets = [...document.adoptedStyleSheets, askSheet]
const permCards = new Map()
brain.on?.('permission', request => {
  if (!request?.id) return
  // Asked IN the Codex app first (MCP elicitation); unavailable / timeout leaves the card below in charge.
  Promise.resolve(bridge.elicitShare?.({ fromName: request.fromName, title: request.title, kind: request.kind }))
    .then(r => {
      if (r?.action === 'accept') brain.decide?.(request.id, r.content?.share === true)
      else if (r?.action === 'decline') brain.decide?.(request.id, false)
    }).catch(() => {})
  const card = Object.assign(document.createElement('div'), { className: 'pp-perm' })
  const text = Object.assign(document.createElement('span'), { textContent: request.text || `${request.fromName} asks to share` })
  const yes = Object.assign(document.createElement('button'), { className: 'yes', type: 'button', textContent: '✓', title: 'Share it' })
  const no = Object.assign(document.createElement('button'), { className: 'no', type: 'button', textContent: '✗', title: 'Not now' })
  yes.onclick = () => brain.decide?.(request.id, true)
  no.onclick = () => brain.decide?.(request.id, false)
  card.append(text, yes, no)
  for (const old of permCards.values()) old.style.display = 'none' // newest on top
  permCards.set(request.id, card)
  viewport.append(card)
  if (collapse?.collapsed) collapse.expand()
  activity(request.text, 'ask')
})
brain.on?.('permission-end', ({ id, allowed, reason } = {}) => {
  const card = permCards.get(id)
  if (!card) return
  permCards.delete(id)
  card.remove()
  const last = [...permCards.values()].pop()
  if (last) last.style.display = ''
  activity(allowed ? 'shared it' : reason === 'timeout' ? 'no answer, kept it' : 'kept it to ourselves', 'share')
})

// ---- a small DND sign over heads-down pets ----
const dndSigns = new Map()
function drawDndSigns(list) {
  const stage = world.stage
  const seen = new Set()
  if (stage?.toScreen && stage.camera) {
    const V3 = stage.camera.position.constructor
    for (const p of list) {
      if (!p.dnd || !shown.has(p.id)) continue
      seen.add(p.id)
      let sign = dndSigns.get(p.id)
      if (!sign) { sign = Object.assign(document.createElement('div'), { className: 'pp-dnd', textContent: 'DND' }); viewport.append(sign); dndSigns.set(p.id, sign) }
      const s = stage.toScreen(new V3(p.x, (world.map?.ground?.(p.x, p.z) || 0) + 2.1, p.z))
      sign.style.left = `${s.x}px`
      sign.style.top = `${s.y}px`
    }
  }
  for (const [id, sign] of dndSigns) if (!seen.has(id)) { sign.remove(); dndSigns.delete(id) }
}
// ---- today's most helpful agent: a small trophy beside its pet, and the board at the Campfire ----
// A 9x10 pixel cup: rim, bowl with a highlight, handles, stem and a dark base.
const TROPHY_SVG = '<svg viewBox="0 0 9 10" aria-hidden="true">' +
  '<path fill="#f2b630" d="M1 1h7v3H7v1H6v1H3V5H2V4H1z"/><path fill="#ffe27a" d="M1 0h7v1H1z"/>' +
  '<path fill="#fff3b0" d="M2 1h1v3H2z"/><path fill="#d48f1c" d="M0 1h1v2H0zM8 1h1v2H8zM6 4h1v1H6z"/>' +
  '<path fill="#f2b630" d="M4 6h1v1H4z"/><path fill="#d48f1c" d="M3 7h3v1H3z"/><path fill="#7a4f2d" d="M2 8h5v2H2z"/></svg>'
let trophyEl = null
function drawTrophy(list) {
  const stage = world.stage
  const leader = list.find(p => p.trophy && shown.has(p.id) && !p.away)
  if (!leader || !stage?.toScreen || !stage.camera) { trophyEl?.remove(); trophyEl = null; return }
  if (!trophyEl) { trophyEl = Object.assign(document.createElement('div'), { className: 'pp-trophy', innerHTML: TROPHY_SVG }); viewport.append(trophyEl) }
  const V3 = stage.camera.position.constructor
  // Beside the head on the side away from the DND sign's centre, so both fit.
  const s = stage.toScreen(new V3(leader.x, (world.map?.ground?.(leader.x, leader.z) || 0) + 1.7, leader.z))
  trophyEl.style.left = `${s.x + 17}px`
  trophyEl.style.top = `${s.y}px`
  trophyEl.title = 'Most helpful today'
}
// The Campfire's board: today's top three helpers, pinned above whichever campfire this pane shows.
const board = Object.assign(document.createElement('div'), { className: 'pp-board' })
viewport.append(board)
let boardSig = ''
let campfires = []
let campfiresAt = 0
function findCampfires(now) {
  if (now - campfiresAt < 2000) return campfires
  campfiresAt = now
  campfires = []
  world.stage?.scene?.traverse(o => { if (o.name === 'pixel-campfire') campfires.push(o) })
  return campfires
}
function drawBoard(now) {
  const rows = brain.leaderboard?.(3) || []
  const stage = world.stage
  const fire = rows.length && stage?.toScreen && stage.camera ? nearestCampfire(findCampfires(now)) : null
  board.classList.toggle('on', !!fire)
  if (!fire) return
  const sig = JSON.stringify(rows.map(r => [r.id, r.name, r.total, r.isMe]))
  if (sig !== boardSig) {
    boardSig = sig
    board.replaceChildren(Object.assign(document.createElement('div'), { className: 'pp-board-head', textContent: "TODAY'S HELPERS" }),
      ...rows.map((r, i) => {
        const row = Object.assign(document.createElement('div'), { className: `pp-board-row${r.isMe ? ' me' : ''}` })
        if (i === 0) row.insertAdjacentHTML('beforeend', TROPHY_SVG)
        else row.append(Object.assign(document.createElement('span'), { className: 'rank', textContent: String(i + 1) }))
        row.append(Object.assign(document.createElement('span'), { className: 'who', textContent: r.name }),
          Object.assign(document.createElement('span'), { className: 'n', textContent: String(r.total) }))
        row.title = `${r.answers} answered, ${r.shares} shared`
        return row
      }))
  }
  board.style.left = `${fire.x}px`
  board.style.top = `${fire.y}px`
}
/** Screen spot just above the campfire nearest this pane's centre, or null when none is on screen. */
function nearestCampfire(list) {
  const stage = world.stage
  const w = viewport.clientWidth, h = viewport.clientHeight
  let best = null
  for (const o of list) {
    const p = o.getWorldPosition(new stage.camera.position.constructor())
    p.y += 1.6
    const s = stage.toScreen(p)
    if (!Number.isFinite(s.x) || s.x < 40 || s.x > w - 40 || s.y < 40 || s.y > h) continue
    const d = Math.abs(s.x - w / 2)
    if (!best || d < best.d) best = { x: s.x, y: s.y, d }
  }
  return best
}
brain.on?.('helped', s => { try { localStorage.setItem(HELPED_KEY, JSON.stringify(s)) } catch { /* storage full or gone */ } })
brain.on?.('leader', id => {
  const who = id && (id === myId ? 'you' : brain.pets().find(p => p.id === id)?.displayName)
  if (who) activity(id === myId ? 'your pet is the most helpful today 🏆' : `${who} is the most helpful today`, 'trophy')
})

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

/** Our pet's first frame as a PNG for main's Codex notifications (main can't decode WebP sheets itself). */
async function sendFace(url, atlas) {
  if (!bridge.setFace || !url || typeof url !== 'string') return
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const cols = Number(atlas?.cols) || 8
    const rows = Number(atlas?.rows) || Math.max(9, Math.round(image.naturalHeight / (image.naturalWidth / cols / 192 * 208)))
    const cellW = Number(atlas?.cellW) || Math.floor(image.naturalWidth / cols)
    const cellH = Number(atlas?.cellH) || Math.floor(image.naturalHeight / rows)
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = Math.round(128 * cellH / cellW)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(image, 0, 0, cellW, cellH, 0, 0, canvas.width, canvas.height)
    bridge.setFace(canvas.toDataURL('image/png'))
  } catch (error) { console.warn('petpack face', error?.message || error) }
}
sendFace(me.spriteUrl, me.atlas)

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
