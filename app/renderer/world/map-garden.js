import * as THREE from 'three'
import { toonMaterial } from './toon.js'
import { seededRandom } from './map-props.js'

const SPECIES = {
  skill: { chunk: 0, name: 'sunwheel', color: '#e5b653' },
  memory: { chunk: 1, name: 'bellflower', color: '#b6a6d6' },
  technique: { chunk: 2, name: 'bamboo', color: '#a9bf76' },
  resource: { chunk: -1, name: 'berry', color: '#e49b80' },
}
const byKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0

function hash(text) {
  let n = 2166136261
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619)
  return n >>> 0
}

function normalize(item) {
  if (!item || !Object.hasOwn(SPECIES, item.kind)) return null
  const seed = typeof item.seed === 'string' || (typeof item.seed === 'number' && Number.isFinite(item.seed)) ? item.seed : 0
  const key = `${item.kind}:${typeof seed}:${seed}`
  const color = typeof item.color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(item.color)
    ? item.color : typeof item.color === 'number' && Number.isInteger(item.color) && item.color >= 0 && item.color <= 0xffffff
      ? `#${item.color.toString(16).padStart(6, '0')}` : SPECIES[item.kind].color
  // grow 0..1: how far through its week a plant is; full grown plants are 60 % bigger than new ones.
  const grow = Number.isFinite(item.grow) ? Math.max(0, Math.min(1, item.grow)) : 1
  return { key, kind: item.kind, seed, color, chunk: SPECIES[item.kind].chunk, grow }
}

// Each seed owns its coordinates. Adding another plant never moves an existing
// one, and a saved garden produces the same positions regardless of item order.
function position(record, chunk, width) {
  const random = seededRandom(hash(record.key)), reach = Math.min(5.9, width / 2 - .65)
  const free = (x, z) => {
    if (Math.abs(x) > width / 2 - .4) return false
    for (const dx of [-.3, 0, .3]) for (const dz of [-.3, 0, .3]) if (!chunk.clear(x + dx, z + dz)) return false
    return true
  }
  for (let attempt = 0; attempt < 96; attempt++) {
    const side = random() < .5 ? -1 : 1
    const behind = random() < .2
    const x = behind ? side * (4.85 + random() * Math.max(.1, reach - 4.85)) : side * (2.65 + random() * Math.max(.1, reach - 2.65))
    const z = behind ? -2.5 + random() * 1.4 : 3.4 + random() * 2.4
    if (free(x, z)) return { x, z, y: chunk.ground(x, z), scale: .88 + random() * .2, phase: random() * Math.PI * 2 }
  }
  // Unusual terrain can exhaust the preferred beds. Search the remaining nearby
  // lawn deterministically, and omit the visual if no whole footprint fits.
  const candidates = []
  for (let z = 3.5; z <= 7; z += .4) for (let x = -reach; x <= reach; x += .4) if (free(x, z)) candidates.push({ x, z })
  if (!candidates.length) return null
  const p = candidates[hash(record.key) % candidates.length]
  return { ...p, y: chunk.ground(p.x, p.z), scale: .94, phase: random() * Math.PI * 2 }
}

function plantParts(kind, color) {
  const pieces = []
  const box = (x, y, z, w, h, d, tint, rz = 0) => pieces.push({ x, y, z, w, h, d, tint, rz })
  const stem = '#64814e', leaf = '#88a65e', pale = '#e9deb0'
  if (kind === 'skill') {
    // A sunny, toothed daisy: the Workshop's little gear-shaped flower.
    box(0, .29, 0, .065, .58, .065, stem)
    box(-.11, .19, 0, .25, .065, .12, leaf, -.4)
    box(.11, .34, .02, .22, .07, .12, leaf, .45)
    for (const [x, y] of [[-.16, .58], [.16, .58], [0, .42], [0, .74]]) box(x, y, .02, .15, .15, .13, color)
    for (const side of [-1, 1]) box(side * .12, .58 + side * .12, .025, .1, .1, .12, color)
    box(0, .58, .055, .2, .2, .16, '#b48443')
    box(-.035, .63, .145, .065, .065, .025, '#f8e5a1')
  } else if (kind === 'memory') {
    // Three nodding bells, like little reading lamps.
    for (const [i, x, z, h] of [[0, -.14, .035, .51], [1, .04, -.045, .74], [2, .17, .08, .59]]) {
      box(x, h / 2, z, .045, h, .045, stem)
      box(x + (i % 2 ? -.07 : .07), h * .38, z, .19, .06, .11, leaf, i % 2 ? -.35 : .35)
      box(x, h, z, .16, .15, .16, color)
      box(x, h - .085, z, .23, .055, .21, color)
      box(x - .025, h + .075, z + .03, .09, .04, .09, pale)
    }
  } else if (kind === 'technique') {
    // Jointed bamboo grows a little taller, with disciplined, alternating leaves.
    for (const [i, x, z, h] of [[0, -.16, .045, .61], [1, 0, -.035, .88], [2, .17, .08, .7]]) {
      box(x, h / 2, z, .07, h, .07, i % 2 ? leaf : stem)
      for (let y = .17; y < h; y += .2) box(x, y, z, .085, .035, .085, '#bfd18a')
      const side = i % 2 ? -1 : 1
      box(x + side * .085, h * .63, z, .22, .055, .1, leaf, side * .45)
      box(x - side * .07, h * .88, z, .19, .05, .1, color, -side * .6)
      box(x, h + .02, z, .09, .09, .09, color)
    }
  } else {
    // A compact berry bush: the Campfire's edible shared resource.
    box(0, .13, 0, .1, .26, .1, stem)
    box(0, .23, 0, .49, .22, .38, stem)
    box(-.03, .37, -.02, .38, .17, .32, leaf)
    box(-.05, .48, -.025, .21, .08, .2, '#a8b96e')
    for (const [x, y, z] of [[-.19, .27, .19], [.14, .4, .12], [.06, .23, .205], [-.09, .43, .16], [.21, .25, .03]]) {
      box(x, y, z, .105, .1, .105, color)
      box(x - .018, y + .045, z + .04, .035, .025, .035, pale)
    }
  }
  return pieces
}

/** Garden records outlive mounted chunks. Every repeated pixel shares a batch. */
export function createKnowledgeGarden({ chunkWidth = 14 } = {}) {
  chunkWidth = Number.isFinite(chunkWidth) && chunkWidth >= 10 ? chunkWidth : 14
  const records = new Map(), chunks = new Map()
  const dummy = new THREE.Object3D(), tint = new THREE.Color()
  let disposed = false, now = 0

  function release(chunk) {
    for (const mesh of [chunk.plants, chunk.sparkles]) {
      if (!mesh) continue
      mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose()
    }
    chunk.plants = chunk.sparkles = null
  }

  function rebuild(chunk, blooming = null) {
    const previous = chunk.items
    release(chunk)
    chunk.items = [...records.values()].filter(record => record.chunk === chunk.index)
      .sort(byKey).flatMap(record => {
        const p = position(record, chunk, chunkWidth)
        if (!p) return []
        const old = previous.find(item => item.record.key === record.key)
        return [{ record, ...p, age: record.key === blooming ? 0 : old?.age ?? 2, parts: plantParts(record.kind, record.color) }]
      })
    if (!chunk.items.length) return
    const count = chunk.items.reduce((sum, item) => sum + item.parts.length, 0)
    chunk.plants = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), toonMaterial({ color: '#ffffff' }), count)
    chunk.plants.name = 'knowledge-garden-plants'
    chunk.plants.castShadow = chunk.plants.receiveShadow = true
    chunk.sparkles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#fff0b8', transparent: true, opacity: .88, depthWrite: false }), chunk.items.length * 4)
    chunk.sparkles.name = 'knowledge-garden-sparkles'
    chunk.sparkles.userData.noOutline = true
    for (const mesh of [chunk.plants, chunk.sparkles]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 2), Math.hypot(chunkWidth / 2, 6) + 2)
      chunk.root.add(mesh)
    }
    let i = 0
    for (const item of chunk.items) for (const piece of item.parts) chunk.plants.setColorAt(i++, tint.set(piece.tint))
    renderChunk(chunk, 0)
  }

  function renderChunk(chunk, dt) {
    if (!chunk.plants) return
    let index = 0, spark = 0, alive = false
    for (const item of chunk.items) {
      item.age = Math.min(2, item.age + dt)
      const age = item.age
      const growth = age >= 1.4 ? 1 : Math.max(.015, Math.min(1.1, 1 - Math.exp(-6.5 * age) * (Math.cos(age * 10) + .42 * Math.sin(age * 10))))
      const scale = item.scale * growth * (0.75 + 0.45 * item.record.grow)
      const lean = Math.sin(now * 1.05 + item.phase) * .018
      for (const p of item.parts) {
        dummy.position.set(item.x + p.x * scale + lean * p.y, item.y + p.y * scale, item.z + p.z * scale)
        dummy.rotation.set(0, 0, p.rz - lean)
        dummy.scale.set(p.w * scale, p.h * scale, p.d * scale)
        dummy.updateMatrix(); chunk.plants.setMatrixAt(index++, dummy.matrix)
      }
      for (let j = 0; j < 4; j++) {
        const phase = item.phase + j * Math.PI / 2
        const life = Math.max(0, 1 - age / 1.25)
        const size = age < .08 || life <= 0 ? 0 : (.035 + .025 * Math.max(0, Math.sin(age * 13 + j))) * life
        dummy.position.set(item.x + Math.cos(phase) * (.16 + age * .35), item.y + .35 + age * .65 + j % 2 * .13, item.z + Math.sin(phase) * (.12 + age * .22))
        dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(size)
        dummy.updateMatrix(); chunk.sparkles.setMatrixAt(spark++, dummy.matrix)
        alive ||= size > 0
      }
    }
    chunk.plants.instanceMatrix.needsUpdate = true
    chunk.sparkles.instanceMatrix.needsUpdate = true
    chunk.sparkles.visible = alive
  }

  function unmount(index) {
    const chunk = chunks.get(index)
    if (!chunk) return
    release(chunk); chunk.root.removeFromParent(); chunks.delete(index)
  }

  return {
    bloom(item) {
      if (disposed) return false
      const record = normalize(item)
      if (!record) return false
      const existing = records.get(record.key)
      records.set(record.key, record)
      const chunk = chunks.get(record.chunk)
      if (chunk && (!existing || existing.color !== record.color || existing.grow !== record.grow)) rebuild(chunk, existing ? null : record.key)
      return { kind: record.kind, seed: record.seed, color: record.color, chunk: record.chunk }
    },
    setGarden(items = []) {
      if (disposed || !Array.isArray(items)) return false
      records.clear()
      for (const item of items) {
        const record = normalize(item)
        if (record) records.set(record.key, record)
      }
      for (const chunk of chunks.values()) { chunk.items = []; rebuild(chunk) }
      return records.size
    },
    mount(index, group, { kind, clear, ground }) {
      if (disposed || !Number.isInteger(index) || !group || typeof clear !== 'function' || typeof ground !== 'function') return
      unmount(index)
      if (SPECIES[kind]?.chunk !== index) return
      const root = new THREE.Group()
      root.name = `knowledge-garden-${kind}`
      group.add(root)
      const chunk = { index, root, clear, ground, items: [], plants: null, sparkles: null }
      chunks.set(index, chunk); rebuild(chunk)
    },
    unmount,
    update(dt, t = now) {
      if (disposed) return
      if (Number.isFinite(t)) now = t
      dt = Number.isFinite(dt) ? Math.max(0, Math.min(.25, dt)) : 0
      for (const chunk of chunks.values()) renderChunk(chunk, dt)
    },
    snapshot() {
      return [...records.values()].sort(byKey).map(record => {
        const item = chunks.get(record.chunk)?.items.find(item => item.record.key === record.key)
        return { kind: record.kind, seed: record.seed, color: record.color, chunk: record.chunk, species: SPECIES[record.kind].name,
          planted: !!item, ...(item ? { x: item.x + record.chunk * chunkWidth, y: item.y, z: item.z, growing: item.age < 1.4 } : {}) }
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const index of [...chunks.keys()]) unmount(index)
      records.clear()
    },
  }
}
