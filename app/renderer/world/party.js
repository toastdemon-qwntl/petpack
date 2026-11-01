import * as THREE from 'three'

const TAU = Math.PI * 2
const ROAD_Z = 1.5
const clamp = value => Math.max(0, Math.min(1, value))
const mix = (a, b, t) => a + (b - a) * t
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const colors = ['#ffd77b', '#9ccbea', '#e89883', '#aad0a0', '#fff3cc']

// A mirrored critically damped spring: no overshoot, zero velocity at each end.
function ease(value) {
  const t = clamp(value), response = x => (1 - (1 + x) * Math.exp(-x)) / (1 - 2 / Math.E)
  return t < .5 ? response(t * 2) / 2 : 1 - response((1 - t) * 2) / 2
}

function route(from, to) {
  const points = [from, { x: from.x, z: ROAD_Z }, { x: to.x, z: ROAD_Z }, to]
  const lengths = points.slice(1).map((p, i) => distance(points[i], p))
  const total = lengths.reduce((sum, n) => sum + n, 0)
  return progress => {
    let remaining = clamp(progress) * total
    for (let i = 0; i < lengths.length; i++) {
      if (remaining <= lengths[i] && lengths[i] > 1e-8) {
        const t = remaining / lengths[i]
        return { x: mix(points[i].x, points[i + 1].x, t), z: mix(points[i].z, points[i + 1].z, t) }
      }
      remaining -= lengths[i]
    }
    return { x: to.x, z: to.z }
  }
}

function noteTexture() {
  const rows = ['....##..', '....###.', '....#.##', '....#...', '....#...', '....#...', '..###...', '.####...', '.###....', '........']
  const data = new Uint8Array(8 * 10 * 4)
  rows.forEach((row, y) => [...row].forEach((pixel, x) => {
    if (pixel !== '#') return
    const offset = (y * 8 + x) * 4
    data.set([255, 255, 255, 255], offset)
  }))
  const texture = new THREE.DataTexture(data, 8, 10)
  texture.magFilter = texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.flipY = true
  texture.needsUpdate = true
  return texture
}

/**
 * World-space, shared-clock conga, used by attachMood(world).
 * start(ids, { durationS = 12, startAt = clock() }) -> Promise<boolean>.
 * durationS includes gathering, dancing and returning; update(dt, t) samples t
 * directly, so pane visibility, frame rate and late starts never alter the line.
 * move receives grounded world coordinates with snap:true. pose is transient.
 * has(id) includes scheduled dancers. cancel(id?) cancels the entire line and
 * restores every surviving pet; completion resolves true, cancellation false.
 */
export function createParty({ scene, getPet, move, pose, ground = () => 0, clock = () => performance.now() / 1000 }) {
  const root = new THREE.Group()
  root.name = 'petpack-conga'
  root.userData.noPick = true
  scene.add(root)
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: .92, depthWrite: false, toneMapped: false })
  const confetti = new THREE.InstancedMesh(geometry, material, 256)
  confetti.count = 0
  confetti.frustumCulled = false
  confetti.userData.noOutline = true
  confetti.userData.noPick = true
  confetti.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  root.add(confetti)
  const matrix = new THREE.Object3D(), palette = colors.map(color => new THREE.Color(color))
  for (let i = 0; i < 256; i++) confetti.setColorAt(i, palette[i % palette.length])
  const texture = noteTexture()
  const notes = [], noteMaterials = palette.map(color => new THREE.SpriteMaterial({
    map: texture, color, transparent: true, alphaTest: .1, depthWrite: false, toneMapped: false,
  }))
  for (let i = 0; i < 64; i++) {
    const note = new THREE.Sprite(noteMaterials[i % noteMaterials.length])
    note.userData.noOutline = note.userData.noPick = true
    note.visible = false
    note.scale.set(.32, .4, 1)
    root.add(note); notes.push(note)
  }
  root.visible = false
  let active = null, disposed = false

  function restore(party) {
    for (const pet of party.pets) {
      if (!getPet(pet.id)) continue
      move(pet.id, { x: pet.x, z: pet.z, facing: pet.facing, speed: 0, anim: 'idle', snap: true })
      pose(pet.id, { lift: 0, rotation: 0, scaleX: 1, scaleY: 1 })
    }
  }
  function finish(result) {
    const party = active
    if (!party) return false
    active = null
    root.visible = false; confetti.count = 0
    for (const note of notes) note.visible = false
    restore(party)
    party.resolve(result)
    return true
  }
  function sample(party, index, age) {
    const pet = party.pets[index]
    const p = clamp(age / party.duration)
    if (p < .24) return pet.inward(ease(p / .24))
    if (p <= .76) {
      const u = (p - .24) / .52
      return {
        x: pet.lineX + party.travel * ease(u),
        z: ROAD_Z + Math.sin(age * 3.8 - index * .72) * .3 * Math.sin(Math.PI * u),
      }
    }
    return pet.outward(ease((p - .76) / .24))
  }
  function draw(party, age, positions) {
    const p = age / party.duration
    const envelope = Math.min(clamp((p - .16) * 10), clamp((.9 - p) * 10))
    root.visible = envelope > 0
    confetti.count = 0
    for (const note of notes) note.visible = false
    if (!root.visible) return
    let noteIndex = 0, particleIndex = 0
    for (let i = 0; i < party.pets.length; i++) {
      const point = positions[i]
      const floor = ground(point.x, point.z) || 0
      // Three notes per eight seconds per dancer. Each view samples the same
      // integer cycle; drift never depends on a view-local random generator.
      for (let j = 0; j < 2 && noteIndex < notes.length; j++) {
        const phase = ((age * .42 + i * .173 + j * .5) % 1 + 1) % 1
        const note = notes[noteIndex++]
        note.visible = phase < .75
        note.position.set(point.x + Math.sin(i * 1.3 + j * 2) * .48 + phase * .26,
          floor + 3.15 + phase * .85, point.z + .14)
        note.scale.set(.32 * envelope * (1 - phase * .35), .4 * envelope * (1 - phase * .35), 1)
      }
      for (let j = 0; j < 8 && particleIndex < 256; j++) {
        const phase = ((age * .56 + i * .219 + j / 8) % 1 + 1) % 1
        const angle = j * 2.39996 + i * 1.9
        matrix.position.set(point.x + Math.cos(angle + phase) * (.34 + phase * .8),
          floor + 3.8 - phase * 2.7, point.z + Math.sin(angle) * .5)
        matrix.rotation.set(phase * 5 + i, angle + phase * 4, phase * 6 - j)
        const size = envelope * Math.min(1, phase * 6, (1 - phase) * 5)
        matrix.scale.set(.07 * size, .13 * size, .035 * size)
        matrix.updateMatrix()
        confetti.setMatrixAt(particleIndex++, matrix.matrix)
      }
    }
    confetti.count = particleIndex
    confetti.instanceMatrix.needsUpdate = true
  }

  return {
    start(ids, options = {}) {
      if (disposed || !Array.isArray(ids)) return Promise.resolve(false)
      const unique = [...new Set(ids)]
      let pets = unique.map(id => {
        const pet = getPet(id)
        return pet && Number.isFinite(pet.x) && Number.isFinite(pet.z)
          ? { id, x: pet.x, z: pet.z, facing: pet.facing === -1 ? -1 : 1 } : null
      })
      if (pets.length < 2 || pets.some(pet => !pet)) return Promise.resolve(false)
      const duration = options.durationS ?? 12, start = options.startAt ?? clock()
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(start)) return Promise.resolve(false)
      finish(false)
      // A replacement starts at the restored homes, never at the cancelled
      // dance's intermediate positions. Invalid calls leave the party alone.
      pets = pets.map(pet => ({ ...pet, x: getPet(pet.id).x, z: getPet(pet.id).z }))
      const minX = Math.min(...pets.map(pet => pet.x)), maxX = Math.max(...pets.map(pet => pet.x))
      const travel = Math.max(5.5, maxX - minX)
      // The leading pet is first in ids; the tail starts at the leftmost home.
      // Every dancer traverses the full occupied span, including bezel seams.
      pets.forEach((pet, index) => {
        pet.lineX = minX + (pets.length - index - 1) * 1.25
        pet.inward = route(pet, { x: pet.lineX, z: ROAD_Z })
        pet.outward = route({ x: pet.lineX + travel, z: ROAD_Z }, pet)
      })
      return new Promise(resolve => { active = { pets, travel, duration, start, resolve } })
    },
    update(_dt, t) {
      if (disposed || !active || !Number.isFinite(t)) return
      const party = active, age = t - party.start
      if (party.pets.some(pet => !getPet(pet.id))) { finish(false); return }
      if (age < 0) { root.visible = false; return }
      if (age >= party.duration) { finish(true); return }
      const positions = party.pets.map((pet, i) => {
        const point = sample(party, i, age)
        const before = sample(party, i, Math.max(0, age - .005))
        const after = sample(party, i, Math.min(party.duration, age + .005))
        const speed = distance(before, after) / Math.max(.005, Math.min(party.duration, age + .005) - Math.max(0, age - .005))
        const dx = after.x - before.x
        move(pet.id, { ...point, facing: Math.abs(dx) > 1e-5 ? Math.sign(dx) : pet.facing,
          speed, anim: speed > .04 ? 'run' : 'idle', snap: true })
        const envelope = Math.min(clamp((age / party.duration - .15) * 10), clamp((.87 - age / party.duration) * 10))
        const beat = Math.sin(age * TAU * 1.7 - i * .72)
        pose(pet.id, { lift: Math.max(0, beat) * .14 * envelope, rotation: beat * .065 * envelope,
          scaleX: 1, scaleY: 1 })
        return point
      })
      draw(party, age, positions)
    },
    has(id) { return Boolean(active?.pets.some(pet => pet.id === id)) },
    cancel(id) { return active && (id === undefined || active.pets.some(pet => pet.id === id)) ? finish(false) : false },
    dispose() {
      if (disposed) return
      finish(false); disposed = true
      root.removeFromParent()
      geometry.dispose(); material.dispose(); texture.dispose()
      noteMaterials.forEach(item => item.dispose())
    },
  }
}
