import * as THREE from 'three'
import { toonMaterial } from './toon.js'

/** Chunk-local, seeded life. The same chunk and world clock render identically. */
export function createMapAmbient(root, {
  random, clear, waterShape, chimney = null,
  bounds = { minX: -7, maxX: 7, minZ: -16, maxZ: 14 },
}) {
  const time = { value: 0 }, dummy = new THREE.Object3D(), tint = new THREE.Color()
  const area = (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ)
  const point = () => ({ x: bounds.minX + random() * (bounds.maxX - bounds.minX), z: bounds.minZ + random() * (bounds.maxZ - bounds.minZ) })
  function instances(name, count, material, geometry = new THREE.BoxGeometry(1, 1, 1)) {
    const mesh = new THREE.InstancedMesh(geometry, material, count)
    mesh.name = name
    // Animated bounds are conservative; chunks themselves are explicitly evicted.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, -1), Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 6)
    root.add(mesh)
    return mesh
  }
  const grassMaterial = toonMaterial({ color: '#ffffff' })
  grassMaterial.side = THREE.DoubleSide
  grassMaterial.onBeforeCompile = shader => {
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
  for (let i = 0; i < area * 4 && grassSpots.length < area * .65; i++) {
    const p = point()
    if (clear(p.x, p.z)) grassSpots.push(p)
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
  for (let i = 0; i < area * 5 && gleams.length < 28; i++) {
    const p = point()
    if (waterShape(p.x, p.z) && Math.abs(p.z - 1.5) > 1.45) gleams.push({ ...p, phase: random() * 6.28 })
  }
  const water = instances('water-pixel-glints', gleams.length, toonMaterial({ color: '#a3d3c5', emissive: '#274a44' }))
  const flights = Array.from({ length: 3 }, () => ({ x: (random() - .5) * 9, z: 3.8 + random() * 3, phase: random() * 6.28 }))
  const butterflies = instances('butterfly-wings', flights.length * 2, toonMaterial({ color: '#ffffff', emissive: '#352410' }))
  flights.forEach((_, i) => {
    for (let side = 0; side < 2; side++) butterflies.setColorAt(i * 2 + side, tint.set(['#f9d27d', '#e8a185', '#f4e7be'][i % 3]))
  })
  const smoke = instances('chimney-pixel-smoke', chimney ? 7 : 0, toonMaterial({ color: '#d7d3bc' }))
  const leaves = instances('drifting-leaves', 3, toonMaterial({ color: '#b8b566' }))
  const leafSpots = Array.from({ length: 3 }, point)
  let disposed = false
  function set(mesh, i, x, y, z, sx, sy, sz, ry = 0, rz = 0) {
    dummy.position.set(x, y, z); dummy.scale.set(sx, sy, sz); dummy.rotation.set(0, ry, rz)
    dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix)
  }
  function update(_dt, t = 0) {
    if (disposed) return
    time.value = t
    gleams.forEach((p, i) => {
      const pulse = Math.sin(t * 1.9 + p.phase)
      set(water, i, p.x, -.145, p.z, pulse > .3 ? .22 + .2 * pulse : .07, .015, .045)
    })
    flights.forEach((p, i) => {
      const x = p.x + Math.sin(t * .32 + p.phase) * .6, z = p.z + Math.cos(t * .25 + p.phase) * .4
      const y = .85 + Math.sin(t * 1.4 + p.phase) * .19, flap = Math.sin(t * 10 + p.phase)
      for (let side = 0; side < 2; side++) {
        const sign = side ? 1 : -1
        set(butterflies, i * 2 + side, x + sign * .07, y + Math.abs(flap) * .04, z, .14, .035, .1, p.phase, flap * sign * 1.1)
      }
    })
    if (chimney) for (let i = 0; i < 7; i++) {
      const age = ((t * .17 + i / 7) % 1 + 1) % 1
      const size = (.12 + age * .3) * Math.min(1, (1 - age) * 4)
      set(smoke, i, chimney.x + age * 1.1, chimney.y + age * 2, chimney.z, size, size * .7, size)
    }
    leafSpots.forEach((p, i) => {
      const age = ((t * .095 + i / 3) % 1 + 1) % 1
      set(leaves, i, p.x + Math.sin(age * 8 + i) * .4, (1 - age) * 2.6 + .08, p.z + age, .12, .035, .19, age * 7, age * 5)
    })
    for (const mesh of [water, butterflies, smoke, leaves]) mesh.instanceMatrix.needsUpdate = true
  }
  update(0, 0)
  return { update, dispose() { disposed = true } }
}
