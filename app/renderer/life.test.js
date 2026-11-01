import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLife, STATIONS, KINDS, NAP_AFTER_S, CHUNK_W } from './life.js'
import { createTerrain, createStripNavigation } from './world/map-paths.js'

const terrain = createTerrain({ seed: 77, chunkWidth: CHUNK_W })
const nav = createStripNavigation(terrain)
const walkable = p => terrain.isRoad(p.x, p.z) && !terrain.isWater(p.x, p.z)

function reachable(from, goal) {
  const route = nav.path(from, goal)
  const end = route.at(-1)
  return !!end && Math.abs(end.x - goal.x) < 1e-6 && Math.abs(end.z - goal.z) < 1e-6
}

test('working goes to the seat landmark station with its per-kind effect and a progress beat', () => {
  for (let seat = -4; seat <= 4; seat++) {
    const life = createLife({ me: 'pip', seed: 3 })
    const kind = KINDS[((seat % 4) + 4) % 4]
    const a = life.next({ status: 'working', statusSince: 0, now: 5, seat, x: seat * CHUNK_W, z: 1.5 })
    assert.equal(a.kind, kind)
    assert.equal(a.station, STATIONS[kind][0].name)
    assert.ok(Math.abs(a.goal.x - seat * CHUNK_W) <= 2, 'on the landmark apron')
    assert.equal(a.fx.method, 'lifeFx')
    assert.equal(a.fx.args[0], 'pip')
    assert.equal(a.fx.args[1].kind, STATIONS[kind][0].fx)
    assert.equal(a.fx.args[1].progress, true)
    assert.equal(a.durationS, 20)
    // A long task moves to the second station.
    const b = life.next({ status: 'working', statusSince: 0, now: 100, seat, x: a.goal.x, z: a.goal.z })
    assert.equal(b.station, STATIONS[kind][1].name)
  }
})

test('idle activities are cozy, 10-40 s, and never the same twice in a row', () => {
  const life = createLife({ me: 'pip', seed: 11 })
  let prev = null
  const seen = new Set()
  let x = 0, z = 1.5
  for (let i = 0; i < 200; i++) {
    const seat = -1 // the Campfire chunk with a pond: every idle activity is available
    const a = life.next({ status: 'idle', statusSince: i * 30, now: i * 30 + 1, seat, x, z,
      peersHere: [{ id: 'bot', x: seat * CHUNK_W + 2, z: 1.5, status: 'idle' }] })
    assert.notEqual(a.id, prev, `repeat at ${i}`)
    assert.ok(a.durationS >= 10 && a.durationS <= 40, `${a.id} lasts ${a.durationS}`)
    assert.ok(['idle', 'wave', 'review', 'jump'].includes(a.anim))
    seen.add(a.id)
    prev = a.id
    x = a.goal.x; z = a.goal.z
  }
  for (const name of ['bench', 'fish', 'fire', 'lookout', 'chat', 'stretch', 'flowers', 'stroll']) assert.ok(seen.has(name), `saw ${name}`)
})

test('chat faces the idle friend on screen and shows a heart or a note', () => {
  const life = createLife({ me: 'pip', seed: 1 })
  let chat
  for (let i = 0; i < 40 && !chat; i++) {
    const a = life.next({ status: 'idle', statusSince: 0, now: i, seat: 0, x: -3, z: 1.5, peersHere: [{ id: 'kit', x: 2, z: 1.5, status: 'idle' }] })
    if (a.id === 'chat') chat = a
  }
  assert.ok(chat)
  assert.equal(chat.with, 'kit')
  assert.equal(chat.facing, 1)
  assert.ok(Math.abs(Math.abs(chat.goal.x - 2) - 1.05) < 1e-6)
  assert.ok(['heart', 'note'].includes(chat.fx.args[1].kind))
  // Busy or off-screen pets are not chat partners.
  const lone = createLife({ me: 'pip', seed: 1 })
  for (let i = 0; i < 40; i++) {
    const a = lone.next({ status: 'idle', statusSince: 0, now: i, seat: 0, x: 0, z: 1.5,
      peersHere: [{ id: 'busy', x: 1, z: 1.5, status: 'working' }, { id: 'far', x: 30, z: 1.5, status: 'idle' }] })
    assert.notEqual(a.id, 'chat')
  }
})

test('naps after the idle threshold and keeps napping', () => {
  const life = createLife({ me: 'pip', seed: 5 })
  const before = life.next({ status: 'idle', statusSince: 0, now: NAP_AFTER_S - 1, seat: 0, x: 0, z: 1.5 })
  assert.notEqual(before.id, 'nap')
  const nap = life.next({ status: 'idle', statusSince: 0, now: NAP_AFTER_S + 1, seat: 0, x: 0, z: 1.5 })
  assert.equal(nap.id, 'nap')
  assert.deepEqual(nap.fx, { method: 'sleep', args: ['pip', true] })
  assert.equal(life.next({ status: 'idle', statusSince: 0, now: NAP_AFTER_S + 50, seat: 0, x: 0, z: 1.5 }).id, 'nap')
  // When the brain owns the moments, life only walks to the bench.
  const quiet = createLife({ me: 'pip', seed: 5, moments: false })
  const q = quiet.next({ status: 'idle', statusSince: 0, now: 400, seat: 0, x: 0, z: 1.5 })
  assert.equal(q.id, 'nap')
  assert.equal(q.fx, undefined)
})

test('waiting knocks at the front, done celebrates once, failed slumps home and recovers with a rainbow', () => {
  const life = createLife({ me: 'pip', seed: 9 })
  const k1 = life.next({ status: 'waiting', statusSince: 10, now: 10, seat: 1, x: 14, z: 1.5 })
  assert.equal(k1.id, 'knock')
  assert.deepEqual(k1.goal, { x: 14, z: 4.25 })
  assert.deepEqual(k1.fx, { method: 'knock', args: ['pip', true] })
  const k2 = life.next({ status: 'waiting', statusSince: 10, now: 18, seat: 1, x: 14, z: 4.25 })
  assert.equal(k2.id, 'knock')
  assert.equal(k2.fx, undefined, 'one knock per wait')

  const c = life.next({ status: 'done', statusSince: 30, now: 30, seat: 1, x: 14, z: 4.25 })
  assert.equal(c.id, 'celebrate')
  assert.deepEqual(c.fx, { method: 'celebrate', args: ['pip'] })
  const after = life.next({ status: 'done', statusSince: 30, now: 34, seat: 1, x: 14, z: 4.25 })
  assert.notEqual(after.id, 'celebrate')

  const f = life.next({ status: 'failed', statusSince: 50, now: 50, seat: 1, x: 14, z: 1.5 })
  assert.equal(f.id, 'slump-home')
  assert.equal(f.anim, 'failed')
  assert.deepEqual(f.fx, { method: 'weather', args: ['pip', 'rain'] })
  assert.equal(life.next({ status: 'failed', statusSince: 50, now: 64, seat: 1, x: f.goal.x, z: f.goal.z }).fx, undefined)
  const back = life.next({ status: 'working', statusSince: 70, now: 70, seat: 1, x: f.goal.x, z: f.goal.z })
  const rainbow = { method: 'weather', args: ['pip', 'rainbow'] }
  assert.ok(back.fx?.method === 'lifeFx' && JSON.stringify(back.then) === JSON.stringify(rainbow))
})

test('every goal is on a walkable spot that map.path reaches, for every status and seat', () => {
  const statuses = ['idle', 'working', 'waiting', 'done', 'failed']
  for (let seat = -5; seat <= 6; seat++) {
    for (const seed of [1, 2, 3]) {
      const life = createLife({ me: `p${seed}`, seed })
      let pos = { x: seat * CHUNK_W, z: 1.5 }
      for (let i = 0; i < 60; i++) {
        const status = statuses[(i >> 2) % statuses.length]
        const a = life.next({ status, statusSince: Math.floor(i / 4) * 40, now: i * 12 + (i % 7 === 0 ? 300 : 0), seat, ...pos,
          peersHere: [{ id: 'o', x: seat * CHUNK_W + 5.9, z: 2.6, status: 'idle' }] })
        assert.ok(walkable(a.goal), `${a.id} at ${JSON.stringify(a.goal)} is walkable`)
        assert.ok(reachable(pos, a.goal), `${a.id} reachable from ${JSON.stringify(pos)}`)
        assert.equal(Math.floor(a.goal.x / CHUNK_W + 0.5), seat, `${a.id} stays on its own pane`)
        pos = a.goal
      }
    }
  }
})

test('deterministic from seed + time', () => {
  const run = seed => {
    const life = createLife({ me: 'pip', seed })
    const out = []
    for (let i = 0; i < 30; i++) out.push(life.next({ status: i < 10 ? 'working' : 'idle', statusSince: i < 10 ? 0 : 200, now: 200 + i * 20, seat: 2, x: 28, z: 1.5 }))
    return JSON.stringify(out)
  }
  assert.equal(run(4), run(4))
  assert.notEqual(run(4), run(5))
})
