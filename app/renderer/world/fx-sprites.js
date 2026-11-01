import * as THREE from 'three'

// Two shared draw calls: coloured luminous centres stay readable on a pale
// desktop, while the additive radial halos bloom over the world behind them.
export function createGlowField(parent, camera, capacity = 2048) {
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array(capacity * 3)
  const colors = new Float32Array(capacity * 3)
  const sizes = new Float32Array(capacity)
  const alphas = new Float32Array(capacity)
  for (const [name, array, size] of [
    ['position', positions, 3], ['color', colors, 3], ['size', sizes, 1], ['alpha', alphas, 1],
  ]) geometry.setAttribute(name, new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage))
  geometry.setDrawRange(0, 0)

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const context = canvas.getContext('2d')
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.14, 'rgba(255,255,255,.8)')
  gradient.addColorStop(0.32, 'rgba(255,255,255,.25)')
  gradient.addColorStop(0.65, 'rgba(255,255,255,.065)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 128, 128)
  const texture = new THREE.CanvasTexture(canvas)
  const uniforms = { projectionScale: { value: 600 }, glowMap: { value: texture } }
  const vertexShader = `
    attribute float size;
    attribute float alpha;
    varying vec3 tint;
    varying float opacity;
    uniform float projectionScale;
    void main() {
      vec4 view = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * view;
      gl_PointSize = clamp(size * projectionScale / max(.01, -view.z), 1.0, 192.0);
      tint = color;
      opacity = alpha;
    }
  `
  const haloMaterial = new THREE.ShaderMaterial({
    uniforms, vertexShader, vertexColors: true, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    fragmentShader: `
      uniform sampler2D glowMap;
      varying vec3 tint;
      varying float opacity;
      void main() {
        float a = texture2D(glowMap, gl_PointCoord).a * opacity * .62;
        gl_FragColor = vec4(mix(tint, vec3(1.), .25), a);
        #include <colorspace_fragment>
      }
    `,
  })
  const coreMaterial = new THREE.ShaderMaterial({
    uniforms, vertexShader, vertexColors: true, transparent: true,
    depthWrite: false, toneMapped: false,
    fragmentShader: `
      varying vec3 tint;
      varying float opacity;
      void main() {
        float r = length(gl_PointCoord - .5);
        float a = (1. - smoothstep(.025, .19, r)) * opacity;
        if (a < .003) discard;
        vec3 c = mix(tint, vec3(1.), .96 * (1. - smoothstep(.0, .12, r)));
        gl_FragColor = vec4(c, a);
        #include <colorspace_fragment>
      }
    `,
  })
  const halo = new THREE.Points(geometry, haloMaterial)
  const core = new THREE.Points(geometry, coreMaterial)
  halo.frustumCulled = core.frustumCulled = false
  halo.renderOrder = 5
  core.renderOrder = 6
  parent.add(halo, core)
  let count = 0
  return {
    begin() { count = 0 },
    add(x, y, z, color, size, alpha = 1) {
      if (count >= capacity || alpha <= 0) return
      const offset = count * 3
      positions[offset] = x; positions[offset + 1] = y; positions[offset + 2] = z
      colors[offset] = color.r; colors[offset + 1] = color.g; colors[offset + 2] = color.b
      sizes[count] = size; alphas[count] = alpha
      count++
    },
    end() {
      geometry.setDrawRange(0, count)
      for (const attribute of Object.values(geometry.attributes)) attribute.needsUpdate = true
    },
    resize(_width, height) {
      uniforms.projectionScale.value = height * Math.min(window.devicePixelRatio || 1, 2)
        / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov || 22) / 2))
    },
    dispose() {
      parent.remove(halo, core)
      geometry.dispose(); haloMaterial.dispose(); coreMaterial.dispose(); texture.dispose()
    },
  }
}

export function seedFor(value) {
  let hash = 2166136261
  for (const letter of String(value)) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619)
  return (hash >>> 0) / 4294967296
}
