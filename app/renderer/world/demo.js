import { createWorld } from './index.js'
import { createStory, DURATION, loopTime, previousGarden, storyGift } from './story.js'
import { createDesk } from './desk.js'
import { attachSound } from './sound.js'
import { attachMood } from './mood.js'

// PLAY can still be absent from a preview assembled while its lane is landing.
const playModule = await fetch(new URL('./play.js', import.meta.url), { method: 'HEAD' })
  .then(response => response.ok ? import('./play.js') : null).catch(() => null)

const params = new URLSearchParams(location.search)
const layout = params.has('solo') ? 'solo' : params.has('trio') ? 'trio' : 'pair'
const testPet = params.get('pet') === 'test'
const pixelScale = Math.max(1, Math.min(4, Math.round(Number(params.get('px')) || 2)))
const soloSeat = Math.trunc(Number(params.get('seat')) || 0)
document.body.classList.toggle('solo', layout === 'solo')

const desks = createDesk(document.querySelector('main'), { layout })
function sizeSolo() {
  if (layout !== 'solo') return
  const { paneHost } = desks[0]
  const pane = paneHost.closest('.petpack-pane')
  const root = document.querySelector('main')
  if (pane.parentElement !== root) {
    root.replaceChildren(pane)
    Object.assign(root.style, { minHeight: '100svh', display: 'grid', placeItems: 'center', padding: '24px' })
    Object.assign(pane.style, { position: 'relative', inset: 'auto', width: 'max-content', height: 'max-content', aspectRatio: 'auto' })
    pane.removeAttribute('data-dock')
    desks[0].dock = null
  }
  const quantum = pixelScale * 4
  const width = Math.max(quantum, Math.floor(Math.min(1020, innerWidth - 72, (innerHeight - 72) * 4 / 3) / quantum) * quantum)
  Object.assign(paneHost.style, { width: `${width}px`, height: `${width * .75}px` })
}
sizeSolo()
window.addEventListener('resize', sizeSolo)
let time = Math.max(0, Number(params.get('t')) || 0)
let paused = params.has('paused') || matchMedia('(prefers-reduced-motion: reduce)').matches
let origin = performance.now() / 1000 - time
let frameId = 0, disposed = false, seeking = false, seekGeneration = 0
let initialized = false, muted = true, layoutKey = ''
let testAtlas = null
let ids = new Set()
const worlds = desks.map(({ paneHost, dock }, i) => {
  const current = attachMood(createWorld(paneHost, {
    seat: layout === 'solo' ? soloSeat : i, pixelScale, dock, clock: () => time, autoRender: false,
  }))
  playModule?.attachPlay?.(current, { container: paneHost })
  return attachSound(current, { muted: true, volume: .16 / Math.sqrt(desks.length) })
})
const world = worlds[0]
const story = createStory(world.map, { testPet })
const dimensions = () => worlds.map(current => {
  const canvas = current.stage.renderer.domElement
  return `${canvas.clientWidth}x${canvas.clientHeight}`
}).join('/')
const requestedHour = params.get('hour')
const hour = requestedHour !== null && requestedHour.trim() !== '' && Number.isFinite(Number(requestedHour))
  ? Number(requestedHour) : null
for (const current of worlds) current.setTimeOfDay(hour)

const speaker = document.getElementById('sound-toggle')
function setMuted(value) {
  muted = !!value
  for (const current of worlds) current.setMuted(muted || seeking)
  if (speaker) {
    speaker.dataset.muted = String(muted)
    speaker.setAttribute('aria-pressed', String(!muted))
    speaker.setAttribute('aria-label', muted ? 'Turn village sound on' : 'Mute village sound')
    speaker.title = muted ? 'Turn village sound on' : 'Mute village sound'
  }
}
function firstGesture(event) {
  if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return
  document.removeEventListener('pointerdown', firstGesture, true)
  document.removeEventListener('keydown', firstGesture, true)
  // The speaker's own click handles its toggle; a click elsewhere unlocks too.
  if (!speaker?.contains(event.target)) setMuted(false)
}
function toggleSound() { setMuted(!muted) }
setMuted(true)
document.addEventListener('pointerdown', firstGesture, true)
document.addEventListener('keydown', firstGesture, true)
speaker?.addEventListener('click', toggleSound)

const subscriptions = []
for (const current of worlds) {
  for (const [listen, replay] of [['onThrow', 'throwPet'], ['onTouch', 'touchPet']]) {
    const unsubscribe = current[listen]?.(event => {
      for (const peer of worlds) if (peer !== current) peer[replay]?.(event.id, event)
    })
    if (unsubscribe) subscriptions.push(unsubscribe)
  }
}
// Scripted moments borrow motion. Keep touch/drag from borrowing it a second
// time; the pets are otherwise playable throughout their shared journey.
function protectMoment(event) {
  const hit = event.target.closest?.('.petpack-play-layer [data-pet-id]')
  if (!hit) return
  const id = hit.dataset.petId, t = loopTime(time)
  const mood = world.moodSnapshot().find(pet => String(pet.id) === id)
  if (seeking || mood?.sleeping || mood?.arriving || mood?.partying ||
    (t < 6 && ['pip', 'cleo'].includes(id)) || (t >= 36 && t < 42 && id === 'cleo')) {
    event.preventDefault(); event.stopImmediatePropagation()
  }
}
document.addEventListener('pointerdown', protectMoment, true)
document.addEventListener('keydown', protectMoment, true)

function applyState(at) {
  const state = story.sample(at)
  const phase = loopTime(at)
  const nextIds = new Set(state.map(pet => pet.id))
  for (const current of worlds) {
    for (const id of ids) if (!nextIds.has(id)) current.removePet(id)
    for (const pet of state) {
      current.upsertPet(pet.id, {
        // Names return after landing; confetti and the balloon get room to read.
        displayName: phase >= 49.5 || (pet.id === 'fern' && phase < 47.4) ? '' : pet.displayName,
        color: pet.color, kind: pet.kind,
        skillCount: pet.skillCount, isMe: pet.homeSeat === current.seat,
        memoryCount: pet.memoryCount || 0, techniqueCount: pet.techniqueCount || 0,
        spriteUrl: pet.id === 'test' ? testAtlas : null,
      })
      current.updatePet(pet.id, { x: pet.x, z: pet.z, anim: pet.anim, status: pet.status,
        facing: pet.facing, speed: pet.speed, snap: true, showStatus: pet.showStatus })
      current.setHat(pet.id, pet.hat)
    }
  }
  ids = nextIds
}
function dispatch(event) {
  for (const current of worlds) {
    if (event.type === 'ask') current.ask(event.from, event.to, {
      question: event.question, answer: event.answer, ...storyGift(event),
    })
    else if (event.type === 'gift') current.gift(event.from, event.to, storyGift(event))
    else if (event.type === 'collab') current.collab(event.from, event.to, { kind: event.kind, label: event.label })
    else if (event.type === 'say') current.say(event.id, event.text)
    else if (event.type === 'handshake') current.handshake({ seat: event.seat, side: event.side })
    else if (event.type === 'knock') current.knock(event.id, event.enabled)
    else if (event.type === 'celebrate') current.celebrate(event.id)
    else if (event.type === 'sleep') for (const id of event.ids) current.sleep(id, event.enabled)
    else if (event.type === 'weather') current.weather(event.id, event.weather)
    else if (event.type === 'arrive') current.arrive(event.id, event.mode)
    else if (event.type === 'conga') {
      // Hand all motion to the finale, including an unfinished user throw.
      current.resetEffects()
      for (const pet of story.sample(event.at)) current.setHat(pet.id, pet.hat)
      current.conga([...event.ids, ...(testPet ? ['test'] : [])], { durationS: event.durationS, startAt: event.at })
    }
  }
}
function draw(dt, at, render = true) {
  for (const current of worlds) current.renderFrame(dt, at, { render, deferRender: true })
}
function present() { for (const current of worlds) current.stage.render() }

// A canonical 60 Hz simulation makes random-access and successive film frames
// identical. Forward frame-by-frame seeks reuse state; partial/backward seeks
// rebuild from the loop start. Replays advance effects without GPU draws.
const HZ = 60, EPSILON = 1e-7
async function advance(at, { capture = false } = {}) {
  const generation = ++seekGeneration
  seeking = true
  const requested = Number(at)
  const bounded = Number.isFinite(requested) ? Math.max(0, requested) : 0
  const gridTarget = Math.round(bounded * HZ) / HZ
  const target = Math.abs(bounded - gridTarget) < EPSILON ? gridTarget : bounded
  const start = Math.floor(target / DURATION) * DURATION
  const onGrid = Math.abs(time * HZ - Math.round(time * HZ)) < EPSILON
  const rebuild = !initialized || dimensions() !== layoutKey || target < time || !onGrid ||
    Math.floor(time / DURATION) !== Math.floor(target / DURATION)
  // Resizing or resuming from a partial film frame can also reconstruct history.
  // Only newly advancing life is audible, regardless of who requested the draw.
  capture ||= rebuild
  if (capture) for (const current of worlds) current.setMuted(true)
  let cursor = time
  if (rebuild) {
    for (const current of worlds) {
      current.resetEffects()
      for (const id of ids) current.removePet(id)
      current.setGarden(previousGarden(target))
    }
    ids.clear()
    cursor = start
    applyState(cursor)
    draw(0, cursor, false)
    for (const event of story.events(cursor - EPSILON, cursor)) dispatch(event)
    initialized = true
  }
  while (cursor < target - EPSILON && !disposed && generation === seekGeneration) {
    const gridNext = (Math.floor(cursor * HZ + EPSILON) + 1) / HZ
    const next = Math.min(target, gridNext)
    applyState(next)
    for (const event of story.events(cursor, next)) dispatch(event)
    // Live audio follows real playback; capture replays remain completely quiet.
    draw(next === gridNext ? 1 / HZ : next - cursor, next, !capture)
    cursor = next
    await Promise.resolve()
  }
  if (disposed || generation !== seekGeneration) return
  time = target
  present()
  layoutKey = dimensions()
  seeking = false
  if (capture) for (const current of worlds) current.setMuted(muted)
}
async function seek(at) {
  await advance(at, { capture: true })
  origin = performance.now() / 1000 - time
}
async function tick(now) {
  if (disposed) return
  if (!seeking) {
    const target = paused ? time : Math.max(time, Math.floor((now / 1000 - origin) * HZ) / HZ)
    if (target > time + EPSILON || dimensions() !== layoutKey) await advance(target, { capture: paused || target - time > .75 })
    else present()
  }
  frameId = requestAnimationFrame(tick)
}

if (testPet) {
  const cast = await import('./sprite-pet.js')
  const makeTestAtlas = cast.makeTestAtlas || (await import('./atlas.js')).makeTestAtlas
  if (typeof makeTestAtlas === 'function') {
    const atlas = await makeTestAtlas()
    testAtlas = typeof atlas === 'string' ? atlas : atlas.spriteUrl || atlas.url || atlas.toDataURL?.()
  }
}
function visibility() {
  if (!document.hidden) origin = performance.now() / 1000 - time
}
function pagehide(event) { if (!event.persisted) window.petpackDemo.dispose() }
document.addEventListener('visibilitychange', visibility)
window.addEventListener('pagehide', pagehide)

// Test/capture controls live off the product surface: the pets run themselves.
window.petpackDemo = {
  world, worlds, desks, duration: DURATION, layout,
  get time() { return time },
  get paused() { return paused },
  get muted() { return muted },
  setMuted,
  seek,
  pause() { paused = true },
  play() { origin = performance.now() / 1000 - time; paused = false },
  sample: at => story.sample(at),
  focus: () => [],
  dispose() {
    if (disposed) return
    disposed = true; seekGeneration++
    cancelAnimationFrame(frameId)
    for (const current of worlds) current.dispose()
    for (const unsubscribe of subscriptions) unsubscribe()
    speaker?.removeEventListener('click', toggleSound)
    document.removeEventListener('pointerdown', firstGesture, true)
    document.removeEventListener('keydown', firstGesture, true)
    document.removeEventListener('pointerdown', protectMoment, true)
    document.removeEventListener('keydown', protectMoment, true)
    window.removeEventListener('resize', sizeSolo)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pagehide', pagehide)
  },
}
await seek(time)
window.petpackDemo.ready = true
frameId = requestAnimationFrame(tick)
