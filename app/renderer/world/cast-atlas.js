import * as THREE from 'three'
import { ANIMATIONS, createContactShadow, motionState, safeDelta, spring } from './cast-shared.js'

const COLS = 8, ROWS = 9
const ART_W = 48, ART_H = 52
const rowForAnim = { idle: 0, wave: 3, jump: 4, failed: 5, waiting: 6, review: 8 }

/** Premultiplied-alpha box filtering prevents pale/black halos around small pets. */
export function preparePetAtlas(image) {
  const width = image.naturalWidth ?? image.width, height = image.naturalHeight ?? image.height
  const cellW = Math.floor(width / COLS), cellH = Math.floor(height / ROWS)
  // Codex cells have a 12:13 aspect. Allow integer rounding on either axis,
  // including sheets with incomplete trailing pixels outside the 8×9 grid.
  if (!(cellW > 0 && cellH > 0) || Math.abs(cellW * ART_H - cellH * ART_W) > ART_W + ART_H) {
    throw new Error(`Expected an 8×9 Codex pet atlas; received ${width}×${height}`)
  }
  const source = document.createElement('canvas')
  source.width = cellW * COLS; source.height = cellH * ROWS
  const context = source.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0)
  const data = context.getImageData(0, 0, source.width, source.height).data
  const canvas = document.createElement('canvas')
  canvas.width = ART_W * COLS; canvas.height = ART_H * ROWS
  const ctx = canvas.getContext('2d')
  const output = ctx.createImageData(canvas.width, canvas.height)
  const frames = Array.from({ length: ROWS }, () => [])
  const bounds = Array.from({ length: ROWS }, () => ({ minX: ART_W, minY: ART_H, maxX: -1, maxY: -1 }))
  const scaleX = cellW / ART_W, scaleY = cellH / ART_H
  const coverage = 255 * scaleX * scaleY * .42
  // Exact area weights also work for fractional scales and tiny source cells.
  // At 1536×1872 these are the original 4×4, unit-weight samples, byte for byte.
  const samples = (size, scale) => Array.from({ length: size }, (_, i) => {
    const start = i * scale, end = (i + 1) * scale
    return Array.from({ length: Math.ceil(end) - Math.floor(start) }, (_, j) => {
      const pixel = Math.floor(start) + j
      return { pixel, weight: Math.min(end, pixel + 1) - Math.max(start, pixel) }
    })
  })
  const samplesX = samples(ART_W, scaleX), samplesY = samples(ART_H, scaleY)
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      let visible = false
      for (let y = 0; y < ART_H; y++) {
        for (let x = 0; x < ART_W; x++) {
          let alpha = 0, red = 0, green = 0, blue = 0
          for (const sy of samplesY[y]) {
            for (const sx of samplesX[x]) {
              const p = ((row * cellH + sy.pixel) * source.width + col * cellW + sx.pixel) * 4
              const a = data[p + 3] * sx.weight * sy.weight
              alpha += a; red += data[p] * a; green += data[p + 1] * a; blue += data[p + 2] * a
            }
          }
          // Hard alpha coverage: every drawn pixel is solid, with no grey fringe.
          if (alpha < coverage) continue
          const p = ((row * ART_H + y) * canvas.width + col * ART_W + x) * 4
          output.data[p] = Math.round(red / alpha)
          output.data[p + 1] = Math.round(green / alpha)
          output.data[p + 2] = Math.round(blue / alpha)
          output.data[p + 3] = 255
          const b = bounds[row]
          b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x)
          b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y)
          visible = true
        }
      }
      if (visible) frames[row].push(col)
    }
  }
  const firstRow = frames.findIndex(row => row.length > 0)
  if (firstRow < 0) throw new Error('Pet atlas is fully transparent at the world pixel scale')
  ctx.putImageData(output, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  const restingRow = frames[0].length ? 0 : firstRow
  return { texture, frames, firstRow, restingRow, restingBounds: bounds[restingRow] }
}

/** Shared by uploaded Codex atlases and the synchronous procedural cast. */
export function createAtlasCharacter(atlas, { color = '#79b9dc', name = 'Codex pet' } = {}) {
  const texture = atlas.texture.clone()
  texture.repeat.set(1 / COLS, 1 / ROWS)
  const object3d = new THREE.Group()
  object3d.name = name
  const shadow = createContactShadow(new THREE.Color(color).lerp(new THREE.Color('#405b58'), .86))
  object3d.add(shadow.mesh)
  const b = atlas.restingBounds
  const units = 2 / Math.max(1, b.maxY - b.minY + 1)
  const material = new THREE.SpriteMaterial({
    map: texture, transparent: false, alphaTest: .5, depthWrite: true, toneMapped: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.name = 'Pixel billboard'
  sprite.center.set((b.minX + b.maxX + 1) / (2 * ART_W), (ART_H - b.maxY - 1) / ART_H)
  sprite.scale.set(ART_W * units, ART_H * units, 1)
  sprite.userData.noOutline = true
  material.userData.pixelSprite = true
  object3d.add(sprite)

  // Billboard in camera space; snap the feet, not each vertex, so the silhouette
  // stays rigid during camera glides. Read the active art render target, not DPR.
  const resolution = { value: new THREE.Vector2(1, 1) }
  const bufferSize = new THREE.Vector2()
  material.onBeforeCompile = shader => {
    shader.uniforms.castResolution = resolution
    shader.vertexShader = 'uniform vec2 castResolution;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('mvPosition.xy += rotatedPosition;', `
      if ( projectionMatrix[ 2 ][ 3 ] == 0.0 ) {
        vec2 ndc = (projectionMatrix * mvPosition).xy;
        vec2 grid = (ndc * 0.5 + 0.5) * castResolution;
        vec2 snapped = (floor(grid + 0.5) / castResolution - 0.5) * 2.0;
        mvPosition.xy += (snapped - ndc) / vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
      }
      mvPosition.xy += rotatedPosition;`)
  }
  material.customProgramCacheKey = () => 'petpack-pixel-billboard-v2'
  sprite.onBeforeRender = renderer => {
    const target = renderer.getRenderTarget()
    if (target) resolution.value.set(target.width, target.height)
    else resolution.value.copy(renderer.getDrawingBufferSize(bufferSize))
  }

  let anim = 'idle', facing = 1, elapsed = 0, walkPhase = 0, moving
  let lastRow = -1, lastFrame = -1, lastFlip = false, disposed = false
  const popState = motionState()
  const previousPosition = new THREE.Vector3()
  const currentPosition = new THREE.Vector3()
  let positioned = false

  function updateFrame() {
    let row = anim === 'run' ? (facing < 0 ? 2 : 1) : rowForAnim[anim]
    if (!atlas.frames[row].length && anim === 'run') {
      row = [7, facing < 0 ? 1 : 2, 0, atlas.firstRow].find(i => atlas.frames[i].length)
    }
    if (!atlas.frames[row].length) row = atlas.frames[0].length ? 0 : atlas.firstRow
    const frames = atlas.frames[row]
    const step = anim === 'run' ? Math.floor(walkPhase * frames.length) : Math.floor(elapsed * (anim === 'jump' ? 10 : 7))
    const hold = anim === 'jump' || anim === 'failed'
    const frame = frames[hold ? Math.min(step, frames.length - 1) : step % frames.length]
    // A left-only source needs mirroring for rightward motion, too.
    const sourceFacesLeft = row === 2
    const flip = (facing < 0) !== sourceFacesLeft
    // Row 2 is already reflected around the cell centre. Reflect the anchor
    // along with the artwork, including a left-only resting-row fallback.
    const reflectAnchor = (facing < 0) !== (atlas.restingRow === 2)
    const restCentre = (b.minX + b.maxX + 1) / (2 * ART_W)
    sprite.center.x = reflectAnchor ? 1 - restCentre : restCentre
    if (row !== lastRow || frame !== lastFrame || flip !== lastFlip) {
      texture.repeat.x = (flip ? -1 : 1) / COLS
      texture.offset.set((frame + (flip ? 1 : 0)) / COLS, (ROWS - row - 1) / ROWS)
      lastRow = row; lastFrame = frame; lastFlip = flip
      sprite.userData.frame = { row, column: frame, flip }
    }
  }
  updateFrame()
  return {
    object3d,
    height: 2,
    set(state = {}) {
      if (disposed) return
      if (ANIMATIONS.has(state.anim) && state.anim !== anim) {
        anim = state.anim; elapsed = 0
        if (anim === 'run') walkPhase = 0
      }
      if (state.facing === 1 || state.facing === -1) facing = state.facing
      if (typeof state.moving === 'boolean' || Number.isFinite(state.moving)) moving = state.moving
      updateFrame()
    },
    pop() { if (!disposed) popState.v = 9 },
    update(dt) {
      if (disposed) return
      dt = safeDelta(dt)
      elapsed += dt
      object3d.getWorldPosition(currentPosition)
      const distance = positioned ? Math.hypot(currentPosition.x - previousPosition.x, currentPosition.z - previousPosition.z) : 0
      previousPosition.copy(currentPosition)
      positioned = true
      if (anim === 'run' && dt > 0) {
        // Actual world distance takes precedence. Numeric moving is world units/s;
        // boolean true supports a stationary animation preview at the usual pace.
        const fallback = typeof moving === 'number' ? Math.max(0, moving) : moving === false ? 0 : 1.8
        const travel = distance > .00001 ? Math.min(distance, dt * 8) : fallback * dt
        walkPhase = (walkPhase + travel / 1.25) % 1
      }
      const lift = Math.max(0, spring(popState, 0, dt, 220, 24) * .4)
      sprite.position.y = lift
      // Pixel art breathes in its atlas; pop moves it without stretching pixels.
      shadow.update(lift)
      updateFrame()
    },
    dispose() {
      if (disposed) return
      disposed = true
      object3d.removeFromParent()
      material.dispose(); texture.dispose(); shadow.dispose()
      // THREE.Sprite geometry is shared by Three.js; never dispose it per pet.
      atlas.release?.()
    },
  }
}

