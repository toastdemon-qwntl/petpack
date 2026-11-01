import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const TAU = Math.PI * 2
const smoothstep = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

// Integer seats, including negative seats, always produce the same little garden.
export function seededRandom(seed) {
  let state = (Math.imul(seed | 0, 0x45d9f3b) ^ 0x6d2b79f5) >>> 0
  return () => {
    state += 0x6d2b79f5
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The global path does not depend on which islands are currently mounted.
export function groundPoint(x) {
  return {
    y: 0.18 + 0.035 * Math.sin(x * 0.48),
    z: 0.28 * Math.sin(x * 0.34) + 0.12 * Math.sin(x * 0.73),
  }
}

function windMaterial(color, time, amount = 0.075) {
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.88 })
  material.onBeforeCompile = shader => {
    shader.uniforms.uMeadowTime = time
    shader.vertexShader = 'uniform float uMeadowTime;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        float phase = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 0.9;
        transformed.x += sin(uMeadowTime * 1.35 + phase) * ${amount.toFixed(3)} * max(position.y, 0.0);
        transformed.z += cos(uMeadowTime * 0.9 + phase) * ${(amount * 0.5).toFixed(3)} * max(position.y, 0.0);
      #endif
    `)
  }
  material.customProgramCacheKey = () => `meadow-wind-${amount}`
  return material
}

function merged(parts) {
  const result = mergeGeometries(parts)
  parts.forEach(part => part.dispose())
  return result
}

function flowerGeometry() {
  const petals = []
  for (let p = 0; p < 5; p++) {
    const angle = p * TAU / 5
    const petal = new THREE.SphereGeometry(1, 7, 5)
    petal.scale(0.095, 0.04, 0.145)
    petal.rotateY(angle)
    petal.translate(Math.sin(angle) * 0.115, 0.47, Math.cos(angle) * 0.115)
    petals.push(petal)
  }
  return merged(petals)
}

function grassGeometry() {
  const leaves = []
  for (let i = 0; i < 3; i++) {
    const h = [0.28, 0.42, 0.32][i]
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.04, 0, 0, 0.04, 0, 0, -0.02, h * 0.58, 0.028,
      0.04, 0, 0, 0.05, h * 0.58, 0.028, -0.02, h * 0.58, 0.028,
      -0.02, h * 0.58, 0.028, 0.05, h * 0.58, 0.028, 0.095, h, 0.09,
    ], 3))
    g.rotateY(i * 2.2)
    g.computeVertexNormals()
    leaves.push(g)
  }
  return merged(leaves)
}

export function createIslandAssets() {
  const time = { value: 0 }
  const sphere = new THREE.SphereGeometry(1, 24, 16)
  const trunk = new THREE.CylinderGeometry(0.085, 0.15, 1, 9)
  trunk.translate(0, 0.5, 0)
  const stem = new THREE.CylinderGeometry(0.015, 0.02, 0.45, 5)
  stem.translate(0, 0.225, 0)
  const flowerCenter = new THREE.SphereGeometry(0.064, 8, 6)
  flowerCenter.scale(1, 0.5, 1)
  flowerCenter.translate(0, 0.505, 0)
  const grass = windMaterial('#77a854', time)
  grass.side = THREE.DoubleSide
  const rock = new THREE.MeshStandardMaterial({
    color: '#ece7e5', vertexColors: true, roughness: 1,
    transparent: true, depthWrite: true,
  })
  rock.onBeforeCompile = shader => {
    shader.vertexShader = 'varying float vIslandHeight;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvIslandHeight = position.y;')
    shader.fragmentShader = 'varying float vIslandHeight;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      diffuseColor.a *= smoothstep(-2.5, -0.4, vIslandHeight);
      #include <opaque_fragment>
    `)
  }
  const geometry = {
    sphere, trunk, grass: grassGeometry(), stem, petals: flowerGeometry(), flowerCenter,
    plank: new THREE.BoxGeometry(0.19, 0.105, 1.27),
    post: new THREE.CylinderGeometry(0.045, 0.052, 0.52, 7),
    pebble: new THREE.SphereGeometry(1, 10, 7),
  }
  const material = {
    grass, rock,
    meadow: new THREE.MeshStandardMaterial({ color: '#99c67d', vertexColors: true, roughness: 0.94 }),
    path: new THREE.MeshStandardMaterial({ color: '#f6e5bf', roughness: 0.98 }),
    trunk: new THREE.MeshStandardMaterial({ color: '#ba9973', roughness: 0.92 }),
    leaves: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.68 }),
    stem: windMaterial('#78a351', time),
    petals: windMaterial('#ffffff', time),
    flowerCenter: windMaterial('#f7d67b', time),
    wood: new THREE.MeshStandardMaterial({ color: '#ddbc92', roughness: 0.9 }),
    rope: new THREE.MeshStandardMaterial({ color: '#eddbc0', roughness: 1 }),
    pebble: new THREE.MeshStandardMaterial({ color: '#e4dac1', roughness: 0.9 }),
  }
  return {
    geometry, material, time,
    dispose() {
      Object.values(geometry).forEach(value => value.dispose())
      Object.values(material).forEach(value => value.dispose())
    },
  }
}

function outline(angle, radius, halfWidth, phase) {
  // A soft superellipse gives the strip generous walkable ends, unlike an oval.
  const c = Math.cos(angle), s = Math.sin(angle)
  const ripple = 1 + 0.022 * Math.sin(angle * 5 + phase) + 0.014 * Math.cos(angle * 9 - phase)
  return {
    x: Math.sign(c) * Math.pow(Math.abs(c), 0.66) * halfWidth * radius * ripple,
    z: Math.sign(s) * Math.pow(Math.abs(s), 0.85) * 3.05 * radius * ripple,
  }
}

function terrainHeight(x, z, radius, center) {
  const walk = groundPoint(center + x)
  const shoulder = 1 - Math.exp(-Math.pow((z - walk.z) / 0.92, 4))
  const hills = 0.11 + 0.11 * Math.sin(x * 0.62 + 1.5) * Math.cos(z * 0.9)
  return walk.y - 0.025 + shoulder * hills - (1 - Math.sqrt(1 - Math.pow(smoothstep(0.84, 1, radius), 2))) * 0.29
}

function landGeometry(center, halfWidth, phase, underside = false) {
  const segments = 96, rings = underside ? 12 : 22
  const positions = [], colors = [], indices = []
  const color = new THREE.Color()
  for (let ring = 0; ring <= rings; ring++) {
    const r = underside ? Math.sin(ring / rings * Math.PI / 2) : ring / rings
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * TAU
      const point = outline(angle, r, halfWidth, phase)
      let y = terrainHeight(point.x, point.z, r, center)
      if (underside) y = terrainHeight(point.x, point.z, 1, center) - 2.6 * Math.sqrt(1 - r * r) + 0.09 * Math.sin(angle * 5 + phase) * r * (1 - r)
      positions.push(point.x, y, point.z)
      if (underside) {
        color.set('#bdcccd').lerp(new THREE.Color('#eadbc5'), r * 0.86)
      } else {
        const variation = 0.94 + 0.065 * Math.sin(point.x * 0.7 + point.z * 1.15) + 0.025 * Math.cos(point.x * 2 - point.z)
        color.setRGB(variation, variation, variation * 0.97)
      }
      colors.push(color.r, color.g, color.b)
      if (ring < rings && i < segments) {
        const a = ring * (segments + 1) + i, b = a + segments + 1
        if (underside) indices.push(a, b, a + 1, b, b + 1, a + 1)
        else indices.push(a, a + 1, b, b, a + 1, b + 1)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function pathGeometry(center, halfWidth) {
  const positions = [], indices = [], segments = 128
  for (let i = 0; i <= segments; i++) {
    const x = -halfWidth + i / segments * halfWidth * 2
    const ground = groundPoint(center + x)
    const halfPath = 0.57 + 0.08 * Math.sin((center + x) * 0.9)
    for (const side of [-1, 1]) positions.push(x, ground.y + 0.005, ground.z + side * halfPath)
    if (i < segments) {
      const a = i * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export function createIsland(seat, seatWidth, assets) {
  const random = seededRandom(seat)
  const group = new THREE.Group()
  group.name = `island-${seat}`
  const center = (seat + 0.5) * seatWidth
  group.position.x = center
  const halfWidth = seatWidth / 2 - 0.73
  const phase = random() * TAU
  const ownedGeometries = []
  const batches = []
  const { geometry, material } = assets
  const dummy = new THREE.Object3D()
  const color = new THREE.Color()

  function surface(g, m) {
    ownedGeometries.push(g)
    const mesh = new THREE.Mesh(g, m)
    mesh.receiveShadow = true
    group.add(mesh)
    return mesh
  }
  surface(landGeometry(center, halfWidth, phase), material.meadow)
  surface(landGeometry(center, halfWidth, phase, true), material.rock)
  surface(pathGeometry(center, halfWidth + 0.02), material.path)

  function batch(g, m, transforms, shadow = false) {
    const mesh = new THREE.InstancedMesh(g, m, transforms.length)
    transforms.forEach((item, index) => {
      dummy.position.set(...item.position)
      dummy.rotation.set(0, item.rotation || 0, item.lean || 0)
      dummy.scale.set(...(item.scale || [1, 1, 1]))
      dummy.updateMatrix()
      mesh.setMatrixAt(index, dummy.matrix)
      if (item.color) mesh.setColorAt(index, color.set(item.color))
    })
    mesh.castShadow = shadow
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    batches.push(mesh)
    group.add(mesh)
    return mesh
  }

  const trunks = [], crowns = []
  const treeColors = ['#91bf78', '#a8cd87', '#bad69a', '#83b889', '#aec78b']
  const treeXs = [-0.73, -0.35, 0.40, 0.76]
  treeXs.forEach((u, index) => {
    const x = u * halfWidth + (random() - 0.5) * 0.55
    const z = -1.85 - random() * 0.35
    const h = 1.55 + random() * 0.65
    const y = terrainHeight(x, z, 0.65, center)
    const size = 0.78 + random() * 0.24
    trunks.push({ position: [x, y, z], scale: [1, h, 1], lean: (random() - 0.5) * 0.08 })
    const tint = treeColors[((seat + index) % treeColors.length + treeColors.length) % treeColors.length]
    crowns.push({ position: [x, y + h + 0.21, z], scale: [size, size * 1.07, size * 0.83], color: tint })
    crowns.push({ position: [x - 0.42 * size, y + h - 0.15, z + 0.05], scale: [size * 0.72, size * 0.72, size * 0.72], color: tint })
    crowns.push({ position: [x + 0.39 * size, y + h - 0.08, z + 0.14], scale: [size * 0.66, size * 0.76, size * 0.66], color: tint })
  })
  batch(geometry.trunk, material.trunk, trunks, true)
  batch(geometry.sphere, material.leaves, crowns, true)

  const grasses = [], flowers = [], pebbles = [], shrubs = []
  const flowerColors = ['#fff5dd', '#f1b8ad', '#d4c4ed', '#f9df8c', '#fff5dd']
  for (let i = 0; i < 260; i++) {
    const x = (random() - 0.5) * halfWidth * 1.85
    const z = (random() - 0.5) * 5.4
    const radius = Math.sqrt(Math.pow(Math.abs(x / halfWidth), 3) + Math.pow(z / 3.05, 2))
    const walk = groundPoint(center + x)
    if (radius > 0.90 || Math.abs(z - walk.z) < 0.91) continue
    const y = terrainHeight(x, z, radius, center)
    const scale = 0.55 + random() * 0.65
    const transform = { position: [x, y, z], scale: [scale, scale, scale], rotation: random() * TAU }
    if (i % 3 === 0) flowers.push({ ...transform, color: flowerColors[Math.floor(random() * flowerColors.length)] })
    else grasses.push({ ...transform, color: random() > 0.5 ? '#b9d694' : '#d2dfa0' })
  }
  for (let i = 0; i < 15; i++) {
    const x = (random() - 0.5) * halfWidth * 1.8
    const ground = groundPoint(center + x)
    const side = random() > 0.5 ? 1 : -1
    pebbles.push({ position: [x, ground.y + 0.01, ground.z + side * (0.73 + random() * 0.13)], scale: [0.08 + random() * 0.09, 0.04 + random() * 0.035, 0.065 + random() * 0.045], rotation: random() * TAU })
  }
  for (let i = 0; i < 6; i++) {
    const x = (random() - 0.5) * halfWidth * 1.75
    const z = -2.0 - random() * 0.35
    const size = 0.22 + random() * 0.2
    shrubs.push({ position: [x, 0.27, z], scale: [size * 1.5, size, size], color: '#afcb86' })
  }
  batch(geometry.grass, material.grass, grasses)
  batch(geometry.stem, material.stem, flowers.map(({ color, ...item }) => item))
  batch(geometry.petals, material.petals, flowers)
  batch(geometry.flowerCenter, material.flowerCenter, flowers.map(({ color, ...item }) => item))
  batch(geometry.pebble, material.pebble, pebbles)
  batch(geometry.sphere, material.leaves, shrubs, true)

  // Each island owns its right bridge. Neighbours meet at the same world point.
  const boundary = seatWidth / 2
  const planks = [], posts = []
  const bridgeHalf = 0.99
  for (let i = 0; i <= 9; i++) {
    const x = boundary - bridgeHalf + i / 9 * bridgeHalf * 2
    const ground = groundPoint(center + x)
    planks.push({ position: [x, ground.y - 0.058, ground.z], rotation: -Math.atan((groundPoint(center + x + 0.01).z - ground.z) / 0.01), scale: [1, 1, 1] })
  }
  for (const side of [-1, 1]) {
    for (const dx of [-0.85, 0.85]) {
      const x = boundary + dx
      const ground = groundPoint(center + x)
      posts.push({ position: [x, ground.y + 0.2, ground.z + side * 0.67] })
    }
    const points = []
    for (let i = 0; i <= 16; i++) {
      const u = i / 16, x = boundary - 0.85 + u * 1.7
      const ground = groundPoint(center + x)
      points.push(new THREE.Vector3(x, ground.y + 0.43 - Math.sin(u * Math.PI) * 0.13, ground.z + side * 0.67))
    }
    const rope = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 20, 0.024, 5, false)
    surface(rope, material.rope)
  }
  batch(geometry.plank, material.wood, planks, true)
  batch(geometry.post, material.wood, posts, true)

  return {
    group,
    dispose() {
      group.removeFromParent()
      ownedGeometries.forEach(g => g.dispose())
      batches.forEach(mesh => mesh.dispose())
    },
  }
}
