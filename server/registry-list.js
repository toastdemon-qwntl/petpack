#!/usr/bin/env node
// List a room's device registry as a read-only spectator (owner: L1). No secrets: names, ids, seats, times only.
//   node server/registry-list.js [wss://relay/ws] [--room dde-ldn] [--json]
import WebSocket from 'ws'
import { RELAYS, DEFAULT_ROOM, encode, decode } from '../shared/protocol.js'

const args = process.argv.slice(2)
const urls = args.filter((a) => a.startsWith('ws'))
const room = args.includes('--room') ? args[args.indexOf('--room') + 1] : DEFAULT_ROOM
const asJson = args.includes('--json')

function list (url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`${url}: no welcome`)) }, 8000)
    ws.on('error', reject)
    ws.on('open', () => ws.send(encode({ t: 'hello', room, spectator: true })))
    ws.on('message', (d) => {
      const m = decode(d)
      if (m?.t !== 'welcome') return
      clearTimeout(timer); ws.close()
      resolve(m)
    })
  })
}

const out = []
for (const url of urls.length ? urls : RELAYS) {
  try {
    const w = await list(url)
    const agents = (w.agents || []).map((a) => ({ id: a.id, name: a.name, online: a.online, seat: a.seat, lastSeen: new Date(a.lastSeen).toISOString() }))
    out.push({ url, room: w.room, agents })
    if (!asJson) {
      console.log(`${url} room ${w.room}: ${agents.filter((a) => a.online).length} online, ${agents.filter((a) => !a.online).length} napping`)
      for (const a of agents.sort((x, y) => x.lastSeen.localeCompare(y.lastSeen))) console.log(`  ${a.online ? 'ONLINE ' : 'napping'} ${a.lastSeen}  ${a.name.padEnd(16)} ${a.id}  seat ${a.seat}`)
    }
  } catch (e) { console.error(e.message); process.exitCode = 1 }
}
if (asJson) console.log(JSON.stringify(out, null, 2))
