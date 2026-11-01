// STUB (conductor). Owner: stage lane. Replace freely, keep the interface in BRIEF-WORLD.md.
import * as THREE from 'three'

export const SEAT_W = 16

export function createStage(canvas, { seat = 0, seatWidth = SEAT_W } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(22, 2, 0.1, 500)
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x8fb67a, 2))
  const sun = new THREE.DirectionalLight(0xffe2b8, 2)
  sun.position.set(-10, 20, 12)
  scene.add(sun)
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(seatWidth * 8, 1, 6),
    new THREE.MeshStandardMaterial({ color: 0x9bd88f, roughness: 0.85 }),
  )
  strip.position.set(seatWidth * 3, -0.5, 0)
  scene.add(strip)

  let current = seat
  function frame() {
    const cx = (current + 0.5) * seatWidth
    camera.position.set(cx, 10, 30)
    camera.lookAt(cx, 0.5, 0)
  }
  frame()

  return {
    renderer,
    scene,
    camera,
    ground: () => ({ y: 0, z: 0 }),
    setSeat(s) {
      current = s
      frame()
    },
    resize(width, height) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    },
    update() {},
    render() {
      renderer.render(scene, camera)
    },
    dispose() {
      renderer.dispose()
    },
  }
}
