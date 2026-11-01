import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

function target(name, depth = false) {
  const rt = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: depth, stencilBuffer: false,
  })
  rt.texture.name = name
  rt.texture.generateMipmaps = false
  if (depth) rt.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
  return rt
}

/** Low-res edges, then a one-sample nearest upscale. No temporal noise. */
export function createPixelPipeline(renderer, scene, camera) {
  const beauty = target('petpack / color + depth', true)
  const normals = target('petpack / normals + depth', true)
  const ink = target('petpack / outlined art')
  const materials = new Map()
  const hidden = []
  const swapped = []
  const clearColor = new THREE.Color()
  const edgeMaterial = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      colorMap: { value: beauty.texture }, depthMap: { value: beauty.depthTexture },
      normalMap: { value: normals.texture }, normalDepthMap: { value: normals.depthTexture },
      texel: { value: new THREE.Vector2(1, 1) },
      depthRange: { value: camera.far - camera.near }, worldPixel: { value: 0.04 },
      lightDirection: { value: new THREE.Vector3(-0.5, 0.7, 0.5).normalize() },
      rimColor: { value: new THREE.Color().setRGB(1, .87, .64) },
    },
    vertexShader,
    fragmentShader: /* glsl */`
      varying vec2 vUv;
      uniform sampler2D colorMap, depthMap, normalMap, normalDepthMap;
      uniform vec2 texel;
      uniform float depthRange, worldPixel;
      uniform vec3 lightDirection;
      uniform vec3 rimColor;
      void main() {
        vec4 color = texture2D(colorMap, vUv);
        float rawDepth = texture2D(depthMap, vUv).r;
        vec4 encoded = texture2D(normalMap, vUv);
        vec3 normal = normalize(encoded.rgb * 2.0 - 1.0);
        float normalValid = encoded.a * (1.0 - step(0.02,
          abs(texture2D(normalDepthMap, vUv).r - rawDepth) * depthRange));
        float silhouette = 0.0;
        float highlight = 0.0;
        float crease = 0.0;
        for (int i = 0; i < 4; i++) {
          vec2 direction = i == 0 ? vec2(1, 0) : i == 1 ? vec2(-1, 0)
            : i == 2 ? vec2(0, 1) : vec2(0, -1);
          vec2 uv = vUv + direction * texel;
          float adjacentRaw = texture2D(depthMap, uv).r;
          float difference = (adjacentRaw - rawDepth) * depthRange;
          silhouette = max(silhouette, step(max(0.055, worldPixel * 2.2), difference));
          vec4 adjacentEncoded = texture2D(normalMap, uv);
          vec3 adjacent = normalize(adjacentEncoded.rgb * 2.0 - 1.0);
          float valid = normalValid * adjacentEncoded.a * (1.0 - step(0.02,
            abs(texture2D(normalDepthMap, uv).r - adjacentRaw) * depthRange));
          float bend = step(0.18, 1.0 - dot(normal, adjacent)) * valid;
          // A convex neighbour lies behind this face's tangent plane.
          vec3 delta = vec3(direction * worldPixel, -difference);
          float convex = step(worldPixel * 0.06, -dot(normal, delta));
          float litSide = step(0.08, dot(normal - adjacent, lightDirection));
          highlight = max(highlight, bend * convex * litSide);
          crease = max(crease, bend * (1.0 - convex) * (1.0 - litSide) * 0.16);
        }
        silhouette *= (1.0 - step(0.99999, rawDepth)) * step(0.5, normalValid);
        vec3 shade = color.rgb * vec3(0.48, 0.53, 0.58) + vec3(0.009, 0.012, 0.011);
        vec3 rim = color.rgb + (rimColor - color.rgb) * 0.23;
        color.rgb = mix(color.rgb * (1.0 - crease), rim, highlight * (1.0 - silhouette));
        color.rgb = mix(color.rgb, shade, silhouette * 0.88);
        gl_FragColor = color;
      }
    `,
  })
  const blitMaterial = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      art: { value: ink.texture }, resolution: { value: new THREE.Vector2() },
      viewport: { value: new THREE.Vector2() }, offset: { value: new THREE.Vector2() },
      gutter: { value: 2 },
    },
    vertexShader,
    fragmentShader: /* glsl */`
      varying vec2 vUv;
      uniform sampler2D art;
      uniform vec2 resolution, viewport, offset;
      uniform float gutter;
      void main() {
        vec2 source = vUv * viewport + gutter + offset;
        gl_FragColor = texture2D(art, (floor(source) + 0.5) / resolution);
        #include <colorspace_fragment>
      }
    `,
  })
  const quad = new FullScreenQuad(edgeMaterial)

  function normalMaterial(source) {
    let entry = materials.get(source)
    if (!entry) {
      const material = new THREE.MeshNormalMaterial()
      material.name = 'petpack / alpha-aware normals'
      material.customProgramCacheKey = () => `petpack-normals:${source.customProgramCacheKey()}`
      material.onBeforeCompile = (shader, glRenderer) => {
        Object.assign(shader.uniforms, THREE.UniformsUtils.clone(THREE.UniformsLib.common))
        // Share vertex motion (e.g. map grass) and its live uniform objects. Keep
        // the normal fragment shader independent of any custom beauty shading.
        const fragment = shader.fragmentShader
        source.onBeforeCompile(shader, glRenderer)
        shader.fragmentShader = fragment
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <uv_pars_fragment>', `#include <uv_pars_fragment>
            #include <map_pars_fragment>
            #include <alphamap_pars_fragment>
            #include <alphatest_pars_fragment>`)
          .replace('#include <normal_fragment_begin>', `#include <map_fragment>
            #include <alphamap_fragment>
            #include <alphatest_fragment>
            #include <normal_fragment_begin>`)
      }
      const release = () => {
        source.removeEventListener('dispose', release)
        material.dispose()
        materials.delete(source)
      }
      entry = { material, release, signature: '' }
      source.addEventListener('dispose', release)
      materials.set(source, entry)
    }
    const m = entry.material
    for (const property of ['map', 'alphaMap', 'alphaTest', 'side', 'flatShading',
      'normalMap', 'normalMapType', 'bumpMap', 'bumpScale', 'displacementMap',
      'displacementScale', 'displacementBias', 'polygonOffset', 'polygonOffsetFactor',
      'polygonOffsetUnits', 'clippingPlanes', 'clipIntersection']) {
      if (source[property] !== undefined) m[property] = source[property]
    }
    if (source.normalScale) m.normalScale.copy(source.normalScale)
    m.visible = source.visible && source.depthWrite !== false && !(source.transparent && source.opacity < 1)
    const signature = [!!m.map, !!m.alphaMap, m.alphaTest > 0, m.side, m.flatShading,
      !!m.normalMap, !!m.bumpMap, !!m.displacementMap, source.version].join('/')
    if (entry.signature !== signature) { m.needsUpdate = true; entry.signature = signature }
    return m
  }

  return {
    setNight(amount) { edgeMaterial.uniforms.rimColor.value.setRGB(1 - amount * .65, .87 - amount * .4, .64 - amount * .02) },
    resize(w, h, visibleW, visibleH) {
      for (const rt of [beauty, normals, ink]) rt.setSize(w, h)
      edgeMaterial.uniforms.texel.value.set(1 / w, 1 / h)
      blitMaterial.uniforms.resolution.value.set(w, h)
      blitMaterial.uniforms.viewport.value.set(visibleW, visibleH)
    },
    setCamera(worldPixel, offset, light) {
      edgeMaterial.uniforms.worldPixel.value = worldPixel
      edgeMaterial.uniforms.depthRange.value = camera.far - camera.near
      edgeMaterial.uniforms.lightDirection.value.copy(light).transformDirection(camera.matrixWorldInverse)
      blitMaterial.uniforms.offset.value.copy(offset)
    },
    render() {
      const previousTarget = renderer.getRenderTarget()
      const background = scene.background
      const override = scene.overrideMaterial
      const autoShadow = renderer.shadowMap.autoUpdate
      let needsShadow = renderer.shadowMap.needsUpdate
      renderer.getClearColor(clearColor)
      const clearAlpha = renderer.getClearAlpha()
      try {
        renderer.setRenderTarget(beauty)
        renderer.render(scene, camera)
        needsShadow = renderer.shadowMap.needsUpdate
        // Preserve cut-outs, instancing, skinning and sides. Translucent FX
        // keep their beauty pass without acquiring false rectangular borders.
        scene.traverseVisible(object => {
          if (!object.material) return
          if (!object.isMesh || object.userData.noOutline) {
            hidden.push(object); object.visible = false; return
          }
          swapped.push([object, object.material])
          object.material = Array.isArray(object.material)
            ? object.material.map(normalMaterial) : normalMaterial(object.material)
        })
        scene.background = null
        scene.overrideMaterial = null
        renderer.shadowMap.autoUpdate = false
        renderer.shadowMap.needsUpdate = false
        renderer.setClearColor(0x8080ff, 0)
        renderer.setRenderTarget(normals)
        renderer.render(scene, camera)
        quad.material = edgeMaterial
        renderer.setRenderTarget(ink)
        quad.render(renderer)
        quad.material = blitMaterial
        renderer.setRenderTarget(previousTarget)
        quad.render(renderer)
      } finally {
        for (const [object, material] of swapped) object.material = material
        for (const object of hidden) object.visible = true
        swapped.length = hidden.length = 0
        scene.background = background
        scene.overrideMaterial = override
        renderer.shadowMap.autoUpdate = autoShadow
        renderer.shadowMap.needsUpdate = needsShadow
        renderer.setClearColor(clearColor, clearAlpha)
        renderer.setRenderTarget(previousTarget)
      }
    },
    dispose() {
      for (const entry of [...materials.values()]) entry.release()
      for (const rt of [beauty, normals, ink]) rt.dispose()
      edgeMaterial.dispose()
      blitMaterial.dispose()
      quad.dispose()
    },
  }
}
