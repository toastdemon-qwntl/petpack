#!/usr/bin/env node
// Live device-registry smoke (owner: L1).
//   node server/registry-smoke.js [wss://relay/ws] [--room code]
// A spectator watches a fresh room. Agent A moves; the same id connects twice more (second pane, MCP overlay):
// each takeover closes the older socket 4409 and resumes A's position, observer B sees no leave/join, and the
// spectator still counts one A. Then A disconnects (B sees it napping in place) and a new session resumes there.
import WebSocket from 'ws'
import { DEFAULT_RELAY, encode, decode, rid } from '../shared/protocol.js'

const args = process.argv.slice(2)
const url = args.find((a) => a.startsWith('ws')) || process.env.PETPACK_RELAY || DEFAULT_RELAY
const room = args.includes('--room') ? args[args.indexOf('--room') + 1] : rid('registry-')
const t0 = Date.now()
const ms = () => `${Date.now() - t0}ms`
const sleep = (n) => new Promise((resolve) => setTimeout(resolve, n))

function client (hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const inbox = []
    const waiters = []
    const c = {
      ws, inbox, closeCode: null,
      send: (m) => ws.send(encode(m)),
      next (pred, timeout = 8000, what = 'message') {
        const i = inbox.findIndex(pred)
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
        return new Promise((res, rej) => {
          const w = { pred, res, timer: setTimeout(() => rej(new Error(`no ${what} within ${timeout} ms`)), timeout) }
          waiters.push(w)
        })
      },
      closed: () => c.closeCode != null ? Promise.resolve(c.closeCode) : new Promise((res) => ws.once('close', (code) => res(code))),
      close () { ws.close(); return c.closed() }
    }
    ws.on('message', (d) => {
      const m = decode(d)
      if (!m) return
      const w = waiters.find((x) => x.pred(m))
      if (w) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.res(m) } else inbox.push(m)
    })
    ws.on('close', (code) => { c.closeCode = code })
    ws.on('error', reject)
    ws.on('open', () => {
      c.send({ t: 'hello', room, dock: 'none', name: 'registry-smoke', color: '#33aaff', status: 'idle', catalog: [], ...hello })
      c.next((m) => m.t === 'welcome', 8000, 'welcome').then((w) => { c.welcome = w; resolve(c) }, reject)
    })
  })
}

const check = (cond, label) => {
  if (!cond) throw new Error(`FAIL ${label}`)
  console.log(`ok  ${label} (${ms()})`)
}

async function main () {
  console.log(`relay ${url} room ${room}`)
  const spec = await client({ spectator: true })
  check(spec.welcome.you.spectator === true && spec.welcome.you.seat === null, 'spectator welcome, no seat')
  const aid = rid('agent-')
  const a1 = await client({ id: aid, x: 0, z: 0, dock: 'right' }) // a real pane (probes leave no trace)
  const b = await client({ id: rid('observer-') })
  check(a1.welcome.you.resumed === false, 'A is new to the registry')
  a1.send({ t: 'state', x: 7.5, z: 1.25, facing: -1, anim: 'run', status: 'working' })
  await b.next((m) => m.t === 'state' && m.pets.some((p) => p.id === aid && p.x === 7.5), 8000, 'A state at B')
  const seen = await spec.next((m) => m.t === 'state' && m.pets.some((p) => p.id === aid && p.x === 7.5), 8000, 'A state at spectator')
  check(!!seen, 'spectator sees A move')

  const a2 = await client({ id: aid, x: 0, z: 0, dock: 'right' }) // a second pane sending its home
  check((await a1.closed()) === 4409, 'first socket closed 4409 replaced')
  check(a2.welcome.you.takeover && a2.welcome.you.resumed && a2.welcome.you.x === 7.5 && a2.welcome.you.z === 1.25, 'second connection takes over and resumes x/z')
  const a3 = await client({ id: aid, dock: 'right' }) // e.g. an MCP-launched overlay
  check((await a2.closed()) === 4409, 'second socket closed 4409 replaced')
  check(a3.welcome.you.resumed && a3.welcome.you.x === 7.5, 'third connection resumes x/z')
  await sleep(300)
  const churn = b.inbox.filter((m) => (m.t === 'leave' && m.id === aid) || (m.t === 'join' && m.peer?.id === aid))
  check(churn.length === 0, 'observer saw no leave/join churn')
  const spec2 = await client({ spectator: true })
  check(spec2.welcome.agents.filter((x) => x.id === aid).length === 1 && spec2.welcome.agents.length === 2, 'registry: exactly one A (2 agents in room)')

  await a3.close()
  const lv = await b.next((m) => m.t === 'leave' && m.id === aid, 8000, 'leave')
  check(lv.away === true && lv.x === 7.5, 'A naps in place when its owner leaves')
  const a4 = await client({ id: aid, x: 0, z: 0, dock: 'right' })
  check(a4.welcome.you.resumed && a4.welcome.you.x === 7.5 && a4.welcome.you.facing === -1, 'next session resumes at the registry position')
  // battleships: two 'across' panes that join together share one seat, the later one flipped
  const p1 = await client({ id: rid('across-'), sit: 'across' })
  const p2 = await client({ id: rid('across-'), sit: 'across' })
  check(p2.welcome.you.flipped === true && p2.welcome.you.seat === p1.welcome.you.seat, `across panes share seat ${p1.welcome.you.seat}, the second flipped`)
  const sm = await spec.next((m) => m.t === 'seat' && m.why === 'across', 8000, 'across seat at spectator')
  check(Object.keys(sm.flipped).length === 1 && sm.across.length === 1, 'spectator sees the across pair')
  for (const c of [a4, b, spec, spec2, p1, p2]) c.ws.close()
  console.log(`PASS registry smoke in ${ms()}`)
}

main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1) })
