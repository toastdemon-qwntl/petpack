import * as THREE from 'three'

// A stepped, pixel-cut contact shadow; no soft radial gradient or mipmaps.
export function createContactShadow(color = '#405b58') {
  const canvas = document.createElement('canvas')
  canvas.width = 32; canvas.height = 20
  const ctx = canvas.getContext('2d')
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 32; x++) {
      const radius = ((x - 15.5) / 15) ** 2 + ((y - 9.5) / 9) ** 2
      if (radius > 1) continue
      ctx.fillStyle = radius < .48 ? '#ffffff' : '#ffffff80'
      ctx.fillRect(x, y, 1, 1)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  const material = new THREE.MeshBasicMaterial({
    color, map: texture, transparent: true, opacity: .25, alphaTest: .01,
    depthWrite: false, toneMapped: false, polygonOffset: true,
    polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.45, .92), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = .025
  mesh.renderOrder = -1
  mesh.userData.noPick = true
  mesh.userData.noOutline = true
  return {
    mesh,
    update(lift = 0, width = 1) {
      mesh.scale.setScalar(width * (1 + lift * .2))
      material.opacity = .25 / (1 + lift * 1.8)
    },
    dispose() { mesh.geometry.dispose(); material.dispose(); texture.dispose() },
  }
}

// Substeps keep the spring stable after a tab has been in the background.
export function spring(state, target, dt, stiffness = 220, damping = 23) {
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
  const h = dt / steps
  for (let i = 0; i < steps; i++) {
    state.v += ((target - state.x) * stiffness - state.v * damping) * h
    state.x += state.v * h
  }
  return state.x
}

export const ANIMATIONS = new Set(['idle', 'run', 'wave', 'jump', 'failed', 'waiting', 'working', 'review'])
export const motionState = (x = 0) => ({ x, v: 0 })
export const safeDelta = dt => Math.min(.1, Math.max(0, Number.isFinite(dt) ? dt : 0))
