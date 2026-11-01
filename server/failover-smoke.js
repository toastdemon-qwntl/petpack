#!/usr/bin/env node
// Live failover smoke (owner: L1). Two clients join one fresh room through the RELAYS list using the net.js
// failover reference; then you stop the primary (az webapp stop), and they must both reconnect to the secondary,
// see each other and exchange state; start the primary again and (with --back) both must move home.
//   node server/failover-smoke.js [--back] [--probe-ms 15000] [--timeout-s 240]
import { createNet } from './net-failover.js'
import { RELAYS, rid } from '../shared/protocol.js'

const args = process.argv.slice(2)
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt }
const back = args.includes('--back')
const probeMs = flag('--probe-ms', 15000)
const timeoutMs = flag('--timeout-s', 240) * 1000
const room = rid('failover-')
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function mk (name) {
  const id = rid(`${name}-`)
  const c = { id, name, peers: new Set(), lastState: new Map(), relay: null }
  c.net = createNet({
    urls: RELAYS, probeMs,
    hello: () => ({ t: 'hello', v: 2, id, room, dock: name === 'mac' ? 'right' : 'left', name, color: '#33aaff' }),
    onMessage: (m) => {
      if (m.t === 'welcome') {
        c.peers = new Set(m.peers.map((p) => p.id)); c.relay = c.net.url
        console.log(`${ts()} ${name} welcome on relay #${c.net.index} ${c.net.url} room ${m.room} peers ${m.peers.length}`)
      } else if (m.t === 'join') c.peers.add(m.peer.id)
      else if (m.t === 'leave') c.peers.delete(m.id)
      else if (m.t === 'state') for (const p of m.pets) c.lastState.set(p.id, { ...p, relay: c.net.index })
    },
    onStatus: (s) => console.log(`${ts()} ${name} ${s}`)
  })
  c.net.connect()
  return c
}

async function until (label, fn) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`)
    await sleep(100)
  }
  console.log(`${ts()} ok  ${label}`)
}

async function together (index) {
  await until(`both online on relay #${index} and see each other`, () =>
    mac.net.connected && win.net.connected && mac.net.index === index && win.net.index === index &&
    mac.peers.has(win.id) && win.peers.has(mac.id))
  const x = Math.round(Math.random() * 1000) / 10
  const tick = setInterval(() => { mac.net.send({ t: 'state', x, z: 0, facing: 1, anim: 'run', status: 'working' }) }, 200)
  await until(`state flows mac -> win on relay #${index}`, () => win.lastState.get(mac.id)?.x === x && win.lastState.get(mac.id)?.relay === index)
  clearInterval(tick)
}

const mac = mk('mac')
const win = mk('win')
try {
  console.log(`room ${room}; relays ${RELAYS.join(' , ')}`)
  await together(0)
  console.log(`${ts()} READY: stop the primary now`)
  await together(1)
  console.log(`${ts()} FAILED OVER: both clients on the secondary`)
  if (back) {
    console.log(`${ts()} start the primary again; clients probe it every ${probeMs} ms`)
    await together(0)
    console.log(`${ts()} BACK: both clients home on the primary`)
  }
  console.log(`PASS failover smoke in ${ts()}`)
  mac.net.close(); win.net.close()
  process.exit(0)
} catch (e) {
  console.error(`FAIL ${e.message}`)
  process.exit(1)
}
