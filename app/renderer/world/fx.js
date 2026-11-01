import * as THREE from 'three'
import { createGlowField, seedFor } from './fx-sprites.js'
import { createBubbles } from './bubbles.js'
import { createGifts } from './gift.js'
import { createCollabs } from './collab.js'

const TAU = Math.PI * 2
function isVisible(anchor) {
  for (let object = anchor; object; object = object.parent) if (!object.visible) return false
  return true
}

/** Pixel effects in world space, with matching pixel-snapped DOM bubbles. */
export function createFx({ scene, camera, overlay, stage }) {
  const root = new THREE.Group()
  root.name = 'petpack-fx'
  scene.add(root)
  const pets = new Map()
  const field = createGlowField(root, camera, 8192, { pixelScale: stage?.pixelScale || 2 })
  const bubbles = createBubbles(overlay, camera, stage)
  const gifts = createGifts(root, field, bubbles, pets)
  const collabs = createCollabs(field, bubbles, pets)
  const feet = new THREE.Vector3(), head = new THREE.Vector3()
  let disposed = false, clock = 0
  function detach(id) {
    const pet = pets.get(id)
    if (!pet) return
    gifts.detach(id); collabs.detach(id)
    bubbles.detach(pet.ui)
    pets.delete(id)
  }
  const fx = {
    attach(id, { anchor, height = 2, color = '#8db6d1', name = '', isMe = false }) {
      if (disposed || !anchor?.getWorldPosition) return
      const previous = pets.get(id)
      const skills = previous?.skills || 0, status = previous?.ui.status || 'idle'
      const saying = previous?.ui.sayTime > 0 ? previous.ui.text : ''
      const sayTime = previous?.ui.sayTime || 0
      if (previous) bubbles.detach(previous.ui)
      const tint = new THREE.Color(color)
      const ui = bubbles.attach({ name, isMe, color: tint })
      pets.set(id, { anchor, height, color: tint, skills,
        orbitCount: previous?.orbitCount || 0, phase: seedFor(id) * TAU, ui })
      bubbles.status(ui, status)
      if (saying) { bubbles.say(ui, saying); ui.sayTime = sayTime }
    },
    detach,
    setSkills(id, count) {
      const pet = pets.get(id), value = Number(count)
      if (pet) pet.skills = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
    },
    setStatus(id, status) { const pet = pets.get(id); if (pet) bubbles.status(pet.ui, status) },
    say(id, text) { const pet = pets.get(id); if (pet) bubbles.say(pet.ui, text) },
    gift(fromId, toId, options) { return disposed ? Promise.resolve(false) : gifts.gift(fromId, toId, options) },
    collab(idA, idB, options) { return disposed ? Promise.resolve(false) : collabs.collab(idA, idB, options) },
    update(dt, t) {
      if (disposed) return
      dt = Number.isFinite(dt) ? Math.max(0, dt) : 0
      clock = Number.isFinite(t) ? t : clock + dt
      camera.updateMatrixWorld()
      field.begin()
      for (const pet of pets.values()) {
        pet.anchor.getWorldPosition(feet)
        head.copy(feet); head.y += pet.height + .13
        const visible = isVisible(pet.anchor)
        bubbles.update(pet.ui, feet, head, dt, clock, visible)
        pet.orbitCount += (pet.skills - pet.orbitCount) * (1 - Math.exp(-dt * 9))
        if (!visible) continue
        const slots = Math.min(8192, Math.max(pet.skills, Math.ceil(pet.orbitCount - .015)))
        for (let i = 0; i < slots; i++) {
          const alpha = THREE.MathUtils.clamp(pet.orbitCount - i, 0, 1)
          const angle = pet.phase + i * TAU / Math.max(1, slots) + clock * .55
          const radius = .99 + Math.floor(i / 8) * .14
          const x = feet.x + Math.cos(angle) * radius
          const y = feet.y + pet.height * .46 + Math.sin(angle * 2 + pet.phase) * .19
          const z = feet.z + Math.sin(angle) * radius * .65
          field.add(x, y, z, pet.color, .22 + (i % 3) * .018, alpha * .95,
            (Math.floor(clock * 2 + i * 1.37) % 5 === 0) ? 'sparkle' : 'dot')
        }
      }
      gifts.update(dt, clock); collabs.update(dt, clock)
      field.end()
    },
    resize(width, height) {
      if (disposed) return
      const w = Math.max(1, Number(width) || 1), h = Math.max(1, Number(height) || 1)
      field.resize(w, h); bubbles.resize(w, h)
    },
    dispose() {
      if (disposed) return
      disposed = true
      gifts.dispose(); collabs.dispose()
      for (const id of pets.keys()) detach(id)
      bubbles.dispose(); field.dispose(); scene.remove(root)
    },
  }
  fx.resize(overlay.clientWidth || 520, overlay.clientHeight || 340)
  return fx
}
