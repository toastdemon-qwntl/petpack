export const DURATION = 45
export const PETS = [
  { id: 'pip', displayName: 'Pip', color: '#0A84FF', skillCount: 5, seat: 0 },
  { id: 'cleo', displayName: 'Cleo', color: '#FF375F', skillCount: 2, seat: 0 },
  { id: 'mochi', displayName: 'Mochi', color: '#FF9F0A', skillCount: 3, seat: 1 },
  { id: 'fern', displayName: 'Fern', color: '#30D158', skillCount: 4, seat: 2 },
  { id: 'nova', displayName: 'Nova', color: '#BF5AF2', skillCount: 1, seat: 2 },
]

const clamp = value => Math.max(0, Math.min(1, value))
const ease = value => { const p = clamp(value); return p * p * (3 - 2 * p) }
const between = (t, start, end) => t >= start && t < end
const lerp = (a, b, t) => a + (b - a) * t
export const loopTime = time => ((time % DURATION) + DURATION) % DURATION

export function arrivalElevation(time) {
  const age = loopTime(time) - 30
  if (age < 0) return 0
  if (age < 0.72) return 7 * (1 - (age / 0.72) ** 2)
  if (age < 1.35) return Math.sin((age - 0.72) / 0.63 * Math.PI) * 0.65
  return 0
}

function position(id, t) {
  if (id === 'pip') return t < 12 ? 6.1 + Math.sin(t * 0.48) * 1.6 : t < 18 ? lerp(5.36, 11.2, ease((t - 12) / 6)) : t < 33 ? 11.2 + Math.sin((t - 18) * 0.5) * 0.18 : lerp(11.37, 6.1, ease((t - 33) / 12))
  if (id === 'cleo') return t < 10 ? 11.8 + Math.sin(t * 0.55) * 0.65 : t < 17 ? lerp(11.34, 20.2, ease((t - 10) / 7)) : t < 34 ? 20.2 + Math.sin((t - 17) * 0.45) * 0.55 : lerp(20.73, 11.8, ease((t - 34) / 11))
  if (id === 'mochi') return 27 + Math.sin(t * Math.PI * 4 / DURATION + 1) * 1.15
  if (id === 'fern') return 36.5 + Math.sin(t * Math.PI * 2 / DURATION) * 1.25
  if (id === 'nova') return 43 + Math.sin((t - 30) * 0.55) * 0.45
  return 24 + Math.sin(t * 0.7) * 0.6
}

/** Pure shared state: independent of frame rate, viewport, seat and renderer. */
export function sampleStory(time, { testPet = false } = {}) {
  const t = loopTime(time)
  const definitions = testPet ? [...PETS, { id: 'test', displayName: 'Pixel', color: '#64D2FF', skillCount: 2, seat: 1 }] : PETS
  return definitions.filter(pet => pet.id !== 'nova' || t >= 30).map(pet => {
    const x = position(pet.id, t)
    const velocity = (position(pet.id, t + 0.02) - x) / 0.02
    let anim = Math.abs(velocity) > 0.12 ? 'run' : 'idle'
    let status = 'idle'
    let skillCount = pet.skillCount
    let elevation = 0
    if (pet.id === 'pip') {
      if (between(t, 2, 6.8)) { status = 'working'; anim = 'review' }
      if (between(t, 6.8, 10)) { status = 'done'; anim = t < 8 ? 'jump' : 'wave' }
      if (between(t, 18.6, 21)) anim = 'wave'
    }
    if (pet.id === 'mochi' && between(t, 7, 11)) { status = 'waiting'; anim = 'waiting' }
    if (pet.id === 'cleo') {
      if (t >= 20.5) skillCount++
      if (between(t, 20.5, 22)) { status = 'done'; anim = 'jump' }
      if (between(t, 23, 25)) anim = 'wave'
    }
    if (pet.id === 'fern') {
      if (t >= 24.5) skillCount++
      if (between(t, 24.5, 26)) { status = 'done'; anim = 'jump' }
      if (between(t, 32, 34)) anim = 'wave'
    }
    if (pet.id === 'nova') {
      const age = t - 30
      elevation = arrivalElevation(time)
      if (age < 2) anim = 'jump'
      if (t >= 33.5) skillCount++
      if (between(t, 33.5, 35.5)) { status = 'done'; anim = 'jump' }
    }
    return { ...pet, skillCount, x, anim, status, facing: velocity < -0.03 ? -1 : 1, elevation }
  })
}

export const EVENTS = [
  { at: 19, type: 'gift', from: 'pip', to: 'cleo', color: '#0A84FF', label: 'pdf' },
  { at: 20.5, type: 'say', id: 'cleo', text: 'learned pdf' },
  { at: 23, type: 'gift', from: 'cleo', to: 'fern', color: '#0A84FF', label: 'pdf' },
  { at: 24.5, type: 'say', id: 'fern', text: 'learned pdf' },
  { at: 31.1, type: 'say', id: 'nova', text: 'hello, world' },
  { at: 32, type: 'gift', from: 'fern', to: 'nova', color: '#30D158', label: 'welcome' },
  { at: 33.5, type: 'say', id: 'nova', text: 'learned a new trick' },
]

/** Events crossed since the last tick. Hidden tabs never replay a backlog of gifts. */
export function storyEvents(previous, current) {
  if (current < previous || current - previous > 3) return []
  const events = []
  const first = Math.floor(previous / DURATION)
  const last = Math.floor(current / DURATION)
  for (let cycle = first; cycle <= last; cycle++) {
    for (const event of EVENTS) {
      const at = cycle * DURATION + event.at
      if (at > previous && at <= current) events.push({ ...event, at })
    }
  }
  return events
}
