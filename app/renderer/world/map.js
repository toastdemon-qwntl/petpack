import * as THREE from 'three'
import { createPainter, seededRandom, tree, fence, lantern, flowers, bench, signpost } from './map-props.js'
import { createChunkLandmark } from './map-landmarks.js'
import { createMapAmbient } from './map-ambient.js'
import { createTerrain, createStripNavigation } from './map-paths.js'

export const CHUNK_W = 14
const TYPES = [
  { kind: 'skill', label: 'Workshop', icon: 'gear' },
  { kind: 'memory', label: 'Library', icon: 'book' },
  { kind: 'technique', label: 'Dojo', icon: 'fist' },
  { kind: 'resource', label: 'Campfire', icon: 'flame' },
]
const mod = (n, d) => ((n % d) + d) % d
const indexOf = n => Number.isFinite(n) ? Math.trunc(n) : 0
const palette = {
  grass: ['#92a86b', '#96ab70', '#99ae72', '#8fa468', '#9bb074'],
  path: ['#cbb383', '#d0b889', '#cbb384', '#d4bc8d', '#c6ad7d'],
  bank: ['#9c9870', '#a6a079', '#8e9168'],
  water: ['#448e8a', '#468f8a', '#498f89', '#448b87'],
}

/** Each seat owns a 14-unit view onto a single deterministic, unbounded road. */
export function createMap(scene, { seed = 1, chunkWidth = CHUNK_W } = {}) {
  chunkWidth = Number.isFinite(chunkWidth) && chunkWidth >= 10 ? chunkWidth : CHUNK_W
  const root = new THREE.Group()
  root.name = 'petpack-world-strip'
  scene.add(root)
  const chunks = new Map(), terrain = createTerrain({ seed, chunkWidth })
  const navigation = createStripNavigation(terrain)
  const bounds = { minX: -Infinity, maxX: Infinity, minZ: -16, maxZ: 14 }
  let disposed = false, time = 0
  function chunkCenter(i) { return { x: indexOf(i) * chunkWidth, z: -1.25 } }
  function landmark(i) {
    i = indexOf(i)
    const { kind, label } = TYPES[mod(i, 4)]
    return { x: i * chunkWidth, z: 1.5, kind, label }
  }
  function spotsIn(i) {
    const x = indexOf(i) * chunkWidth
    return [{ x: x - 2, z: 1.5 }, { x: x + 2, z: 1.5 }, { x, z: 3.6 }, { x: x + 3.5, z: 1.5 }]
  }
  function makeChunk(i) {
    const group = new THREE.Group(), cx = i * chunkWidth, half = chunkWidth / 2
    group.name = `village-chunk-${i}`
    group.position.x = cx
    group.userData.chunk = i
    const random = seededRandom((seed >>> 0) ^ Math.imul(i, 0x9e3779b1) ^ 0x68bc21eb)
    const p = createPainter(group), type = TYPES[mod(i, 4)]
    const wet = (x, z) => terrain.waterShape(cx + x, z)
    const reserved = (x, z) => terrain.isRoad(cx + x, z, .35) || (Math.abs(x) < 4.4 && z > -7 && z < .25)
    const occupied = []
    const reserve = (x, z, w, d) => occupied.push({ x, z, w: w / 2, d: d / 2 })
    const blocked = (x, z) => occupied.some(o => Math.abs(x - o.x) < o.w + .2 && Math.abs(z - o.z) < o.d + .2)
    const columns = Math.ceil(chunkWidth * 2), cell = chunkWidth / columns
    for (let col = 0; col < columns; col++) for (let row = 0; row < 60; row++) {
      const x = -half + (col + .5) * cell, z = -15.75 + row * .5
      if (wet(x, z)) {
        p.tile(x, -.16, z, cell, .5, palette.water[Math.floor(random() * 4)])
        continue
      }
      const bank = wet(x + .5, z) || wet(x - .5, z) || wet(x, z + .5) || wet(x, z - .5)
      const path = terrain.isRoad(cx + x, z) || (Math.abs(x) < 3.1 && z > -1.5 && z < 1.5) ||
        (type.kind === 'resource' && Math.abs(x) < 4.5 && z > -6 && z < -.5)
      const colors = path ? palette.path : bank ? palette.bank : palette.grass
      const color = colors[Math.floor(random() * colors.length)]
      if (bank) p.box(x, -.12, z, cell, .24, .5, color)
      else p.tile(x, 0, z, cell, .5, color)
      if (path && random() < .15) p.box(x, .009, z, .13 + random() * .18, .018, .08 + random() * .08, '#e0cca1')
    }
    // Road edges continue in global half-unit courses, including across pane seams.
    for (let j = 0; j < columns; j++) {
      const x = -half + (j + .5) * cell
      for (const z of [.08, 2.92]) if (!wet(x, z)) p.box(x, .035, z, cell - .045, .07, .17, j % 3 ? '#b9ad83' : '#d6c696')
    }
    // A crossing belongs to its RIGHT chunk. The neighbouring pane renders that
    // same chunk too, so no duplicate deck, split railing, or separate water RNG.
    if (mod(i, 3) === 1) {
      const bx = -half
      for (let j = 0; j < 28; j++) {
        const x = bx - 1.75 + (j + .5) * .125, y = terrain.ground(cx + x, 1.5)
        p.box(x, y - .055, 1.5, .116, .11, 2.58, j % 3 ? '#bda277' : '#cdb58c')
        for (const z of [.63, 2.37]) p.box(x, y + .009, z, .032, .018, .05, '#7f7056')
      }
      for (const z of [.08, 2.92]) {
        for (let j = 0; j <= 4; j++) {
          const x = bx - 1.5 + j * .75, y = terrain.ground(cx + x, 1.5)
          p.box(x, y + .35, z, .13, .7, .13, '#8b795b')
          p.box(x, y + .74, z, .2, .1, .2, '#d1bb8e')
        }
        for (let j = 0; j < 12; j++) {
          const x = bx - 1.5 + (j + .5) * .25
          p.box(x, terrain.ground(cx + x, 1.5) + .59, z, .26, .09, .09, '#a8926c')
        }
      }
    }
    const fit = Math.min(1, chunkWidth / CHUNK_W)
    for (const side of [-1, 1]) {
      // The apron keeps its walking width even when optional chunks are narrower.
      const x = side * Math.max(3.2, 3.85 * fit)
      if (!wet(x, 3.8)) { flowers(p, x, 3.8, 1.45, .7, random, 18); reserve(x, 3.8, 1.7, 1) }
      if (!wet(side * 4.4 * fit, -.45)) { lantern(p, side * 4.4 * fit, -.45); reserve(side * 4.4 * fit, -.45, .8, .5) }
    }
    signpost(p, -3.7 * fit, -.55, type.icon, 1)
    reserve(-3.7 * fit, -.55, 1.8, .4)
    if (!wet(-4.7 * fit, 5.9)) { bench(p, -4.7 * fit, 5.9); reserve(-4.7 * fit, 5.9, 2, 1) }
    for (const side of [-1, 1]) {
      const x = side * 5.35 * fit
      if (!wet(x, -5)) { tree(p, x, -4.7 - random() * .4, mod(i + (side > 0 ? 1 : 0), 3), random, .82 + random() * .08); reserve(x, -4.9, 2.8, 3) }
      if (!wet(x, -8.5)) fence(p, x - .8, -8.5, 1.6)
    }
    // Trees are behind the entire road, so visiting pets stay visible at every x.
    for (let j = 0; j < 18; j++) {
      const x = (random() - .5) * (chunkWidth - 1), z = -9 - random() * 5
      if (wet(x, z) || blocked(x, z)) continue
      tree(p, x, z, mod(i + j, 3), random, .72 + random() * .28)
      reserve(x, z, 2.5, 2.6)
    }
    const pond = terrain.pond(i)
    if (pond) {
      const px = pond.x - cx
      for (let j = 0; j < 16; j++) {
        const angle = j / 16 * Math.PI * 2, x = px + Math.cos(angle) * 1.95, z = 6.2 + Math.sin(angle) * 1.35
        if (wet(x, z)) continue
        for (let k = 0; k < 2; k++) {
          const h = .32 + random() * .27
          p.box(x + k * .1, h / 2, z, .045, h, .045, '#718d59')
          if (!k) p.box(x, h, z, .08, .16, .08, '#967e4e')
        }
      }
      for (const [dx,dz] of [[-.7,-.2],[.5,.3]]) {
        p.box(px + dx, -.125, 6.2 + dz, .4, .03, .27, '#6f9c67')
        p.box(px + dx, -.075, 6.2 + dz, .14, .06, .14, '#ebc5bc')
      }
    }
    // Low foreground detail preserves the open crossing and central meeting area.
    for (let j = 0; j < 65; j++) {
      const x = (random() - .5) * chunkWidth, z = -8 + random() * 21
      if (wet(x, z) || reserved(x, z) || blocked(x, z)) continue
      if (j % 5 === 0) {
        p.box(x, .08, z, .07, .16, .07, '#ded0a4')
        p.box(x, .18, z, .24, .09, .21, '#c59474')
        p.box(x - .055, .23, z, .045, .02, .045, '#ecdcb3')
      } else p.stone(x, .065, z, .13 + random() * .2, .13, .16, j % 3 ? '#a7ab85' : '#c0bd94', random() * 3)
    }
    p.finish()
    const architecture = createChunkLandmark(group, type.kind, { scale: .85 * fit })
    const air = createMapAmbient(group, {
      random, bounds: { minX: -half, maxX: half, minZ: -16, maxZ: 14 },
      waterShape: wet, chimney: architecture.chimney,
      clear: (x,z) => !wet(x,z) && !reserved(x,z) && !blocked(x,z),
    })
    root.add(group)
    const chunk = { group, update(dt,t) { architecture.update(dt,t); air.update(dt,t) }, dispose() {
      air.dispose(); architecture.dispose(); group.removeFromParent()
      const geometries = new Set(), materials = new Set()
      group.traverse(object => {
        if (object.geometry) geometries.add(object.geometry)
        if (object.material) for (const m of Array.isArray(object.material) ? object.material : [object.material]) materials.add(m)
        if (object.isInstancedMesh) object.dispose()
      })
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose())
    } }
    chunk.update(0, time)
    return chunk
  }
  function ensure(minChunk, maxChunk) {
    if (disposed || !Number.isFinite(minChunk) || !Number.isFinite(maxChunk)) return
    let min = indexOf(minChunk), max = indexOf(maxChunk)
    if (min > max) [min,max] = [max,min]
    // One guard chunk each side supplies geometry, cast shadows and animated
    // details across the seam. A changed seat releases every more distant chunk.
    min--; max++
    for (const [i,chunk] of chunks) if (i < min || i > max) { chunk.dispose(); chunks.delete(i) }
    for (let i = min; i <= max; i++) if (!chunks.has(i)) chunks.set(i, makeChunk(i))
  }
  ensure(-1, 1)
  return {
    bounds, chunkWidth, ensure, chunkCenter, landmark, spotsIn,
    landmarks: { workshop: landmark(0), library: landmark(1), dojo: landmark(2), campfire: landmark(-1) },
    spots: [-1,0,1,2].flatMap(spotsIn), ground: terrain.ground, path: navigation.path,
    update(dt, t = 0) { if (disposed) return; time = Number.isFinite(t) ? t : time; for (const chunk of chunks.values()) chunk.update(dt,time) },
    dispose() { if (disposed) return; disposed = true; for (const chunk of chunks.values()) chunk.dispose(); chunks.clear(); root.removeFromParent() },
  }
}
