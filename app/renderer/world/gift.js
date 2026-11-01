import * as THREE from 'three'

const DURATION = 1.5
const ease = (p) => p * p * (3 - 2 * p)

export function createGifts(parent, field, bubbles, pets) {
  const flights = new Set()
  const bursts = new Set()
  const ringGeometry = new THREE.RingGeometry(.94, 1, 64)
  const from = new THREE.Vector3()
  const to = new THREE.Vector3()
  const point = new THREE.Vector3()

  function endpoint(pet, result) {
    pet.anchor.getWorldPosition(result)
    result.y += pet.height * .68
  }
  function arc(start, end, progress, result) {
    const p = ease(THREE.MathUtils.clamp(progress, 0, 1))
    result.lerpVectors(start, end, p)
    result.y += Math.sin(p * Math.PI) * 2.5
    result.z += Math.sin(p * Math.PI) * .32
    return result
  }
  function finish(flight, arrived) {
    flights.delete(flight)
    flight.label?.remove()
    flight.resolve(arrived)
  }
  function burst(flight, receiver, age) {
    const origin = new THREE.Vector3()
    receiver.anchor.getWorldPosition(origin)
    const rings = [0, 1].map(() => {
      const material = new THREE.MeshBasicMaterial({ color: flight.color, transparent: true,
        opacity: .7, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
      const ring = new THREE.Mesh(ringGeometry, material)
      ring.rotation.x = -Math.PI / 2
      ring.position.copy(origin); ring.position.y += .045
      ring.scale.setScalar(.01)
      parent.add(ring)
      return ring
    })
    bursts.add({ origin, color: flight.color, height: receiver.height * .85, age, rings })
  }
  function removeBurst(effect) {
    for (const ring of effect.rings) { parent.remove(ring); ring.material.dispose() }
    bursts.delete(effect)
  }

  return {
    gift(fromId, toId, { color, label } = {}) {
      const giver = pets.get(fromId)
      const receiver = pets.get(toId)
      if (!giver || !receiver) return Promise.resolve(false)
      return new Promise((resolve) => {
        const tint = new THREE.Color(color || giver.color)
        flights.add({ fromId, toId, color: tint, age: 0, resolve,
          start: new THREE.Vector3(), end: new THREE.Vector3(),
          label: bubbles.createGiftLabel(label) })
      })
    },
    detach(id) {
      for (const flight of flights) if (flight.fromId === id || flight.toId === id) finish(flight, false)
    },
    update(dt, t) {
      for (const flight of flights) {
        const giver = pets.get(flight.fromId)
        const receiver = pets.get(flight.toId)
        if (!giver || !receiver) { finish(flight, false); continue }
        flight.age += dt
        if (flight.arrived) {
          from.copy(flight.start); to.copy(flight.end)
          if (flight.age > DURATION + .35) { finish(flight, true); continue }
        } else {
          endpoint(giver, from); endpoint(receiver, to)
          flight.start.copy(from); flight.end.copy(to)
        }
        const progress = Math.min(1, flight.age / DURATION)
        const tailFade = Math.pow(Math.max(0, 1 - Math.max(0, flight.age - DURATION) / .35), 2)
        // Re-evaluate the same world-space curve for every camera. Anchors can
        // keep walking while the gift is in flight, including across seats.
        for (let i = 32; i >= 1; i--) {
          const p = progress - i * .0105
          if (p < 0) continue
          const taper = 1 - i / 33
          arc(from, to, p, point)
          field.add(point.x, point.y, point.z, flight.color, .18 + taper * .42, taper * taper * .62 * tailFade)
          if (i % 3 === 0) {
            const flutter = Math.sin(i * 2.4 + t * 5) * (1 - taper) * .13
            field.add(point.x, point.y + flutter, point.z + flutter, flight.color, .16, taper * .6 * tailFade)
          }
        }
        arc(from, to, progress, point)
        if (!flight.arrived) field.add(point.x, point.y, point.z, flight.color, 1.08 + Math.sin(t * 17) * .06, 1)
        const labelOpacity = Math.min(1, progress / .12, (1 - progress) / .16)
        bubbles.projectGift(flight.label, point, Math.max(0, labelOpacity))
        if (progress >= 1 && !flight.arrived) {
          // Resolve at contact; the comet's tail can dissolve after the pop.
          flight.arrived = true
          burst(flight, receiver, flight.age - DURATION - dt)
          flight.label?.remove(); flight.label = null
          flight.resolve(true)
        }
      }
      for (const effect of bursts) {
        effect.age += dt
        const age = effect.age
        if (age > 1.35) { removeBurst(effect); continue }
        const fade = Math.pow(Math.max(0, 1 - age / 1.35), 1.7)
        for (let i = 0; i < 28; i++) {
          const azimuth = i * 2.39996323
          const spread = .65 + (i % 7) * .13
          const radial = (1 - Math.exp(-age * 3.6)) * spread
          const lift = .75 + (i % 5) * .28
          const x = effect.origin.x + Math.cos(azimuth) * radial
          const y = effect.origin.y + effect.height + lift * age - 1.65 * age * age
          const z = effect.origin.z + Math.sin(azimuth) * radial * .65
          if (y > effect.origin.y + .03) field.add(x, y, z, effect.color, .20 + (i % 3) * .055, fade)
        }
        // A short central bloom makes the exact arrival readable, even at 600px.
        if (age < .32) field.add(effect.origin.x, effect.origin.y + effect.height, effect.origin.z,
          effect.color, 1.5 + age * 2, (1 - age / .32) * .85)
        effect.rings.forEach((ring, i) => {
          const p = THREE.MathUtils.clamp((age - i * .14) / 1.1, 0, 1)
          ring.visible = age >= i * .14
          ring.scale.setScalar(.2 + (1 - Math.pow(1 - p, 3)) * (1.45 + i * .25))
          ring.material.opacity = (1 - p) * (1 - p) * .55
        })
      }
    },
    dispose() {
      for (const flight of flights) finish(flight, false)
      for (const effect of bursts) removeBurst(effect)
      ringGeometry.dispose()
    },
  }
}
