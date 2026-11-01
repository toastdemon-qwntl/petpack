import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { createIsland, createIslandAssets, groundPoint } from './island.js'
import { createAmbient } from './ambient.js'

export const SEAT_W = 16

export function createStage(canvas, { seat = 0, seatWidth = SEAT_W } = {}) {
  seat = Number.isFinite(seat) ? Math.trunc(seat) : 0
  seatWidth = Number.isFinite(seatWidth) && seatWidth > 0 ? seatWidth : SEAT_W
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' })
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.98
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(22, 2, 0.1, 180)

  // A studio reflection gives the cast's glossy Dots a broad, soft highlight.
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const environment = pmrem.fromScene(room, 0.05)
  scene.environment = environment.texture
  scene.environmentIntensity = 0.24
  room.dispose()
  pmrem.dispose()

  const hemisphere = new THREE.HemisphereLight('#e5efff', '#a7ae87', 1.35)
  scene.add(hemisphere)
  const sun = new THREE.DirectionalLight('#ffe2b8', 2.65)
  sun.castShadow = true
  sun.shadow.mapSize.set(1536, 1536)
  sun.shadow.camera.left = -seatWidth * 1.3
  sun.shadow.camera.right = seatWidth * 1.3
  sun.shadow.camera.top = 12
  sun.shadow.camera.bottom = -12
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 65
  sun.shadow.normalBias = 0.035
  sun.shadow.bias = -0.00015
  sun.shadow.radius = 3
  scene.add(sun, sun.target)
  const rim = new THREE.DirectionalLight('#fff3d9', 0.75)
  scene.add(rim, rim.target)

  const assets = createIslandAssets()
  const ambient = createAmbient(scene)
  const islands = new Map()
  let targetSeat = seat, currentX = (seat + 0.5) * seatWidth, velocity = 0
  let elapsed = 0, disposed = false, mountedSeat = null
  let distance = 24

  function ensureIslands() {
    const nearest = Math.floor(currentX / seatWidth)
    if (nearest === mountedSeat && islands.has(targetSeat)) return
    mountedSeat = nearest
    const required = new Set([nearest - 1, nearest, nearest + 1, targetSeat - 1, targetSeat, targetSeat + 1])
    for (const s of required) {
      if (!islands.has(s)) {
        const island = createIsland(s, seatWidth, assets)
        islands.set(s, island)
        scene.add(island.group)
      }
    }
    for (const [s, island] of islands) {
      if (!required.has(s)) {
        island.dispose()
        islands.delete(s)
      }
    }
    ambient.sync(required, seatWidth)
  }

  function frame() {
    const pitch = THREE.MathUtils.degToRad(25)
    const breathe = Math.sin(elapsed * 0.23) * 0.026
    const targetY = 0.68
    camera.position.set(currentX + Math.sin(elapsed * 0.16) * 0.035, targetY + Math.sin(pitch) * distance + breathe, Math.cos(pitch) * distance)
    camera.lookAt(currentX, targetY, 0)
    camera.updateMatrixWorld()
    sun.position.set(currentX - 7, 13, -5)
    sun.target.position.set(currentX, 0, 0)
    rim.position.set(currentX + 6, 8, 8)
    rim.target.position.set(currentX, 0, 0)
  }

  function resize(width, height) {
    if (disposed) return
    width = Math.max(1, Number.isFinite(width) ? width : 600)
    height = Math.max(1, Number.isFinite(height) ? height : 300)
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    // Fit the full seat and keep headroom for bubbles on wide, shallow overlays.
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    distance = Math.max((seatWidth + 0.65) / (2 * tanHalfFov * camera.aspect), 7.1 / (2 * tanHalfFov)) + 1.3
    camera.updateProjectionMatrix()
    frame()
  }

  ensureIslands()
  resize(canvas.clientWidth || 600, canvas.clientHeight || 300)

  return {
    renderer, scene, camera,
    ground: groundPoint,
    setSeat(next) {
      if (disposed || !Number.isFinite(next)) return
      targetSeat = Math.trunc(next)
      ensureIslands()
    },
    resize,
    update(dt, t) {
      if (disposed) return
      dt = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1))
      elapsed = Number.isFinite(t) ? t : elapsed + dt
      // Exact critically damped spring: stable at any frame rate, with no overshoot.
      const goal = (targetSeat + 0.5) * seatWidth
      const offset = currentX - goal
      const omega = 5.8, decay = Math.exp(-omega * dt)
      const impulse = (velocity + omega * offset) * dt
      currentX = goal + (offset + impulse) * decay
      velocity = (velocity - omega * impulse) * decay
      ensureIslands()
      assets.time.value = elapsed
      ambient.update(elapsed)
      frame()
    },
    render() {
      if (!disposed) renderer.render(scene, camera)
    },
    dispose() {
      if (disposed) return
      disposed = true
      islands.forEach(island => island.dispose())
      islands.clear()
      ambient.dispose()
      assets.dispose()
      environment.dispose()
      scene.environment = null
      sun.shadow.dispose()
      scene.remove(hemisphere, sun, sun.target, rim, rim.target)
      renderer.dispose()
    },
  }
}
