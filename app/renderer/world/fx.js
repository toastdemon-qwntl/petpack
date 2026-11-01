import * as THREE from 'three'
import { createGlowField, seedFor } from './fx-sprites.js'
import { createBubbles } from './bubbles.js'
import { createGifts } from './gift.js'

const TAU = Math.PI * 2

/** World-space lights and a camera-projected, pointer-transparent DOM layer. */
export function createFx({ scene, camera, overlay }) {
  const root = new THREE.Group()
  root.name = 'petpack-fx'
  scene.add(root)
  const pets = new Map()
  const field = createGlowField(root, camera)
  const bubbles = createBubbles(overlay, camera)
  const gifts = createGifts(root, field, bubbles, pets)
  const feet = new THREE.Vector3()
  const head = new THREE.Vector3()
  let disposed = false
  let clock = 0

  function detach(id) {
    const pet = pets.get(id)
    if (!pet) return
    gifts.detach(id)
    bubbles.detach(pet.ui)
    pets.delete(id)
  }

  const fx = {
    attach(id, { anchor, height = 1.4, color = '#0A84FF', name = '', isMe = false }) {
      if (disposed || !anchor) return
      const previous = pets.get(id)
      // Reattaching updates identity/atlas anchors without losing current UI state.
      const skills = previous?.skills || 0
      const status = previous?.ui.status || 'idle'
      const saying = previous?.ui.sayTime > 0 ? previous.ui.text : ''
      const sayTime = previous?.ui.sayTime || 0
      if (previous) bubbles.detach(previous.ui)
      const tint = new THREE.Color(color)
      const ui = bubbles.attach({ name, isMe, color: tint })
      pets.set(id, { anchor, height, color: tint, skills, orbitCount: previous?.orbitCount || 0,
        phase: seedFor(id) * TAU, ui })
      bubbles.status(ui, status)
      if (saying) { bubbles.say(ui, saying); ui.sayTime = sayTime }
    },
    detach,
    setSkills(id, count) {
      const pet = pets.get(id)
      if (pet) pet.skills = Math.max(0, Math.min(12, Math.floor(Number(count) || 0)))
    },
    setStatus(id, status) {
      const pet = pets.get(id)
      if (pet) bubbles.status(pet.ui, status)
    },
    say(id, text) {
      const pet = pets.get(id)
      if (pet) bubbles.say(pet.ui, text)
    },
    gift(fromId, toId, options) {
      return disposed ? Promise.resolve(false) : gifts.gift(fromId, toId, options)
    },
    update(dt, t) {
      if (disposed) return
      dt = Number.isFinite(dt) ? Math.max(0, dt) : 0
      clock = Number.isFinite(t) ? t : clock + dt
      camera.updateMatrixWorld()
      field.begin()
      for (const pet of pets.values()) {
        pet.anchor.getWorldPosition(feet)
        head.copy(feet); head.y += pet.height + .30
        bubbles.update(pet.ui, feet, head, dt, clock)
        pet.orbitCount += (pet.skills - pet.orbitCount) * (1 - Math.exp(-dt * 8))
        const slots = Math.max(pet.skills, Math.ceil(pet.orbitCount - .015))
        for (let i = 0; i < slots; i++) {
          const alpha = THREE.MathUtils.clamp(pet.orbitCount - i, 0, 1)
          const angle = pet.phase + i * 2.39996323 + clock * (.52 + (i % 3) * .085)
          const radius = .78 + (i % 3) * .13
          const x = feet.x + Math.cos(angle) * radius
          const y = feet.y + pet.height * .58 + Math.sin(angle + (i % 3) * .85) * .35
          const z = feet.z + Math.sin(angle) * radius * .66
          field.add(x, y, z, pet.color, .45 + Math.sin(clock * 2 + i) * .035, alpha * .9)
        }
      }
      gifts.update(dt, clock)
      field.end()
    },
    resize(width, height) {
      if (disposed) return
      const w = Math.max(1, Number(width) || 1)
      const h = Math.max(1, Number(height) || 1)
      field.resize(w, h); bubbles.resize(w, h)
    },
    dispose() {
      if (disposed) return
      disposed = true
      gifts.dispose()
      for (const id of pets.keys()) detach(id)
      bubbles.dispose(); field.dispose()
      scene.remove(root)
    },
  }
  fx.resize(overlay.clientWidth || 600, overlay.clientHeight || 300)
  return fx
}
