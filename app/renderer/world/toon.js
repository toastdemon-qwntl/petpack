// STUB (conductor). Owner: render lane. Keep the interface in BRIEF-WORLD-R2.md.
import * as THREE from 'three'

let ramp
function gradient() {
  if (!ramp) {
    ramp = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat)
    ramp.minFilter = ramp.magFilter = THREE.NearestFilter
    ramp.needsUpdate = true
  }
  return ramp
}

export function toonMaterial({ color = '#ffffff', map = null, emissive = '#000000' } = {}) {
  return new THREE.MeshToonMaterial({ color, map, emissive, gradientMap: gradient() })
}
