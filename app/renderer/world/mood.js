/**
 * attachMood(world) -> the same world. Additive, opt-in; no story/DOM changes.
 * sleep(id, boolean=true) -> boolean; curled rest, then a stretch and yawn.
 * weather(id, 'rain'|'rainbow'|null) -> boolean; rainbow lasts 4.8 shared seconds.
 * setHat(id, 0..5) -> boolean; none, sprout, cap, scholar, wizard, crown.
 * arrive(id, 'balloon') -> Promise<boolean>; 5.4-second arrival, false on cancellation.
 * conga(ids, { durationS=12, startAt }) -> Promise<boolean>; startAt is seconds in
 * the same clock passed to createWorld/renderFrame. Send identical events/clock
 * to all panes. Call after positioning pets. Conga and arrivals temporarily own
 * motion; latest external position is resumed afterward. Sleep holds position.
 * moodSnapshot() -> read-only visual state, useful to an integrating director.
 * disposeMood() detaches just this decorator; world.dispose/resetEffects/removePet
 * also clean up/cancel it. Repeated attach is harmless. Weather is explicit:
 * integration chooses which failures deserve rain and which successes a rainbow.
 */
import * as THREE from 'three'
import { createMoodArt } from './cast-mood-art.js'
import { createParty } from './party.js'

const attached = new WeakMap()
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v))
// Closed-form critically damped spring, normalized to arrive exactly at duration.
function ease(t) { t = clamp(t); return (1 - (1 + 7 * t) * Math.exp(-7 * t)) / (1 - 8 * Math.exp(-7)) }
const phase = x => x - Math.floor(x)
const finite = Number.isFinite

export function attachMood(world) {
  if (attached.has(world)) return world
  const { stage, map } = world
  if (!stage?.scene || typeof world.snapshot !== 'function') throw new TypeError('attachMood needs a petpack World')
  const art = createMoodArt(), actors = new Map()
  const root = new THREE.Group(); root.name = 'Petpack moods'; stage.scene.add(root)
  const up = new THREE.Vector3(), right = new THREE.Vector3(), toward = new THREE.Vector3()
  let time = 0, clockReady = false, pendingParty = null, disposed = false, snapshots = new Map()
  const originals = {}
  const installed = {}
  const updateStage = stage.update
  const rawMove = world.updatePet
  // Commands can follow a snap in the same turn, before a renderer tick.
  const read = id => world.snapshot().find(p => p.id === id)
  const findAnchor = id => stage.scene.children.find(o => o.userData.petpackId === id)

  function actor(id) {
    if (disposed) return null
    let a = actors.get(id)
    const anchor = findAnchor(id)
    if (!anchor || !read(id) || !anchor.visible) return null
    if (a && a.anchor !== anchor) { clearActor(a); actors.delete(id); a = null }
    if (!a) {
      const group = new THREE.Group(); group.name = `Mood of ${String(id)}`; root.add(group)
      a = { id, anchor, group, hat: 0, hatAt: -100, sleeping: false, sleepAt: -100, wakeAt: -100,
        weather: null, weatherAt: -100, arrival: null, queued: null, pose: {}, sprite: null }
      actors.set(id, a)
    }
    const sprite = anchor.children.flatMap(o => o.children).find(o => o.isSprite && o.name === 'Pixel billboard')
    if (sprite && a.sprite !== sprite) {
      restoreSprite(a)
      a.sprite = sprite
      a.base = { x: sprite.scale.x, y: sprite.scale.y, rotation: sprite.material.rotation }
    }
    return a
  }
  function restoreSprite(a) {
    if (!a.sprite || !a.base) return
    a.sprite.scale.x = a.base.x; a.sprite.scale.y = a.base.y
    a.sprite.material.rotation = a.base.rotation
    a.sprite.position.y -= a.appliedLift || 0
    a.appliedLift = 0
  }
  function stamp(a, key, width, options) {
    const s = art.sprite(key, width, options); a.group.add(s); return s
  }
  function move(id, state) {
    rawMove.call(world, id, state)
    const current = world.snapshot().find(p => p.id === id)
    if (current) snapshots.set(id, current)
    const a = actors.get(id)
    if (a?.sprite && state.anim) {
      a.sprite.userData.petpackSample?.({ anim: state.anim, facing: state.facing,
        phase: ((state.x || 0) + (state.z || 0)) / 1.25, elapsed: 0 })
    }
  }
  function applyPose(id, pose) {
    const a = actor(id)
    if (a) a.pose = { ...a.pose, ...pose }
  }
  const party = createParty({ scene: root, getPet: id => read(id) || null, move,
    pose: applyPose, ground: (x, z) => map.ground(x, z), clock: () => time })
  function cancelPending(id) {
    if (pendingParty && (id === undefined || pendingParty.ids.includes(id))) {
      pendingParty.resolve(false); pendingParty = null
    }
  }
  function held(a) { return a.sleeping || !!a.arrival || party.has(a.id) || !!pendingParty?.ids.includes(a.id) }
  function releaseMotion(a) {
    if (!held(a) && a.queued) { const queued = a.queued; a.queued = null; rawMove.call(world, a.id, queued) }
  }
  function settleArrival(a, completed = false) {
    if (!a.arrival) return
    const arrival = a.arrival; a.arrival = null
    if (a.balloon) { art.release(a.balloon); a.balloon = null }
    a.anchor.position.y = map.ground(a.anchor.position.x, a.anchor.position.z)
    arrival.resolve(completed)
    releaseMotion(a)
  }
  function sleep(id, enabled = true) {
    const a = actor(id)
    if (!a) return false
    if (!!enabled === a.sleeping) return true
    cancelPending(id); party.cancel(id); settleArrival(a)
    a.sleeping = !!enabled
    const p = read(id)
    if (a.sleeping) {
      a.sleepAt = time; a.home = { x: p.x, z: p.z }
      rawMove.call(world, id, { ...a.home, snap: true, anim: 'review', speed: 0 })
      a.zzz ||= Array.from({ length: 3 }, () => stamp(a, 'z', .2))
    } else {
      a.wakeAt = time
      rawMove.call(world, id, { anim: 'idle' })
      a.yawn ||= stamp(a, 'yawn', .24)
      releaseMotion(a)
    }
    return true
  }
  function weather(id, value) {
    const a = actor(id)
    if (!a || ![null, 'rain', 'rainbow'].includes(value)) return false
    if (value === a.weather) return true
    a.weather = value; a.weatherAt = time
    if (value === 'rain') {
      a.cloud ||= stamp(a, 'cloud', 1.65)
      a.drops ||= Array.from({ length: 9 }, () => stamp(a, 'drop', .055))
      if (!a.puddle) { a.puddle = art.puddle(); a.group.add(a.puddle) }
      a.rainEnd = null
    } else a.rainEnd = time
    if (value === 'rainbow') a.rainbow ||= stamp(a, 'rainbow', 2.55, { base: true })
    return true
  }
  function setHat(id, level) {
    const a = actor(id)
    if (!a || !Number.isInteger(level) || level < 0 || level > 5) return false
    if (a.hat === level) return true
    if (a.hatSprite) { art.release(a.hatSprite); a.hatSprite = null }
    const upgraded = level > a.hat
    a.hat = level
    if (level) {
      a.hatSprite = stamp(a, `hat${level}`, level === 4 ? .86 : .8, { base: true })
      // Art sheets have transparent bottom margins: place their visible brim on
      // the measured head, not the bottom of the padded texture.
      a.hatSprite.center.y = (16 - (level === 4 ? 14 : level === 3 ? 14 : level === 1 ? 14 : 15)) / 16
    }
    if (upgraded) {
      a.hatAt = time
      a.stars ||= Array.from({ length: 5 }, () => stamp(a, 'star', .15))
    }
    return true
  }
  function arrive(id, mode = 'balloon') {
    const a = actor(id)
    if (!a || mode !== 'balloon') return Promise.resolve(false)
    cancelPending(id); party.cancel(id); settleArrival(a)
    a.sleeping = false
    const p = read(id)
    rawMove.call(world, id, { x: p.x, z: p.z, snap: true, speed: 0, anim: 'wave' })
    a.balloon = stamp(a, 'balloon', 2.55, { base: true })
    return new Promise(resolve => { a.arrival = { at: time, x: p.x, z: p.z, resolve } })
  }
  function conga(ids, options) {
    if (disposed || !Array.isArray(ids)) return Promise.resolve(false)
    if (options != null && (typeof options !== 'object' ||
      (options.durationS !== undefined && (!finite(options.durationS) || options.durationS <= 0)) ||
      (options.startAt !== undefined && !finite(options.startAt)))) return Promise.resolve(false)
    options ||= {}
    const unique = [...new Set(ids)]
    if (unique.length < 2 || unique.some(id => !actor(id))) return Promise.resolve(false)
    cancelPending()
    if (!clockReady && options?.startAt === undefined) {
      return new Promise(resolve => { pendingParty = { ids: unique, options, resolve } })
    }
    for (const id of unique) {
      const a = actor(id); settleArrival(a); a.sleeping = false
      rawMove.call(world, id, { anim: 'idle' })
    }
    return party.start(unique, options).then(result => {
      for (const id of unique) { const a = actors.get(id); if (a) releaseMotion(a) }
      return result
    })
  }

  function position(sprite, x, y, depth = .03) {
    sprite.position.copy(right).multiplyScalar(x).addScaledVector(up, y).addScaledVector(toward, depth)
  }
  function paint(a, t) {
    const sprite = a.sprite
    if (!sprite) return
    const asleep = a.sleeping ? ease((t - a.sleepAt) / .85) : 0
    const wake = t - a.wakeAt
    const waking = !a.sleeping && wake >= 0 && wake < 1.8
    const stretch = waking ? Math.sin(Math.PI * clamp(wake / 1.8)) : 0
    const curl = a.sleeping ? asleep : waking ? 1 - ease(wake / .7) : 0
    const p = a.pose
    const sx = (1 + curl * .13 - stretch * .10) * (p.scaleX ?? 1)
    const sy = (1 - curl * .43 + stretch * .17) * (p.scaleY ?? 1)
    const rotation = curl * .4 * (read(a.id)?.facing || 1) + (p.rotation || 0)
    sprite.scale.set(a.base.x * sx, a.base.y * sy, 1)
    sprite.material.rotation = a.base.rotation + rotation
    const breath = a.sleeping ? Math.sin((t - a.sleepAt) * 1.9) * .022 : 0
    const lift = (p.lift || 0) + breath
    // The cast resets its sprite lift every frame. Only mood-owned offsets are
    // removed during detach; no absolute writes to another lane's root pose.
    sprite.position.y += lift
    a.appliedLift = lift
    const head = sprite.userData.petpackHead || { x: 0, y: 2 }
    const hx = head.x * sx * Math.cos(rotation) - head.y * sy * Math.sin(rotation)
    const hy = head.x * sx * Math.sin(rotation) + head.y * sy * Math.cos(rotation)
    a.group.position.copy(a.anchor.position)
    a.group.position.y += sprite.position.y
    a.group.visible = a.anchor.visible

    if (a.hatSprite) {
      a.hatSprite.visible = curl < .12
      position(a.hatSprite, hx, hy - .035, .075)
      a.hatSprite.material.rotation = rotation
    }
    a.stars?.forEach((star, i) => {
      const age = t - a.hatAt, k = age / 1.15
      star.visible = k >= 0 && k < 1 && curl < .12
      position(star, hx + Math.cos(i * 2.4) * (.26 + k * .65), hy + .3 + Math.sin(i * 2.4) * (.25 + k * .55))
      star.material.opacity = clamp(1 - k)
    })
    a.zzz?.forEach((z, i) => {
      z.visible = a.sleeping && asleep > .75
      const k = phase((t - a.sleepAt) / 3.8 - i / 3)
      position(z, .4 + k * .6 + Math.sin(k * Math.PI) * .16, 1.05 + k * 1.3)
      z.scale.setScalar(.14 + k * .13)
      z.material.opacity = Math.sin(k * Math.PI) * .85
    })
    if (a.yawn) { a.yawn.visible = waking && wake > .4 && wake < 1.2; position(a.yawn, hx, hy - .67, .1) }
    const rain = a.weather === 'rain'
    const rainFade = rain ? ease((t - a.weatherAt) / .65) : a.rainEnd == null ? 0 : 1 - ease((t - a.rainEnd) / .7)
    const cloudY = Math.max(2.1, hy) + .8
    if (a.cloud) {
      a.cloud.visible = rainFade > .01; a.cloud.material.opacity = rainFade
      position(a.cloud, Math.sin(t * 1.3) * .06, cloudY)
    }
    a.drops?.forEach((drop, i) => {
      const k = phase(t * 1.1 + i * .618)
      drop.visible = rainFade > .01
      drop.material.opacity = rainFade * .72
      position(drop, ((i * .381) % 1 - .5) * 1.4, cloudY - .25 - k * (cloudY - .3))
    })
    if (a.puddle) {
      const pool = rain ? ease((t - a.weatherAt) / 2) : a.rainEnd == null ? 0 : 1 - ease((t - a.rainEnd) / 2.4)
      a.puddle.visible = pool > .01 && !a.arrival
      a.puddle.position.set(0, .04 - sprite.position.y, 0)
      a.puddle.scale.setScalar(.55 + pool * .45); a.puddle.material.opacity = pool * .5
    }
    if (a.rainbow) {
      const age = t - a.weatherAt
      const envelope = a.weather === 'rainbow' ? ease(age / .6) * (1 - ease((age - 2.8) / 2)) : 0
      a.rainbow.visible = envelope > .01
      position(a.rainbow, 0, Math.max(2.1, hy) + .18)
      a.rainbow.material.opacity = envelope * .92
      if (a.weather === 'rainbow' && age >= 4.8) a.weather = null
    }
    a.pose = {}
  }
  function advance(dt, t) {
    if (disposed) return
    if (!clockReady && finite(t)) {
      for (const a of actors.values()) {
        for (const key of ['hatAt', 'sleepAt', 'wakeAt', 'weatherAt']) if (a[key] !== -100) a[key] += t
        if (a.rainEnd != null) a.rainEnd += t
        if (a.arrival) a.arrival.at += t
      }
      time = t; clockReady = true
      if (pendingParty) { const task = pendingParty; pendingParty = null; conga(task.ids, task.options).then(task.resolve) }
    }
    if (finite(t)) time = t
    snapshots = new Map(world.snapshot().map(p => [p.id, p]))
    right.set(1, 0, 0).applyQuaternion(stage.camera.quaternion)
    up.set(0, 1, 0).applyQuaternion(stage.camera.quaternion)
    toward.set(0, 0, 1).applyQuaternion(stage.camera.quaternion)
    // Catch atlas replacements (including asynchronous URL loads) before posing.
    for (const a of actors.values()) {
      if (!snapshots.has(a.id) || !findAnchor(a.id)) { party.cancel(a.id); clearActor(a); actors.delete(a.id); continue }
      actor(a.id)
      if (a.sleeping) {
        rawMove.call(world, a.id, { ...a.home, snap: true, speed: 0, anim: 'review' })
        a.sprite?.userData.petpackSample?.({ anim: 'review', elapsed: 0 })
      }
    }
    party.update(dt, time)
    for (const a of actors.values()) {
      if (a.arrival) {
        const flight = a.arrival, age = time - flight.at
        const descent = 5.8 * (1 - ease(age / 3.2))
        const hop = age >= 3.2 && age < 4.15 ? Math.sin((age - 3.2) / .95 * Math.PI) * .43 : 0
        rawMove.call(world, a.id, { x: flight.x, z: flight.z, snap: true, speed: 0, anim: age < 3.2 ? 'wave' : 'idle' })
        a.anchor.position.y += descent + hop
        const departure = ease((age - 3.7) / 1.7)
        position(a.balloon, Math.sin(age * 1.5) * .12 + departure * 1.5, .1 + departure * 6, -.12)
        a.balloon.material.rotation = Math.sin(age * 1.5) * .035
        a.balloon.material.opacity = 1 - departure
        if (age >= 5.4) settleArrival(a, true)
      }
      paint(a, time)
      releaseMotion(a)
    }
  }
  function clearActor(a) {
    const wasSleeping = a.sleeping
    a.sleeping = false
    settleArrival(a)
    if (wasSleeping) rawMove.call(world, a.id, { anim: 'idle' })
    releaseMotion(a)
    restoreSprite(a)
    art.release(a.group)
  }
  function reset() {
    cancelPending()
    party.cancel()
    for (const a of actors.values()) clearActor(a)
    actors.clear(); snapshots.clear()
  }
  function wrap(name, method) {
    originals[name] = world[name]; installed[name] = method; world[name] = method
  }
  function disposeMood() {
    if (disposed) return
    reset(); disposed = true
    party.dispose(); root.removeFromParent(); art.dispose()
    if (stage.update === tickStage) stage.update = updateStage
    for (const [name, method] of Object.entries(installed)) {
      if (world[name] === method) {
        if (originals[name] === undefined) delete world[name]
        else world[name] = originals[name]
      }
    }
    attached.delete(world)
  }
  function tickStage(dt, t) { const result = updateStage.call(stage, dt, t); advance(dt, t); return result }
  stage.update = tickStage
  wrap('sleep', sleep); wrap('weather', weather); wrap('setHat', setHat); wrap('arrive', arrive); wrap('conga', conga)
  wrap('disposeMood', disposeMood)
  wrap('moodSnapshot', () => [...actors.values()].map(a => ({ id: a.id, sleeping: a.sleeping, weather: a.weather, hat: a.hat,
    arriving: !!a.arrival, partying: party.has(a.id), head: a.sprite?.userData.petpackHead ? { ...a.sprite.userData.petpackHead } : null })))
  wrap('updatePet', function(id, state = {}) {
    const a = actors.get(id)
    if (a && held(a)) {
      const { x, z, snap, speed, facing, anim, ...rest } = state
      // Queue motion only: replaying an older task status would erase a newer
      // completion received while the pet was sleeping or arriving.
      const motion = {}
      for (const key of ['x', 'z', 'snap', 'speed', 'facing', 'anim']) if (state[key] !== undefined) motion[key] = state[key]
      if (Object.keys(motion).length) a.queued = { ...a.queued, ...motion }
      if (Object.keys(rest).length) rawMove.call(world, id, rest)
      return
    }
    return rawMove.call(world, id, state)
  })
  wrap('removePet', function(id) {
    cancelPending(id)
    party.cancel(id)
    const a = actors.get(id)
    if (a) { clearActor(a); actors.delete(id); snapshots.delete(id) }
    return originals.removePet.call(world, id)
  })
  wrap('resetEffects', function(...args) { reset(); return originals.resetEffects?.apply(world, args) })
  wrap('dispose', function(...args) { disposeMood(); return originals.dispose.apply(world, args) })
  attached.set(world, { disposeMood })
  return world
}
