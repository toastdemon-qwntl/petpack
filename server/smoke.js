#!/usr/bin/env node
// Two-client smoke against a live relay (owner: L1).
//   node server/smoke.js [wss://petpack-relay.azurewebsites.net/ws]
// Two ws clients join one fresh room, see each other (welcome/join), exchange state both ways, send a gift
// (target only), and do one ask/answer and one fetch/fetched round trip. Exit 0 on success.
import WebSocket from 'ws'
import { DEFAULT_RELAY, DEFAULT_ROOM, encode, decode, rid } from '../shared/protocol.js'

// --default-room: both clients send no room (like an installed 0.1.0) and must land in DEFAULT_ROOM; they join as
// headless probes (dock 'none', no catalog), so the shared room keeps no trace of them and no laptop pairs with them.
const shared = process.argv.includes('--default-room')
const url = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.PETPACK_RELAY || DEFAULT_RELAY
const room = shared ? null : rid('smoke-')
const t0 = Date.now()
const ms = () => `${Date.now() - t0}ms`

function client (id, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const inbox = []
    const waiters = []
    const c = {
      id,
      send: (m) => ws.send(encode(m)),
      next (pred, timeout = 8000, what = 'message') {
        const i = inbox.findIndex(pred)
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
        return new Promise((res, rej) => {
          const w = { pred, res, timer: setTimeout(() => rej(new Error(`${id}: no ${what} within ${timeout} ms`)), timeout) }
          waiters.push(w)
        })
      },
      close: () => ws.close()
    }
    ws.on('message', (d) => {
      const m = decode(d)
      if (!m) return
      const w = waiters.find((x) => x.pred(m))
      if (w) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.res(m) } else inbox.push(m)
    })
    ws.on('error', reject)
    ws.on('open', () => {
      c.send({ t: 'hello', id, room, seat: null, dock: 'right', name: id, color: '#33aaff', status: 'idle', skills: [], catalog: [], sprite: null, answers: true, ...extra })
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
  const item = { ref: 'memory:smoke', kind: 'memory', title: 'smoke', summary: 'smoke note', bytes: 5, sha: 'smoke1', mtime: Date.now() }
  const mac = await client(rid('mac-'), shared ? { dock: 'none' } : { dock: 'right', catalog: [item] })
  check(shared ? mac.welcome.room === DEFAULT_ROOM : mac.welcome.room === room && mac.welcome.peers.length === 0, `mac welcome in ${mac.welcome.room}`)
  const win = await client(rid('win-'), { dock: shared ? 'none' : 'left' })
  if (shared) check(win.welcome.room === DEFAULT_ROOM, `win welcome in ${win.welcome.room}`)
  check(win.welcome.peers.some((p) => p.id === mac.id), 'win sees mac in welcome')
  const j = await mac.next((m) => m.t === 'join' && m.peer.id === win.id, 8000, 'join')
  check(!!j, 'mac sees win join')
  if (!shared) {
    const dock = await mac.next((m) => m.t === 'seat' && m.why === 'dock', 8000, 'dock link')
    check(dock.links.some(([l, r]) => l === mac.id && r === win.id), 'dock auto-link mac|win')
  }

  // each probe stays inside its own (far-right) chunk, so no real pane draws it
  const mx = mac.welcome.you.seat * 14 + 0.5
  const wx = win.welcome.you.seat * 14 + 0.5
  mac.send({ t: 'state', x: mx, z: -1, facing: 1, anim: 'run', status: 'working' })
  const s1 = await win.next((m) => m.t === 'state' && m.pets.some((p) => p.id === mac.id && p.x === mx), 8000, 'state from mac')
  check(s1.pets.find((p) => p.id === mac.id).status === 'working', 'win gets mac state x/z')
  win.send({ t: 'state', x: wx, z: 0.5, facing: -1, anim: 'idle', status: 'idle' })
  await mac.next((m) => m.t === 'state' && m.pets.some((p) => p.id === win.id && p.x === wx), 8000, 'state from win')
  check(true, 'mac gets win state x/z')

  const skill = { id: 'smoke-skill', name: 'smoke-skill', description: 'a smoke gift', files: [{ path: 'SKILL.md', b64: Buffer.from('---\nname: smoke-skill\ndescription: a smoke gift\n---\n').toString('base64') }] }
  mac.send({ t: 'gift', to: win.id, gid: 'g1', skill })
  const g = await win.next((m) => m.t === 'gift', 8000, 'gift')
  check(g.from === mac.id && g.skill.name === 'smoke-skill' && g.skill.files.length === 1, 'win receives gift from mac')
  if (!shared) {
    win.send({ t: 'fx', kind: 'learned', skill: { id: skill.id, name: skill.name, description: skill.description } })
    const fx = await mac.next((m) => m.t === 'fx' && m.kind === 'learned', 8000, 'learned fx')
    check(fx.from === win.id, 'mac sees learned fx')
  }

  win.send({ t: 'ask', qid: 'q1', to: mac.id, question: 'how do we smoke?', kind: 'memory' })
  const q = await mac.next((m) => m.t === 'ask', 8000, 'ask')
  mac.send({ t: 'answer', qid: q.qid, to: q.from, ok: true, text: 'like this' })
  const a = await win.next((m) => m.t === 'answer', 8000, 'answer')
  check(a.from === mac.id && a.text === 'like this', 'ask/answer round trip')

  win.send({ t: 'fetch', fid: 'f1', owner: mac.id, ref: 'memory:smoke', as: 'text' })
  const f = await mac.next((m) => m.t === 'fetch', 8000, 'fetch')
  mac.send({ t: 'fetched', fid: f.fid, to: f.from, ok: true, sha: 'smoke1', text: 'smoke body' })
  const fd = await win.next((m) => m.t === 'fetched', 8000, 'fetched')
  check(fd.ok && fd.text === 'smoke body', 'fetch/fetched round trip')

  mac.close(); win.close()
  console.log(`PASS two-client smoke in ${ms()}`)
}

main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1) })
