import * as THREE from 'three'
import { createStage } from './stage.js'
import * as village from './map.js'
import { createPixelPet } from './pixel-pet.js'
import { createSpritePet } from './sprite-pet.js'
import { createFx } from './fx.js'

const animations = new Set(['idle', 'run', 'wave', 'jump', 'failed', 'waiting', 'review'])
const statuses = new Set(['idle', 'working', 'waiting', 'done', 'failed'])
const parents = new WeakMap()
const finite = Number.isFinite
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

/** One window into the shared village. The optional clock is in seconds. */
export function createWorld(container, { seat = 0, pixelScale = 2, dock = null, clock, autoRender = true } = {}) {
  const ownsCanvas = container.tagName !== 'CANVAS'
  const canvas = ownsCanvas ? document.createElement('canvas') : container
  const parent = ownsCanvas ? container : canvas.parentElement
  if (!parent) throw new Error('Attach the world to an element before creating it')
  let parentState = parents.get(parent)
  if (!parentState) {
    parentState = { count: 0, position: parent.style.position, changed: getComputedStyle(parent).position === 'static' }
    parents.set(parent, parentState)
    if (parentState.changed) parent.style.position = 'relative'
  }
  parentState.count++
  const pane = parent.closest('.petpack-pane') || parent
  const oldDock = pane.getAttribute('data-dock')
  if (dock === 'left' || dock === 'right') pane.dataset.dock = dock
  canvas.classList.add('petpack-world-canvas')
  canvas.setAttribute('aria-label', 'A living pixel-art village where pets share and learn together')
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated' })
  if (ownsCanvas) parent.append(canvas)
  const overlay = document.createElement('div')
  overlay.className = 'petpack-fx-overlay'
  Object.assign(overlay.style, { position: 'absolute', pointerEvents: 'none', overflow: 'hidden' })
  parent.append(overlay)
  const stage = createStage(canvas, { pixelScale })
  const map = village.createMap(stage.scene, { seed: 77 })
  const chunkWidth = map.chunkWidth || village.CHUNK_W || 14
  let fx = createFx({ scene: stage.scene, camera: stage.camera, overlay, stage })
  const pets = new Map()
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const beforePoint = new THREE.Vector3()
  let disposed = false
  let frameId = 0
  let previousFrame
  let previousTime
  let currentSeat = 0
  let loadedSeat = null
  const pendingAsks = new Set()

  function setSeat(nextSeat) {
    if (disposed || !finite(Number(nextSeat))) return
    currentSeat = Math.trunc(Number(nextSeat))
    map.ensure?.(currentSeat - 1, currentSeat + 1)
    loadedSeat = currentSeat
    const center = map.chunkCenter?.(currentSeat) || { x: currentSeat * chunkWidth, z: 0 }
    stage.focus(center.x, center.z, { span: chunkWidth })
  }
  setSeat(seat)
  // The first frame is already at its seat; only subsequent seat changes glide.
  for (let i = 0; i < 24; i++) stage.update(.25, 0)

  function syncFx(pet) {
    fx.attach(pet.id, { anchor: pet.anchor, height: pet.character.height, color: pet.info.color,
      name: pet.info.displayName, isMe: pet.info.isMe })
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
      if (disposed || pets.get(pet.id) !== pet || generation !== pet.generation) { character.dispose(); return }
      replaceCharacter(pet, character)
    }).catch(() => { /* Keep the procedural pet when an atlas is missing or unreadable. */ })
  }
  function upsertPet(id, info = {}) {
    if (disposed) return
    let pet = pets.get(id)
    if (pet) {
      const old = pet.info
      pet.info = { ...old, ...info }
      if (old.color !== pet.info.color || old.kind !== pet.info.kind || old.spriteUrl !== pet.info.spriteUrl) {
        replaceCharacter(pet, createPixelPet(pet.info))
        loadSprite(pet)
      } else if (old.displayName !== pet.info.displayName || old.isMe !== pet.info.isMe) syncFx(pet)
      if (old.skillCount !== pet.info.skillCount) fx.setSkills(id, pet.info.skillCount)
      return
    }
    const metadata = { displayName: '', color: '#71b6db', kind: 'cat', spriteUrl: null, skillCount: 0, isMe: false, ...info }
    const character = createPixelPet(metadata)
    const anchor = new THREE.Group()
    anchor.userData.petpackId = id
    anchor.add(character.object3d)
    anchor.visible = false
    stage.scene.add(anchor)
    pet = { id, info: metadata, character, anchor, generation: 0, positioned: false,
      x: 0, z: 0, lastX: 0, lastZ: 0, target: null, route: [], travelSpeed: 0, speed: 0,
      state: { anim: 'idle', facing: 1, status: 'idle' } }
    pets.set(id, pet)
    syncFx(pet)
    loadSprite(pet)
  }
  function placePet(pet) {
    const y = map.ground(pet.x, pet.z)
    pet.anchor.position.set(pet.x, finite(y) ? y : 0, pet.z)
  }
  function updatePet(id, state = {}) {
    const pet = pets.get(id)
    if (!pet || disposed) return
    if (finite(state.x) || finite(state.z)) {
      const target = { x: finite(state.x) ? state.x : pet.x, z: finite(state.z) ? state.z : pet.z }
      if (!pet.positioned || state.snap) {
        if (!pet.positioned) { pet.lastX = target.x; pet.lastZ = target.z }
        pet.x = target.x; pet.z = target.z
        pet.positioned = true; pet.anchor.visible = true
        pet.route = []; pet.travelSpeed = 0; pet.target = target
        placePet(pet)
      } else if (!pet.target || distance(target, pet.target) > .001) {
        pet.target = target
        pet.route = (map.path({ x: pet.x, z: pet.z }, target) || [])
          .filter(p => finite(p.x) && finite(p.z)).map(p => ({ x: p.x, z: p.z }))
        while (pet.route.length && distance(pet, pet.route[0]) < .001) pet.route.shift()
      }
    }
    if (animations.has(state.anim)) pet.state.anim = state.anim
    pet.sampledSpeed = state.snap && finite(state.speed) ? Math.max(0, state.speed) : null
    // A resting pose may look at a companion; walking always derives its turn below.
    if (state.facing === 1 || state.facing === -1) pet.state.facing = state.facing
    if (statuses.has(state.status) && state.status !== pet.state.status) {
      pet.state.status = state.status
      fx.setStatus(id, state.status)
    }
  }
  function walk(pet, dt) {
    if (!pet.route.length || !dt) return
    let remaining = distance(pet, pet.route[0])
    for (let i = 1; i < pet.route.length; i++) remaining += distance(pet.route[i - 1], pet.route[i])
    const desired = Math.min(3.2, remaining * 5)
    pet.travelSpeed += (desired - pet.travelSpeed) * (1 - Math.exp(-dt * 9))
    let step = Math.min(remaining, pet.travelSpeed * dt)
    while (pet.route.length && step > 0) {
      const next = pet.route[0]
      const length = distance(pet, next)
      if (length <= step + .00001) {
        pet.x = next.x; pet.z = next.z
        pet.route.shift(); step -= length
      } else {
        pet.x += (next.x - pet.x) * step / length
        pet.z += (next.z - pet.z) * step / length
        step = 0
      }
    }
    if (remaining < .004) { pet.x = pet.route.at(-1)?.x ?? pet.x; pet.z = pet.route.at(-1)?.z ?? pet.z; pet.route = []; pet.travelSpeed = 0 }
  }
  function removePet(id) {
    const pet = pets.get(id)
    if (!pet) return
    pets.delete(id); pet.generation++
    fx.detach(id)
    pet.anchor.removeFromParent()
    pet.character.dispose()
    for (const task of pendingAsks) if (task.from === id || task.to === id) {
      pendingAsks.delete(task); task.resolve(false)
    }
  }
  // Retained for round-2 callers. A pane belongs to its seat, even during a visit.
  function follow() {}
  function resize() {
    if (disposed) return
    const width = Math.max(1, canvas.clientWidth)
    const height = Math.max(1, canvas.clientHeight)
    Object.assign(overlay.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${width}px`, height: `${height}px` })
    stage.resize(width, height)
    fx.resize(width, height)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(ownsCanvas ? container : canvas)
  resize()
  function frame(now) {
    if (disposed) return
    const time = clock ? clock() : now / 1000
    const elapsed = Math.max(0, previousFrame === undefined ? 1 / 60 : (now - previousFrame) / 1000)
    const realDt = Math.min(.25, elapsed)
    const clockDelta = clock ? Math.max(0, previousTime === undefined ? 0 : time - previousTime) : elapsed
    previousFrame = now; previousTime = time
    renderFrame(clockDelta, time, { cameraDt: realDt })
    frameId = requestAnimationFrame(frame)
  }
  function renderFrame(clockDelta = 0, time = 0, { render = true, cameraDt = clockDelta } = {}) {
    if (disposed) return
    clockDelta = finite(clockDelta) ? Math.max(0, clockDelta) : 0
    const dt = Math.min(.1, clockDelta)
    for (const pet of pets.values()) {
      if (!pet.positioned) continue
      walk(pet, dt)
      const dx = pet.x - pet.lastX
      const dz = pet.z - pet.lastZ
      pet.speed = pet.sampledSpeed ?? (clockDelta ? Math.min(8, Math.hypot(dx, dz) / clockDelta) : 0)
      placePet(pet)
      beforePoint.set(pet.lastX, pet.anchor.position.y, pet.lastZ)
      const screenDelta = stage.toScreen(pet.anchor.position).x - stage.toScreen(beforePoint).x
      if (Math.abs(screenDelta) > .03) pet.state.facing = screenDelta < 0 ? -1 : 1
      const anim = pet.speed > .07 ? 'run' : pet.state.anim === 'run' ? 'idle' : pet.state.anim
      pet.character.set({ anim, facing: pet.state.facing, moving: pet.speed })
      pet.character.update(dt, time)
      pet.lastX = pet.x; pet.lastZ = pet.z
    }
    stage.update(Math.min(.25, cameraDt), time)
    // Stream the visible neighbourhood during long seat changes, too. Retain
    // bounded chunks instead of loading every intervening seat at once.
    const visibleSeat = Math.round(stage.camera.position.x / chunkWidth)
    if (visibleSeat !== loadedSeat) {
      map.ensure?.(visibleSeat - 1, visibleSeat + 1)
      loadedSeat = visibleSeat
    }
    map.update(dt, time)
    stage.scene.updateMatrixWorld(true)
    stage.camera.updateMatrixWorld(true)
    for (const task of pendingAsks) {
      task.age += dt
      if (task.age >= 2.3 && task.phase === 0) { fx.setStatus(task.to, 'working'); task.phase++ }
      if (task.age >= 3.6 && task.phase === 1) { fx.say(task.to, task.options.answer || 'Let me help.'); task.phase++ }
      if (task.age >= 6.3) {
        pendingAsks.delete(task)
        if (task.options.kind) gift(task.to, task.from, task.options).then(task.resolve)
        else task.resolve(true)
      }
    }
    fx.update(Math.min(3, clockDelta), time)
    if (render) stage.render()
  }
  if (autoRender) frameId = requestAnimationFrame(frame)
  function gift(fromId, toId, options = {}) {
    if (disposed || !pets.has(fromId) || !pets.has(toId)) return Promise.resolve(false)
    const receiver = pets.get(toId)
    return Promise.resolve(fx.gift(fromId, toId, options)).then(result => {
      if (!disposed && pets.get(toId) === receiver && result !== false && !result?.cancelled) receiver.character.pop()
      return result
    })
  }
  return {
    upsertPet, updatePet, removePet, follow, gift, giftFx: gift, setSeat, renderFrame,
    get seat() { return currentSeat },
    resetEffects() {
      if (disposed) return
      for (const task of pendingAsks) task.resolve(false)
      pendingAsks.clear()
      fx.dispose()
      fx = createFx({ scene: stage.scene, camera: stage.camera, overlay, stage })
      for (const pet of pets.values()) syncFx(pet)
      resize()
    },
    ask(fromId, toId, options = {}) {
      if (disposed || fromId === toId || !pets.has(fromId) || !pets.has(toId)) return Promise.resolve(false)
      if (typeof fx.ask === 'function') {
        const asker = pets.get(fromId)
        return Promise.resolve(fx.ask(fromId, toId, options)).then(result => {
          if (!disposed && result === true && options.kind && pets.get(fromId) === asker) asker.character.pop()
          return result
        })
      }
      fx.say(fromId, options.question || 'Can you help?')
      return new Promise(resolve => pendingAsks.add({ from: fromId, to: toId, options, age: 0, phase: 0, resolve }))
    },
    // Read-only references let a deterministic director use the real map's routes.
    map, stage,
    collab(idA, idB, options = {}) {
      if (disposed || !pets.has(idA) || !pets.has(idB)) return Promise.resolve(false)
      return typeof fx.collab === 'function' ? Promise.resolve(fx.collab(idA, idB, options)) : gift(idA, idB, options)
    },
    say(id, text) { if (!disposed && pets.has(id)) fx.say(id, String(text)) },
    pick(clientX, clientY) {
      if (disposed) return null
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
      pointer.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2)
      stage.scene.updateMatrixWorld(true); stage.camera.updateMatrixWorld(true)
      raycaster.setFromCamera(pointer, stage.camera)
      for (const hit of raycaster.intersectObjects([...pets.values()].filter(p => p.positioned).map(p => p.anchor), true)) {
        if (hit.object.userData.noPick) continue
        let object = hit.object
        while (object) { if (object.userData.petpackId !== undefined) return object.userData.petpackId; object = object.parent }
      }
      return null
    },
    snapshot() { return [...pets.values()].map(p => ({ id: p.id, x: p.x, z: p.z, moving: p.speed, facing: p.state.facing, status: p.state.status, route: p.route.length })) },
    dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(frameId); observer.disconnect()
      for (const id of [...pets.keys()]) removePet(id)
      fx.dispose(); map.dispose(); stage.dispose()
      overlay.remove()
      if (ownsCanvas) canvas.remove()
      if (dock === 'left' || dock === 'right') {
        if (oldDock === null) pane.removeAttribute('data-dock')
        else pane.setAttribute('data-dock', oldDock)
      }
      if (--parentState.count === 0) {
        if (parentState.changed && parent.style.position === 'relative') parent.style.position = parentState.position
        parents.delete(parent)
      }
    },
  }
}
