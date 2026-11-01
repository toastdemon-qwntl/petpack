import * as THREE from 'three'

// The mesh stays at the feet while the pet hops.
export function createContactShadow(color = '#617073') {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,.65)')
  gradient.addColorStop(.3, 'rgba(255,255,255,.42)')
  gradient.addColorStop(.65, 'rgba(255,255,255,.12)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  const material = new THREE.MeshBasicMaterial({
    color, map: texture, transparent: true, opacity: .35,
    depthWrite: false, toneMapped: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.32), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = .014
  mesh.renderOrder = -1
  mesh.userData.noPick = true
  return {
    mesh,
    update(lift = 0, width = 1) {
      mesh.scale.setScalar(width * (1 + lift * .22))
      material.opacity = .35 / (1 + lift * 1.8)
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

export const ANIMATIONS = new Set(['idle', 'run', 'wave', 'jump', 'failed', 'waiting', 'review'])
export const motionState = (x = 0) => ({ x, v: 0 })
export const safeDelta = dt => Math.min(.1, Math.max(0, Number.isFinite(dt) ? dt : 0))
