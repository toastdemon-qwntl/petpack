export const DURATION = 60
export const PETS = [
  { id: 'pip', displayName: 'Pip', color: '#6d99e5', kind: 'cat', skillCount: 3, memoryCount: 1, techniqueCount: 1, homeSeat: 0 },
  { id: 'cleo', displayName: 'Cleo', color: '#df706d', kind: 'cat', skillCount: 5, memoryCount: 4, techniqueCount: 2, homeSeat: 1 },
  { id: 'fern', displayName: 'Fern', color: '#80b291', kind: 'sprout', skillCount: 2, memoryCount: 2, techniqueCount: 3, homeSeat: 2 },
]
const TEST_PET = { id: 'test', displayName: 'Pixel', color: '#85bac8', kind: 'cat', skillCount: 2, homeSeat: 0 }
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

// One useful request changes a pet's day. These beats use the same simulation
// clock in every pane, including when a film jumps directly to a later frame.
export const EVENTS = [
  { at: 0, type: 'sleep', ids: ['pip', 'cleo'], enabled: true },
  { at: .6, type: 'sleep', ids: ['pip', 'cleo'], enabled: false },
  { at: .8, type: 'handshake', seat: 0, side: 'right' },
  { at: 6.2, type: 'weather', id: 'pip', weather: 'rain' },
  { at: 6.3, type: 'say', id: 'pip', text: 'Deploy is stuck…' },
  { at: 14.2, type: 'ask', from: 'pip', to: 'cleo', question: 'How do I deploy?',
    answer: 'Use azure-deploy.', kind: 'skill', label: 'azure-deploy' },
  { at: 17.7, type: 'weather', id: 'pip', weather: 'rainbow' },
  { at: 18.7, type: 'collab', from: 'pip', to: 'cleo', kind: 'memory', label: 'deployment checklist' },
  { at: 22.1, type: 'say', id: 'pip', text: 'Got it. Thank you!' },
  { at: 31.5, type: 'celebrate', id: 'pip' },
  { at: 34.6, type: 'say', id: 'pip', text: 'Shipped to Azure!' },
  { at: 36, type: 'knock', id: 'cleo', enabled: true },
  { at: 37.8, type: 'say', id: 'cleo', text: 'Need you for a moment.' },
  { at: 40.5, type: 'knock', id: 'cleo', enabled: false },
  { at: 42, type: 'arrive', id: 'fern', mode: 'balloon' },
  { at: 47.5, type: 'say', id: 'fern', text: 'Hello, neighbours!' },
  { at: 49.5, type: 'conga', ids: ['pip', 'cleo', 'fern'], durationS: 10 },
].sort((a, b) => a.at - b.at)

const giftColors = { skill: '#ffcd78', memory: '#9be5d5', technique: '#d8d1fb', resource: '#ffc88a' }
export function storyGift(event) {
  return { kind: event.kind || 'skill', color: event.color || giftColors[event.kind] || '#ffcd78',
    label: event.label, seed: `demo:${event.from}:${event.to}:${event.label || event.kind}` }
}
// A loop revisits the same knowledge: learned flowers persist without unlimited
// duplicates. A capture in a later loop restores those already-learned records.
export function previousGarden(time) {
  return time < DURATION ? [] : EVENTS.filter(e => (e.type === 'ask' || e.type === 'gift') && e.kind).map(storyGift)
}

/** Hidden tabs resume life now instead of replaying stale conversations. */
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

const kinds = ['skill', 'memory', 'technique', 'resource']
const labels = ['Workshop', 'Library', 'Dojo', 'Campfire']
function landmark(map, seat) {
  if (map.landmark) return map.landmark(seat)
  const type = ((seat % 4) + 4) % 4
  return { x: seat * (map.chunkWidth || 14), z: 1.5, kind: kinds[type], label: labels[type] }
}

/** Positions are a pure function of time; two computers see one shared journey. */
export function createStory(map, { testPet = false } = {}) {
  const workshop = landmark(map, 0), library = landmark(map, 1)
  const key = (at, location) => ({ at, ...location })
  const pipHome = offset(workshop, -1.35, 0)
  const cleoHome = offset(library, 1.35, 0)
  const pipVisit = offset(library, -1.35, 0)
  // Until the map lane lands its strip, keep this file loadable with the old map.
  const routes = map.landmark ? map : { path: (a, b) => [a, b] }
  const positions = {
    pip: itinerary(routes, [key(0, { x: 5.3, z: 1.5 }), key(2.4, { x: 5.3, z: 1.5 }),
      key(6, pipHome), key(8, pipHome), key(14, pipVisit), key(23, pipVisit),
      key(29, pipHome), key(60, pipHome)]),
    cleo: itinerary(routes, [key(0, { x: 8.7, z: 1.5 }), key(2.4, { x: 8.7, z: 1.5 }),
      key(6, cleoHome), key(60, cleoHome)]),
    fern: itinerary(routes, [key(0, offset(library, 4.4, 0)), key(60, offset(library, 4.4, 0))]),
    test: itinerary(routes, [key(0, offset(workshop, -3.2, .65)),
      key(30, offset(workshop, -3.2, .65)), key(38, offset(library, -3.2, .65)),
      key(50, offset(library, -3.2, .65)), key(60, offset(workshop, -3.2, .65))]),
  }
  function sample(time) {
    const t = loopTime(time)
    return [...PETS, ...(testPet ? [TEST_PET] : [])].filter(pet => pet.id !== 'fern' || t >= 42).map(pet => {
      const pose = positions[pet.id](t)
      let anim = pose.speed > .07 ? 'run' : 'idle', status = 'idle', skillCount = pet.skillCount, hat = 0
      if (pet.id === 'pip') {
        status = t < 5.6 ? 'idle' : t < 6.2 ? 'working' : t < 8 ? 'failed'
          : t < 17.6 ? 'waiting' : t < 18.7 ? 'idle' : t < 22.1 ? 'working'
            : t < 29 ? 'idle' : t < 31.5 ? 'working' : 'done'
        if (between(t, 6.2, 8)) anim = 'failed'
        if (between(t, 14, 17.6)) anim = 'waiting'
        if (between(t, 18.7, 22.1) || between(t, 29, 31.5)) anim = 'review'
        if (t >= 17.6) { skillCount++; hat = 3 }
        if (pose.speed < .07) pose.facing = 1
      } else if (pet.id === 'cleo') {
        if (between(t, 15.25, 17.6) || between(t, 18.7, 22.1)) { status = 'working'; anim = 'review' }
        if (between(t, 36, 40.5)) { status = 'waiting'; anim = 'waiting' }
        if (t >= 40.5) status = 'done'
        if (pose.speed < .07) pose.facing = -1
      } else if (pet.id === 'fern') {
        anim = t < 47.4 ? 'wave' : 'idle'
        status = t < 49.2 ? 'idle' : 'done'
      }
      if (t >= 49.2) status = 'done'
      // The task remains done while its celebration takes the visual foreground.
      // Speech still works; persistent status badges yield to clouds and confetti.
      const showStatus = t >= 6 && !between(t, 42, 47.5) && t < 49.5 &&
        !(pet.id === 'pip' && (between(t, 6.2, 14.2) || between(t, 17.7, 23) || between(t, 31.5, 34.6)))
      return { ...pet, ...pose, anim, status, skillCount, hat, showStatus }
    })
  }
  return { duration: DURATION, sample, events: storyEvents, focus: () => [] }
}

// Capture imports retained for old callers.
const defaultMap = { chunkWidth: 14, path: (a, b) => [a, b] }
const defaults = new Map()
export function sampleStory(time, { testPet = false, map } = {}) {
  if (map) return createStory(map, { testPet }).sample(time)
  if (!defaults.has(testPet)) defaults.set(testPet, createStory(defaultMap, { testPet }))
  return defaults.get(testPet).sample(time)
}
export function arrivalElevation() { return 0 }
