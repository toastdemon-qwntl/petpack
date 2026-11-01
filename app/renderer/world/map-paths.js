// The terrain and walking contract share these functions. Nothing here depends on
// Three.js or loaded chunks: a pet can plan a journey before either pane exists.
export const ROAD_Z = 1.5
export const ROAD_HALF_WIDTH = 1.25
export const mod = (n, divisor) => ((n % divisor) + divisor) % divisor

function hash(n, seed) {
  let value = Math.imul(n | 0, 0x45d9f3b) ^ (seed | 0)
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296
}

export function createTerrain({ seed = 1, chunkWidth = 14 } = {}) {
  const width = Number.isFinite(chunkWidth) && chunkWidth > 0 ? chunkWidth : 14
  const roadZ = ROAD_Z, roadHalfWidth = ROAD_HALF_WIDTH
  const bridgeHalfWidth = 1.75, bridgeHeight = .20, streamWidth = 1.25
  const apronHalfWidth = 2, apronMinZ = -.2, apronMaxZ = 4.5, tile = .5
  const chunkAt = x => Math.floor(x / width + .5)
  const streamBoundary = x => 1 + 3 * Math.round((x / width - .5) / 3)

  // A stream is owned by a boundary, not either adjacent chunk. Its centre stays
  // exactly on that boundary through the road; both panes draw identical banks.
  function streamCenter(index, z) {
    const distance = Math.max(0, Math.abs(z - roadZ) - 2)
    const phase = hash(index, seed) * Math.PI * 2
    const sway = Math.sin(distance * .29 + phase) * Math.min(1, distance * .22)
    return (index - .5) * width + sway * .62
  }
  function streamAt(x) {
    const index = streamBoundary(x)
    return { index, x: (index - .5) * width, width: streamWidth, center: z => streamCenter(index, z) }
  }
  function pond(index) {
    return mod(index, 4) === 3
      ? { index, x: index * width + 3.8, z: 6.2, radiusX: 1.7, radiusZ: 1.1 }
      : null
  }
  function pondAt(x) {
    const index = 3 + 4 * Math.round(((x - 3.8) / width - 3) / 4)
    return pond(index)
  }
  function pondShape(x, z) {
    const p = pondAt(x)
    return ((x - p.x) / p.radiusX) ** 2 + ((z - p.z) / p.radiusZ) ** 2 < 1
  }
  function waterShape(x, z) {
    const index = streamBoundary(x)
    return Math.abs(x - streamCenter(index, z)) < streamWidth / 2 || pondShape(x, z)
  }
  function bridgeAt(x, z) {
    if (Math.abs(z - roadZ) > roadHalfWidth) return null
    const stream = streamAt(x)
    return Math.abs(x - stream.x) <= bridgeHalfWidth ? stream : null
  }
  function ground(x, z) {
    const bridge = bridgeAt(x, z)
    if (!bridge) return 0
    return bridgeHeight * Math.min(1, (bridgeHalfWidth - Math.abs(x - bridge.x)) / (bridgeHalfWidth - .9))
  }
  // Match both the mathematical shoreline and the visible half-tile water cells.
  function isWater(x, z) {
    if (bridgeAt(x, z)) return false
    return waterShape(x, z) || waterShape(Math.floor(x / tile) * tile + tile / 2, Math.floor(z / tile) * tile + tile / 2)
  }
  const onMainRoad = (x, z, margin = 0) => Math.abs(z - roadZ) <= Math.max(0, roadHalfWidth + margin)
  function onApron(x, z, margin = 0) {
    return Math.abs(x - chunkAt(x) * width) <= Math.max(0, apronHalfWidth + margin) &&
      z >= apronMinZ - margin && z <= apronMaxZ + margin
  }
  const isRoad = (x, z, margin = 0) => onMainRoad(x, z, margin) || onApron(x, z, margin)

  return {
    chunkWidth: width, roadZ, roadHalfWidth, bridgeHalfWidth, bridgeHeight, streamWidth,
    apronHalfWidth, apronMinZ, apronMaxZ, tile, minZ: -16, maxZ: 14,
    chunkAt, streamAt, streamCenter, pond, pondAt, pondShape,
    waterShape, isWater, bridgeAt, ground, isRoad, onMainRoad, onApron,
  }
}

const same = (a, b) => Math.abs(a.x - b.x) < 1e-8 && Math.abs(a.z - b.z) < 1e-8

export function createStripNavigation(terrain = createTerrain()) {
  const { roadZ } = terrain
  function endpoint(p) {
    // Arbitrary stale positions recover onto the public road. Valid road/apron
    // coordinates are preserved exactly, so meetings never end with a teleport.
    return terrain.isRoad(p.x, p.z) && !terrain.isWater(p.x, p.z)
      ? { x: p.x, z: p.z } : { x: p.x, z: roadZ }
  }
  function compact(points) {
    const result = []
    for (const p of points) {
      if (result.length && same(result[result.length - 1], p)) continue
      if (result.length > 1) {
        const a = result[result.length - 2], b = result[result.length - 1]
        const cross = (b.x - a.x) * (p.z - b.z) - (b.z - a.z) * (p.x - b.x)
        const dot = (b.x - a.x) * (p.x - b.x) + (b.z - a.z) * (p.z - b.z)
        if (Math.abs(cross) < 1e-8 && dot >= 0) result.pop()
      }
      result.push(p)
    }
    return result
  }
  return {
    path(from, to) {
      if (![from?.x, from?.z, to?.x, to?.z].every(Number.isFinite)) return []
      const a = endpoint(from), b = endpoint(to)
      if (same(a, b)) return [a]
      // The main road is continuous across every chunk and every bridge. Joining
      // it before travelling laterally avoids diagonal cuts through the scenery.
      return compact([a, { x: a.x, z: roadZ }, { x: b.x, z: roadZ }, b])
    },
  }
}

// Historical dev pages may still import the round-2 names while lanes update.
const defaultTerrain = createTerrain()
export const waterShape = defaultTerrain.waterShape
export const isWater = defaultTerrain.isWater
export const groundHeight = defaultTerrain.ground
export const isRoad = defaultTerrain.isRoad
export const streamX = z => defaultTerrain.streamCenter(1, z)
export const ROAD_NODES = [-2, -1, 0, 1, 2, 3].map(i => ({ x: i * 14, z: ROAD_Z }))
export const ROAD_EDGES = ROAD_NODES.slice(1).map((_, i) => [i, i + 1])
export function createNavigation() {
  return { ...createStripNavigation(defaultTerrain), spots: ROAD_NODES.map(p => ({ ...p })) }
}
