/**
 * attachPlay(world, { container, date? }) returns the same World. Attach just
 * after createWorld, before upsertPet, to retain names and knowledge counts.
 * Adds:
 *   world.throwPet(id, { vx = 0, vz = 0, from?, to?, duration?, elapsed? })
 *     -> Promise<boolean>; velocities are world units/second, never pane pixels.
 *     Optional replay fields come directly from an onThrow event. No re-broadcast.
 *   world.onThrow(callback) -> unsubscribe; a local drag emits
 *     { id, from:{x,y,z}, to:{x,y,z}, duration, vx, vz } at release.
 *   world.touchPet(id, { from?, facing?, elapsed? } = {}) -> boolean; replay a giggle.
 *   world.onTouch(callback) -> unsubscribe; emits { id, from, facing } locally.
 *     Only the touched pane opens the card; the world-space giggle is shared.
 *   world.photo() -> PNG data URL, art resolution enlarged exactly 4×.
 *   world.playHitTest(clientX, clientY) -> pet id|null, for native click-through.
 * Captured drags continue beyond the pane; cancellation restores the start.
 * Positional updates during a throw are held until landing. Status/count updates
 * remain live. Drive the existing renderFrame for shared-clock remote replays.
 * No independent animation loop; disposal/reset/removal settle pending throws.
 */
import * as THREE from 'three'
import { attachPhoto, drawPixelIcon } from './photo.js'

const installed = new WeakMap()
const atlasPixels = new WeakMap()
const finite = Number.isFinite
const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
const TAU = Math.PI * 2
const gravity = 15
const movement = state => Object.fromEntries(['x', 'z', 'anim', 'facing', 'speed', 'snap']
  .filter(key => state[key] !== undefined).map(key => [key, state[key]]))

function spring(s, target, dt, frequency = 18) {
  const offset = s.x - target, impulse = s.v + frequency * offset
  const decay = Math.exp(-frequency * dt)
  s.x = target + (offset + impulse * dt) * decay
  s.v = (s.v - frequency * impulse * dt) * decay
  return s.x
}

// Clip hit targets to the atlas silhouette, including its transparent padding.
// The row envelope preserves ears/legs; holes inside a creature remain touchable.
function silhouette(sprite) {
  const texture = sprite.material.map, image = texture?.image
  if (!image?.width) return 'inset(15%)'
  let entry = atlasPixels.get(image)
  if (!entry) {
    const canvas = document.createElement('canvas')
    canvas.width = image.width; canvas.height = image.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(image, 0, 0)
    try { entry = { pixels: ctx.getImageData(0, 0, image.width, image.height).data, shapes: new Map() } }
    catch { return 'inset(15%)' }
    atlasPixels.set(image, entry)
  }
  const f = sprite.userData.frame || { row: 0, column: 0, flip: false }
  const key = `${f.row}/${f.column}/${f.flip}`
  if (entry.shapes.has(key)) return entry.shapes.get(key)
  const w = Math.round(image.width * Math.abs(texture.repeat.x))
  const h = Math.round(image.height * texture.repeat.y)
  const left = [], right = []
  for (let y = 0; y < h; y++) {
    let low = w, high = -1
    for (let x = 0; x < w; x++) {
      const sx = f.column * w + (f.flip ? w - x - 1 : x)
      if (entry.pixels[((f.row * h + y) * image.width + sx) * 4 + 3] > 127) { low = Math.min(low, x); high = x }
    }
    if (high >= low) {
      left.push(`${low / w * 100}% ${y / h * 100}%`, `${low / w * 100}% ${(y + 1) / h * 100}%`)
      right.unshift(`${(high + 1) / w * 100}% ${(y + 1) / h * 100}%`, `${(high + 1) / w * 100}% ${y / h * 100}%`)
    }
  }
  const shape = left.length ? `polygon(${left.concat(right).join(',')})` : 'inset(50%)'
  entry.shapes.set(key, shape)
  return shape
}

export function attachPlay(world, { container = world.stage?.renderer?.domElement?.parentElement, date } = {}) {
  if (installed.has(world)) return world
  const stage = world.stage, scene = stage?.scene, canvas = stage?.renderer?.domElement
  if (!container || !scene || !canvas) throw new TypeError('attachPlay needs a live petpack world and container')
  attachPhoto(world, { date })
  const doc = canvas.ownerDocument, view = doc.defaultView
  const old = Object.fromEntries(['updatePet', 'upsertPet', 'removePet', 'snapshot', 'resetEffects', 'dispose'].map(key => [key, world[key]]))
  const originalUpdate = stage.update
  const metadata = new Map(), destinations = new Map(), pets = new Map(), actions = new Map(), listeners = new Set(), touchListeners = new Set(), particles = new Set()
  const iconTextures = new Map()
  const pos = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3()
  const layer = doc.createElement('div')
  layer.className = 'petpack-play-layer'
  Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '4' })
  container.append(layer)
  const priorPointer = [container.style.pointerEvents, canvas.style.pointerEvents]
  container.style.pointerEvents = canvas.style.pointerEvents = 'none'
  let disposed = false, selected = null, hover = null, pressed = null, lastTime

  const card = doc.createElement('div')
  card.className = 'petpack-play-card'
  card.setAttribute('role', 'status')
  Object.assign(card.style, { position: 'absolute', width: '148px', boxSizing: 'border-box', padding: '8px 10px',
    background: '#fff6df', color: '#466b61', border: '2px solid #d8d5af', boxShadow: '3px 4px 0 #365f5838',
    font: '11px/1.25 ui-monospace, SFMono-Regular, Consolas, monospace', pointerEvents: 'none',
    clipPath: 'polygon(4px 0,calc(100% - 4px) 0,calc(100% - 4px) 2px,100% 2px,100% calc(100% - 4px),calc(100% - 2px) calc(100% - 4px),calc(100% - 2px) 100%,4px 100%,4px calc(100% - 2px),0 calc(100% - 2px),0 4px,4px 4px)', display: 'none' })
  const title = doc.createElement('div'), counts = doc.createElement('div'), statusIcon = doc.createElement('canvas'), name = doc.createElement('span')
  statusIcon.width = statusIcon.height = 9
  Object.assign(statusIcon.style, { width: '14px', height: '14px', imageRendering: 'pixelated', flexShrink: '0' })
  Object.assign(title.style, { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '7px' })
  Object.assign(name.style, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: '600' })
  Object.assign(counts.style, { display: 'flex', justifyContent: 'space-between', gap: '8px' })
  title.append(statusIcon, name); card.append(title, counts); layer.append(card)
  const countNodes = ['skill', 'memory', 'technique'].map(kind => {
    const row = doc.createElement('span'), icon = doc.createElement('canvas'), value = doc.createElement('span')
    icon.width = icon.height = 9
    Object.assign(icon.style, { width: '14px', height: '14px', imageRendering: 'pixelated' })
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '3px' })
    drawPixelIcon(icon.getContext('2d'), kind, 0, 0)
    row.append(icon, value); counts.append(row)
    return { row, value, kind }
  })
  let cardKey = '', cardSpring = { x: 0, v: 0 }

  function iconTexture(kind) {
    if (iconTextures.has(kind)) return iconTextures.get(kind)
    const c = doc.createElement('canvas'); c.width = c.height = 9
    drawPixelIcon(c.getContext('2d'), kind, 0, 0)
    const texture = new THREE.CanvasTexture(c)
    texture.magFilter = texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false; texture.colorSpace = THREE.SRGBColorSpace
    iconTextures.set(kind, texture)
    return texture
  }
  function particle(kind, id, index = 0) {
    const material = new THREE.SpriteMaterial({ map: iconTexture(kind), transparent: true, depthWrite: false, toneMapped: false })
    const object = new THREE.Sprite(material)
    object.userData.noPick = object.userData.noOutline = true
    object.scale.setScalar(kind === 'heart' ? .4 : .24)
    scene.add(object)
    const item = { object, id, kind, index, age: 0 }
    particles.add(item)
    return item
  }
  function removeParticle(item) { item.object.removeFromParent(); item.object.material.dispose(); particles.delete(item) }

  function outline(sprite) {
    const material = sprite.material.clone()
    material.map = sprite.material.map
    material.transparent = true; material.depthWrite = false; material.alphaTest = .01
    material.color.set('#fff4cb'); material.opacity = .64
    const step = { value: new THREE.Vector2(.001, .001) }
    const compile = sprite.material.onBeforeCompile
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(sprite.material, shader, renderer)
      shader.uniforms.playTexel = step
      shader.fragmentShader = 'uniform vec2 playTexel;\n' + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        float center = texture2D(map, vMapUv).a;
        float edge = max(max(texture2D(map, vMapUv + vec2(playTexel.x,0)).a,
          texture2D(map, vMapUv - vec2(playTexel.x,0)).a),
          max(texture2D(map, vMapUv + vec2(0,playTexel.y)).a,
          texture2D(map, vMapUv - vec2(0,playTexel.y)).a));
        diffuseColor.a *= edge * (1.0 - center);`)
    }
    material.customProgramCacheKey = () => 'petpack-play-silhouette-v1'
    const glow = new THREE.Sprite(material)
    glow.name = 'PLAY hover silhouette'
    glow.userData.noPick = glow.userData.noOutline = true
    glow.onBeforeRender = sprite.onBeforeRender
    glow.visible = false
    sprite.parent.add(glow)
    return { glow, step }
  }
  function syncPets() {
    const snapshots = old.snapshot.call(world)
    const live = new Set(snapshots.map(p => p.id))
    for (const id of pets.keys()) if (!live.has(id)) releasePet(id)
    for (const snapshot of snapshots) {
      const anchor = scene.children.find(o => o.userData.petpackId === snapshot.id)
      if (!anchor?.visible) continue
      let sprite
      anchor.traverse(o => { if (o.isSprite && o.material.userData.pixelSprite && !o.userData.noPick) sprite = o })
      if (!sprite) continue
      let pet = pets.get(snapshot.id)
      if (pet?.sprite !== sprite) {
        if (pet) releasePet(snapshot.id)
        const hit = doc.createElement('button')
        hit.type = 'button'; hit.dataset.petId = String(snapshot.id)
        Object.assign(hit.style, { position: 'absolute', display: 'block', padding: '0', border: '0', background: 'transparent',
          pointerEvents: 'auto', touchAction: 'none', userSelect: 'none', cursor: 'grab', outline: 'none' })
        layer.prepend(hit)
        pet = { id: snapshot.id, anchor, sprite, scale: sprite.scale.clone(), rotation: sprite.material.rotation,
          hit, ...outline(sprite), snapshot }
        pets.set(snapshot.id, pet)
        hit.addEventListener('pointerdown', event => pointerDown(event, pet))
        hit.addEventListener('pointerenter', () => { hover = pet.id })
        hit.addEventListener('pointerleave', () => { if (hover === pet.id) hover = null })
        hit.addEventListener('focus', () => { hover = pet.id })
        hit.addEventListener('blur', () => { if (hover === pet.id) hover = null })
        hit.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); giggle(pet.id) } })
        hit.addEventListener('lostpointercapture', () => { if (pressed?.id === pet.id) cancelGrab() })
      }
      pet.snapshot = snapshot
      const info = metadata.get(pet.id) || snapshot
      pet.hit.setAttribute('aria-label', info.displayName || String(pet.id))
    }
    return snapshots
  }
  function settle(id, result, restore = false) {
    const action = actions.get(id)
    if (!action) return
    actions.delete(id)
    if (restore && action.origin) {
      old.updatePet.call(world, id, { x: action.origin.x, z: action.origin.z, snap: true, speed: 0, anim: 'idle' })
      const target = action.deferred || action.returnTo
      if (target) old.updatePet.call(world, id, { ...target, snap: false })
    }
    action.resolve?.(result)
  }
  function restorePose(pet) {
    const applied = pet.applied
    if (!applied) return
    // Restore only values still owned by this decorator. Another lane may have
    // applied a new pose, and the cast resets its own vertical pop every frame.
    if (pet.sprite.scale.equals(applied.scale)) pet.sprite.scale.copy(applied.baseScale)
    if (pet.sprite.material.rotation === applied.rotation) pet.sprite.material.rotation = applied.baseRotation
    for (const axis of ['x', 'y', 'z']) if (pet.sprite.position[axis] === applied.position[axis]) pet.sprite.position[axis] = applied.basePosition[axis]
    pet.applied = null
  }
  function releasePet(id) {
    if (pressed?.id === id) cancelGrab()
    settle(id, false)
    const pet = pets.get(id)
    if (!pet) return
    restorePose(pet)
    pet.glow.removeFromParent(); pet.glow.material.dispose(); pet.hit.remove()
    for (const item of particles) if (item.id === id) removeParticle(item)
    pets.delete(id)
    if (selected === id) closeCard()
    if (hover === id) hover = null
  }
  function closeCard() { selected = null; card.style.display = 'none'; cardKey = '' }
  function giggle(id, local = true, options = {}) {
    const pet = pets.get(id)
    if (disposed || !pet || actions.has(id)) return false
    const point = { ...pet.snapshot }
    if (options.from && [options.from.x, options.from.z].every(finite)) {
      point.x = options.from.x; point.z = options.from.z
    }
    old.updatePet.call(world, id, { x: point.x, z: point.z, snap: true, anim: 'idle', speed: 0 })
    const age = finite(options.elapsed) ? Math.max(0, options.elapsed) : 0
    const facing = options.facing === -1 || options.facing === 1 ? options.facing : point.facing
    actions.set(id, { phase: 'giggle', age, facing, origin: point, returnTo: destinations.get(id), x: point.x, z: point.z })
    particle('heart', id).age = age
    if (local) {
      selected = id; cardSpring = { x: 0, v: 0 }; card.style.display = 'block'
      for (const listener of touchListeners) {
        try { listener({ id, from: { x: point.x, z: point.z }, facing }) } catch (error) { view.reportError?.(error) }
      }
    }
    return true
  }
  function safeGround(x, z) { const y = world.map.ground(x, z); return finite(y) ? y : 0 }
  function throwPet(id, options = {}, notify = false) {
    if (disposed) return Promise.resolve(false)
    syncPets()
    const pet = pets.get(id)
    if (!pet) return Promise.resolve(false)
    const velocity = { vx: finite(options.vx) ? clamp(options.vx, -28, 28) : 0, vz: finite(options.vz) ? clamp(options.vz, -16, 16) : 0 }
    const prior = actions.get(id)
    const from = { x: pet.snapshot.x, y: safeGround(pet.snapshot.x, pet.snapshot.z), z: pet.snapshot.z }
    if (prior?.phase === 'grab') { from.x = prior.x; from.z = prior.z; from.y = safeGround(from.x, from.z) + prior.lift.x }
    if (options.from && [options.from.x, options.from.z].every(finite)) Object.assign(from, options.from)
    if (!finite(from.y)) from.y = safeGround(from.x, from.z)
    const duration = finite(options.duration) ? clamp(options.duration, .35, 2) : clamp(.72 + Math.hypot(velocity.vx, velocity.vz) * .023, .72, 1.3)
    const target = options.to && [options.to.x, options.to.z].every(finite) ? options.to : { x: from.x + velocity.vx * duration, z: from.z + velocity.vz * duration }
    const endpoint = world.map.path(from, target)?.at(-1) || { x: target.x, z: 1.5 }
    const to = { x: endpoint.x, y: safeGround(endpoint.x, endpoint.z), z: endpoint.z }
    settle(id, false)
    destinations.set(id, { x: to.x, z: to.z })
    closeCard()
    let resolve
    const promise = new Promise(done => { resolve = done })
    actions.set(id, { phase: 'flight', age: Math.max(0, finite(options.elapsed) ? options.elapsed : 0), from, to, duration,
      origin: { ...pet.snapshot }, x: from.x, z: from.z, resolve, vx: (to.x - from.x) / duration, facing: to.x < from.x ? -1 : 1 })
    old.updatePet.call(world, id, { x: from.x, z: from.z, snap: true, anim: 'run', speed: 3 })
    const event = { id, from: { ...from }, to: { ...to }, duration, vx: velocity.vx, vz: velocity.vz }
    if (notify) for (const listener of listeners) {
      try { listener(event) } catch (error) { view.reportError?.(error) }
    }
    return promise
  }
  function planeDelta(dx, dy) {
    const o = stage.toScreen(pos.set(0, 0, 0)), x = stage.toScreen(pos.set(1, 0, 0)), z = stage.toScreen(pos.set(0, 0, 1))
    const ax = x.x - o.x, ay = x.y - o.y, bx = z.x - o.x, by = z.y - o.y
    const determinant = ax * by - ay * bx
    return { x: (dx * by - dy * bx) / determinant, z: (dy * ax - dx * ay) / determinant }
  }
  function pointerDown(event, pet) {
    if (event.button !== 0 || pressed || disposed || actions.get(pet.id)?.phase === 'flight') return
    event.preventDefault(); event.stopPropagation()
    closeCard(); settle(pet.id, false)
    const p = old.snapshot.call(world).find(p => p.id === pet.id)
    if (!p) return
    const now = performance.now()
    pressed = { id: pet.id, pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      moved: false, samples: [{ x: event.clientX, y: event.clientY, t: now }], target: pet.hit }
    actions.set(pet.id, { phase: 'grab', age: 0, origin: { ...p }, returnTo: destinations.get(pet.id), x: p.x, z: p.z, tx: p.x, tz: p.z,
      sx: { x: p.x, v: 0 }, sz: { x: p.z, v: 0 }, lift: { x: 0, v: 0 }, sway: { x: 0, v: 0 } })
    old.updatePet.call(world, pet.id, { x: p.x, z: p.z, snap: true, speed: 0, anim: 'idle' })
    pet.hit.setPointerCapture(event.pointerId)
    pet.hit.style.cursor = 'grabbing'
  }
  function pointerMove(event) {
    if (!pressed || event.pointerId !== pressed.pointer) return
    const action = actions.get(pressed.id)
    if (!action) return
    const dx = event.clientX - pressed.clientX, dy = event.clientY - pressed.clientY
    if (Math.hypot(dx, dy) > 4) pressed.moved = true
    const delta = planeDelta(dx, dy)
    action.tx = action.origin.x + delta.x; action.tz = action.origin.z + delta.z
    const now = performance.now()
    pressed.samples.push({ x: event.clientX, y: event.clientY, t: now })
    pressed.samples = pressed.samples.filter(p => now - p.t <= 100).slice(-12)
  }
  function endCapture() {
    const capture = pressed
    pressed = null
    if (capture?.target.hasPointerCapture(capture.pointer)) capture.target.releasePointerCapture(capture.pointer)
    if (capture) capture.target.style.cursor = 'grab'
    return capture
  }
  function cancelGrab() {
    const capture = endCapture()
    if (capture) settle(capture.id, false, true)
  }
  function pointerUp(event) {
    if (!pressed || event.pointerId !== pressed.pointer) return
    pointerMove(event)
    const capture = endCapture(), action = actions.get(capture.id)
    if (!action) return
    if (!capture.moved && action.age < .32) { settle(capture.id, false, true); giggle(capture.id); return }
    const samples = capture.samples, first = samples[0], last = samples.at(-1)
    const seconds = Math.max(.025, (last.t - first.t) / 1000)
    const velocity = planeDelta((last.x - first.x) / seconds, (last.y - first.y) / seconds)
    throwPet(capture.id, { vx: velocity.x, vz: velocity.z }, true)
  }
  const outside = event => { if (!event.target.closest?.('.petpack-play-layer button')) closeCard() }
  const escape = event => { if (event.key === 'Escape') { cancelGrab(); closeCard() } }
  const cancelPointer = event => { if (event.pointerId === pressed?.pointer) cancelGrab() }
  const hidden = () => { if (doc.hidden) cancelGrab() }
  doc.addEventListener('pointerdown', outside, true)
  view.addEventListener('pointermove', pointerMove)
  view.addEventListener('pointerup', pointerUp)
  view.addEventListener('pointercancel', cancelPointer)
  view.addEventListener('blur', cancelGrab)
  doc.addEventListener('visibilitychange', hidden)
  doc.addEventListener('keydown', escape)

  function advance(dt) {
    syncPets()
    for (const pet of pets.values()) {
      const action = actions.get(pet.id)
      if (action) {
        const baseScale = pet.sprite.scale.clone(), basePosition = pet.sprite.position.clone(), baseRotation = pet.sprite.material.rotation
        action.age += dt
        let lift = 0, angle = 0, squash = 1, width = 1
        if (action.phase === 'grab') {
          action.x = spring(action.sx, action.tx, dt)
          action.z = spring(action.sz, action.tz, dt)
          lift = spring(action.lift, action.age > .12 || pressed?.moved ? .85 : 0, dt)
          angle = spring(action.sway, clamp(-action.sx.v * .045, -.35, .35), dt, 12) + Math.sin(action.age * 17) * .045 * lift
          old.updatePet.call(world, pet.id, { x: action.x, z: action.z, snap: true, speed: lift > .1 ? 2.8 : 0, anim: lift > .1 ? 'run' : 'idle' })
        } else if (action.phase === 'flight') {
          const t = Math.min(action.age, action.duration), progress = t / action.duration
          action.x = action.from.x + (action.to.x - action.from.x) * progress
          action.z = action.from.z + (action.to.z - action.from.z) * progress
          const y = action.from.y + (action.to.y - action.from.y) * progress + gravity * t * (action.duration - t) / 2
          lift = Math.max(0, y - safeGround(action.x, action.z))
          angle = clamp(-action.vx * .015, -.35, .35) * Math.sin(progress * Math.PI)
          old.updatePet.call(world, pet.id, { x: action.x, z: action.z, snap: true, speed: 3, anim: 'run' })
          if (action.age >= action.duration) {
            action.age -= action.duration; action.phase = 'land'
            for (let i = 0; i < 3; i++) particle('star', pet.id, i).age = action.age - dt
          }
        }
        if (action.phase === 'land') {
          const impact = Math.exp(-action.age * 10) * Math.cos(action.age * 19)
          squash = 1 - .3 * impact; width = 1 + .22 * impact
          angle = Math.sin(action.age * 18) * .06 * Math.exp(-action.age * 3)
          old.updatePet.call(world, pet.id, { x: action.x, z: action.z, snap: true, speed: 0, anim: 'idle' })
          if (action.age >= 1.1) {
            const deferred = action.deferred || action.returnTo
            settle(pet.id, true)
            if (deferred) old.updatePet.call(world, pet.id, { ...deferred, snap: false })
          }
        } else if (action.phase === 'giggle') {
          const p = clamp(action.age / .62, 0, 1), eased = 1 - (1 + 8 * p) * Math.exp(-8 * p)
          // Billboard pirouette: a quick full turn, tiny lift, then spring settle.
          angle = TAU * eased
          lift = Math.sin(Math.PI * p) * .3
          if (action.age >= .72) {
            const deferred = action.deferred || action.returnTo
            settle(pet.id, true)
            if (deferred) old.updatePet.call(world, pet.id, { ...deferred, snap: false })
          }
        }
        pet.anchor.position.set(action.x, safeGround(action.x, action.z), action.z)
        // Rotate around the centre for a pirouette, and the head when dangling.
        // A billboard normally rotates around its feet, which would send its
        // face through the road on the upside-down half of a turn.
        const pivot = action.phase === 'giggle' ? 1 : action.phase === 'grab' ? 1.85 : 0
        right.setFromMatrixColumn(stage.camera.matrixWorld, 0)
        up.setFromMatrixColumn(stage.camera.matrixWorld, 1)
        pet.sprite.position.copy(basePosition).addScaledVector(right, Math.sin(angle) * pivot)
          .addScaledVector(up, (1 - Math.cos(angle)) * pivot)
        pet.sprite.position.y += lift
        pet.sprite.scale.set(baseScale.x * width, baseScale.y * squash, baseScale.z)
        pet.sprite.material.rotation = baseRotation + angle
        pet.applied = { baseScale, basePosition, baseRotation, scale: pet.sprite.scale.clone(),
          position: pet.sprite.position.clone(), rotation: pet.sprite.material.rotation }
        // Newer casts expose deterministic sampling; older casts retain their
        // normal animation. This also resets a local drag's leg phase on launch.
        pet.sprite.userData.petpackSample?.({
          anim: ['grab', 'flight'].includes(action.phase) ? 'run' : 'idle',
          phase: action.age * 2.4, elapsed: action.age,
          facing: action.facing ?? pet.snapshot.facing,
        })
        pet.anchor.traverse(object => {
          if (object.isMesh && object.userData.noPick && object.material?.transparent) {
            object.material.opacity /= 1 + lift * 1.8
          }
        })
      }
      pet.glow.visible = hover === pet.id || pressed?.id === pet.id
      pet.glow.position.copy(pet.sprite.position)
      pet.glow.scale.copy(pet.sprite.scale); pet.glow.center.copy(pet.sprite.center)
      pet.glow.material.rotation = pet.sprite.material.rotation
      const artPixel = (stage.camera.right - stage.camera.left) / (canvas.clientWidth / stage.pixelScale + 4)
      pet.step.value.set(Math.abs(pet.sprite.material.map.repeat.x) * artPixel / pet.sprite.scale.x,
        pet.sprite.material.map.repeat.y * artPixel / pet.sprite.scale.y)
    }
    scene.updateMatrixWorld(true)
    for (const item of particles) {
      item.age += dt
      const pet = pets.get(item.id)
      if (!pet || item.age > (item.kind === 'heart' ? .95 : 1.1)) { removeParticle(item); continue }
      const p = pet.anchor.position
      if (item.kind === 'heart') {
        item.object.position.set(p.x + .68, p.y + 2.05 + item.age * .6, p.z)
        item.object.scale.setScalar(.38 * (1 - Math.exp(-item.age * 22)))
      } else {
        const phase = item.age * 7 + item.index * TAU / 3
        item.object.position.set(p.x + Math.cos(phase) * .68, p.y + 2.08 + Math.sin(phase * 2) * .10, p.z + Math.sin(phase) * .35)
      }
      item.object.material.opacity = clamp((1.1 - item.age) * 4, 0, 1)
    }
    layout(dt)
  }
  function layout(dt) {
    const rect = canvas.getBoundingClientRect(), host = container.getBoundingClientRect()
    const offsetX = rect.left - host.left, offsetY = rect.top - host.top
    const unit = stage.toScreen(right.setFromMatrixColumn(stage.camera.matrixWorld, 0))
    const origin = stage.toScreen(pos.set(0, 0, 0))
    const pixels = Math.hypot(unit.x - origin.x, unit.y - origin.y)
    for (const pet of pets.values()) {
      pet.sprite.getWorldPosition(pos)
      const p = stage.toScreen(pos), w = pet.sprite.scale.x * pixels, h = pet.sprite.scale.y * pixels
      const left = p.x - pet.sprite.center.x * w, top = p.y - (1 - pet.sprite.center.y) * h
      const visible = left + w >= 0 && left <= rect.width && top + h >= 0 && top <= rect.height
      pet.hit.style.display = visible ? 'block' : 'none'
      if (!visible) continue
      Object.assign(pet.hit.style, { left: `${left + offsetX}px`, top: `${top + offsetY}px`, width: `${w}px`, height: `${h}px`,
        clipPath: silhouette(pet.sprite), transformOrigin: `${pet.sprite.center.x * 100}% ${(1 - pet.sprite.center.y) * 100}%`,
        transform: `rotate(${-pet.sprite.material.rotation}rad)` })
      // A nearer pet owns overlapping hit pixels, just like the depth buffer.
      pet.hit.style.zIndex = String(10 + Math.round(pet.anchor.position.z * 10))
      if (selected !== pet.id) continue
      const info = metadata.get(pet.id) || pet.snapshot
      const count = key => Math.max(0, Math.trunc(Number(info[key]) || 0))
      const values = [count('skillCount'), count('memoryCount'), count('techniqueCount')]
      const status = pet.snapshot.status || 'idle'
      const key = JSON.stringify([info.displayName || pet.id, status, values])
      if (key !== cardKey) {
        cardKey = key; name.textContent = info.displayName || String(pet.id)
        const ctx = statusIcon.getContext('2d'); ctx.clearRect(0, 0, 9, 9); drawPixelIcon(ctx, status, 0, 0)
        countNodes.forEach((node, i) => { node.value.textContent = values[i] > 99 ? '99+' : values[i]; node.row.title = `${values[i]} ${node.kind}s` })
        card.setAttribute('aria-label', `${name.textContent}, ${status}; ${values[0]} skills, ${values[1]} memories, ${values[2]} techniques`)
      }
      const progress = spring(cardSpring, 1, dt, 20)
      const cw = Math.min(148, rect.width - 8)
      card.style.width = `${cw}px`; card.style.zIndex = '1000'
      let cx = p.x + 25
      if (cx + cw > rect.width - 4) cx = p.x - cw - 25
      const cy = clamp(p.y - 72, 4, Math.max(4, rect.height - 64))
      const px = stage.pixelScale
      Object.assign(card.style, { display: 'block', left: `${Math.round(clamp(cx, 4, rect.width - cw - 4) / px) * px + offsetX}px`,
        top: `${Math.round((cy + (1 - progress) * 8) / px) * px + offsetY}px`, opacity: String(progress) })
    }
    if (selected !== null && pets.get(selected)?.hit.style.display === 'none') card.style.display = 'none'
  }

  stage.update = function(dt, time) {
    for (const pet of pets.values()) restorePose(pet)
    originalUpdate.call(stage, dt, time)
    if (disposed) return
    const delta = finite(time) && finite(lastTime) ? Math.max(0, time - lastTime) : Math.max(0, dt || 0)
    lastTime = finite(time) ? time : undefined
    advance(delta)
  }
  world.upsertPet = function(id, info = {}) { metadata.set(id, { ...metadata.get(id), ...info }); return old.upsertPet.call(world, id, info) }
  world.updatePet = function(id, state = {}) {
    if (finite(state.x) || finite(state.z)) destinations.set(id, { ...destinations.get(id), ...movement(state) })
    const action = actions.get(id)
    if (!action) return old.updatePet.call(world, id, state)
    const { x, z, snap, speed, anim, facing, ...rest } = state
    if (finite(x) || finite(z)) action.deferred = { ...action.deferred, ...movement(state) }
    return old.updatePet.call(world, id, rest)
  }
  world.snapshot = function() {
    return old.snapshot.call(world).map(p => { const a = actions.get(p.id); return a ? { ...p, x: a.x, z: a.z, facing: a.facing ?? p.facing, play: a.phase } : p })
  }
  world.removePet = function(id) { releasePet(id); metadata.delete(id); destinations.delete(id); return old.removePet.call(world, id) }
  world.throwPet = (id, options) => throwPet(id, options)
  world.touchPet = (id, options) => { if (disposed) return false; syncPets(); return giggle(id, false, options) }
  world.onTouch = callback => {
    if (disposed || typeof callback !== 'function') return () => {}
    touchListeners.add(callback); return () => touchListeners.delete(callback)
  }
  world.onThrow = callback => {
    if (disposed || typeof callback !== 'function') return () => {}
    listeners.add(callback); return () => listeners.delete(callback)
  }
  world.playHitTest = (clientX, clientY) => {
    if (disposed) return null
    const elements = doc.elementsFromPoint(clientX, clientY)
    for (const element of elements) for (const pet of pets.values()) if (element === pet.hit) return pet.id
    return null
  }
  world.resetEffects = function(...args) {
    cancelGrab(); closeCard()
    for (const id of actions.keys()) settle(id, false, true)
    for (const item of particles) removeParticle(item)
    return old.resetEffects?.apply(world, args)
  }
  world.dispose = function(...args) {
    if (disposed) return
    disposed = true; cancelGrab()
    for (const id of [...pets.keys()]) releasePet(id)
    for (const item of particles) removeParticle(item)
    for (const texture of iconTextures.values()) texture.dispose()
    iconTextures.clear(); metadata.clear(); destinations.clear(); listeners.clear(); touchListeners.clear(); layer.remove()
    doc.removeEventListener('pointerdown', outside, true)
    view.removeEventListener('pointermove', pointerMove); view.removeEventListener('pointerup', pointerUp)
    view.removeEventListener('pointercancel', cancelPointer); view.removeEventListener('blur', cancelGrab)
    doc.removeEventListener('visibilitychange', hidden); doc.removeEventListener('keydown', escape)
    if (container.style.pointerEvents === 'none') container.style.pointerEvents = priorPointer[0]
    if (canvas.style.pointerEvents === 'none') canvas.style.pointerEvents = priorPointer[1]
    return old.dispose.apply(world, args)
  }
  installed.set(world, true)
  syncPets(); layout(0)
  return world
}
