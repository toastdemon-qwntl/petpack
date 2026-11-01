import * as THREE from 'three'
import { createStage, SEAT_W } from './stage.js'
import { createDot } from './dot.js'
import { createSpritePet } from './sprite-pet.js'
import { createFx } from './fx.js'

const animations = new Set(['idle', 'run', 'wave', 'jump', 'failed', 'waiting', 'review'])
const statuses = new Set(['idle', 'working', 'waiting', 'done', 'failed'])
const positionedParents = new WeakMap()

/** The network-facing world. Every pet, including neighbours, lives in world coordinates. */
export function createWorld(canvas, { seat = 0, seatWidth = SEAT_W, clock } = {}) {
  const parent = canvas.parentElement
  if (!parent) throw new Error('The world canvas must be attached to an element')
  let parentPosition = positionedParents.get(parent)
  if (!parentPosition && getComputedStyle(parent).position === 'static') {
    parentPosition = { previous: parent.style.position, count: 0 }
    positionedParents.set(parent, parentPosition)
    parent.style.position = 'relative'
  }
  if (parentPosition) parentPosition.count++
  const overlay = document.createElement('div')
  overlay.className = 'petpack-fx-overlay'
  Object.assign(overlay.style, { position: 'absolute', pointerEvents: 'none', overflow: 'hidden' })
  parent.append(overlay)

  const stage = createStage(canvas, { seat, seatWidth })
  const fx = createFx({ scene: stage.scene, camera: stage.camera, overlay })
  const pets = new Map()
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let disposed = false
  let frameId = 0
  let previousFrame
  let currentSeat = seat

  function syncFx(pet) {
    fx.attach(pet.id, {
      anchor: pet.anchor, height: pet.character.height, color: pet.info.color,
      name: pet.info.displayName, isMe: pet.info.isMe,
    })
    fx.setSkills(pet.id, pet.info.skillCount)
    fx.setStatus(pet.id, pet.state.status)
  }

  function replaceCharacter(pet, character) {
    pet.character.object3d.removeFromParent()
    pet.character.dispose()
    pet.character = character
    pet.anchor.add(character.object3d)
    character.set({ ...pet.state, moving: pet.speed })
    syncFx(pet)
  }

  function loadSprite(pet) {
    const generation = ++pet.generation
    if (!pet.info.spriteUrl) return
    createSpritePet({ spriteUrl: pet.info.spriteUrl, color: pet.info.color }).then(character => {
      if (disposed || pets.get(pet.id) !== pet || pet.generation !== generation) {
        character.dispose()
        return
      }
      replaceCharacter(pet, character)
    }).catch(() => {
      // A missing or unreadable atlas leaves the built-in Dot in place.
    })
  }

  function upsertPet(id, info = {}) {
    if (disposed) return
    let pet = pets.get(id)
    if (pet) {
      const previous = pet.info
      pet.info = { ...previous, ...info }
      if (previous.color !== pet.info.color || previous.spriteUrl !== pet.info.spriteUrl) {
        replaceCharacter(pet, createDot({ color: pet.info.color }))
        loadSprite(pet)
      } else if (previous.displayName !== pet.info.displayName || previous.isMe !== pet.info.isMe) {
        syncFx(pet)
      }
      if (previous.skillCount !== pet.info.skillCount) fx.setSkills(id, pet.info.skillCount)
      return
    }
    const metadata = { displayName: '', color: '#0A84FF', spriteUrl: null, skillCount: 0, isMe: false, ...info }
    const character = createDot({ color: metadata.color })
    const anchor = new THREE.Group()
    anchor.userData.petpackId = id
    anchor.add(character.object3d)
    anchor.visible = false
    stage.scene.add(anchor)
    pet = {
      id, info: metadata, anchor, character, generation: 0, positioned: false,
      x: (currentSeat + 0.5) * seatWidth, targetX: 0, speed: 0,
      state: { anim: 'idle', facing: 1, status: 'idle' },
      elevation: metadata.entrance === 'drop' ? 7 : 0, fallVelocity: 0,
    }
    pets.set(id, pet)
    syncFx(pet)
    loadSprite(pet)
  }

  function updatePet(id, state = {}) {
    const pet = pets.get(id)
    if (!pet || disposed) return
    if (Number.isFinite(state.x)) {
      pet.targetX = state.x
      if (!pet.positioned || state.snap) {
        pet.x = state.x
        pet.positioned = true
        pet.anchor.visible = true
        placePet(pet)
      }
    }
    if (animations.has(state.anim)) pet.state.anim = state.anim
    if (state.facing === 1 || state.facing === -1) pet.state.facing = state.facing
    if (statuses.has(state.status) && state.status !== pet.state.status) {
      pet.state.status = state.status
      fx.setStatus(id, state.status)
    }
    // Optional deterministic elevation for the demo's sky arrival.
    if (Number.isFinite(state.elevation)) {
      pet.elevation = Math.max(0, state.elevation)
      pet.fallVelocity = 0
      pet.controlledElevation = true
    }
  }

  function placePet(pet) {
    const ground = stage.ground(pet.x)
    pet.anchor.position.set(pet.x, ground.y + pet.elevation, ground.z)
  }

  function removePet(id) {
    const pet = pets.get(id)
    if (!pet) return
    pets.delete(id)
    pet.generation++
    fx.detach(id)
    pet.anchor.removeFromParent()
    pet.character.dispose()
  }

  function resize() {
    if (disposed) return
    const width = Math.max(1, canvas.clientWidth)
    const height = Math.max(1, canvas.clientHeight)
    Object.assign(overlay.style, {
      left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`,
      width: `${width}px`, height: `${height}px`,
    })
    stage.resize(width, height)
    fx.resize(width, height)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  resize()

  function frame(now) {
    if (disposed) return
    const time = clock ? clock() : now / 1000
    // The optional clock synchronizes poses. Real frame time still lets UI springs
    // settle when a demo is paused or the user requests reduced motion.
    const elapsed = previousFrame === undefined ? 1 / 60 : Math.max(0, (now - previousFrame) / 1000)
    const dt = Math.min(elapsed, 0.05)
    previousFrame = now
    stage.update(dt, time)
    for (const pet of pets.values()) {
      const before = pet.x
      pet.x += (pet.targetX - pet.x) * (1 - Math.exp(-15 * dt))
      const velocity = dt ? Math.abs(pet.x - before) / dt : 0
      pet.speed += (velocity - pet.speed) * (1 - Math.exp(-12 * dt))
      if (pet.elevation > 0 && !pet.controlledElevation) {
        pet.fallVelocity -= dt * 24
        pet.elevation = Math.max(0, pet.elevation + pet.fallVelocity * dt)
        if (!pet.elevation) pet.character.pop()
      }
      placePet(pet)
      pet.character.set({ anim: pet.state.anim, facing: pet.state.facing, moving: pet.speed })
      pet.character.update(dt, time)
    }
    stage.scene.updateMatrixWorld(true)
    stage.camera.updateMatrixWorld(true)
    fx.update(Math.min(elapsed, 3), time)
    stage.render()
    frameId = requestAnimationFrame(frame)
  }
  frameId = requestAnimationFrame(frame)

  return {
    setSeat(next) {
      if (disposed || !Number.isFinite(next)) return
      currentSeat = next
      stage.setSeat(next)
    },
    upsertPet, updatePet, removePet,
    giftFx(fromId, toId, options = {}) {
      if (disposed || !pets.has(fromId) || !pets.has(toId)) return Promise.resolve()
      const receiver = pets.get(toId)
      return Promise.resolve(fx.gift(fromId, toId, options)).then(result => {
        if (!disposed && pets.get(toId) === receiver && result !== false && result?.cancelled !== true) receiver.character.pop()
        return result
      })
    },
    say(id, text) { if (!disposed && pets.has(id)) fx.say(id, String(text)) },
    pick(clientX, clientY) {
      if (disposed) return null
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
      pointer.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2)
      stage.scene.updateMatrixWorld(true)
      stage.camera.updateMatrixWorld(true)
      raycaster.setFromCamera(pointer, stage.camera)
      const anchors = [...pets.values()].filter(pet => pet.anchor.visible).map(pet => pet.anchor)
      for (const hit of raycaster.intersectObjects(anchors, true)) {
        let object = hit.object
        if (object.userData.noPick) continue
        while (object) {
          if (object.userData.petpackId !== undefined) return object.userData.petpackId
          object = object.parent
        }
      }
      return null
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(frameId)
      observer.disconnect()
      for (const id of [...pets.keys()]) removePet(id)
      fx.dispose()
      stage.dispose()
      overlay.remove()
      if (parentPosition && --parentPosition.count === 0) {
        if (parent.style.position === 'relative') parent.style.position = parentPosition.previous
        positionedParents.delete(parent)
      }
    },
  }
}
