// One continuous village: every crossing of the stream uses the central bridge.
// This module is deliberately independent of Three.js so navigation can be checked
// without a renderer. Coordinates are the same world units used by the scenery.
export const ROAD_NODES = [
  { x: -20, z: -8 }, { x: -20, z: 0 }, { x: -16, z: 0 },
  { x: -16, z: 10 }, { x: -7, z: 10 }, { x: -7, z: 0 },
  { x: -3.5, z: 0 }, { x: 3.5, z: 0 }, { x: 8, z: 0 },
  { x: 18, z: 0 }, { x: 18, z: -8 }, { x: 18, z: 10 },
  { x: -27, z: 0 }, { x: 27, z: 0 }, { x: 27, z: -8 },
  { x: 27, z: 10 }, { x: -9, z: -8 }, { x: -9, z: 0 },
  { x: 8, z: -8 }, { x: -27, z: 10 }, { x: 12, z: 0 },
  { x: 12, z: 10 },
]

export const ROAD_EDGES = [
  [0, 1], [1, 2], [2, 17], [17, 5], [5, 6], [6, 7], [7, 8],
  [8, 20], [20, 9], [9, 13], [3, 4], [4, 5], [1, 12],
  [12, 19], [19, 3], [20, 21], [21, 11],
  [10, 9], [10, 14], [14, 13], [13, 15], [15, 11],
  [0, 16], [16, 17], [10, 18], [18, 8],
]

export const streamX = z => 0.8 * Math.sin(z * 0.24) + 0.4 * Math.sin(z * 0.55)
export const waterShape = (x, z) => Math.abs(x - streamX(z)) < 1.15 ||
  ((x - 6.5) / 3.8) ** 2 + ((z - 12.5) / 2.8) ** 2 < 1

const onBridge = (x, z) => Math.abs(x) <= 3.5 && Math.abs(z) <= 1.1
export const isWater = (x, z) => waterShape(x, z) && !onBridge(x, z)
export const groundHeight = (x, z) => onBridge(x, z)
  ? 0.32 * Math.min(1, Math.max(0, (3.5 - Math.abs(x)) / 2)) : 0

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const same = (a, b) => distance(a, b) < 1e-7
function project(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z
  const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)))
  return { x: a.x + dx * f, z: a.z + dz * f }
}
export function isRoad(x, z, margin = 0) {
  const p = { x, z }, radius = Math.max(0, 1.1 + margin)
  return ROAD_EDGES.some(([a, b]) => distance(p, project(p, ROAD_NODES[a], ROAD_NODES[b])) <= radius)
}

function building(x, z) {
  return z >= -15 && z <= -9.1 &&
    ((x >= -24 && x <= -16) || (x >= 14 && x <= 22))
}

// A tiny binary heap keeps the rare off-path recovery bounded to the village grid.
class Frontier {
  constructor() { this.items = [] }
  push(id, score) {
    const entry = { id, score }, a = this.items
    let i = a.length
    a.push(entry)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].score <= score) break
      a[i] = a[p]; i = p
    }
    a[i] = entry
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop()
    if (a.length) {
      let i = 0
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1
        if (c + 1 < a.length && a[c + 1].score < a[c].score) c++
        if (a[c].score >= last.score) break
        a[i] = a[c]; i = c
      }
      a[i] = last
    }
    return first.id
  }
  get length() { return this.items.length }
}

export function createNavigation(blocked = () => false) {
  const blockedAt = typeof blocked === 'function' ? blocked : () => false
  const safe = p => p.x >= -32 && p.x <= 32 && p.z >= -20 && p.z <= 20 &&
    !isWater(p.x, p.z) && !building(p.x, p.z) && !blockedAt(p.x, p.z)
  function clear(a, b) {
    const n = Math.max(1, Math.ceil(distance(a, b) / 0.125))
    for (let i = 0; i <= n; i++) {
      const f = i / n
      if (!safe({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f })) return false
    }
    return true
  }
  function clean(points) {
    const out = []
    for (const p of points) {
      if (out.length && same(out[out.length - 1], p)) continue
      if (out.length > 1) {
        const a = out[out.length - 2], b = out[out.length - 1]
        const cross = (b.x - a.x) * (p.z - b.z) - (b.z - a.z) * (p.x - b.x)
        const dot = (b.x - a.x) * (p.x - b.x) + (b.z - a.z) * (p.z - b.z)
        if (Math.abs(cross) < 1e-7 && dot >= 0 && clear(a, p)) out.pop()
      }
      out.push({ x: p.x, z: p.z })
    }
    return out
  }
  function graphPath(from, to) {
    const points = ROAD_NODES.map(p => ({ ...p })), links = points.map(() => [])
    const connect = (a, b, weight = distance(points[a], points[b])) => {
      if (!clear(points[a], points[b])) return
      links[a].push([b, weight]); links[b].push([a, weight])
    }
    ROAD_EDGES.forEach(([a, b]) => connect(a, b))
    const joins = []
    function attach(p) {
      const endpoint = points.length
      points.push(p); links.push([])
      const candidates = ROAD_EDGES.map(([a, b], edge) => {
        const point = project(p, points[a], points[b])
        return { point, edge, a, b, gap: distance(p, point) }
      }).sort((a, b) => a.gap - b.gap)
      // For an on-road endpoint, only attach nearby road sections. This prevents
      // a valid but visually implausible diagonal shortcut across the meadow.
      const maxGap = candidates[0].gap <= 1.1 ? 1.101 : candidates[0].gap + 3
      let attached = 0
      for (const c of candidates) {
        if (c.gap > maxGap || attached >= 4) break
        if (!clear(p, c.point)) continue
        const node = points.length
        points.push(c.point); links.push([])
        connect(endpoint, node, c.gap * 4)
        connect(node, c.a); connect(node, c.b)
        for (const j of joins) if (j.edge === c.edge) connect(node, j.node)
        joins.push({ edge: c.edge, node }); attached++
      }
      return endpoint
    }
    const start = attach(from), finish = attach(to)
    const costs = new Float64Array(points.length).fill(Infinity)
    const previous = new Int32Array(points.length).fill(-1), done = new Set()
    const queue = new Frontier()
    costs[start] = 0; queue.push(start, 0)
    while (queue.length) {
      const id = queue.pop()
      if (done.has(id)) continue
      if (id === finish) {
        const route = []
        for (let n = id; n !== -1; n = previous[n]) route.push(points[n])
        return clean(route.reverse())
      }
      done.add(id)
      for (const [next, cost] of links[id]) {
        const candidate = costs[id] + cost
        if (candidate >= costs[next]) continue
        costs[next] = candidate; previous[next] = id; queue.push(next, candidate)
      }
    }
    return null
  }

  const step = 0.5, columns = 129, rows = 81, count = columns * rows
  const pointAt = id => ({ x: (id % columns) * step - 32, z: Math.floor(id / columns) * step - 20 })
  function nearest(p, needsConnector) {
    if (!needsConnector && safe(p)) return { ...p }
    const cx = Math.round((Math.max(-32, Math.min(32, p.x)) + 32) / step)
    const cz = Math.round((Math.max(-20, Math.min(20, p.z)) + 20) / step)
    for (let radius = 0; radius < columns; radius++) {
      let best = null, gap = Infinity
      for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
        if (radius && Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue
        const x = cx + dx, z = cz + dz
        if (x < 0 || x >= columns || z < 0 || z >= rows) continue
        const id = z * columns + x, q = pointAt(id), d = distance(p, q)
        if (d < gap && safe(q) && (!needsConnector || clear(p, q))) { best = { id, ...q }; gap = d }
      }
      if (best) return best
    }
    return null
  }
  function gridPath(from, to) {
    const start = nearest(from, true), finish = nearest(to, true)
    if (!start || !finish) return []
    const cost = new Float64Array(count).fill(Infinity)
    const previous = new Int32Array(count).fill(-1), done = new Uint8Array(count)
    const queue = new Frontier()
    cost[start.id] = 0; queue.push(start.id, distance(start, finish))
    while (queue.length) {
      const id = queue.pop()
      if (done[id]) continue
      if (id === finish.id) {
        const route = [to]
        for (let n = id; n !== -1; n = previous[n]) route.push(pointAt(n))
        route.push(from)
        return clean(route.reverse())
      }
      done[id] = 1
      const p = pointAt(id), ix = id % columns, iz = Math.floor(id / columns)
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dz) || ix + dx < 0 || ix + dx >= columns || iz + dz < 0 || iz + dz >= rows) continue
        const next = id + dz * columns + dx, q = pointAt(next)
        if (done[next] || !clear(p, q)) continue
        const weight = isRoad(q.x, q.z) ? 1 : 4
        const candidate = cost[id] + Math.hypot(dx, dz) * step * weight
        if (candidate >= cost[next]) continue
        cost[next] = candidate; previous[next] = id
        queue.push(next, candidate + distance(q, finish))
      }
    }
    return []
  }
  return {
    spots: [2, 5, 8, 9, 4, 13, 15, 18].map(id => ({ ...ROAD_NODES[id] })).filter(safe),
    path(from, to) {
      if (![from?.x, from?.z, to?.x, to?.z].every(Number.isFinite)) return []
      const a = nearest(from, false), b = nearest(to, false)
      if (!a || !b) return []
      if (same(a, b)) return [{ x: a.x, z: a.z }]
      return graphPath(a, b) || gridPath(a, b)
    },
  }
}
