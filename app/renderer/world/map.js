// STUB (conductor). Owner: map lane. Keep the interface in BRIEF-WORLD-R2.md.
import * as THREE from 'three'
import { toonMaterial } from './toon.js'

export function createMap(scene) {
  const group = new THREE.Group()
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(64, 40), toonMaterial({ color: '#8fcf6e' }))
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  group.add(ground)
  const landmarks = {
    library: { x: -20, z: -8, kind: 'memory', label: 'Library' },
    workshop: { x: 18, z: -8, kind: 'skill', label: 'Workshop' },
    dojo: { x: 18, z: 10, kind: 'technique', label: 'Dojo' },
    campfire: { x: -16, z: 10, kind: 'resource', label: 'Campfire' },
  }
  for (const l of Object.values(landmarks)) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(3, 2.4, 3), toonMaterial({ color: '#d9b38c' }))
    box.position.set(l.x, 1.2, l.z - 2.5)
    box.castShadow = true
    group.add(box)
  }
  scene.add(group)
  return {
    bounds: { minX: -32, maxX: 32, minZ: -20, maxZ: 20 },
    ground: () => 0,
    landmarks,
    spots: [{ x: 0, z: 0 }, { x: -6, z: 4 }, { x: 6, z: -3 }, { x: 10, z: 5 }],
    path: (from, to) => [{ x: from.x, z: from.z }, { x: to.x, z: to.z }],
    update() {},
    dispose() {
      scene.remove(group)
    },
  }
}
