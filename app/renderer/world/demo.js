import { createWorld } from './index.js'
import { sampleStory, storyEvents, arrivalElevation, DURATION } from './story.js'

const params = new URLSearchParams(location.search)
const solo = params.has('solo')
const testPet = params.get('pet') === 'test'
const requestedSeat = Number(params.get('seat') || 0)
const seat = Number.isFinite(requestedSeat) ? Math.floor(requestedSeat) : 0
const table = document.querySelector('.table')
const template = document.querySelector('#laptop-template')
document.body.classList.toggle('solo', solo)
if (solo) table.setAttribute('aria-label', `Petpack world, seat ${seat + 1}`)

let time = Math.max(0, Number(params.get('t')) || 0)
let paused = params.has('paused') || matchMedia('(prefers-reduced-motion: reduce)').matches
let origin = performance.now() / 1000 - time
let lastSample = -Infinity
let previousEventTime = time
let frameId
let disposed = false
let testAtlas
const worlds = []

// Register the shared clock before any renderer's animation callback.
function tick(now) {
  if (disposed) return
  if (!paused) time = now / 1000 - origin
  if (time - lastSample >= 0.095 || time < lastSample) {
    applyState(time)
    lastSample = time
  }
  // Walking exercises network-rate interpolation; the scripted drop is continuous.
  for (const { world, ids } of worlds) {
    if (ids.has('nova')) world.updatePet('nova', { elevation: arrivalElevation(time) })
  }
  for (const event of storyEvents(previousEventTime, time)) dispatch(event)
  previousEventTime = time
  frameId = requestAnimationFrame(tick)
}
frameId = requestAnimationFrame(tick)

for (const currentSeat of solo ? [seat] : [0, 1, 2]) {
  const element = template.content.firstElementChild.cloneNode(true)
  element.setAttribute('aria-label', `Laptop ${currentSeat + 1}`)
  table.append(element)
  const canvas = element.querySelector('canvas')
  const world = createWorld(canvas, { seat: currentSeat, clock: () => time })
  const record = { world, ids: new Set(), seat: currentSeat, element }
  worlds.push(record)
  canvas.addEventListener('pointerup', event => {
    const id = world.pick(event.clientX, event.clientY)
    if (id) for (const item of worlds) item.world.say(id, 'hello!')
  })
}

function applyState(at, snap = false) {
  const state = sampleStory(at, { testPet })
  const ids = new Set(state.map(pet => pet.id))
  for (const record of worlds) {
    for (const id of record.ids) if (!ids.has(id)) record.world.removePet(id)
    for (const pet of state) {
      record.world.upsertPet(pet.id, {
        displayName: pet.displayName, color: pet.color, skillCount: pet.skillCount,
        isMe: pet.seat === record.seat && ['pip', 'mochi', 'fern'].includes(pet.id),
        spriteUrl: pet.id === 'test' ? testAtlas || null : null,
      })
      record.world.updatePet(pet.id, { x: pet.x, facing: pet.facing, anim: pet.anim, status: pet.status, elevation: pet.elevation, snap })
    }
    record.ids = new Set(ids)
  }
}

function dispatch(event) {
  for (const { world } of worlds) {
    if (event.type === 'gift') world.giftFx(event.from, event.to, { color: event.color, label: event.label })
    else if (event.type === 'say') world.say(event.id, event.text)
  }
}
applyState(time, true)

if (testPet) {
  // The namespace import keeps this page compatible with the original cast stub.
  const cast = await import('./sprite-pet.js')
  const makeTestAtlas = cast.makeTestAtlas || (await import('./atlas.js').catch(() => ({}))).makeTestAtlas
  if (typeof makeTestAtlas === 'function') {
    const atlas = await makeTestAtlas()
    testAtlas = typeof atlas === 'string' ? atlas : atlas.spriteUrl || atlas.url || atlas.toDataURL?.()
    applyState(time)
  }
}

// A small capture surface: no controls or production copy over the world.
window.petpackDemo = {
  worlds: worlds.map(record => record.world),
  get time() { return time },
  get paused() { return paused },
  duration: DURATION,
  seek(at) {
    time = Math.max(0, Number(at) || 0)
    origin = performance.now() / 1000 - time
    previousEventTime = time
    lastSample = time
    applyState(time, true)
  },
  pause() { paused = true },
  play() { origin = performance.now() / 1000 - time; paused = false },
  sample: at => sampleStory(at, { testPet }),
  dispose() {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frameId)
    for (const { world } of worlds) world.dispose()
  },
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { lastSample = -Infinity; previousEventTime = time }
})
window.addEventListener('pagehide', event => { if (!event.persisted) window.petpackDemo.dispose() })
