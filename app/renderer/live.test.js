// WIDE lane: the chunk streaming that lets a zoomed pane and the live strip show more than seat +-1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { widenEnsure, visibleChunks } from './zoom.js'

function fakeWorld(cameraX = 0, half = 7) {
  const calls = []
  const map = { chunkWidth: 14, ensure(a, b) { calls.push([a, b]) } }
  const stage = { camera: { position: { x: cameraX }, left: -half, right: half } }
  return { world: { map, stage }, map, calls }
}

test('widenEnsure widens the world\'s own seat-1..seat+1 streaming to the zoomed range', () => {
  const { world, map, calls } = fakeWorld(0)
  const original = map.ensure
  const stream = widenEnsure(world)
  stream.update(-3, 4)
  assert.deepEqual(calls.at(-1), [-3, 4])
  map.ensure(-1, 1) // what renderFrame does when the camera centre crosses a chunk
  assert.deepEqual(calls.at(-1), [-3, 4])
  map.ensure(5, 7) // a wider request from the world still wins
  assert.deepEqual(calls.at(-1), [-3, 7])
  const before = calls.length
  stream.update(-3, 4) // unchanged range: no extra work
  assert.equal(calls.length, before)
  stream.dispose()
  assert.equal(map.ensure, original)
  map.ensure(-1, 1)
  assert.deepEqual(calls.at(-1), [-1, 1])
})

test('widenEnsure narrows again on the way home and never drops the camera\'s own chunk', () => {
  const { world, calls } = fakeWorld(28)
  const stream = widenEnsure(world)
  stream.update(-1, 6)
  stream.update(2, 2)
  assert.deepEqual(calls.at(-1), [1, 3])
})

test('visibleChunks reads the chunk range an orthographic camera shows', () => {
  assert.deepEqual(visibleChunks(fakeWorld(0, 7).world.stage), { lo: 0, hi: 0, center: 0, half: 7 })
  const wide = visibleChunks(fakeWorld(14, 35).world.stage)
  assert.equal(wide.lo, -1)
  assert.equal(wide.hi, 3)
  assert.equal(visibleChunks(null), null)
})

test('a world without a map gets a harmless stream', () => {
  const stream = widenEnsure({})
  stream.update(0, 1)
  stream.dispose()
})
