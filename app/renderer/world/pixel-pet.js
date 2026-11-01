// STUB (conductor). Owner: cast lane. Keep the interface in BRIEF-WORLD-R2.md.
import * as THREE from 'three'

export function createPixelPet({ color = '#0A84FF' } = {}) {
  const object3d = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.2), new THREE.MeshBasicMaterial({ color }))
  body.position.y = 0.6
  object3d.add(body)
  return {
    object3d,
    height: 1.4,
    set() {},
    pop() {},
    update() {},
    dispose() {
      body.geometry.dispose()
      body.material.dispose()
    },
  }
}
