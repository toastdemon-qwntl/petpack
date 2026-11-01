import { createWorld } from './index.js'
import { createStory, DURATION } from './story.js'

const params = new URLSearchParams(location.search)
const testPet = params.get('pet') === 'test'
const pixelScale = Math.max(1, Math.min(4, Number(params.get('px')) || 2))
document.body.classList.toggle('solo', params.has('solo'))
let time = Math.max(0, Number(params.get('t')) || 0)
let paused = params.has('paused') || matchMedia('(prefers-reduced-motion: reduce)').matches
let origin = performance.now() / 1000 - time
let previousEventTime = time
let frameId
let disposed = false
let testAtlas = null
let ids = new Set()
let world
let story

// Register the director before the world's draw callback: both see the same clock.
function tick(now) {
  if (disposed) return
  if (!paused) time = now / 1000 - origin
  if (story) {
    applyState(time)
    for (const event of story.events(previousEventTime, time)) dispatch(event)
    previousEventTime = time
  }
  frameId = requestAnimationFrame(tick)
}
frameId = requestAnimationFrame(tick)
world = createWorld(document.querySelector('.world-viewport'), { pixelScale, clock: () => time })
story = createStory(world.map, { testPet })

function applyState(at) {
  const state = story.sample(at)
  const nextIds = new Set(state.map(pet => pet.id))
  for (const id of ids) if (!nextIds.has(id)) world.removePet(id)
  for (const pet of state) {
    world.upsertPet(pet.id, {
      displayName: pet.displayName, color: pet.color, kind: pet.kind,
      skillCount: pet.skillCount, isMe: pet.isMe,
      spriteUrl: pet.id === 'test' ? testAtlas : null,
    })
    // The pure story has already sampled the map's routes. Network callers omit
    // snap and the World API walks those routes with acceleration and braking.
    world.updatePet(pet.id, { x: pet.x, z: pet.z, anim: pet.anim, status: pet.status, facing: pet.facing, snap: true })
  }
  ids = nextIds
  world.follow(story.focus(at))
}
function dispatch(event) {
  if (event.type === 'gift') world.gift(event.from, event.to, { color: event.color, label: event.label })
  else if (event.type === 'collab') world.collab(event.from, event.to, { kind: event.kind, label: event.label })
  else if (event.type === 'say') world.say(event.id, event.text)
}
applyState(time)

if (testPet) {
  // Both atlas export locations have existed; keep them loadable during cast work.
  const cast = await import('./sprite-pet.js')
  const makeTestAtlas = cast.makeTestAtlas || (await import('./atlas.js').catch(() => ({}))).makeTestAtlas
  if (typeof makeTestAtlas === 'function') {
    try {
      const atlas = await makeTestAtlas()
      if (!disposed) {
        testAtlas = typeof atlas === 'string' ? atlas : atlas.spriteUrl || atlas.url || atlas.toDataURL?.()
        applyState(time)
      }
    } catch { /* A procedural companion remains visible if the test atlas fails. */ }
  }
}

function visibility() {
  if (!document.hidden) previousEventTime = time
}
function pagehide(event) { if (!event.persisted) window.petpackDemo.dispose() }
document.addEventListener('visibilitychange', visibility)
window.addEventListener('pagehide', pagehide)

// Capture controls are deliberately absent from the product surface.
window.petpackDemo = {
  world, worlds: [world], duration: DURATION,
  get time() { return time },
  get paused() { return paused },
  seek(at) {
    time = Math.max(0, Number(at) || 0)
    origin = performance.now() / 1000 - time
    previousEventTime = time
    applyState(time)
  },
  pause() { paused = true },
  play() { origin = performance.now() / 1000 - time; paused = false },
  sample: at => story.sample(at),
  focus: at => story.focus(at),
  dispose() {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frameId)
    world.dispose()
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pagehide', pagehide)
  },
}
