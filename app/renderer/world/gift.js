import * as THREE from 'three'

const FLIGHT = 1.35
const BURST = .55
const ease = p => p * p * (3 - 2 * p)

/** One moving pixel, a sparse comet tail, and a little eight-way arrival burst. */
export function createGifts(_parent, field, bubbles, pets) {
  const flights = new Set()
  const point = new THREE.Vector3()
  function endpoint(pet, result) {
    pet.anchor.getWorldPosition(result)
    result.y += pet.height * .66
    result.z += .12
  }
  function arc(start, end, progress, result) {
    const p = ease(THREE.MathUtils.clamp(progress, 0, 1))
    result.lerpVectors(start, end, p)
    // Keep a hop readable in the little pane, even for neighbouring pets.
    result.y += Math.sin(p * Math.PI) * Math.min(1.6, .65 + start.distanceTo(end) * .13)
    return result
  }
  function finish(flight, arrived) {
    flights.delete(flight)
    flight.label?.remove()
    flight.resolve(arrived)
  }
  return {
    gift(fromId, toId, { color, label } = {}) {
      const giver = pets.get(fromId), receiver = pets.get(toId)
      if (!giver || !receiver || fromId === toId) return Promise.resolve(false)
      return new Promise(resolve => flights.add({ fromId, toId, color: new THREE.Color(color || giver.color),
        age: 0, resolve, start: new THREE.Vector3(), end: new THREE.Vector3(),
        label: bubbles.createGiftLabel(label) }))
    },
    detach(id) {
      for (const flight of flights) if (flight.fromId === id || flight.toId === id) finish(flight, false)
    },
    update(dt, t) {
      for (const flight of flights) {
        const giver = pets.get(flight.fromId), receiver = pets.get(flight.toId)
        if (!giver || !receiver) { finish(flight, false); continue }
        flight.age += dt
        const progress = Math.min(1, flight.age / FLIGHT)
        const after = flight.age - FLIGHT
        if (after >= BURST) { finish(flight, true); continue }
        endpoint(giver, flight.start); endpoint(receiver, flight.end)
        if (after < 0) {
          for (let i = 1; i <= 10; i++) {
            const tail = progress - i * .035
            if (tail < 0) continue
            arc(flight.start, flight.end, tail, point)
            point.y += Math.sin(i * 2.4 + t * 4) * .045
            field.add(point.x, point.y, point.z, flight.color, .07 + (1 - i / 11) * .10,
              (1 - i / 12) * .8, i % 3 ? 'dot' : 'sparkle')
          }
          arc(flight.start, flight.end, progress, point)
          field.add(point.x, point.y, point.z, flight.color, .38, 1, 'sparkle')
          bubbles.projectGift(flight.label, point, Math.max(0, Math.min(1, progress * 7, (1 - progress) * 6)))
        } else {
          // Preserve the World API's contact cue; the visual burst finishes afterward.
          if (!flight.arrived) { flight.arrived = true; flight.resolve(true) }
          flight.label?.remove(); flight.label = null
          const p = after / BURST, spread = (1 - (1 + p * 5) * Math.exp(-p * 5)) * .95
          for (let i = 0; i < 10; i++) {
            const angle = i * Math.PI / 5
            field.add(flight.end.x + Math.cos(angle) * spread,
              flight.end.y + Math.sin(angle) * spread * .85 - p * p * .17,
              flight.end.z + .06, flight.color, i % 2 ? .12 : .19, 1 - p,
              i % 2 ? 'dot' : 'sparkle')
          }
          field.add(flight.end.x, flight.end.y, flight.end.z, flight.color,
            .43 * (1 - p), Math.max(0, 1 - p * 2), 'sparkle')
        }
      }
    },
    dispose() { for (const flight of flights) finish(flight, false) },
  }
}
