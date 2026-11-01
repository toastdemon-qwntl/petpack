import * as THREE from 'three'
import { createPixelPipeline } from './post-pixel.js'

const PITCH = THREE.MathUtils.degToRad(38)
const SIN = Math.sin(PITCH)
const COS = Math.cos(PITCH)
const GUTTER = 2

// Exact critically damped spring; target reversals cannot overshoot the new goal.
function spring(state, goal, dt, frequency) {
  const displacement = state.value - goal
  if (Math.abs(displacement) < 0.000001) {
    state.value = goal
    state.velocity = 0
    return
  }
  const impulse = state.velocity + frequency * displacement
  const decay = Math.exp(-frequency * dt)
  const next = goal + (displacement + impulse * dt) * decay
  state.velocity = (state.velocity - frequency * impulse * dt) * decay
  state.value = next
  if ((next - goal) * displacement < 0 || Math.abs(next - goal) < 0.000001) {
    state.value = goal
    state.velocity = 0
  }
}

export function createStage(canvas, { pixelScale = 2 } = {}) {
  pixelScale = Number.isFinite(pixelScale) ? Math.max(1, Math.round(pixelScale)) : 2
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.BasicShadowMap
  renderer.info.autoReset = false
  canvas.style.imageRendering = 'pixelated'
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#c6dfde')
  const camera = new THREE.OrthographicCamera(-6, 6, 4, -4, 0.1, 180)
  const ambient = new THREE.HemisphereLight('#9fb8e8', '#9b9e65', 1.65)
  const sun = new THREE.DirectionalLight('#ffe9c4', 2.65)
  sun.position.set(-24, 38, 22)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 0.5, far: 125 })
  sun.shadow.bias = -0.00015
  sun.shadow.normalBias = 0.025
  sun.shadow.camera.updateProjectionMatrix()
  scene.add(ambient, sun, sun.target)
  const lightOffset = sun.position.clone()
  const lightDirection = sun.position.clone().normalize()
  const lightRight = new THREE.Vector3(lightDirection.z, 0, -lightDirection.x).normalize()
  const lightUp = new THREE.Vector3().crossVectors(lightDirection, lightRight)
  const shadowCenter = new THREE.Vector3()
  const shadowFocus = new THREE.Vector3()
  let shadowRadius = 16
  const pipeline = createPixelPipeline(renderer, scene, camera)
  const x = { value: 0, velocity: 0 }
  const z = { value: 0, velocity: 0 }
  const span = { value: 12, velocity: 0 }
  const goal = { x: 0, z: 0, span: 12 }
  const offset = new THREE.Vector2()
  const aim = new THREE.Vector3()
  const projected = new THREE.Vector3()
  let width = 1, height = 1, artWidth = 5, artHeight = 5
  let disposed = false

  function place() {
    const unit = span.value * pixelScale / width
    const up = 0.65 * COS - z.value * SIN
    const snappedX = Math.round(x.value / unit) * unit
    const snappedUp = Math.round(up / unit) * unit
    const deltaUp = snappedUp - up
    aim.set(snappedX, 0.65 + deltaUp * COS, z.value - deltaUp * SIN)
    camera.left = -artWidth * unit / 2
    camera.right = artWidth * unit / 2
    camera.top = artHeight * unit / 2
    camera.bottom = -artHeight * unit / 2
    camera.updateProjectionMatrix()
    camera.position.set(aim.x, aim.y + SIN * 65, aim.z + COS * 65)
    camera.lookAt(aim)
    camera.updateMatrixWorld()
    // Keep shadow texels fixed in world space while covering the current view.
    // A broad whole-map shadow wastes resolution and produces noisy stair-steps.
    const radius = Math.max(16, 2 ** Math.ceil(Math.log2(span.value * 0.85)))
    if (radius !== shadowRadius) {
      shadowRadius = radius
      Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius })
      sun.shadow.camera.updateProjectionMatrix()
    }
    const shadowTexel = shadowRadius * 2 / sun.shadow.mapSize.x
    shadowFocus.set(x.value, 0, z.value)
    shadowCenter.copy(lightRight).multiplyScalar(Math.round(shadowFocus.dot(lightRight) / shadowTexel) * shadowTexel)
      .addScaledVector(lightUp, Math.round(shadowFocus.dot(lightUp) / shadowTexel) * shadowTexel)
    sun.target.position.copy(shadowCenter)
    sun.position.copy(shadowCenter).add(lightOffset)
    // Include the fractional spare pixel for odd pane sizes in the overscan crop.
    offset.set((x.value - snappedX) / unit + (artWidth - width / pixelScale) / 2 - GUTTER,
      (up - snappedUp) / unit + (artHeight - height / pixelScale) / 2 - GUTTER)
    pipeline.setCamera(unit, offset, lightDirection)
  }

  function resize(w, h) {
    if (disposed) return
    width = Number.isFinite(w) ? Math.max(1, w) : 1
    height = Number.isFinite(h) ? Math.max(1, h) : 1
    artWidth = Math.ceil(width / pixelScale) + GUTTER * 2
    artHeight = Math.ceil(height / pixelScale) + GUTTER * 2
    renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
    renderer.setSize(width, height, false)
    pipeline.resize(artWidth, artHeight, width / pixelScale, height / pixelScale)
    place()
  }
  resize(canvas.clientWidth || 520, canvas.clientHeight || 340)

  return {
    renderer, scene, camera, pixelScale,
    resize,
    focus(nextX, nextZ, { span: nextSpan } = {}) {
      if (disposed) return
      if (Number.isFinite(nextX)) goal.x = nextX
      if (Number.isFinite(nextZ)) goal.z = nextZ
      if (Number.isFinite(nextSpan)) goal.span = THREE.MathUtils.clamp(nextSpan, 4, 80)
    },
    toScreen(point) {
      projected.copy(point).project(camera)
      return {
        x: ((projected.x + 1) * artWidth / 2 - GUTTER - offset.x) * pixelScale,
        y: ((1 - projected.y) * artHeight / 2 - (artHeight - height / pixelScale) + GUTTER + offset.y) * pixelScale,
      }
    },
    update(dt) {
      if (disposed) return
      dt = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, 0.25) : 0
      spring(x, goal.x, dt, 5.8)
      spring(z, goal.z, dt, 5.8)
      spring(span, goal.span, dt, 5)
      place()
    },
    render() {
      if (disposed) return
      renderer.info.reset()
      pipeline.render()
    },
    dispose() {
      if (disposed) return
      disposed = true
      pipeline.dispose()
      sun.shadow.dispose()
      scene.remove(ambient, sun, sun.target)
      renderer.dispose()
    },
  }
}
