import * as THREE from 'three'

const WHITE = new THREE.Color('#ffffff')
const TINT = {
  skill: new THREE.Color('#ffcd78'), memory: new THREE.Color('#9be5d5'),
  technique: new THREE.Color('#d8d1fb'), resource: new THREE.Color('#ffc88a'),
}
const LENGTH = { skill: 3.5, memory: 3.9, technique: 3.2, resource: 3.5 }
const clamp = THREE.MathUtils.clamp
const settle = p => 1 - (1 + p * 7) * Math.exp(-p * 7)

/** Cosmetic choreography only: the world's director owns pet poses and movement. */
export function createCollabs(field, bubbles, pets) {
  const active = new Set()
  const a = new THREE.Vector3(), b = new THREE.Vector3(), middle = new THREE.Vector3()
  function finish(effect, result) {
    active.delete(effect)
    effect.label?.remove()
    effect.resolve(result)
  }
  function sparkle(x, y, z, tint, age, count = 8, radius = .9) {
    for (let i = 0; i < count; i++) {
      const angle = i * Math.PI * 2 / count + .22
      const spread = settle(age * 2) * radius
      field.add(x + Math.cos(angle) * spread, y + Math.sin(angle) * spread * .75 - age * age * .3,
        z + Math.sin(i * 2.4) * spread * .3, tint, .13 + (i % 3) * .035,
        Math.max(0, 1 - age), i % 3 ? 'dot' : 'sparkle')
    }
  }
  return {
    collab(idA, idB, { kind = 'skill', label = '' } = {}) {
      if (!pets.has(idA) || !pets.has(idB) || idA === idB || !LENGTH[kind]) return Promise.resolve(false)
      // A pet has one collaboration at a time; callers of an interrupted scene are released.
      for (const effect of active) if ([effect.idA, effect.idB].includes(idA)
        || [effect.idA, effect.idB].includes(idB)) finish(effect, false)
      return new Promise(resolve => active.add({ idA, idB, kind, age: 0, resolve,
        duration: LENGTH[kind], label: bubbles.createGiftLabel(label) }))
    },
    detach(id) {
      for (const effect of active) if (effect.idA === id || effect.idB === id) finish(effect, false)
    },
    update(dt, t) {
      for (const effect of active) {
        const petA = pets.get(effect.idA), petB = pets.get(effect.idB)
        if (!petA || !petB) { finish(effect, false); continue }
        effect.age += dt
        const age = effect.age, p = clamp(age / effect.duration, 0, 1)
        petA.anchor.getWorldPosition(a); petB.anchor.getWorldPosition(b)
        middle.lerpVectors(a, b, .5)
        const y = middle.y + Math.min(petA.height, petB.height) * .58
        const x = middle.x, z = middle.z + .22
        const tint = TINT[effect.kind]
        const fade = Math.min(1, age * 5, (effect.duration - age) * 4)
        if (p >= 1) { finish(effect, true); continue }
        // The collaboration's shared object stays central as both pets continue moving.
        if (effect.kind === 'skill') {
          const working = age < 2.45
          if (working) {
            field.add(x, y - .15, z, WHITE, .88, fade, 'anvil')
            for (let side = -1; side <= 1; side += 2) {
              const phase = (age * 2.1 + (side < 0 ? 0 : .5)) % 1
              const lift = Math.sin(Math.PI * phase)
              field.add(x + side * (.30 + lift * .15), y + .27 + lift * .36, z + .04,
                WHITE, .68, fade, 'hammer', side)
              if (phase < .30) sparkle(x, y + .14, z + .06, tint, phase * 2.8, 7, .62)
            }
          } else {
            const born = age - 2.45
            field.add(x, y + .30 + settle(born) * .55, z, tint, .36 + Math.sin(born * 7) * .05, fade, 'sparkle')
            sparkle(x, y + .5, z, tint, born, 10)
          }
        } else if (effect.kind === 'memory') {
          const open = settle(Math.min(age, 1))
          field.add(x, y + .18 + Math.sin(age * 2) * .05, z, WHITE, 1.22 * open, fade, 'book')
          for (let i = 0; i < 6; i++) {
            const pageAge = (age - .38 - i * .27)
            if (pageAge < 0 || pageAge > 1.7) continue
            const progress = pageAge / 1.7, side = i % 2 ? -1 : 1
            field.add(x + side * settle(progress) * 1.25, y + .5 + Math.sin(progress * Math.PI) * .8,
              z - progress * .15, WHITE, .34, Math.min(1, pageAge * 5, (1 - progress) * 5), 'page', side)
          }
          if (age > 2.8) sparkle(x, y + .5, z, tint, age - 2.8, 10, 1.2)
        } else if (effect.kind === 'technique') {
          const beat = (age * 1.55) % 1
          const punch = Math.pow(Math.max(0, Math.sin(beat * Math.PI)), 3)
          for (let i = 0; i < 2; i++) {
            const anchor = i ? b : a, direction = i ? -1 : 1
            const h = (i ? petB : petA).height
            field.add(anchor.x + direction * (.4 + punch * .27), anchor.y + h * .60,
              anchor.z + .25, WHITE, .46, fade, 'fist', direction)
            for (let j = 0; j < 3; j++) {
              field.add(anchor.x - direction * (.52 + j * .13), anchor.y + h * (.35 + j * .19),
                anchor.z + .20, tint, .44 + punch * .26, punch * fade, 'slash', direction)
            }
            if (beat < .24) sparkle(anchor.x, anchor.y + h + .15, anchor.z,
              tint, beat * 3, 4, .4)
          }
          if (age > 2.5) sparkle(x, y + .7, z, tint, age - 2.5, 8, .8)
        } else {
          const pass = clamp((age - .45) / 2, 0, 1)
          const travel = settle(pass) / settle(1)
          const tx = THREE.MathUtils.lerp(a.x, b.x, travel)
          const tz = THREE.MathUtils.lerp(a.z, b.z, travel) + .28
          const ty = THREE.MathUtils.lerp(a.y + petA.height * .6, b.y + petB.height * .6, travel)
            + Math.sin(travel * Math.PI) * .85
          // The map supplies the campfire. Only the shared parcel and its embers are FX.
          field.add(tx, ty, tz, WHITE, .58, fade, 'item')
          for (let i = 0; i < 7; i++) {
            const ember = (age * .7 + i * .14) % 1
            field.add(x + Math.sin(i * 2.4 + age) * .5, middle.y + .35 + ember * 1.1, z,
              tint, .08 + (i % 2) * .04, (1 - ember) * fade, 'dot')
          }
          if (age > 2.45) sparkle(b.x, b.y + petB.height * .65, b.z + .15, tint, age - 2.45, 10)
        }
        middle.y = Math.max(y + 1.15, a.y + petA.height + .2, b.y + petB.height + .2)
        // Keep the shared label above participants' own speech/status bubbles.
        const bubbleHeight = pet => pet.ui.sayTime > 0 || pet.ui.status !== 'idle' ? pet.ui.bubble.height : 0
        const lift = Math.max(bubbleHeight(petA), bubbleHeight(petB))
        bubbles.projectGift(effect.label, middle, Math.max(0, fade), lift)
      }
    },
    dispose() { for (const effect of active) finish(effect, false) },
  }
}
