import { createWorld } from './index.js'
import { createStory, DURATION } from './story.js'
import { createDesk } from './desk.js'

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
let previousTime = time
let frameId = 0, disposed = false, seeking = false, seekGeneration = 0
let testAtlas = null
let ids = new Set()
const worlds = desks.map(({ paneHost, dock }, i) => createWorld(paneHost, {
  seat: layout === 'solo' ? soloSeat : i, pixelScale, dock, clock: () => time, autoRender: false,
}))
const world = worlds[0]
const story = createStory(world.map, { testPet })

function applyState(at) {
  const state = story.sample(at)
  const nextIds = new Set(state.map(pet => pet.id))
  for (const current of worlds) {
    for (const id of ids) if (!nextIds.has(id)) current.removePet(id)
    for (const pet of state) {
      current.upsertPet(pet.id, {
        displayName: pet.displayName, color: pet.color, kind: pet.kind,
        skillCount: pet.skillCount, isMe: pet.homeSeat === current.seat,
        spriteUrl: pet.id === 'test' ? testAtlas : null,
      })
      current.updatePet(pet.id, { x: pet.x, z: pet.z, anim: pet.anim, status: pet.status,
        facing: pet.facing, speed: pet.speed, snap: true })
    }
  }
  ids = nextIds
}
function dispatch(event) {
  for (const current of worlds) {
    if (event.type === 'ask') current.ask(event.from, event.to, {
      question: event.question, answer: event.answer, kind: event.kind, label: event.label,
    })
    else if (event.type === 'gift') current.gift(event.from, event.to, { color: event.color, label: event.label })
    else if (event.type === 'collab') current.collab(event.from, event.to, { kind: event.kind, label: event.label })
    else if (event.type === 'say') current.say(event.id, event.text)
  }
}
function draw(dt, at, render = true) {
  for (const current of worlds) current.renderFrame(dt, at, { render })
}

// Reconstruct the active conversation as well as the positions for captures.
// Only the last 12 seconds can still have live effects. Replay without GPU draws.
async function seek(at) {
  const generation = ++seekGeneration
  seeking = true
  const target = Math.max(0, Number(at) || 0)
  for (const current of worlds) {
    current.resetEffects()
    for (const id of ids) current.removePet(id)
  }
  ids.clear()
  let cursor = Math.max(0, target - 12)
  applyState(cursor)
  draw(0, cursor, false)
  while (cursor < target - .000001 && !disposed && generation === seekGeneration) {
    const next = Math.min(target, cursor + 1 / 30)
    applyState(next)
    for (const event of story.events(cursor, next)) dispatch(event)
    draw(next - cursor, next, false)
    cursor = next
    await Promise.resolve()
  }
  if (disposed || generation !== seekGeneration) return
  time = target
  applyState(time)
  draw(0, time)
  previousTime = time
  origin = performance.now() / 1000 - time
  seeking = false
}
function tick(now) {
  if (disposed) return
  if (!seeking) {
    if (!paused) time = now / 1000 - origin
    const delta = Math.max(0, time - previousTime)
    applyState(time)
    for (const event of story.events(previousTime, time)) dispatch(event)
    draw(delta, time)
    previousTime = time
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
  if (!document.hidden) { origin = performance.now() / 1000 - time; previousTime = time }
}
function pagehide(event) { if (!event.persisted) window.petpackDemo.dispose() }
document.addEventListener('visibilitychange', visibility)
window.addEventListener('pagehide', pagehide)

// Test/capture controls live off the product surface: the pets run themselves.
window.petpackDemo = {
  world, worlds, desks, duration: DURATION, layout,
  get time() { return time },
  get paused() { return paused },
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
    window.removeEventListener('resize', sizeSolo)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pagehide', pagehide)
  },
}
await seek(time)
window.petpackDemo.ready = true
frameId = requestAnimationFrame(tick)
