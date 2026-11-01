import * as THREE from 'three'
import { seededRandom } from './island.js'

export function createAmbient(scene) {
  const root = new THREE.Group()
  root.name = 'meadow-air'
  scene.add(root)
  const patches = new Map()
  const time = { value: 0 }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 32
  const context = canvas.getContext('2d')
  const halo = context.createRadialGradient(16, 16, 0, 16, 16, 16)
  halo.addColorStop(0, 'rgba(255, 251, 215, 1)')
  halo.addColorStop(0.2, 'rgba(255, 247, 201, 0.8)')
  halo.addColorStop(1, 'rgba(255, 247, 201, 0)')
  context.fillStyle = halo
  context.fillRect(0, 0, 32, 32)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const pollenMaterial = new THREE.PointsMaterial({
    color: '#fff5c8', map: texture, size: 0.09, transparent: true,
    opacity: 0.64, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  pollenMaterial.onBeforeCompile = shader => {
    shader.uniforms.uAirTime = time
    shader.vertexShader = 'uniform float uAirTime;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      transformed.x += sin(uAirTime * 0.21 + position.z * 4.0) * 0.6;
      transformed.y += sin(uAirTime * 0.38 + position.x * 2.0) * 0.23;
      transformed.z += cos(uAirTime * 0.17 + position.y * 3.0) * 0.3;
    `)
  }
  const cloudCanvas = document.createElement('canvas')
  cloudCanvas.width = 256
  cloudCanvas.height = 128
  const cloudContext = cloudCanvas.getContext('2d')
  for (const [x, y, radius] of [[57, 76, 42], [103, 57, 47], [148, 67, 48], [196, 80, 35]]) {
    const puff = cloudContext.createRadialGradient(x, y, 0, x, y, radius)
    puff.addColorStop(0, 'rgba(255,255,255,0.7)')
    puff.addColorStop(0.45, 'rgba(255,255,255,0.48)')
    puff.addColorStop(1, 'rgba(255,255,255,0)')
    cloudContext.fillStyle = puff
    cloudContext.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  }
  const cloudTexture = new THREE.CanvasTexture(cloudCanvas)
  cloudTexture.colorSpace = THREE.SRGBColorSpace
  const cloudGeometry = new THREE.PlaneGeometry(1, 1)
  const cloudMaterial = new THREE.MeshBasicMaterial({
    color: '#ffffff', map: cloudTexture, transparent: true, opacity: 0.46, depthWrite: false,
  })
  const dummy = new THREE.Object3D()

  function addSeat(seat, seatWidth) {
    if (patches.has(seat)) return
    const random = seededRandom(seat ^ 0x7f32)
    const group = new THREE.Group()
    group.position.x = (seat + 0.5) * seatWidth
    const points = []
    for (let i = 0; i < 28; i++) points.push((random() - 0.5) * seatWidth, 0.45 + random() * 2.7, (random() - 0.5) * 5)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    const pollen = new THREE.Points(geometry, pollenMaterial)
    pollen.frustumCulled = false
    group.add(pollen)
    const clouds = new THREE.InstancedMesh(cloudGeometry, cloudMaterial, 3)
    for (let cloud = 0; cloud < 3; cloud++) {
      dummy.position.set((cloud - 1) * 5 + random(), -2.3 - random() * 0.6, -1.6 - random() * 2.4)
      const scale = 0.85 + random() * 0.3
      dummy.rotation.x = -Math.PI * 25 / 180
      dummy.scale.set(scale * 4.8, scale * 2.4, 1)
      dummy.updateMatrix()
      clouds.setMatrixAt(cloud, dummy.matrix)
    }
    clouds.computeBoundingSphere()
    group.add(clouds)
    root.add(group)
    patches.set(seat, { group, geometry, clouds, phase: random() * Math.PI * 2 })
  }

  function removeSeat(seat) {
    const patch = patches.get(seat)
    if (!patch) return
    patch.group.removeFromParent()
    patch.geometry.dispose()
    patch.clouds.dispose()
    patches.delete(seat)
  }

  return {
    sync(seats, seatWidth) {
      for (const seat of seats) addSeat(seat, seatWidth)
      for (const seat of patches.keys()) if (!seats.has(seat)) removeSeat(seat)
    },
    update(t) {
      time.value = t
      for (const patch of patches.values()) {
        patch.clouds.position.x = Math.sin(t * 0.07 + patch.phase) * 0.55
        patch.clouds.position.y = Math.sin(t * 0.19 + patch.phase) * 0.045
      }
    },
    dispose() {
      for (const seat of patches.keys()) removeSeat(seat)
      root.removeFromParent()
      texture.dispose()
      pollenMaterial.dispose()
      cloudTexture.dispose()
      cloudGeometry.dispose()
      cloudMaterial.dispose()
    },
  }
}
