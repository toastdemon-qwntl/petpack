// STUB (conductor). Owner: cast lane. Replace freely, keep the interface in BRIEF-WORLD.md.
import * as THREE from 'three'

export async function createSpritePet({ spriteUrl }) {
  const texture = await new THREE.TextureLoader().loadAsync(spriteUrl)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.repeat.set(1 / 8, 1 / 9)
  texture.offset.set(0, 8 / 9)
  const object3d = new THREE.Group()
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 1.52),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.05 }),
  )
  plane.position.y = 0.76
  object3d.add(plane)
  return {
    object3d,
    height: 1.52,
    set() {},
    pop() {},
    update() {},
    dispose() {
      texture.dispose()
      plane.geometry.dispose()
      plane.material.dispose()
    },
  }
}
