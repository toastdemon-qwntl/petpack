import * as THREE from 'three'

let ramp
let users = 0

// One unfiltered three-value light ramp, shared for the lifetime of its materials.
export function toonMaterial({ color = '#ffffff', map = null, emissive = '#000000' } = {}) {
  if (!ramp) {
    ramp = new THREE.DataTexture(new Uint8Array([42, 144, 255]), 3, 1, THREE.RedFormat)
    ramp.name = 'petpack / three-step light'
    ramp.minFilter = ramp.magFilter = THREE.NearestFilter
    ramp.generateMipmaps = false
    ramp.needsUpdate = true
  }
  const material = new THREE.MeshToonMaterial({ color, map, emissive, gradientMap: ramp })
  material.name = 'petpack / toon'
  users++
  const release = () => {
    material.removeEventListener('dispose', release)
    if (--users === 0) { ramp.dispose(); ramp = null }
  }
  material.addEventListener('dispose', release)
  return material
}
