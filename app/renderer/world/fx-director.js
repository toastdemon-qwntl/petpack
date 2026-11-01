// Short, interruptible moments borrow a pet's route, then give it back to its
// latest caller. All timing is simulation time, shared by neighbouring panes.
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const finite = Number.isFinite

export function createJoyDirector({ pets, map, moments, move, status, seat }) {
  const leases = new Map(), meetings = new Map(), jumps = new Map(), celebrations = new Map()
  let disposed = false
  const width = map.chunkWidth || 14
  function borrow(pet, owner) {
    const saved = { x: pet.target?.x ?? pet.x, z: pet.target?.z ?? pet.z, ...pet.state }
    const lease = { pet, owner, saved, returning: false }
    leases.set(pet.id, lease)
    return lease
  }
  function restore(lease) {
    if (leases.get(lease.pet.id) !== lease) return
    leases.delete(lease.pet.id)
    if (pets.get(lease.pet.id) === lease.pet) {
      move(lease.pet.id, { ...lease.saved, snap: false, speed: undefined })
      status(lease.pet.id, lease.saved.status || 'idle')
    }
  }
  function goHome(lease) {
    lease.returning = true
    move(lease.pet.id, { ...lease.saved, snap: false, speed: undefined })
  }
  function finish(meeting, result) {
    meetings.delete(meeting.key)
    for (const lease of meeting.leases) restore(lease)
    if (!result) meeting.bridge.cancel()
    meeting.resolve(result)
  }
  function jump(id) {
    const pet = pets.get(id)
    if (!pet) return
    pet.character.pop()
    jumps.set(id, .85)
  }
  return {
    capture(id, state) {
      const lease = leases.get(id)
      if (!lease) return false
      Object.assign(lease.saved, state)
      // Returning follows the latest requested destination without teleporting.
      if (lease.returning) move(id, { ...state, snap: false, speed: undefined, facing: undefined })
      return true
    },
    pose(id) {
      const lease = leases.get(id)
      if (jumps.has(id)) return { anim: 'jump' }
      if (lease?.owner === 'knock' && !lease.returning && lease.arrived) {
        return { anim: lease.beat < .7 ? 'wave' : 'waiting', facing: 1 }
      }
      return null
    },
    handshake({ seat: source = seat(), side = 'right' } = {}) {
      if (disposed || !finite(source) || !['left', 'right'].includes(side)) return Promise.resolve(false)
      const left = Math.trunc(source) - (side === 'left' ? 1 : 0), key = String(left)
      if (meetings.has(key)) return meetings.get(key).promise
      const x = (left + .5) * width, z = 1.5
      const choose = chunk => [...pets.values()].filter(p => p.positioned && !leases.has(p.id) &&
        Math.floor(p.x / width + .5) === chunk).sort((a, b) => distance(a, { x, z }) - distance(b, { x, z }) || String(a.id).localeCompare(String(b.id)))[0]
      const a = choose(left), b = choose(left + 1)
      if (!a || !b) return Promise.resolve(false)
      let resolve
      const promise = new Promise(done => { resolve = done })
      const bridge = moments.bridge({ x, z, y: map.ground(x, z) })
      const meeting = { key, bridge, promise, resolve, age: 0, phase: 'approach', leases: [] }
      for (const [pet, direction] of [[a, 1], [b, -1]]) {
        const lease = borrow(pet, meeting)
        lease.destination = { x: x - direction * .72, z }
        meeting.leases.push(lease)
        move(pet.id, { ...lease.destination, anim: 'idle', facing: direction, status: 'idle' })
      }
      meetings.set(key, meeting)
      return promise
    },
    knock(id, enabled = true) {
      if (disposed) return false
      const old = leases.get(id)
      if (!enabled) {
        if (old?.owner === 'knock' && !old.returning) goHome(old)
        return !!old && old.owner === 'knock'
      }
      if (old) return old.owner === 'knock'
      const pet = pets.get(id)
      if (!pet?.positioned) return false
      const lease = borrow(pet, 'knock')
      // The open apron reaches the foreground without crossing flower beds.
      const home = Math.round(pet.x / width)
      lease.destination = { x: home * width, z: 4.25 }
      lease.beat = 8; lease.arrived = false; lease.secondTap = false
      move(id, { ...lease.destination, anim: 'waiting', status: 'waiting' })
      return true
    },
    celebrate(id) {
      const pet = pets.get(id)
      if (disposed || !pet?.positioned) return Promise.resolve(false)
      const site = map.landmark(Math.round(pet.x / width))
      jump(id)
      celebrations.get(id)?.cancel()
      const flight = moments.celebrate({ x: site.x, y: map.ground(site.x, site.z) + 3.5,
        z: site.z - 1.7, color: pet.info.color })
      const token = {}
      token.cancel = () => flight.cancel?.()
      celebrations.set(id, token)
      return flight.then(result => {
        if (celebrations.get(id) === token) {
          celebrations.delete(id)
          if (pets.get(id) === pet) status(id, pet.state.status)
        }
        return result
      })
    },
    update(dt) {
      if (disposed) return
      for (const id of celebrations.keys()) status(id, 'idle')
      for (const [id, left] of jumps) { if (left <= dt) jumps.delete(id); else jumps.set(id, left - dt) }
      for (const meeting of meetings.values()) {
        meeting.age += dt
        if (meeting.age > 30) { finish(meeting, false); continue }
        if (meeting.phase === 'approach' && meeting.leases.every(l => distance(l.pet, l.destination) < .07)) {
          meeting.phase = 'touch'; meeting.touchAt = meeting.age
          meeting.bridge.touch()
          for (const lease of meeting.leases) jump(lease.pet.id)
        } else if (meeting.phase === 'touch' && meeting.age - meeting.touchAt > .9) {
          meeting.phase = 'return'; meeting.bridge.finish()
          meeting.leases.forEach(goHome)
        } else if (meeting.phase === 'return' && meeting.leases.every(l => !l.pet.route.length || distance(l.pet, l.saved) < .07)) finish(meeting, true)
      }
      for (const lease of leases.values()) {
        if (lease.owner !== 'knock') continue
        const pet = lease.pet
        if (lease.returning) {
          if (!pet.route.length || distance(pet, lease.saved) < .07) restore(lease)
          continue
        }
        if (!lease.arrived && distance(pet, lease.destination) < .07) lease.arrived = true
        if (!lease.arrived) continue
        status(pet.id, 'waiting')
        lease.beat += dt
        const tap = () => moments.tap({ x: pet.x + .38, y: pet.anchor.position.y + pet.character.height * .57, z: pet.z + .2 })
        if (lease.beat >= 8) {
          lease.beat %= 8; lease.secondTap = true; tap()
        } else if (lease.secondTap && lease.beat >= .27) {
          lease.secondTap = false; tap()
        }
      }
    },
    detach(id) {
      const lease = leases.get(id)
      if (lease?.owner && lease.owner !== 'knock') finish(lease.owner, false)
      else if (lease) restore(lease)
      jumps.delete(id)
      celebrations.get(id)?.cancel()
      celebrations.delete(id)
    },
    reset() {
      for (const meeting of meetings.values()) finish(meeting, false)
      for (const lease of leases.values()) restore(lease)
      for (const id of celebrations.keys()) { const pet = pets.get(id); if (pet) status(id, pet.state.status) }
      celebrations.clear()
      jumps.clear(); moments.reset()
    },
    dispose() { if (disposed) return; this.reset(); disposed = true; moments.dispose() },
  }
}
