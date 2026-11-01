#!/usr/bin/env node
// Live layout smoke (owner: L1).
//   node server/layout-smoke.js [wss://relay/ws]
// Fresh room: A (side, docked right) then B (across, docked left) on the same IP pair up as battleships: one seat,
// B flipped, both 'across' (A gets a corrective sit) in one layout version. A's contradicting sit is corrected, the
// 10 s heartbeat carries v, layout? returns the same full layout, and B reconnecting keeps seat, flip and sit.
import WebSocket from 'ws'
import { DEFAULT_RELAY, encode, decode, rid } from '../shared/protocol.js'

const url = process.argv.slice(2).find((a) => a.startsWith('ws')) || process.env.PETPACK_RELAY || DEFAULT_RELAY
const room = rid('layout-')
const t0 = Date.now()
const ms = () => `${Date.now() - t0}ms`

function client (hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const inbox = []
    const waiters = []
    const c = {
      ws, id: hello.id,
      send: (m) => ws.send(encode(m)),
      next (pred, timeout = 8000, what = 'message') {
        const i = inbox.findIndex(pred)
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
        return new Promise((res, rej) => {
          const w = { pred, res, timer: setTimeout(() => rej(new Error(`no ${what} within ${timeout} ms`)), timeout) }
          waiters.push(w)
        })
      },
      closed: () => new Promise((res) => ws.once('close', res))
    }
    ws.on('message', (d) => {
      const m = decode(d)
      if (!m) return
      const w = waiters.find((x) => x.pred(m))
      if (w) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.res(m) } else inbox.push(m)
    })
    ws.on('error', reject)
    ws.on('open', () => {
      c.send({ t: 'hello', room, color: '#33aaff', status: 'idle', catalog: [], test: true, ...hello })
      c.next((m) => m.t === 'welcome', 8000, 'welcome').then((w) => { c.welcome = w; resolve(c) }, reject)
    })
  })
}

const check = (cond, label) => {
  if (!cond) throw new Error(`FAIL ${label}`)
  console.log(`ok  ${label} (${ms()})`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function main () {
  console.log(`relay ${url} room ${room}`)
  const aId = rid('a-'); const bId = rid('b-')
  const a = await client({ id: aId, dock: 'right', sit: 'side' })
  check(a.welcome.layout?.v > 0, `welcome carries the layout (v ${a.welcome.layout?.v})`)
  const b = await client({ id: bId, dock: 'left', sit: 'across' })
  const l = await a.next((m) => m.t === 'layout' && !m.beat && m.seats[bId] !== undefined, 8000, 'layout')
  check(l.v > a.welcome.layout.v, `layout v went up to ${l.v}`)
  check(l.seats[aId] === l.seats[bId] && same(l.flipped, { [bId]: true }) && same(l.across, [[aId, bId]]), `one seat (${l.seats[aId]}), B flipped`)
  check(same(l.sits, { [aId]: 'across', [bId]: 'across' }), 'the pair agrees: both across (inferred from B)')
  check((await a.next((m) => m.t === 'sit' && m.corrected, 8000, 'corrective sit')).sit === 'across', 'A got a corrective sit')
  a.send({ t: 'sit', sit: 'side' })
  check((await a.next((m) => m.t === 'sit' && m.corrected, 8000, 'corrective sit')).sit === 'across', "A's contradicting sit corrected, pair kept")
  const beat = await a.next((m) => m.t === 'layout' && m.beat, 12000, 'heartbeat')
  check(beat.v === l.v && beat.seats === undefined, `10 s heartbeat carries only v (${beat.v})`)
  a.send({ t: 'layout?' })
  const full = await a.next((m) => m.t === 'layout' && !m.beat, 8000, 'layout reply')
  check(full.v === l.v && same(full.seats, l.seats), 'layout? returns the full layout at the same v')
  b.ws.close(); await b.closed()
  const b2 = await client({ id: bId, dock: 'left', sit: 'side' })
  check(b2.welcome.you.seat === l.seats[aId] && b2.welcome.you.flipped === true && b2.welcome.you.sit === 'across', 'B reconnects: same seat, still flipped, still across')
  for (const c of [a, b2]) c.ws.close()
  console.log(`PASS layout smoke in ${ms()}`)
}

main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1) })
