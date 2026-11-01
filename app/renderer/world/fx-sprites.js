import * as THREE from 'three'
import { createFxAtlas } from './fx-art.js'

/** All knowledge, gift and collaboration sprites share one draw call and atlas. */
export function createGlowField(parent, _camera, capacity = 8192, { pixelScale = 2 } = {}) {
  const atlas = createFxAtlas()
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array(capacity * 3)
  const colors = new Float32Array(capacity * 3)
  const sizes = new Float32Array(capacity)
  const alphas = new Float32Array(capacity)
  const tiles = new Float32Array(capacity)
  const facings = new Float32Array(capacity)
  for (const [name, array, size] of [
    ['position', positions, 3], ['color', colors, 3], ['size', sizes, 1],
    ['alpha', alphas, 1], ['tile', tiles, 1], ['facing', facings, 1],
  ]) geometry.setAttribute(name, new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage))
  geometry.setDrawRange(0, 0)
  const uniforms = { artSize: { value: new THREE.Vector2(260, 170) },
    atlas: { value: atlas.texture }, columns: { value: atlas.columns } }
  const material = new THREE.ShaderMaterial({
    name: 'petpack-pixel-fx', uniforms, vertexColors: true, transparent: true,
    depthWrite: false, depthTest: true, toneMapped: false,
    vertexShader: `
      attribute float size;
      attribute float alpha;
      attribute float tile;
      attribute float facing;
      uniform vec2 artSize;
      varying vec3 tint;
      varying float opacity;
      varying float tileIndex;
      varying float mirror;
      void main() {
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * view;
        vec2 pixel = (gl_Position.xy / gl_Position.w * .5 + .5) * artSize;
        gl_Position.xy = ((floor(pixel) + .5) / artSize * 2. - 1.) * gl_Position.w;
        gl_PointSize = clamp(floor(size * artSize.y * projectionMatrix[1][1] * .5 / gl_Position.w + .5), 1., 96.);
        tint = color;
        opacity = alpha;
        tileIndex = tile;
        mirror = facing;
      }
    `,
    fragmentShader: `
      uniform sampler2D atlas;
      uniform float columns;
      varying vec3 tint;
      varying float opacity;
      varying float tileIndex;
      varying float mirror;
      void main() {
        vec2 uv = gl_PointCoord;
        if (mirror < 0.) uv.x = 1. - uv.x;
        vec4 ink = texture2D(atlas, vec2((tileIndex + uv.x) / columns, 1. - uv.y));
        if (ink.a < .5 || opacity <= .01) discard;
        vec3 light = mix(ink.rgb * tint, ink.rgb, step(.87, min(ink.r, min(ink.g, ink.b))) * .7);
        gl_FragColor = vec4(light, ink.a * opacity);
        #include <colorspace_fragment>
      }
    `,
  })
  const points = new THREE.Points(geometry, material)
  points.name = 'petpack-pixel-fx'
  points.userData.pixelOutline = false
  points.frustumCulled = false
  points.renderOrder = 8
  const viewport = new THREE.Vector4()
  points.onBeforeRender = renderer => {
    // Render targets may include an overscan gutter for the camera's pixel snap.
    // Use the actual beauty viewport, not the CSS pane or its device-pixel ratio.
    renderer.getCurrentViewport(viewport)
    uniforms.artSize.value.set(viewport.z, viewport.w)
  }
  parent.add(points)
  let count = 0
  return {
    begin() { count = 0 },
    add(x, y, z, color, size, alpha = 1, tile = 'sparkle', facing = 1) {
      if (count >= capacity || alpha <= 0 || size <= 0) return
      const offset = count * 3
      positions[offset] = x; positions[offset + 1] = y; positions[offset + 2] = z
      colors[offset] = color.r; colors[offset + 1] = color.g; colors[offset + 2] = color.b
      sizes[count] = size; alphas[count] = alpha; tiles[count] = atlas.tiles[tile] ?? 0
      facings[count] = facing
      count++
    },
    end() {
      geometry.setDrawRange(0, count)
      for (const attribute of Object.values(geometry.attributes)) {
        attribute.clearUpdateRanges()
        if (count) attribute.addUpdateRange(0, count * attribute.itemSize)
        attribute.needsUpdate = true
      }
    },
    resize(width, height) { uniforms.artSize.value.set(Math.ceil(width / pixelScale), Math.ceil(height / pixelScale)) },
    dispose() { parent.remove(points); geometry.dispose(); material.dispose(); atlas.texture.dispose() },
  }
}

export function seedFor(value) {
  let hash = 2166136261
  for (const letter of String(value)) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619)
  return (hash >>> 0) / 4294967296
}
