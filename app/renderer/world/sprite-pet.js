import * as THREE from 'three'
import { ANIMATIONS, createContactShadow, motionState, safeDelta, spring } from './cast-shared.js'

const CELL_W = 192
const CELL_H = 208
const COLS = 8
const ROWS = 9
const atlases = new Map()
const rowForAnim = { idle: 0, wave: 3, jump: 4, failed: 5, waiting: 6, review: 8 }

function scanAtlas(image) {
  if (image.width !== CELL_W * COLS || image.height !== CELL_H * ROWS) {
    throw new Error(`Pet atlas must be 1536×1872; received ${image.width}×${image.height}`)
  }
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0)
  const { data } = ctx.getImageData(0, 0, image.width, image.height)
  const bounds = Array.from({ length: ROWS }, () => ({ minX: CELL_W, minY: CELL_H, maxX: -1, maxY: -1 }))
  const frames = Array.from({ length: ROWS }, () => [])
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      let visible = false
      for (let y = 0; y < CELL_H; y++) {
        for (let x = 0; x < CELL_W; x++) {
          const alpha = data[((row * CELL_H + y) * image.width + col * CELL_W + x) * 4 + 3]
          if (!alpha) continue
          visible = true
          // Ignore almost invisible antialias fringes when finding the feet.
          if (alpha < 8) continue
          const b = bounds[row]
          b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x)
          b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y)
        }
      }
      if (visible) frames[row].push(col)
    }
  }
  const firstRow = frames.findIndex(row => row.length > 0)
  if (firstRow < 0) throw new Error('Pet atlas is fully transparent')
  const restingBounds = bounds[frames[0].length ? 0 : firstRow]
  return { frames, restingBounds, firstRow }
}

async function acquireAtlas(url) {
  if (!url) throw new Error('A spriteUrl is required for a sprite pet')
  let entry = atlases.get(url)
  if (!entry) {
    entry = { users: 0 }
    entry.ready = new THREE.TextureLoader().loadAsync(url).then(texture => {
      try {
        const scan = scanAtlas(texture.image)
        texture.colorSpace = THREE.SRGBColorSpace
        // Linear sampling with a half-pixel cell inset keeps atlas edges clean.
        texture.magFilter = THREE.LinearFilter
        texture.minFilter = THREE.LinearFilter
        texture.generateMipmaps = false
        return { texture, ...scan }
      } catch (error) { texture.dispose(); throw error }
    })
    atlases.set(url, entry)
  }
  entry.users++
  function release() {
    if (--entry.users === 0) {
      if (atlases.get(url) === entry) atlases.delete(url)
      entry.ready.then(atlas => atlas.texture.dispose(), () => {})
    }
  }
  try { return { ...await entry.ready, release } }
  catch (error) { release(); throw error }
}

export async function createSpritePet({ spriteUrl, color = '#0A84FF' } = {}) {
  const atlas = await acquireAtlas(spriteUrl)
  const texture = atlas.texture.clone()
  texture.repeat.set((CELL_W - 1) / (COLS * CELL_W), (CELL_H - 1) / (ROWS * CELL_H))
  const object3d = new THREE.Group()
  object3d.name = 'Sprite pet'
  const shadow = createContactShadow(new THREE.Color(color).lerp(new THREE.Color('#56636b'), .88))
  object3d.add(shadow.mesh)
  const billboard = new THREE.Group()
  object3d.add(billboard)
  const body = new THREE.Group()
  billboard.add(body)
  const b = atlas.restingBounds
  const units = 1.5 / Math.max(1, b.maxY - b.minY + 1)
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(CELL_W * units, CELL_H * units),
    new THREE.MeshBasicMaterial({
      map: texture, transparent: true, alphaTest: .02, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }),
  )
  const centreX = (CELL_W / 2 - (b.minX + b.maxX + 1) / 2) * units
  plane.position.set(centreX, (b.maxY + 1 - CELL_H / 2) * units, 0)
  body.add(plane)
  const cameraPosition = new THREE.Vector3()
  const petPosition = new THREE.Vector3()
  const parentRotation = new THREE.Quaternion()
  const direction = new THREE.Vector3()
  // No camera parameter is needed: the renderer supplies its live camera here.
  // Only yaw changes, so feet remain planted even with a steep camera pitch.
  plane.onBeforeRender = (_renderer, _scene, camera) => {
    camera.getWorldPosition(cameraPosition)
    object3d.getWorldPosition(petPosition)
    object3d.getWorldQuaternion(parentRotation).invert()
    direction.subVectors(cameraPosition, petPosition).applyQuaternion(parentRotation)
    billboard.rotation.y = Math.atan2(direction.x, direction.z)
    billboard.updateMatrixWorld(true)
  }

  let anim = 'idle'
  let facing = 1
  let elapsed = 0
  let lastRow = -1
  let lastFrame = -1
  let disposed = false
  const popState = motionState()

  function updateFrame() {
    let row = anim === 'run' ? (facing < 0 ? 2 : 1) : rowForAnim[anim]
    // Some atlases only contain the general running row.
    const directional = row === 1 || row === 2
    if (!atlas.frames[row].length && directional && atlas.frames[7].length) row = 7
    if (!atlas.frames[row].length) row = atlas.frames[0].length ? 0 : atlas.firstRow
    const frames = atlas.frames[row]
    const fps = anim === 'run' || anim === 'jump' ? 10 : 8
    const step = Math.floor(elapsed * fps)
    const hold = anim === 'jump' || anim === 'failed'
    const frame = frames[hold ? Math.min(step, frames.length - 1) : step % frames.length]
    const flip = facing < 0 && row !== 2
    body.scale.x = (flip ? -1 : 1) * Math.abs(body.scale.x)
    if (row !== lastRow || frame !== lastFrame) {
      texture.offset.set((frame * CELL_W + .5) / (COLS * CELL_W), ((ROWS - row - 1) * CELL_H + .5) / (ROWS * CELL_H))
      lastRow = row
      lastFrame = frame
    }
  }

  updateFrame()
  return {
    object3d,
    height: 1.5,
    set(state = {}) {
      if (ANIMATIONS.has(state.anim) && state.anim !== anim) { anim = state.anim; elapsed = 0 }
      if (state.facing === 1 || state.facing === -1) facing = state.facing
      updateFrame()
    },
    pop() { if (!disposed) popState.v = 12 },
    update(dt) {
      if (disposed) return
      dt = safeDelta(dt)
      elapsed += dt
      const pop = spring(popState, 0, dt, 300, 16)
      body.position.y = Math.max(0, pop * .25)
      body.scale.y = 1 + pop * .19
      body.scale.x = Math.sign(body.scale.x) / Math.sqrt(body.scale.y)
      updateFrame()
      shadow.update(body.position.y)
    },
    dispose() {
      if (disposed) return
      disposed = true
      object3d.removeFromParent()
      texture.dispose()
      plane.geometry.dispose()
      plane.material.dispose()
      shadow.dispose()
      atlas.release()
    },
  }
}
