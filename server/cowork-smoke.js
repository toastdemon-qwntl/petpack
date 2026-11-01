#!/usr/bin/env node
// Live co-work smoke (owner: L1).
//   node server/cowork-smoke.js [wss://relay/ws]
// In a fresh room: Rex (docked right) joins, then Kit (also docked right, so no auto pairing: like joining minutes
// apart) lands far away. Kit sends seat nextTo 'Rex' and must end up on Rex's LEFT, adjacent, with Rex unmoved, a
// why:'cowork' broadcast carrying cowork [Kit, Rex], and neighbours that say so. Then a left-docked laptop joins and
// is auto co-worked onto Rex's free right side (same venue IP / window).
import WebSocket from 'ws'
import { DEFAULT_RELAY, encode, decode, rid } from '../shared/protocol.js'

const url = process.argv.slice(2).find((a) => a.startsWith('ws')) || process.env.PETPACK_RELAY || DEFAULT_RELAY
const room = rid('cowork-')
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
      }
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
  const rex = await client({ id: rid('rex-'), name: 'Rex', dock: 'right' })
  const kit = await client({ id: rid('kit-'), name: 'Kit', dock: 'right' })
  const rexSeat = rex.welcome.you.seat
  check(kit.welcome.you.seat >= rexSeat + 2 && kit.welcome.neighbours[kit.id].left === null, `far apart first: Rex ${rexSeat}, Kit ${kit.welcome.you.seat}`)

  kit.send({ t: 'seat', op: 'nextTo', target: 'Rex' })
  const s = await rex.next((m) => m.t === 'seat' && m.why === 'cowork', 8000, 'cowork seat')
  check(same(s.cowork, [kit.id, rex.id]), 'why cowork, cowork = [Kit, Rex] (docked right: Kit sits on the left)')
  check(s.seats[kit.id] + 1 === s.seats[rex.id], `adjacent seats: Kit ${s.seats[kit.id]}, Rex ${s.seats[rex.id]}`)
  check(same(s.neighbours[kit.id], { left: null, right: rex.id, across: null }), 'neighbours[Kit] = { right: Rex }')
  check(same(s.neighbours[rex.id], { left: kit.id, right: null, across: null }), 'neighbours[Rex] = { left: Kit }')
  const k2 = await kit.next((m) => m.t === 'seat' && m.why === 'cowork', 8000, 'cowork at Kit')
  check(same(k2.cowork, s.cowork), 'both panes get the cowork broadcast')

  const lou = await client({ id: rid('lou-'), name: 'Lou', dock: 'left' })
  const d = await rex.next((m) => m.t === 'seat' && m.why === 'dock', 8000, 'auto co-work')
  check(same(d.cowork, [rex.id, lou.id]) && d.seats[lou.id] === d.seats[rex.id] + 1, 'a left-docked laptop auto co-works onto Rex\'s right')
  check(same(lou.welcome.neighbours[rex.id], { left: kit.id, right: lou.id, across: null }), 'welcome neighbours: Kit | Rex | Lou')
  for (const c of [rex, kit, lou]) c.ws.close()
  console.log(`PASS co-work smoke in ${ms()}`)
}

main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1) })
