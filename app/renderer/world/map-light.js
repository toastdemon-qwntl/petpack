import * as THREE from 'three'

// Hours are local solar mood, not simulation time: every pane given the same
// hour samples exactly the same palette. The long daytime plateau is the locked
// sunny-afternoon render, including its original light positions/intensities.
const DAY = { sky: '#c6dfde', ambient: '#9fb8e8', ground: '#9b9e65', fill: 1.65, sun: '#ffe9c4', key: 2.65, offset: [-24, 38, 22], night: 0 }
const GOLD = { sky: '#e9c6a1', ambient: '#a9afcc', ground: '#ac9468', fill: 1.38, sun: '#ffba70', key: 2.55, offset: [-42, 17, 22], night: .14 }
const DUSK = { sky: '#777f9e', ambient: '#8699d1', ground: '#66716f', fill: 1.04, sun: '#ee9b90', key: 1.05, offset: [-42, 12, 22], night: .68 }
const NIGHT = { sky: '#283b57', ambient: '#7194cc', ground: '#445968', fill: .7, sun: '#8caee8', key: .6, offset: [-24, 38, 22], night: 1 }
const DAWN = { sky: '#d1bcb7', ambient: '#a0afd2', ground: '#929279', fill: 1.25, sun: '#ffd0a5', key: 1.85, offset: [-38, 20, 20], night: .3 }
const keys = [[0, NIGHT], [5, NIGHT], [6.5, DAWN], [8, DAY], [16.5, DAY], [17.5, GOLD], [18.5, DUSK], [20, NIGHT], [24, NIGHT]]
const colorKeys = ['sky', 'ambient', 'ground', 'sun']
for (const palette of new Set(keys.map(k => k[1]))) {
  for (const key of colorKeys) palette[key] = new THREE.Color(palette[key])
  palette.offset = new THREE.Vector3(...palette.offset)
}

export function localHour(date = new Date()) { return date.getHours() + date.getMinutes() / 60 }
export function sampleDaylight(hours) {
  const hour = Number.isFinite(hours) ? ((hours % 24) + 24) % 24 : 14
  let i = 1
  while (hour > keys[i][0]) i++
  const [aTime, a] = keys[i - 1], [bTime, b] = keys[i]
  const f = (hour - aTime) / (bTime - aTime), mix = f * f * (3 - 2 * f)
  const result = { hour }
  for (const key of colorKeys) result[key] = a[key].clone().lerp(b[key], mix)
  for (const key of ['fill', 'key', 'night']) result[key] = THREE.MathUtils.lerp(a[key], b[key], mix)
  result.offset = a.offset.clone().lerp(b.offset, mix)
  return result
}

/** Tiny world-space pools, with stepped square falloff instead of blurry bloom.
 * No point lights: adding a village never multiplies the surface-light shader. */
export function createNightLights(parent, { lamps = [], ground, waterShape }) {
  const root = new THREE.Group()
  root.name = 'night-lantern-light'
  root.visible = false
  parent.add(root)
  const cells = [], panels = []
  const step = .18
  for (const lamp of lamps) {
    if (lamp.panel) panels.push(lamp)
    const radius = lamp.radius || 1.08
    const extent = Math.ceil(radius / step)
    for (let row = -extent; row <= extent; row++) for (let col = -extent; col <= extent; col++) {
      // A world grid, not a pane-local texture, keeps the neighbouring view exact.
      const x = Math.round(lamp.x / step) * step + col * step
      const z = Math.round(lamp.z / step) * step + row * step
      const distance = Math.hypot(x - lamp.x, z - lamp.z)
      if (distance > radius || waterShape(x, z)) continue
      const strength = Math.ceil((1 - distance / radius) * 4) / 4
      cells.push({ x, z, strength })
    }
  }
  const material = new THREE.MeshBasicMaterial({ color: '#ffd17e', transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
  const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(step, step).rotateX(-Math.PI / 2), material, cells.length)
  pool.name = 'pixel-lantern-pools'
  pool.userData.noOutline = true
  const dummy = new THREE.Object3D(), color = new THREE.Color()
  cells.forEach((cell, i) => {
    dummy.position.set(cell.x, ground(cell.x, cell.z) + .026, cell.z)
    dummy.updateMatrix(); pool.setMatrixAt(i, dummy.matrix)
    pool.setColorAt(i, color.setScalar(cell.strength))
  })
  pool.computeBoundingSphere(); root.add(pool)
  // The original lantern housing is opaque. A night-only inset face puts light
  // in front of that housing without changing any of its locked daytime pixels.
  const faces = new THREE.InstancedMesh(new THREE.PlaneGeometry(.23, .33),
    new THREE.MeshBasicMaterial({ color: '#ffdc8b', transparent: true, opacity: 0, depthWrite: false, toneMapped: false }), panels.length)
  faces.name = 'lit-lantern-faces'
  faces.userData.noOutline = true
  panels.forEach((p, i) => {
    dummy.position.set(p.x, 1.44, p.z + .158)
    dummy.updateMatrix(); faces.setMatrixAt(i, dummy.matrix)
  })
  faces.computeBoundingSphere(); root.add(faces)
  let disposed = false
  return {
    setNight(amount) {
      if (disposed) return
      root.visible = amount > .001
      material.opacity = amount * .29
      faces.material.opacity = amount
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const mesh of [pool, faces]) { mesh.dispose(); mesh.geometry.dispose(); mesh.material.dispose() }
      root.removeFromParent()
    },
  }
}
