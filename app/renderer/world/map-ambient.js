import * as THREE from 'three'
import { toonMaterial } from './toon.js'

/** Pixel-sized life, all batched. World time drives motion so a paused capture is stable. */
export function createMapAmbient(root, { random, clear, waterShape, chimney = { x: 20.3, y: 5, z: -12.8 } }) {
  const time = { value: 0 }
  const dummy = new THREE.Object3D()
  const tint = new THREE.Color()
  function instances(name, count, material, geometry = new THREE.BoxGeometry(1, 1, 1)) {
    const mesh = new THREE.InstancedMesh(geometry, material, count)
    mesh.name = name
    mesh.frustumCulled = false
    root.add(mesh)
    return mesh
  }
  const grassMaterial = toonMaterial({ color: '#ffffff' })
  grassMaterial.side = THREE.DoubleSide
  const previousCompile = grassMaterial.onBeforeCompile
  grassMaterial.onBeforeCompile = shader => {
    previousCompile.call(grassMaterial, shader)
    shader.uniforms.villageTime = time
    shader.vertexShader = 'uniform float villageTime;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      float breeze = sin(villageTime * 1.7 + instanceMatrix[3].x * 0.63 + instanceMatrix[3].z * 0.42);
      transformed.x += breeze * position.y * 0.2;
    `)
  }
  const grassGeometry = new THREE.BufferGeometry()
  grassGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -.16,0,0, -.08,.24,0, 0,0,0, 0,0,0, .12,.34,0, .16,0,0,
    0,0,-.13, 0,.19,-.04, 0,0,.07,
  ], 3))
  grassGeometry.computeVertexNormals()
  const grassSpots = []
  for (let i = 0; i < 5500 && grassSpots.length < 1800; i++) {
    const x = random() * 63 - 31.5, z = random() * 39 - 19.5
    if (clear(x, z)) grassSpots.push({ x, z })
  }
  const grass = instances('swaying-grass', grassSpots.length, grassMaterial, grassGeometry)
  const greens = ['#78944f', '#829c53', '#93ab60', '#a9b973', '#647f49']
  grassSpots.forEach((p, i) => {
    dummy.position.set(p.x, 0, p.z)
    dummy.rotation.set(0, random() * Math.PI * 2, 0)
    dummy.scale.setScalar(.6 + random() * .8)
    dummy.updateMatrix()
    grass.setMatrixAt(i, dummy.matrix)
    grass.setColorAt(i, tint.set(greens[i % greens.length]))
  })
  const gleams = []
  for (let i = 0; i < 2000 && gleams.length < 135; i++) {
    const x = random() * 14 - 3, z = random() * 39 - 19.5
    if (waterShape(x, z) && !(Math.abs(x) < 3.7 && Math.abs(z) < 1.3)) gleams.push({ x, z, phase: random() * 6.28 })
  }
  const water = instances('water-pixel-glints', gleams.length, toonMaterial({ color: '#89bbb0', emissive: '#274a44' }))
  const flights = Array.from({ length: 20 }, (_, i) => ({
    x: i < 6 ? -22 + random() * 8 : i < 12 ? 12 + random() * 12 : -9 + random() * 22,
    z: i < 6 ? -5 + random() * 3 : i < 12 ? 9 + random() * 7 : 5 + random() * 10,
    phase: random() * 6.28,
  }))
  const butterflies = instances('butterfly-wings', flights.length * 2, toonMaterial({ color: '#ffffff', emissive: '#352410' }))
  flights.forEach((_, i) => {
    for (let side = 0; side < 2; side++) butterflies.setColorAt(i * 2 + side, tint.set(['#f9d27d', '#e8a185', '#f4e7be'][i % 3]))
  })
  const smoke = instances('chimney-pixel-smoke', 9, toonMaterial({ color: '#d7d3bc' }))
  const leaves = instances('drifting-leaves', 15, toonMaterial({ color: '#b8b566' }))
  let disposed = false
  function set(mesh, i, x, y, z, sx, sy, sz, ry = 0, rz = 0) {
    dummy.position.set(x, y, z)
    dummy.scale.set(sx, sy, sz)
    dummy.rotation.set(0, ry, rz)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
  }
  function update(dt, t = 0) {
    if (disposed) return
    time.value = t
    gleams.forEach((p, i) => {
      const pulse = Math.sin(t * 1.9 + p.phase)
      const width = pulse > .3 ? .22 + .2 * pulse : .07
      set(water, i, p.x + Math.floor(Math.sin(t * .35 + p.phase) * 3) * .065, -.145, p.z, width, .015, .045)
    })
    flights.forEach((p, i) => {
      const x = p.x + Math.sin(t * .32 + p.phase) * 1.1
      const z = p.z + Math.cos(t * .25 + p.phase) * .6
      const y = .85 + Math.sin(t * 1.4 + p.phase) * .19
      const flap = Math.sin(t * 10 + p.phase)
      for (let side = 0; side < 2; side++) {
        const sign = side ? 1 : -1
        set(butterflies, i * 2 + side, x + sign * .07, y + Math.abs(flap) * .04, z, .14, .035, .1, p.phase, flap * sign * 1.1)
      }
    })
    for (let i = 0; i < 9; i++) {
      const age = (t * .17 + i / 9) % 1
      const size = (.12 + age * .3) * Math.min(1, (1 - age) * 4)
      set(smoke, i, chimney.x + age * 1.4 + Math.sin(age * 8 + t * .3) * .1, chimney.y + age * 2.5, chimney.z, size, size * .7, size)
    }
    for (let i = 0; i < 15; i++) {
      const age = (t * .095 + i / 15) % 1
      const x = -29 + (i * 7.73) % 58
      const z = -17 + (i * 11.7) % 34
      set(leaves, i, x + Math.sin(age * 8 + i) * .8, (1 - age) * 3.1 + .08, z + age, .12, .035, .19, age * 7, age * 5)
    }
    for (const mesh of [water, butterflies, smoke, leaves]) mesh.instanceMatrix.needsUpdate = true
  }
  update(0, 0)
  return { update, dispose() { disposed = true } }
}
