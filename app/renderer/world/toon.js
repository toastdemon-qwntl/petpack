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
  // Adjacent cameras differ by an integer number of shadow texels. Float32
  // interpolation can still land either side of a texel boundary under a low
  // sun. Resolve the sub-texel remainder before choosing the nearest sample,
  // then sample its centre; the 1/256-texel grid is far below an art pixel.
  // Keep the approved high-light sampling byte-for-byte (also used by the moon);
  // only the low, moving dawn/dusk light needs this grid. The uniform belongs
  // to the material, not a world.
  const stableShadow = { value: false }
  material.onBeforeRender = (_renderer, scene) => {
    const offset = scene.userData.petpackDaylight?.offset
    stableShadow.value = !!offset && (offset.x !== -24 || offset.y !== 38 || offset.z !== 22)
  }
  material.onBeforeCompile = shader => {
    shader.uniforms.petpackStableShadow = stableShadow
    const shadow = THREE.ShaderChunk.shadowmap_pars_fragment.replace(
      'float depth = texture2D( shadowMap, shadowCoord.xy ).r;',
      `vec2 shadowUV = shadowCoord.xy;
       if (petpackStableShadow) {
         vec2 stableTexel = floor(shadowUV * shadowMapSize * 256.0 + 0.5) / 256.0;
         shadowUV = (floor(stableTexel) + 0.5) / shadowMapSize;
       }
       float depth = texture2D(shadowMap, shadowUV).r;`)
    shader.fragmentShader = 'uniform bool petpackStableShadow;\n' + shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', shadow)
  }
  users++
  const release = () => {
    material.removeEventListener('dispose', release)
    if (--users === 0) { ramp.dispose(); ramp = null }
  }
  material.addEventListener('dispose', release)
  return material
}
