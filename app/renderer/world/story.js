export const DURATION = 60
export const PETS = [
  { id: 'pip', displayName: 'Pip', color: '#6d99e5', kind: 'cat', skillCount: 5, isMe: true },
  { id: 'cleo', displayName: 'Cleo', color: '#e99a82', kind: 'blob', skillCount: 2, isMe: false },
  { id: 'mochi', displayName: 'Mochi', color: '#e4b960', kind: 'robot', skillCount: 3, isMe: false },
  { id: 'fern', displayName: 'Fern', color: '#80b291', kind: 'sprout', skillCount: 4, isMe: false },
  { id: 'nova', displayName: 'Nova', color: '#ac91d0', kind: 'cat', skillCount: 1, isMe: false },
]
const TEST_PET = { id: 'test', displayName: 'Pixel', color: '#85bac8', kind: 'cat', skillCount: 2, isMe: false }
const between = (t, start, end) => t >= start && t < end
const clamp = t => Math.max(0, Math.min(1, t))
export const loopTime = time => ((Number(time) || 0) % DURATION + DURATION) % DURATION

// Pets ease up to a steady walking speed, then brake into the meeting. A cosine
// spring-shaped velocity ramp has zero acceleration at either end and no drift.
// Sampling its integral makes a seek identical to uninterrupted playback.
function travelEase(value) {
  const t = clamp(value)
  const ramp = .16
  const cruise = 1 - ramp
  if (t < ramp) return {
    fraction: (t - ramp / Math.PI * Math.sin(Math.PI * t / ramp)) / (2 * cruise),
    rate: (1 - Math.cos(Math.PI * t / ramp)) / (2 * cruise),
  }
  if (t > 1 - ramp) {
    const remaining = 1 - t
    return {
      fraction: 1 - (remaining - ramp / Math.PI * Math.sin(Math.PI * remaining / ramp)) / (2 * cruise),
      rate: (1 - Math.cos(Math.PI * remaining / ramp)) / (2 * cruise),
    }
  }
  return { fraction: (t - ramp / 2) / cruise, rate: 1 / cruise }
}

function point(value) { return { x: Number(value.x) || 0, z: Number(value.z) || 0 } }
function offset(value, x, z) { return { x: value.x + x, z: value.z + z } }

function route(map, from, to) {
  // map.path owns obstacles, the bridge and legal endpoints. Never smooth a
  // waypoint corner: a smoothed curve could cut into water or a building.
  const raw = map.path(from, to)
  const points = (Array.isArray(raw) && raw.length ? raw : [from]).map(point)
  const lengths = []
  let length = 0
  for (let i = 1; i < points.length; i++) {
    const size = Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z)
    lengths.push(size)
    length += size
  }
  return { points, lengths, length }
}

function along(path, fraction, speed = 0) {
  let distance = clamp(fraction) * path.length
  for (let i = 0; i < path.lengths.length; i++) {
    const length = path.lengths[i]
    if (!length) continue
    if (distance <= length || i === path.lengths.length - 1) {
      const a = path.points[i]
      const b = path.points[i + 1]
      const amount = clamp(distance / length)
      return { x: a.x + (b.x - a.x) * amount, z: a.z + (b.z - a.z) * amount,
        speed, facing: b.x < a.x ? -1 : 1 }
    }
    distance -= length
  }
  return { ...path.points[path.points.length - 1], speed: 0, facing: 1 }
}

function itinerary(map, keys) {
  const trips = []
  for (let i = 1; i < keys.length; i++) {
    const previous = keys[i - 1]
    const next = keys[i]
    trips.push({ start: previous.at, end: next.at, path: route(map, previous, next) })
  }
  return time => {
    const trip = trips.find(item => time >= item.start && time < item.end) || trips[trips.length - 1]
    const duration = trip.end - trip.start
    const { fraction, rate } = travelEase((time - trip.start) / duration)
    return along(trip.path, fraction, trip.path.length * rate / duration)
  }
}

export const EVENTS = [
  { at: 4.4, type: 'say', id: 'pip', text: 'Found a useful skill.' },
  { at: 5.2, type: 'collab', from: 'pip', to: 'cleo', kind: 'skill', label: 'pixel craft' },
  { at: 8.3, type: 'gift', from: 'pip', to: 'cleo', color: '#6d99e5', label: 'pixel craft' },
  { at: 10.1, type: 'say', id: 'cleo', text: 'Got it!' },
  { at: 17.2, type: 'say', id: 'fern', text: 'I remember this…' },
  { at: 18.2, type: 'collab', from: 'fern', to: 'mochi', kind: 'memory', label: 'project memories' },
  { at: 22.4, type: 'say', id: 'mochi', text: 'That makes sense.' },
  { at: 30.2, type: 'collab', from: 'pip', to: 'cleo', kind: 'technique', label: 'a better approach' },
  { at: 35.6, type: 'say', id: 'cleo', text: 'Your turn!' },
  { at: 36.3, type: 'collab', from: 'cleo', to: 'pip', kind: 'technique', label: 'practise together' },
  { at: 46.5, type: 'say', id: 'nova', text: 'Hello, world.' },
  { at: 47.5, type: 'say', id: 'fern', text: 'Welcome to the pack.' },
  { at: 48.4, type: 'collab', from: 'fern', to: 'nova', kind: 'resource', label: 'a little head start' },
  { at: 49.4, type: 'gift', from: 'mochi', to: 'nova', color: '#e4b960', label: 'welcome' },
  { at: 52, type: 'say', id: 'nova', text: 'For me? ♡' },
]

/** Events crossed since the last tick. Hidden tabs do not replay old meetings. */
export function storyEvents(previous, current) {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || current < previous || current - previous > 3) return []
  const events = []
  for (let cycle = Math.floor(previous / DURATION); cycle <= Math.floor(current / DURATION); cycle++) {
    for (const event of EVENTS) {
      const at = cycle * DURATION + event.at
      if (at > previous && at <= current) events.push({ ...event, at })
    }
  }
  return events
}

/** Pure map-aware story. Each pair makes a real journey on its side of town. */
export function createStory(map, { testPet = false } = {}) {
  const { workshop, library, dojo, campfire } = map.landmarks
  const key = (at, location) => ({ at, ...location })
  const positions = {}
  for (const [id, side, delay] of [['pip', -1, 0], ['cleo', 1, .6]]) {
    const home = offset(workshop, side * 2.4, 2.2)
    const work = offset(workshop, side * 1.15, .7)
    const practice = offset(dojo, side * 1.25, .7)
    positions[id] = itinerary(map, [
      key(0, home), key(delay || .05, home), key(4 + delay, work),
      key(11 + delay, work), key(28 + delay, practice), key(40 + delay, practice),
      key(58 + delay, home), key(DURATION, home),
    ])
  }
  for (const [id, side, delay] of [['fern', -1, 0], ['mochi', 1, .7]]) {
    const home = offset(campfire, side * 1.65, 1.4)
    const reading = offset(library, side * 1.15, .8)
    positions[id] = itinerary(map, [
      key(0, home), key(.5 + delay, home), key(16 + delay, reading),
      key(25 + delay, reading), key(42 + delay, home), key(DURATION, home),
    ])
  }
  const arrival = offset(campfire, 4.8, .7)
  const welcome = offset(campfire, .1, 2.1)
  positions.nova = itinerary(map, [key(0, arrival), key(44, arrival), key(47, welcome), key(55, welcome), key(59, arrival), key(DURATION, arrival)])
  const testHome = offset(workshop, -.2, 3.2)
  positions.test = itinerary(map, [key(0, testHome), key(12, testHome), key(29, offset(dojo, -.2, 3.2)), key(40, offset(dojo, -.2, 3.2)), key(58, testHome), key(DURATION, testHome)])

  function sample(time) {
    const t = loopTime(time)
    const definitions = testPet ? [...PETS, TEST_PET] : PETS
    return definitions.filter(pet => pet.id !== 'nova' || between(t, 44, 59)).map(pet => {
      const pose = positions[pet.id](t)
      let anim = pose.speed > .08 ? 'run' : 'idle'
      let status = 'idle'
      let skillCount = pet.skillCount
      if (pet.id === 'pip' || pet.id === 'cleo') {
        if (between(t, 5, 9.8)) { status = 'working'; anim = 'review' }
        if (between(t, 9.8, 11)) { status = 'done'; anim = 'jump' }
        if (between(t, 30, 39.2)) { status = 'working'; anim = Math.floor((t - 30) / 1.5) % 2 === (pet.id === 'pip' ? 0 : 1) ? 'jump' : 'review' }
        if (between(t, 39.2, 40)) { status = 'done'; anim = 'wave' }
        if (pet.id === 'cleo' && t >= 9.8) skillCount++
        if (pet.id === 'pip' && t >= 39.2) skillCount++
        if (pose.speed < .08) pose.facing = pet.id === 'pip' ? 1 : -1
      }
      if (pet.id === 'fern' || pet.id === 'mochi') {
        if (between(t, 17.2, 23.5)) { status = 'working'; anim = 'review' }
        if (between(t, 23.5, 25)) { status = 'done'; anim = 'wave' }
        if (between(t, 46.8, 48.5)) anim = 'wave'
        if (pose.speed < .08) pose.facing = pet.id === 'fern' ? 1 : -1
      }
      if (pet.id === 'nova') {
        if (between(t, 47, 49.5)) anim = 'wave'
        if (between(t, 50.8, 53)) { anim = 'jump'; status = 'done' }
        if (t >= 50.8) skillCount++
        if (pose.speed < .08) pose.facing = -1
      }
      return { ...pet, ...pose, skillCount, anim, status }
    })
  }

  return {
    duration: DURATION,
    sample,
    focus(time) {
      const t = loopTime(time)
      if (t < 12) return ['pip', 'cleo']
      if (t < 26) return ['fern', 'mochi']
      if (t < 41) return ['pip', 'cleo']
      if (t < 44) return ['fern', 'mochi']
      if (t < 56) return ['fern', 'mochi', 'nova']
      return ['pip', 'cleo']
    },
    events: storyEvents,
  }
}

// Legacy capture imports remain valid while the integration page is replaced.
const fallbackMap = {
  landmarks: { library: { x: -20, z: -8 }, workshop: { x: 18, z: -8 }, dojo: { x: 18, z: 10 }, campfire: { x: -16, z: 10 } },
  path: (from, to) => [from, to],
}
const defaults = new Map()
export function sampleStory(time, { testPet = false, map } = {}) {
  if (map) return createStory(map, { testPet }).sample(time)
  if (!defaults.has(testPet)) defaults.set(testPet, createStory(fallbackMap, { testPet }))
  return defaults.get(testPet).sample(time)
}
export function arrivalElevation() { return 0 }
