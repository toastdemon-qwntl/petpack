// STUB (conductor). Owner: render lane. Keep the interface in BRIEF-WORLD-R2.md.
import * as THREE from 'three'

export function createStage(canvas, { pixelScale = 2 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#bfe3f2')
  const camera = new THREE.OrthographicCamera(-6, 6, 4, -4, 0.1, 200)
  scene.add(new THREE.HemisphereLight('#e8f2ff', '#7c8f5a', 1.4))
  const sun = new THREE.DirectionalLight('#ffe9c4', 2.2)
  sun.position.set(-8, 14, 10)
  sun.castShadow = true
  scene.add(sun)

  const target = new THREE.Vector3()
  const goal = new THREE.Vector3()
  let span = 12
  let goalSpan = 12
  let width = 1
  let height = 1
  const pitch = THREE.MathUtils.degToRad(35)

  function place() {
    const h = span / (width / height)
    camera.left = -span / 2
    camera.right = span / 2
    camera.top = h / 2
    camera.bottom = -h / 2
    camera.updateProjectionMatrix()
    camera.position.set(target.x, target.y + Math.sin(pitch) * 40, target.z + Math.cos(pitch) * 40)
    camera.lookAt(target)
    camera.updateMatrixWorld()
  }

  const v = new THREE.Vector3()
  return {
    renderer,
    scene,
    camera,
    pixelScale,
    resize(w, h) {
      width = Math.max(1, w)
      height = Math.max(1, h)
      renderer.setPixelRatio(1)
      renderer.setSize(Math.ceil(width / pixelScale), Math.ceil(height / pixelScale), false)
      canvas.style.imageRendering = 'pixelated'
      place()
    },
    focus(x, z, opts = {}) {
      goal.set(x, 0, z)
      if (opts.span) goalSpan = opts.span
    },
    toScreen(point) {
      v.copy(point).project(camera)
      return { x: (v.x + 1) / 2 * width, y: (1 - v.y) / 2 * height }
    },
    update(dt) {
      const k = 1 - Math.exp(-dt * 3)
      target.lerp(goal, k)
      span += (goalSpan - span) * k
      place()
    },
    render() {
      renderer.render(scene, camera)
    },
    dispose() {
      renderer.dispose()
    },
  }
}
