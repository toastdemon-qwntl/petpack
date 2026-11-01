// Life: what our own pet does when no errand holds it. Pure and deterministic (seed + time), no DOM, no
// network: the brain asks `life.next(state)` whenever its agent is free and walks/animates the answer.
//
//   createLife({ map, me, now, seed, moments }) -> { next(state), reset() }
//   state: { status: idle|working|waiting|done|failed, statusSince, seat, x, z, peersHere: [{ id, x, z, status }] }
//   ->     { id, goal: { x, z }, anim, facing, durationS, fx?: { method, args }, with? }
//
// `fx` is a world call (`world[method](...args)`). `lifeFx` is drawn by attachLifeFx(world) below; sleep,
// celebrate, knock and weather are the world's joy moments. With `moments: false` the caller (the brain)
// already plays the status moments itself, so life only returns the choreography for them.
import { createTerrain, createStripNavigation, ROAD_Z } from './world/map-paths.js'

export const CHUNK_W = 14
export const KINDS = ['skill', 'memory', 'technique', 'resource'] // Workshop, Library, Dojo, Campfire
export const NAP_AFTER_S = 180
export const ROTATE_AFTER_S = 90 // long tasks move to the landmark's second station
export const WORK_BEAT_S = 20 // one work loop; each ends with a small progress sparkle
const IDLE_KINDS = ['bench', 'fish', 'fire', 'lookout', 'chat', 'stretch', 'flowers', 'stroll']
const mod = (n, d) => ((n % d) + d) % d
const chunkOf = x => Math.floor(x / CHUNK_W + 0.5)
const kindAt = i => KINDS[mod(i, 4)]
const round = v => Math.round(v * 100) / 100

// Two stations per landmark, on its walkable apron (|dx| <= 2, z 0..4.5). `face` points at the work.
export const STATIONS = {
  skill: [{ name: 'anvil', dx: -1.15, z: 0.55, face: 1, anim: 'review', fx: 'sparks' },
    { name: 'workbench', dx: 1.25, z: 0.7, face: -1, anim: 'review', fx: 'sparks' }],
  memory: [{ name: 'lectern', dx: -1.0, z: 0.6, face: 1, anim: 'review', fx: 'pages' },
    { name: 'reading nook', dx: 1.3, z: 1.1, face: -1, anim: 'review', fx: 'pages' }],
  technique: [{ name: 'mat', dx: 0.0, z: 2.2, face: 1, anim: 'jump', fx: 'speed' },
    { name: 'training post', dx: 1.45, z: 0.8, face: -1, anim: 'wave', fx: 'speed' }],
  resource: [{ name: 'fire', dx: -1.2, z: 1.3, face: 1, anim: 'review', fx: 'embers' },
    { name: 'woodpile', dx: 1.35, z: 0.9, face: -1, anim: 'wave', fx: 'embers' }],
}

export function hashText(text) {
  let h = 0x811c9dc5
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createLife({ world = null, map = null, me = 'me', now = () => 0, seed, moments = true, napAfterS = NAP_AFTER_S } = {}) {
  const id = typeof me === 'string' ? me : me?.id || 'me'
  const terrain = map?.terrain || createTerrain({ seed: 77, chunkWidth: CHUNK_W })
  const nav = typeof map?.path === 'function' ? map : (world?.map?.path ? world.map : createStripNavigation(terrain))
  const base = hashText(seed ?? id)
  let calls = 0
  let lastIdle = null
  let lastStatus = null
  let celebratedFor = null
  let rainedFor = null
  let knockedFor = null

  const walkable = p => terrain.isRoad(p.x, p.z) && !terrain.isWater(p.x, p.z)
  // Everything stays inside the seat's chunk, so the pet never wanders off its own pane.
  function spot(x, z, cx) {
    x = Math.max(cx - 6.2, Math.min(cx + 6.2, x))
    const p = { x: round(x), z: round(z) }
    if (walkable(p)) return p
    const q = { x: p.x, z: round(Math.max(ROAD_Z - 1.15, Math.min(ROAD_Z + 1.15, z))) }
    return walkable(q) ? q : { x: p.x, z: ROAD_Z }
  }
  const pick = (list, r) => list[Math.floor(r() * list.length) % list.length]
  const facingTo = (from, to) => (to >= from ? 1 : -1)

  function act(name, goal, anim, durationS, extra = {}) {
    return { id: name, goal, anim, facing: extra.facing ?? 1, durationS: round(durationS), ...extra }
  }

  function working(state, cx, seat, r) {
    const kind = kindAt(seat)
    const workedFor = Math.max(0, state.t - (state.statusSince ?? state.t))
    const station = STATIONS[kind][Math.floor(workedFor / ROTATE_AFTER_S) % 2]
    const goal = spot(cx + station.dx + (r() - 0.5) * 0.2, station.z, cx)
    return act(`work:${station.name}`, goal, station.anim, WORK_BEAT_S, {
      facing: station.face, kind, station: station.name,
      fx: { method: 'lifeFx', args: [id, { kind: station.fx, tint: kind, durationS: WORK_BEAT_S, facing: station.face, progress: true }] },
    })
  }

  function idleChoices(state, cx, seat, r) {
    const peers = (state.peersHere || []).filter(p => p && p.id !== id && Number.isFinite(p.x) &&
      Math.abs(p.x - cx) < 6.5 && (!p.status || p.status === 'idle' || p.status === 'done'))
    const pond = terrain.pond(seat)
    const out = {
      bench: () => act('bench', spot(cx - 4.7, ROAD_Z + 1.1, cx), 'idle', 18 + r() * 16, { facing: 1 }),
      lookout: () => {
        const side = r() < 0.5 ? -1 : 1
        return act('lookout', spot(cx + side * 1.6, 4.3, cx), 'idle', 12 + r() * 14, { facing: side })
      },
      stretch: () => act('stretch', spot(state.x, state.z, cx), 'wave', 10 + r() * 4, { facing: r() < 0.5 ? -1 : 1 }),
      flowers: () => {
        const side = r() < 0.5 ? -1 : 1
        return act('flowers', spot(cx + side * 3.3, ROAD_Z + 1.1, cx), 'review', 12 + r() * 10, { facing: side,
          fx: { method: 'lifeFx', args: [id, { kind: 'note', durationS: 6 }] } })
      },
      stroll: () => act('stroll', spot(cx + (r() - 0.5) * 9, ROAD_Z + (r() - 0.5) * 1.6, cx), 'idle', 10 + r() * 8,
        { facing: r() < 0.5 ? -1 : 1 }),
    }
    if (pond) {
      out.fish = () => {
        const x = pond.x - 2.1
        return act('fish', spot(x, ROAD_Z + 1.15, cx), 'review', 24 + r() * 16, { facing: 1,
          fx: { method: 'lifeFx', args: [id, { kind: 'fish', durationS: 22, to: { x: pond.x - 0.6, z: pond.z - 0.4 } }] } })
      }
    }
    if (kindAt(seat) === 'resource') {
      out.fire = () => {
        const side = r() < 0.5 ? -1 : 1
        return act('fire', spot(cx + side * 1.3, 1.3, cx), 'idle', 16 + r() * 18, { facing: -side,
          fx: { method: 'lifeFx', args: [id, { kind: 'warm', tint: 'resource', durationS: 14 }] } })
      }
    }
    if (peers.length) {
      out.chat = () => {
        const peer = pick(peers, r)
        const side = state.x <= peer.x ? -1 : 1
        const goal = spot(peer.x + side * 1.05, Number.isFinite(peer.z) ? peer.z : ROAD_Z, cx)
        return act('chat', goal, 'wave', 12 + r() * 10, { facing: facingTo(goal.x, peer.x), with: peer.id,
          fx: { method: 'lifeFx', args: [id, { kind: r() < 0.5 ? 'heart' : 'note', durationS: 10, with: peer.id }] } })
      }
    }
    return out
  }

  function idle(state, cx, seat, r) {
    const since = Math.max(0, state.t - (state.statusSince ?? state.t))
    if (since >= napAfterS) {
      lastIdle = 'nap'
      return act('nap', spot(cx - 4.7, ROAD_Z + 1.1, cx), 'idle', 40, { facing: 1,
        ...(moments ? { fx: { method: 'sleep', args: [id, true] } } : {}) })
    }
    const choices = idleChoices(state, cx, seat, r)
    // A friend on screen is the best thing to do; otherwise a seeded, never-repeating choice.
    let names = Object.keys(choices).filter(n => n !== lastIdle)
    if (names.includes('chat') && r() < 0.5) names = ['chat']
    const name = pick(names, r)
    lastIdle = name
    return choices[name]()
  }

  function next(state = {}) {
    const t = Number.isFinite(state.now) ? state.now : Number(now()) || 0
    const status = ['idle', 'working', 'waiting', 'done', 'failed'].includes(state.status) ? state.status : 'idle'
    const x = Number.isFinite(state.x) ? state.x : 0
    const seat = Number.isInteger(state.seat) ? state.seat : chunkOf(x)
    const cx = seat * CHUNK_W
    const s = { ...state, t, x, z: Number.isFinite(state.z) ? state.z : ROAD_Z, statusSince: Number.isFinite(state.statusSince) ? state.statusSince : t }
    const r = rng(base ^ Math.imul(++calls, 0x9e3779b1) ^ Math.imul(Math.floor(t), 0x85ebca6b))
    const recovering = lastStatus === 'failed' && status !== 'failed'
    lastStatus = status
    let out
    if (status === 'working') { lastIdle = null; out = working(s, cx, seat, r) } else if (status === 'waiting') {
      // The world's knock walks to the front glass at (seat centre, 4.25); stand exactly there.
      const first = knockedFor !== s.statusSince
      knockedFor = s.statusSince
      out = act('knock', spot(cx, 4.25, cx), 'waiting', 8, { facing: 1,
        ...(moments && first ? { fx: { method: 'knock', args: [id, true] } } : {}) })
    } else if (status === 'failed') {
      const first = rainedFor !== s.statusSince
      rainedFor = s.statusSince
      out = act(first ? 'slump-home' : 'slump', spot(cx - 3.2, ROAD_Z + 0.4, cx), 'failed', first ? 14 : 20, { facing: -1,
        ...(moments && first ? { fx: { method: 'weather', args: [id, 'rain'] } } : {}) })
    } else if (status === 'done' && celebratedFor !== s.statusSince) {
      celebratedFor = s.statusSince
      out = act('celebrate', spot(x, s.z, cx), 'jump', 3, { facing: 1,
        ...(moments ? { fx: { method: 'celebrate', args: [id] } } : {}) })
    } else out = idle(s, cx, seat, r)
    // Coming back from a failure: a rainbow (the brain already plays it for failed -> done).
    if (recovering && (moments || status !== 'done') && !out.fx) out.fx = { method: 'weather', args: [id, 'rainbow'] }
    else if (recovering && (moments || status !== 'done')) out.then = { method: 'weather', args: [id, 'rainbow'] }
    out.status = status
    return out
  }

  return { next, reset() { calls = 0; lastIdle = null; lastStatus = null; celebratedFor = rainedFor = knockedFor = null }, terrain, nav }
}

// ---- lifeFx: small pixel effects drawn over the world pane (browser only) ----
const PALETTE = {
  skill: ['#ffcd78', '#fff3c4', '#ff9a4a'], memory: ['#9be5d5', '#f4fbf6', '#5fb7b0'],
  technique: ['#d8d1fb', '#ffffff', '#a98bd8'], resource: ['#ffc88a', '#ff8a4a', '#fff0c8'],
  heart: ['#e86a7a', '#ffd1d8'], note: ['#fff7e6', '#6d99e5'], fish: ['#f4fbf6', '#e86a7a', '#cfe9f2'],
}
const HEART = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...']
const NOTE = ['..###', '..#.#', '..#.#', '###.#', '###..']
const STAR = ['..#..', '.###.', '#####', '.###.', '..#..']
const BOOK = ['##.##', '#####', '#####']

/** Adds world.lifeFx(id, { kind, durationS, tint, with, to, progress }). Returns the world. */
export function attachLifeFx(world, { container } = {}) {
  if (!world || world.lifeFx || typeof document === 'undefined') return world
  const stage = world.stage
  const worldCanvas = container?.querySelector?.('canvas.petpack-world-canvas') || document.querySelector('canvas.petpack-world-canvas')
  if (!stage || !worldCanvas?.parentElement) { world.lifeFx = () => false; return world }
  const V3 = stage.camera.position.constructor
  const canvas = document.createElement('canvas')
  canvas.className = 'petpack-life-fx'
  Object.assign(canvas.style, { position: 'absolute', pointerEvents: 'none', imageRendering: 'pixelated' })
  worldCanvas.parentElement.append(canvas)
  const ctx = canvas.getContext('2d')
  const effects = new Set()
  let frame = 0
  const ps = () => stage.pixelScale || 2
  function petOf(pid) { return world.snapshot?.().find(p => p.id === pid) || null }
  function screen(x, y, z) {
    const s = stage.toScreen(new V3(x, (world.map?.ground?.(x, z) || 0) + y, z))
    return { x: s.x, y: s.y }
  }
  function px(x, y, color, size = 1) {
    const k = ps()
    ctx.fillStyle = color
    ctx.fillRect(Math.round(x / k) * k, Math.round(y / k) * k, k * size, k * size)
  }
  function sprite(rows, x, y, color, glow) {
    const k = ps()
    const ox = Math.round(x / k) - Math.floor(rows[0].length / 2), oy = Math.round(y / k) - rows.length
    for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) {
      if (rows[j][i] !== '#') continue
      if (glow) { ctx.fillStyle = glow; ctx.fillRect((ox + i) * k - k, (oy + j) * k, k * 3, k) }
      ctx.fillStyle = color; ctx.fillRect((ox + i) * k, (oy + j) * k, k, k)
    }
  }
  const noise = (n) => { const v = Math.sin(n * 12.9898) * 43758.5453; return v - Math.floor(v) }

  function draw(e, now) {
    const pet = petOf(e.id)
    if (!pet) return
    const age = now - e.start
    const kind = e.kind
    const pal = PALETTE[e.tint] || PALETTE[kind] || PALETTE.skill
    const f = e.facing ?? pet.facing ?? 1
    const head = screen(pet.x, 1.75, pet.z)
    const hand = screen(pet.x + f * 0.55, 0.45, pet.z + 0.05)
    if (kind === 'sparks') {
      // A hammer strike every 0.7 s throws a fan of sparks off the anvil.
      const beat = age % 0.7
      for (let i = 0; i < 7; i++) {
        const a = -Math.PI / 2 + (noise(i + Math.floor(age / 0.7) * 7) - 0.5) * 2.2
        const v = 70 + noise(i * 3.1) * 70
        const x = hand.x + Math.cos(a) * v * beat, y = hand.y + Math.sin(a) * v * beat + 160 * beat * beat
        if (beat < 0.45) px(x, y, i % 3 ? pal[0] : pal[1])
      }
      if (beat < 0.12) px(hand.x - ps(), hand.y - ps(), pal[1], 2)
    } else if (kind === 'pages') {
      // A glowing open book floats at chest height; loose pages drift up out of it.
      const bob = Math.sin(age * 2.2) * ps()
      const book = screen(pet.x + f * 0.45, 0.95, pet.z + 0.05)
      sprite(BOOK, book.x, book.y + bob, pal[1], (Math.sin(age * 3) > 0 ? pal[0] : null))
      for (let i = 0; i < 3; i++) {
        const p = (age * 0.6 + i / 3) % 1
        px(book.x + Math.sin((p + i) * 6) * 6 * ps(), book.y - p * 22 * ps(), p < 0.7 ? pal[1] : pal[0], 2)
      }
    } else if (kind === 'speed') {
      // Speed lines streak past the practising pet, alternating sides each beat.
      const side = Math.floor(age / 0.8) % 2 ? 1 : -1
      for (let i = 0; i < 4; i++) {
        const p = (age * 2.5 + i * 0.27) % 1
        const y = head.y + (6 + i * 7) * ps()
        const x0 = head.x + side * (10 + p * 26) * ps()
        for (let k = 0; k < 5; k++) px(x0 + side * k * ps(), y, i % 2 ? pal[0] : pal[1])
      }
    } else if (kind === 'embers' || kind === 'warm') {
      const src = kind === 'warm' ? screen(Math.round(pet.x / CHUNK_W) * CHUNK_W, 0.3, 1.0) : hand
      for (let i = 0; i < 6; i++) {
        const p = (age * 0.55 + i / 6) % 1
        px(src.x + Math.sin(p * 7 + i) * 4 * ps(), src.y - p * 30 * ps(), p < 0.5 ? pal[0] : pal[1])
      }
    } else if (kind === 'heart' || kind === 'note') {
      const partner = e.with ? petOf(e.with) : null
      const rows = kind === 'heart' ? HEART : NOTE
      const bob = Math.round(Math.sin(age * 2.4) * 1.5) * ps()
      const at = partner ? screen((pet.x + partner.x) / 2, 2.1, (pet.z + partner.z) / 2) : head
      if (age % 2.4 < 1.9) sprite(rows, at.x, at.y - 6 * ps() + bob, pal[0])
    } else if (kind === 'fish') {
      // A line out to the pond, a bobber that dips now and then, and a ring when it does.
      const to = e.to ? screen(e.to.x, 0.02, e.to.z) : screen(pet.x + 2, 0.02, pet.z + 2)
      const rod = screen(pet.x + 0.5, 1.15, pet.z)
      for (let i = 0; i <= 12; i++) {
        const p = i / 12
        px(rod.x + (to.x - rod.x) * p, rod.y + (to.y - rod.y) * p + Math.sin(p * Math.PI) * 4 * ps(), pal[2])
      }
      const dip = age % 6 > 4.6 ? 2 * ps() : 0
      px(to.x - ps(), to.y - 2 * ps() + dip, pal[1], 2)
      if (dip) for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2, r = (2 + (age % 6 - 4.6) * 8) * ps()
        px(to.x + Math.cos(a) * r, to.y + Math.sin(a) * r * 0.45, pal[0])
      }
    }
    // Progress: a small sparkle above the head as each work loop completes (every ~20 s).
    if (e.progress && e.durationS - age < 1.2) {
      const k = 1 - Math.max(0, e.durationS - age) / 1.2
      sprite(STAR, head.x, head.y - (4 + k * 8) * ps(), k < 0.8 ? pal[1] : pal[0])
    }
  }

  function loop(t) {
    const now = t / 1000
    const w = worldCanvas.clientWidth, h = worldCanvas.clientHeight
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    Object.assign(canvas.style, { left: `${worldCanvas.offsetLeft}px`, top: `${worldCanvas.offsetTop}px`, width: `${w}px`, height: `${h}px` })
    ctx.clearRect(0, 0, w, h)
    for (const e of [...effects]) {
      if (now - e.start > e.durationS) { effects.delete(e); continue }
      try { draw(e, now) } catch { effects.delete(e) }
    }
    frame = effects.size ? requestAnimationFrame(loop) : 0
    if (!frame) ctx.clearRect(0, 0, w, h)
  }
  world.lifeFx = (pid, spec = {}) => {
    const durationS = Math.max(0.5, Math.min(60, Number(spec.durationS) || 10))
    for (const e of effects) if (e.id === pid) effects.delete(e) // one activity effect per pet
    effects.add({ ...spec, id: pid, durationS, start: performance.now() / 1000 })
    if (!frame) frame = requestAnimationFrame(loop)
    return true
  }
  world.stopLifeFx = pid => { for (const e of effects) if (pid == null || e.id === pid) effects.delete(e) }
  const dispose = world.dispose
  world.dispose = (...args) => { cancelAnimationFrame(frame); effects.clear(); canvas.remove(); return dispose?.apply(world, args) }
  return world
}
