// Live world view (WIDE lane): a public, read-only window onto a whole room. It joins the relay as a spectator,
// draws every seat's chunk side by side as one strip with the real pets walking live, their status bubbles,
// gifts, asks, learned lines, conga and away agents napping, and drifts a slow camera toward the action.
//   live.html?room=<code>   (default room dde-ldn)   &relay=<wss url[,url]>   &hour=<0-24>   &chunks=<n>
import { createWorld } from './world/index.js'
import { createNet, relayAsset } from './net.js'
import { RELAYS, relayList, roomFor, CHUNK_W, rid } from '../../shared/protocol.js'
import { widenEnsure, visibleChunks } from './zoom.js'

const query = new URLSearchParams(location.search)
const room = roomFor(query.get('room'))
const relays = query.get('relay') ? relayList(query.get('relay')) : [...RELAYS]
const hourParam = query.get('hour')
const fixedChunks = Number(query.get('chunks'))
const DELAY_MS = 320 // draw every pet slightly in the past so 10 Hz poses interpolate smoothly
const VIEW_DEPTH = 15 // world units of the strip shown top to bottom (the panes show ~10.5)
const ART_PER_UNIT = 208 / 14 // a 416 px pane at pixelScale 2: pets keep the same art-pixel size here
const MAX_NAPPERS = 14
const NAP_TTL_MS = 24 * 60 * 60 * 1000
const DOT_COLORS = { skill: '#ffcd78', memory: '#9be5d5', technique: '#d8d1fb', resource: '#ffc88a' }
const KINDS = Object.keys(DOT_COLORS)
const PALETTE = ['#6d99e5', '#df706d', '#80b291', '#e3a857', '#a98bd8', '#5fb7b0', '#d8799f', '#8fa65a']
const HAT_AT = [1, 3, 6, 10, 15]
const mod = (n, d) => ((n % d) + d) % d
const hash = text => { let h = 0x811c9dc5; for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0; return h }
const colorFor = id => PALETTE[hash(id) % PALETTE.length]
const clean = (text, max = 44) => { const s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s }

const el = {
  band: document.getElementById('band'),
  room: document.getElementById('room'),
  count: document.getElementById('count'),
  dot: document.getElementById('dot'),
  seats: document.getElementById('seats'),
}
el.room.textContent = room
document.title = `petpack live · ${room}`

// ---- the room as seen by a spectator ----
const myId = `watch-${rid()}`
const peers = new Map() // id -> { id, name, color, seat, sprite, status, online, samples, posed, lastSeen, x, z, anim, animUntil }
const held = new Map() // id -> seat held for an away member
const learned = new Map() // id -> learned count (hats)
let net = null
let online = false

function upsertPeer(p, isOnline) {
  if (!p?.id || p.id === myId) return null
  let peer = peers.get(p.id)
  if (!peer) {
    peer = { id: p.id, name: 'pet', color: colorFor(p.id), seat: null, sprite: null, status: 'idle', online: isOnline,
      samples: [], posed: false, lastSeen: 0, animUntil: 0, anim: null }
    peers.set(p.id, peer)
  }
  if (p.name) peer.name = String(p.name).slice(0, 28)
  if (p.color) peer.color = p.color
  if (Number.isInteger(p.seat)) peer.seat = p.seat
  if (p.sprite !== undefined) peer.sprite = p.sprite
  if (p.status) peer.status = p.status
  if (p.lastSeen) peer.lastSeen = p.lastSeen
  peer.online = isOnline
  if (isOnline && Number.isFinite(p.x) && Number.isFinite(p.z)) pushSample(peer, p)
  return peer
}
function pushSample(peer, s, ts = Date.now() - 150) {
  if (s.status) peer.status = s.status
  const list = peer.samples
  const last = list.at(-1)
  if (last && ts <= last.ts) { Object.assign(last, { x: s.x, z: s.z }); return }
  if (last && ts - last.ts > 300) list.push({ ...last, ts: ts - 100, moving: false })
  list.push({ ts, x: s.x, z: s.z, facing: s.facing === -1 ? -1 : 1, anim: s.anim || 'idle', moving: s.m === 1 || s.anim === 'run' })
  if (list.length > 40) list.splice(0, list.length - 40)
}
function sampleAt(list, at) {
  let i = list.length - 1
  while (i > 0 && list[i - 1].ts > at) i--
  const b = list[i], a = list[i - 1]
  if (a && at > b.ts && b.moving && a.moving) {
    const span = Math.max(1, b.ts - a.ts)
    const ahead = Math.min(200, at - b.ts) / span
    return { x: b.x + (b.x - a.x) * ahead, z: b.z + (b.z - a.z) * ahead, facing: b.facing, anim: 'run', speed: Math.hypot(b.x - a.x, b.z - a.z) / (span / 1000) }
  }
  if (!a || at >= b.ts) return { x: b.x, z: b.z, facing: b.facing, anim: b.anim === 'run' ? 'idle' : b.anim, speed: 0 }
  if (at <= a.ts) return { x: a.x, z: a.z, facing: a.facing, anim: a.anim === 'run' ? 'idle' : a.anim, speed: 0 }
  const span = Math.max(1e-6, b.ts - a.ts)
  const f = (at - a.ts) / span
  const d = Math.hypot(b.x - a.x, b.z - a.z)
  const moving = d > 1e-3
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f,
    facing: Math.abs(b.x - a.x) > 1e-4 ? (b.x > a.x ? 1 : -1) : b.facing,
    anim: moving ? 'run' : b.anim, speed: moving ? Math.min(20, d / (span / 1000)) : 0 }
}

function hello() {
  // A spectator: never seated, never drawn, never dock-linked; leaves no trace when the page closes.
  return { t: 'hello', v: 2, id: myId, room, seat: null, dock: 'none', name: 'live view', color: '#9aa7b1', status: 'idle',
    skills: [], catalog: [], sprite: null, answers: false, spectator: true }
}
function handle(msg) {
  if (!msg || typeof msg !== 'object') return
  switch (msg.t) {
    case 'welcome': {
      online = true
      if (msg.room) el.room.textContent = msg.room
      for (const peer of peers.values()) peer.online = false
      held.clear()
      for (const p of msg.peers || []) upsertPeer(p, !p.away)
      for (const p of msg.away || []) upsertPeer(p, false)
      noteSeats(msg)
      break
    }
    case 'join': {
      const peer = upsertPeer(msg.peer, true)
      if (peer) { action(peer.id, 6); later(peer.id, () => world?.arrive?.(peer.id, 'balloon')) }
      break
    }
    case 'leave': {
      const peer = peers.get(msg.id)
      if (peer) { peer.online = false; peer.lastSeen = msg.lastSeen || Date.now(); peer.samples = []; peer.posed = false }
      break
    }
    case 'state': {
      for (const s of msg.pets || []) {
        if (s.id === myId) continue
        const peer = peers.get(s.id) || upsertPeer({ id: s.id }, true)
        if (!peer) continue
        peer.online = true
        if (peer.posed) { if (s.status) peer.status = s.status } else pushSample(peer, s)
      }
      break
    }
    case 'seat': noteSeats(msg); break
    case 'fx': {
      const { t, v, kind, from, ...p } = msg
      if (from === myId) break
      if (kind === 'pose') {
        const peer = peers.get(from)
        if (!peer || !Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.ts)) break
        peer.posed = true; peer.online = true
        pushSample(peer, p, p.ts)
        break
      }
      if (kind === 'clock') break
      if (!p.src) p.src = from
      showFx(kind, p)
      break
    }
  }
}
function noteSeats(msg) {
  for (const [id, seat] of Object.entries(msg.seats || {})) {
    if (id === myId) continue
    const peer = peers.get(id)
    if (peer && Number.isInteger(seat)) peer.seat = seat
  }
  if (msg.held) {
    held.clear()
    for (const [id, seat] of Object.entries(msg.held)) if (Number.isInteger(seat)) held.set(id, seat)
  }
}

// ---- effects as they happen ----
const waiting = new Map() // id -> [fn] until that pet is in the world
function later(id, fn) {
  if (shown.has(id)) { try { fn() } catch (error) { console.warn('petpack live fx', error) } return }
  const list = waiting.get(id) || []
  list.push(fn); waiting.set(id, list.slice(-6))
}
function both(a, b, fn) { if (shown.has(a) && shown.has(b)) { try { fn() } catch (error) { console.warn('petpack live fx', error) } } }
function showFx(kind, p) {
  const knowledge = p.seed && KINDS.includes(p.dot) ? { kind: p.dot, seed: String(p.seed) } : {}
  if (kind === 'gift' || kind === 'fetch') {
    action([p.src, p.dst], 6)
    both(p.src, p.dst, () => world.gift(p.src, p.dst, { label: '', color: DOT_COLORS[p.dot] || DOT_COLORS.skill, ...knowledge }))
  } else if (kind === 'ask') {
    action([p.src, p.dst], 9)
    both(p.src, p.dst, () => world.ask(p.src, p.dst, { question: clean(p.question), answer: clean(p.answer),
      kind: KINDS.includes(p.dot) ? p.dot : undefined, seed: p.seed ? String(p.seed) : undefined, label: '' }))
  } else if ((kind === 'learned' || kind === 'say') && p.text && p.src) {
    action(p.src, 4)
    later(p.src, () => world.say(p.src, clean(p.text, 30)))
  } else if (kind === 'wave' && peers.has(p.src)) {
    const peer = peers.get(p.src); peer.anim = 'wave'; peer.animUntil = performance.now() + 1400
  } else if (kind === 'knock') later(p.src, () => world.knock?.(p.src, p.on !== false))
  else if (kind === 'weather') later(p.src, () => world.weather?.(p.src, p.w === 'rainbow' ? 'rainbow' : 'rain'))
  else if (kind === 'celebrate') { action(p.src, 5); later(p.src, () => world.celebrate?.(p.src)) }
  else if (kind === 'sleep') later(p.src, () => world.sleep?.(p.src, p.on !== false))
  else if (kind === 'conga' && Array.isArray(p.ids)) {
    action(p.ids, 12)
    const at = Number.isFinite(p.startAt) ? performance.now() + (p.startAt - Date.now()) : performance.now()
    try { world.conga?.(p.ids.filter(id => shown.has(id)), { startAt: at / 1000 }) } catch (error) { console.warn('petpack live conga', error) }
  }
  if (kind === 'learned' && p.src) {
    const n = (learned.get(p.src) || 0) + 1
    learned.set(p.src, n)
    later(p.src, () => world.setHat?.(p.src, HAT_AT.filter(k => n >= k).length))
    if (p.bloom && KINDS.includes(p.bloom.kind)) {
      try { world.bloom?.({ kind: p.bloom.kind, seed: String(p.bloom.seed || p.src), color: peers.get(p.src)?.color || colorFor(p.src) }) } catch { /* garden optional */ }
    }
  }
}

// ---- the world: one strip, a camera that spans several chunks ----
let world = null
let stream = null
let pixelScale = 2
let span = 3 * CHUNK_W
const shown = new Map() // id -> info key
const napping = new Set()
let mood = null

function layout() {
  const w = Math.max(320, innerWidth), h = Math.max(240, innerHeight)
  const chunks = fixedChunks > 0 ? Math.min(80 / CHUNK_W, fixedChunks) : Math.max(1.4, Math.min(4.2, w / h * 1.8))
  span = chunks * CHUNK_W
  // The strip's height shows VIEW_DEPTH of the village; on short screens the band fills the height instead.
  const reserve = h > 520 ? 120 : 56
  const bandH = Math.round(Math.min(h - reserve, w * VIEW_DEPTH / span) / 2) * 2
  el.band.style.height = `${bandH}px`
  span = Math.min(80, Math.max(span, VIEW_DEPTH * w / Math.max(1, bandH) * .98))
  return Math.max(2, Math.min(6, Math.round(w / span / ART_PER_UNIT)))
}
async function build() {
  const nextScale = layout()
  if (world && nextScale === pixelScale) return
  pixelScale = nextScale
  if (world) { stream?.dispose(); mood?.(); world.dispose(); world = null; shown.clear(); napping.clear() }
  const created = createWorld(el.band, { seat: 0, pixelScale, autoRender: false })
  world = created
  stream = widenEnsure(world)
  if (hourParam !== null && hourParam !== 'local' && Number.isFinite(Number(hourParam))) world.setTimeOfDay?.(Number(hourParam))
  try {
    const module = await import('./world/mood.js')
    if (world === created && typeof module.attachMood === 'function') {
      module.attachMood(world)
      mood = () => world.disposeMood?.()
    }
  } catch (error) { console.warn('petpack live: mood unavailable', error?.message || error) }
  cam.x = null
}

// Away agents nap near the seat they held, or among the seats in use.
function napSpots(occupied) {
  const away = [...peers.values()].filter(p => !p.online && Date.now() - (p.lastSeen || 0) <= NAP_TTL_MS)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).slice(0, MAX_NAPPERS)
  const perChunk = new Map()
  const seats = occupied.length ? occupied : [0, 1]
  const offsets = [-4.6, 4.4, -1.7, 1.9, -5.9, 5.6]
  const out = []
  away.forEach((p, i) => {
    const chunk = held.has(p.id) ? held.get(p.id) : seats[mod(hash(p.id), seats.length)]
    const n = perChunk.get(chunk) || 0
    perChunk.set(chunk, n + 1)
    if (n >= offsets.length) return
    out.push({ peer: p, chunk, x: chunk * CHUNK_W + offsets[n] + (mod(hash(p.id), 7) - 3) * .08, z: 4.3 + (n % 2) * .5, facing: n % 2 ? -1 : 1 })
  })
  return out
}

function syncPets(now) {
  const at = Date.now() - DELAY_MS
  const seen = new Set()
  const occupied = new Set()
  const live = []
  for (const peer of peers.values()) {
    if (!peer.online || !peer.samples.length) continue
    const s = sampleAt(peer.samples, at)
    live.push({ peer, s })
    if (Number.isInteger(peer.seat)) occupied.add(peer.seat)
    occupied.add(Math.round(s.x / CHUNK_W))
  }
  const seats = [...occupied].sort((a, b) => a - b)
  const naps = napSpots(seats)
  for (const { peer, s } of live) {
    seen.add(peer.id)
    show(peer, false)
    const anim = s.speed > .07 ? 'run' : peer.animUntil > now ? peer.anim : s.anim
    world.updatePet(peer.id, { x: s.x, z: s.z, facing: s.facing, anim, status: statusOf(peer.status), speed: s.speed, snap: true })
    if (napping.has(peer.id)) { napping.delete(peer.id); try { world.sleep?.(peer.id, false) } catch { /* optional */ } }
  }
  for (const nap of naps) {
    const { peer } = nap
    seen.add(peer.id)
    show(peer, true)
    world.updatePet(peer.id, { x: nap.x, z: nap.z, facing: nap.facing, anim: 'idle', status: 'idle', speed: 0, snap: true })
    if (!napping.has(peer.id)) { napping.add(peer.id); try { world.sleep?.(peer.id, true) } catch { /* optional */ } }
  }
  for (const id of [...shown.keys()]) if (!seen.has(id)) { world.removePet(id); shown.delete(id); napping.delete(id) }
  return { live, naps, seats }
}
const statusOf = s => ['idle', 'working', 'waiting', 'done', 'failed'].includes(s) ? s : 'idle'
function show(peer, away) {
  const spriteUrl = !away && peer.sprite ? relayAsset(net?.url || relays[0], peer.sprite) : null
  const info = { displayName: peer.name, color: peer.color, kind: 'cat', spriteUrl, skillCount: 0, isMe: false }
  const key = JSON.stringify(info)
  if (shown.get(peer.id) === key) return
  world.upsertPet(peer.id, info)
  shown.set(peer.id, key)
  const list = waiting.get(peer.id)
  if (list) { waiting.delete(peer.id); for (const fn of list) { try { fn() } catch (error) { console.warn('petpack live fx', error) } } }
}

// ---- camera: frame the occupied strip; drift slowly; glide to the action ----
const cam = { x: null, focusX: null, until: 0 }
let actionAt = null
function action(ids, seconds) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
  actionAt = { ids: list, until: performance.now() + seconds * 1000 }
}
function petX(id, live) {
  const hit = live.find(e => e.peer.id === id)
  return hit ? hit.s.x : null
}
function steer(dt, now, { live, naps, seats }) {
  const xs = [...seats, ...naps.map(n => n.chunk)]
  const lo = xs.length ? Math.min(...xs) : 0, hi = xs.length ? Math.max(...xs) : 1
  const left = lo * CHUNK_W - CHUNK_W / 2, right = hi * CHUNK_W + CHUNK_W / 2
  const width = right - left
  const t = now / 1000
  let goal
  if (width <= span) {
    const slack = (span - width) / 2
    goal = (left + right) / 2 + Math.sin(t * 2 * Math.PI / 70) * Math.min(slack * .6, CHUNK_W * .35) + Math.sin(t * .23) * .6
  } else {
    const period = Math.min(150, 40 + (width - span) / CHUNK_W * 18)
    const f = (1 - Math.cos(t * 2 * Math.PI / period)) / 2
    goal = left + span / 2 + (width - span) * f
  }
  if (actionAt && actionAt.until > now) {
    const xsAction = actionAt.ids.map(id => petX(id, live)).filter(Number.isFinite)
    if (xsAction.length) {
      const mid = (Math.min(...xsAction) + Math.max(...xsAction)) / 2
      // Only move when the action sits outside the calm middle of the view.
      if (cam.x === null || Math.abs(mid - cam.x) > span * .3) cam.focusX = mid
      if (cam.focusX !== null) goal = cam.focusX
    }
  } else cam.focusX = null
  if (width > span) goal = Math.min(right - span / 2, Math.max(left + span / 2, goal))
  if (cam.x === null) cam.x = goal
  cam.x += (goal - cam.x) * (1 - Math.exp(-dt * .9))
  world.stage.focus(cam.x, -1.25, { span })
  const vis = visibleChunks(world.stage, CHUNK_W)
  const goalLo = Math.floor((cam.x - span / 2) / CHUNK_W + .5), goalHi = Math.ceil((cam.x + span / 2) / CHUNK_W - .5)
  stream.update(Math.min(goalLo, vis?.lo ?? goalLo), Math.max(goalHi, vis?.hi ?? goalHi))
  paintSeats(seats, lo, hi)
}

// Seat numbers under the strip, following the camera (projector-friendly, no chrome).
let seatKey = ''
function paintSeats(seats, lo, hi) {
  const key = `${seats.join(',')}|${lo}|${hi}`
  if (key !== seatKey) {
    seatKey = key
    el.seats.replaceChildren(...seats.map(s => {
      const tag = document.createElement('span')
      tag.dataset.seat = String(s)
      tag.textContent = `seat ${s + 1}`
      return tag
    }))
  }
  const rect = el.band.getBoundingClientRect()
  for (const tag of el.seats.children) {
    const s = Number(tag.dataset.seat)
    const x = rect.width / 2 + (s * CHUNK_W - world.stage.camera.position.x) / span * rect.width
    tag.style.transform = `translate(${Math.round(x)}px, 0) translateX(-50%)`
    tag.style.opacity = x < 30 || x > rect.width - 30 ? '0' : ''
  }
}

let last = performance.now()
let countKey = ''
function frame(now) {
  requestAnimationFrame(frame)
  if (!world) return
  const dt = Math.min(.25, Math.max(0, (now - last) / 1000))
  last = now
  const state = syncPets(now)
  steer(dt, now, state)
  world.renderFrame(dt, now / 1000)
  const n = state.live.length, z = state.naps.length
  const key = `${online}|${n}|${z}`
  if (key !== countKey) {
    countKey = key
    el.count.textContent = online ? `${n} ${n === 1 ? 'agent' : 'agents'} online${z ? ` · ${z} napping` : ''}` : 'connecting…'
    el.dot.classList.toggle('on', online)
  }
}

await build()
let resizeTimer = 0
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { build() }, 200) })
net = createNet({ urls: relays, hello, onMessage: handle, onStatus: status => { online = status === 'online'; if (!online) countKey = '' } })
net.connect()
requestAnimationFrame(frame)
addEventListener('pagehide', () => net?.close())
window.petpackLive = {
  get world() { return world }, get net() { return net }, peers, room, get span() { return span }, get pixelScale() { return pixelScale },
  snapshot: () => ({ online, peers: [...peers.values()].map(p => ({ id: p.id, name: p.name, online: p.online, seat: p.seat, samples: p.samples.length })), shown: [...shown.keys()], pets: world?.snapshot() }),
}
