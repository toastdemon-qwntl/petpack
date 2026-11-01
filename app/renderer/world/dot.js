// STUB (conductor). Owner: cast lane. Replace freely, keep the interface in BRIEF-WORLD.md.
import * as THREE from 'three'

export function createDot({ color = '#0A84FF' } = {}) {
  const object3d = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 32, 16),
    new THREE.MeshPhysicalMaterial({ color, clearcoat: 1, roughness: 0.35 }),
  )
  body.position.y = 0.6
  object3d.add(body)
  return {
    object3d,
    height: 1.2,
    set() {},
    pop() {},
    update() {},
    dispose() {
      body.geometry.dispose()
      body.material.dispose()
    },
  }
}
