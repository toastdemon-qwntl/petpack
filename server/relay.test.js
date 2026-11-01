// T1 relay (SCOPE-backend.md). node --test server/relay.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import WebSocket from 'ws'
import { createRelay } from './relay.js'
import { DEFAULT_ROOM, SCRATCH_ROOM } from '../shared/protocol.js'

let relay, url
before(async () => {
  relay = createRelay({ port: 0, host: '127.0.0.1', log: process.env.RELAY_LOG ? console.log : () => {}, dataDir: null })
  ;({ url } = await relay.listen())
})
after(() => relay.close())

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function client (hello, wsUrl = url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const inbox = []
    const waiters = []
    const c = {
      ws, inbox, id: hello.id, closeCode: null, welcome: null,
      send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify({ v: 2, ...m })),
      next (pred, ms = 2000) {
        const i = inbox.findIndex(pred)
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
        return new Promise((res, rej) => {
          const w = { pred, res, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`${hello.id}: timed out waiting; inbox: ${inbox.map((x) => x.t + (x.why ? ':' + x.why : '') + (x.peer ? ':' + x.peer.id : '')).join(' ')}`)) }, ms) }
          waiters.push(w)
        })
      },
      async none (pred, ms = 300) {
        await sleep(ms)
        return !inbox.some(pred)
      },
      closed () {
        if (c.closeCode != null) return Promise.resolve(c.closeCode)
        return new Promise((res) => ws.once('close', (code) => res(code)))
      },
      close () { ws.close(); return c.closed() }
    }
    ws.on('message', (d) => {
      const m = JSON.parse(d)
      const w = waiters.find((x) => x.pred(m))
      if (w) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.res(m) } else inbox.push(m)
    })
    ws.on('close', (code) => { c.closeCode = code })
    ws.on('error', reject)
    ws.on('open', () => {
      c.send({ t: 'hello', room: null, seat: null, dock: 'right', name: hello.id, color: '#ff0000', status: 'idle', skills: [], catalog: [], sprite: null, answers: true, ...hello })
      c.next((m) => m.t === 'welcome').then((w) => { c.welcome = w; resolve(c) }, reject)
    })
  })
}

const has = (id) => (m) => m.t === 'state' && m.pets.some((p) => p.id === id)

test('state: x/z batches reach the room, not the sender', async () => {
  const a = await client({ id: 'st-a', room: 'st' })
  const b = await client({ id: 'st-b', room: 'st' })
  assert.equal(b.welcome.peers.length, 1)
  assert.equal(b.welcome.peers[0].id, 'st-a')
  for (let i = 1; i <= 5; i++) a.send({ t: 'state', x: i, z: -1.5, facing: -1, anim: 'run', status: 'working' })
  const m = await b.next(has('st-a'))
  await sleep(250)
  const later = b.inbox.filter(has('st-a'))
  const last = [m, ...later].at(-1).pets.find((p) => p.id === 'st-a')
  assert.deepEqual(last, { id: 'st-a', x: 5, z: -1.5, facing: -1, anim: 'run', status: 'working' })
  assert.ok(1 + later.length < 5, 'five states arrive batched')
  assert.ok(await a.none(has('st-a')), 'sender never gets its own pet')
  await a.close(); await b.close()
})

test('gift and answer go to the target only; an unsolicited answer is dropped', async () => {
  const a = await client({ id: 'ga-a', room: 'ga' })
  const b = await client({ id: 'ga-b', room: 'ga' })
  const c = await client({ id: 'ga-c', room: 'ga' })
  const skill = { id: 'pdf', name: 'pdf', description: 'read pdfs', files: [{ path: 'SKILL.md', b64: 'eA==' }] }
  a.send({ t: 'gift', to: 'ga-b', gid: 'g1', skill })
  const g = await b.next((m) => m.t === 'gift')
  assert.equal(g.from, 'ga-a'); assert.equal(g.gid, 'g1'); assert.deepEqual(g.skill, skill)
  assert.ok(await c.none((m) => m.t === 'gift'))
  assert.ok(await a.none((m) => m.t === 'gift', 0))

  a.send({ t: 'ask', qid: 'q1', to: 'ga-b', question: 'how do I x?', kind: 'skill' })
  const q = await b.next((m) => m.t === 'ask')
  assert.equal(q.from, 'ga-a'); assert.equal(q.question, 'how do I x?')
  assert.ok(await c.none((m) => m.t === 'ask', 50))
  b.send({ t: 'answer', qid: 'q1', to: 'ga-a', ok: true, text: 'like this' })
  const ans = await a.next((m) => m.t === 'answer')
  assert.equal(ans.from, 'ga-b'); assert.equal(ans.text, 'like this'); assert.equal(ans.qid, 'q1')
  c.send({ t: 'answer', qid: 'q1', to: 'ga-a', ok: true, text: 'spoof' })
  c.send({ t: 'answer', qid: 'nope', to: 'ga-a', ok: true, text: 'spoof' })
  b.send({ t: 'answer', qid: 'q1', to: 'ga-a', ok: true, text: 'second' })
  assert.ok(await a.none((m) => m.t === 'answer'), 'unsolicited and repeat answers dropped')
  assert.ok(await c.none((m) => m.t === 'answer', 0))
  await Promise.all([a.close(), b.close(), c.close()])
})

test('catalog is broadcast, and an away catalog appears in welcome', async () => {
  const items = [{ ref: 'skill:pdf', kind: 'skill', title: 'pdf', summary: 'read pdfs', bytes: 10, sha: 's1', mtime: 1 }]
  const a = await client({ id: 'cat-a', room: 'cat' })
  const b = await client({ id: 'cat-b', room: 'cat' })
  a.send({ t: 'catalog', items })
  const m = await b.next((x) => x.t === 'catalog')
  assert.equal(m.id, 'cat-a'); assert.deepEqual(m.items, items)
  await a.close()
  const lv = await b.next((x) => x.t === 'leave')
  assert.equal(lv.id, 'cat-a')
  const d = await client({ id: 'cat-d', room: 'cat' })
  const away = d.welcome.away.find((x) => x.id === 'cat-a')
  assert.ok(away, 'away member listed')
  assert.deepEqual(away.catalog, items)
  assert.ok(away.lastSeen > 0)
  assert.ok(!d.welcome.peers.some((p) => p.id === 'cat-a'))
  await b.close(); await d.close()
})

test('fetch reaches the owner, then is served from cache after the owner leaves', async () => {
  const item = { ref: 'memory:deploy', kind: 'memory', title: 'deploy', summary: 'how we deploy', bytes: 5, sha: 'h1', mtime: 1 }
  const a = await client({ id: 'fe-a', room: 'fe', catalog: [item] })
  const b = await client({ id: 'fe-b', room: 'fe' })
  b.send({ t: 'fetch', fid: 'f1', owner: 'fe-a', ref: 'memory:deploy', as: 'text' })
  const f = await a.next((m) => m.t === 'fetch')
  assert.equal(f.from, 'fe-b'); assert.equal(f.fid, 'f1'); assert.equal(f.ref, 'memory:deploy'); assert.equal(f.as, 'text')
  a.send({ t: 'fetched', fid: 'f1', to: 'fe-b', ok: true, sha: 'h1', text: 'hello' })
  const got = await b.next((m) => m.t === 'fetched')
  assert.equal(got.from, 'fe-a'); assert.equal(got.text, 'hello'); assert.equal(got.ok, true)

  // online owner with a matching sha: the relay answers itself
  b.send({ t: 'fetch', fid: 'f2', owner: 'fe-a', ref: 'memory:deploy', as: 'text' })
  const hit = await b.next((m) => m.t === 'fetched' && m.fid === 'f2')
  assert.equal(hit.cached, true); assert.equal(hit.text, 'hello')
  assert.ok(await a.none((m) => m.t === 'fetch', 100))

  await a.close()
  const c = await client({ id: 'fe-c', room: 'fe' })
  c.send({ t: 'fetch', fid: 'f3', owner: 'fe-a', ref: 'memory:deploy', as: 'text' })
  const cached = await c.next((m) => m.t === 'fetched')
  assert.equal(cached.ok, true); assert.equal(cached.text, 'hello'); assert.equal(cached.cached, true); assert.equal(cached.sha, 'h1')
  c.send({ t: 'fetch', fid: 'f4', owner: 'fe-a', ref: 'memory:other', as: 'text' })
  const miss = await c.next((m) => m.t === 'fetched' && m.fid === 'f4')
  assert.equal(miss.ok, false); assert.equal(miss.reason, 'away'); assert.ok(miss.lastSeen > 0)
  await b.close(); await c.close()
})

test('a dock pair auto-links, right-docked on the left', async () => {
  const mac = await client({ id: 'dk-mac', room: 'dock', dock: 'right' })
  const win = await client({ id: 'dk-win', room: 'dock', dock: 'left' })
  const s = await mac.next((m) => m.t === 'seat' && m.why === 'dock')
  assert.deepEqual(s.links, [['dk-mac', 'dk-win']])
  assert.equal(s.seats['dk-win'], s.seats['dk-mac'] + 1)
  assert.equal(win.welcome.you.seat, s.seats['dk-win'], 'welcome is already final')
  // a third, left-docked laptop does not auto-link (both others are linked)
  const third = await client({ id: 'dk-3', room: 'dock', dock: 'left' })
  const s3 = await mac.next((m) => m.t === 'seat' && m.why === 'join' && 'dk-3' in m.seats)
  assert.deepEqual(s3.links, [['dk-mac', 'dk-win']])
  assert.ok(s3.seats['dk-3'] >= s3.seats['dk-win'] + 2, 'one empty chunk between chains')
  await Promise.all([mac.close(), win.close(), third.close()])
})

test('complementary bumps link; ambiguous bumps do not', async () => {
  const p = await client({ id: 'bp-p', room: 'bump', dock: 'right' })
  const q = await client({ id: 'bp-q', room: 'bump', dock: 'right' })
  q.send({ t: 'seat', op: 'bump', side: 'left' })
  await sleep(40)
  p.send({ t: 'seat', op: 'bump', side: 'right' })
  const s = await p.next((m) => m.t === 'seat' && m.why === 'cowork') // bump follows the nextTo rule
  assert.deepEqual(s.links, [['bp-p', 'bp-q']])
  assert.equal(s.seats['bp-q'], s.seats['bp-p'] + 1)
  assert.ok(!s.shrug); assert.deepEqual(s.cowork, ['bp-p', 'bp-q']); assert.equal(s.via, 'bump')
  assert.deepEqual(s.neighbours['bp-p'], { left: null, right: 'bp-q', across: null })

  const x = await client({ id: 'am-x', room: 'amb', dock: 'right' })
  const y = await client({ id: 'am-y', room: 'amb', dock: 'right' })
  const z = await client({ id: 'am-z', room: 'amb', dock: 'right' })
  x.send({ t: 'seat', op: 'bump', side: 'right' })
  y.send({ t: 'seat', op: 'bump', side: 'right' })
  await sleep(40)
  z.send({ t: 'seat', op: 'bump', side: 'left' })
  const sh = await z.next((m) => m.t === 'seat' && m.why === 'bump')
  assert.equal(sh.shrug, true)
  assert.deepEqual(sh.links, [])
  assert.deepEqual(new Set(sh.ids), new Set(['am-x', 'am-y', 'am-z']))
  await Promise.all([p.close(), q.close(), x.close(), y.close(), z.close()])
})

test('arrow move swaps into a seat and links neighbours', async () => {
  const a = await client({ id: 'mv-a', room: 'mv', dock: 'right' })
  const b = await client({ id: 'mv-b', room: 'mv', dock: 'right' })
  assert.equal(b.welcome.you.seat, a.welcome.you.seat + 2)
  b.send({ t: 'seat', op: 'move', to: a.welcome.you.seat + 1 })
  const s = await a.next((m) => m.t === 'seat' && m.why === 'move')
  assert.equal(s.seats['mv-b'], s.seats['mv-a'] + 1)
  assert.deepEqual(s.links, [['mv-a', 'mv-b']])
  b.send({ t: 'seat', op: 'unlink' })
  const u = await a.next((m) => m.t === 'seat' && m.why === 'unlink')
  assert.deepEqual(u.links, [])
  assert.equal(u.seats['mv-b'], u.seats['mv-a'] + 2)
  await a.close(); await b.close()
})

test('a seat is held after leave', async () => {
  const a = await client({ id: 'hd-a', room: 'held' })
  const seat = a.welcome.you.seat
  await a.close()
  const b = await client({ id: 'hd-b', room: 'held' })
  assert.notEqual(b.welcome.you.seat, seat)
  assert.equal(b.welcome.held['hd-a'], seat)
  const a2 = await client({ id: 'hd-a', room: 'held' })
  assert.equal(a2.welcome.you.seat, seat)
  await a2.close(); await b.close()
})

test('a huge frame closes only that socket', async () => {
  const a = await client({ id: 'big-a', room: 'big' })
  const b = await client({ id: 'big-b', room: 'big' })
  const c = await client({ id: 'big-c', room: 'big' })
  a.send(JSON.stringify({ t: 'fx', kind: 'say', text: 'x'.repeat(5 * 1024 * 1024) }))
  assert.equal(await a.closed(), 4413)
  b.send({ t: 'state', x: 3, z: 1, facing: 1, anim: 'idle', status: 'idle' })
  const m = await c.next(has('big-b'))
  assert.equal(m.pets.find((p) => p.id === 'big-b').x, 3)
  const bad = await client({ id: 'big-d', room: 'big' })
  bad.send('not json')
  assert.equal(await bad.closed(), 4400)
  await b.close(); await c.close()
})

test('sprite uploads once and is served by hash; healthz is 200', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const a = await client({ id: 'sp-a', room: 'sp', sprite: { sha: 'x', b64: png.toString('base64') } })
  const b = await client({ id: 'sp-b', room: 'sp' })
  const peer = b.welcome.peers.find((p) => p.id === 'sp-a')
  assert.match(peer.sprite, /\/s\/[a-f0-9]{64}\.webp$/)
  const res = await fetch(peer.sprite)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png)
  const sha = peer.sprite.match(/([a-f0-9]{64})/)[1]
  const c = await client({ id: 'sp-c', room: 'sp', sprite: { sha } })
  const j = await b.next((m) => m.t === 'join' && m.peer.id === 'sp-c')
  assert.equal(j.peer.sprite, peer.sprite)
  const h = await fetch(url.replace('ws:', 'http:').replace('/ws', '/healthz'))
  assert.equal(h.status, 200)
  assert.equal((await h.json()).ok, true)
  await Promise.all([a.close(), b.close(), c.close()])
})

test('fx goes to the room except the sender; learned adds the skill', async () => {
  const a = await client({ id: 'fx-a', room: 'fx' })
  const b = await client({ id: 'fx-b', room: 'fx' })
  a.send({ t: 'fx', kind: 'learned', skill: { id: 'pdf', name: 'pdf', description: 'read pdfs' } })
  const f = await b.next((m) => m.t === 'fx')
  assert.equal(f.from, 'fx-a'); assert.equal(f.kind, 'learned')
  assert.ok(await a.none((m) => m.t === 'fx', 100))
  const c = await client({ id: 'fx-c', room: 'fx' })
  assert.deepEqual(c.welcome.peers.find((p) => p.id === 'fx-a').skills, [{ id: 'pdf', name: 'pdf', description: 'read pdfs' }])
  await Promise.all([a.close(), b.close(), c.close()])
})

test('catalogs, seats, fetched content and sprites survive a restart', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-relay-'))
  const item = { ref: 'skill:deploy', kind: 'skill', title: 'deploy', summary: 'ship it', bytes: 5, sha: 'd1', mtime: 1 }
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const r1 = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir, saveMs: 20 })
  const u1 = (await r1.listen()).url
  const a = await client({ id: 'ps-a', room: 'persist', catalog: [item], sprite: { b64: png.toString('base64') } }, u1)
  const b = await client({ id: 'ps-b', room: 'persist', dock: 'left' }, u1)
  b.send({ t: 'fetch', fid: 'f1', owner: 'ps-a', ref: 'skill:deploy', as: 'pkg' })
  const f = await a.next((m) => m.t === 'fetch')
  a.send({ t: 'fetched', fid: f.fid, to: f.from, ok: true, sha: 'd1', pkg: { files: [{ path: 'SKILL.md', b64: 'eA==' }] } })
  await b.next((m) => m.t === 'fetched')
  const seatA = (await b.next((m) => m.t === 'seat' && m.why === 'dock')).seats['ps-a']
  await sleep(50)
  await r1.close()
  assert.ok(fs.existsSync(path.join(dataDir, 'rooms.json')))

  const r2 = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir, saveMs: 20 })
  const u2 = (await r2.listen()).url
  const c = await client({ id: 'ps-c', room: 'persist' }, u2)
  const away = c.welcome.away.find((x) => x.id === 'ps-a')
  assert.deepEqual(away?.catalog, [item])
  assert.deepEqual(c.welcome.links, [['ps-a', 'ps-b']], 'links held across the restart')
  c.send({ t: 'fetch', fid: 'f2', owner: 'ps-a', ref: 'skill:deploy', as: 'pkg' })
  const hit = await c.next((m) => m.t === 'fetched')
  assert.equal(hit.ok, true); assert.equal(hit.cached, true); assert.deepEqual(hit.pkg.files[0].path, 'SKILL.md')
  const a2 = await client({ id: 'ps-a', room: 'persist', sprite: null }, u2)
  assert.equal(a2.welcome.you.seat, seatA, 'seat held across the restart')
  const sha = crypto.createHash('sha256').update(png).digest('hex')
  const res = await fetch(u2.replace('ws:', 'http:').replace('/ws', `/s/${sha}.webp`))
  assert.equal(res.status, 200)
  await Promise.all([a.closed(), b.closed(), c.close(), a2.close()])
  await r2.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('clients fail over to the next relay together and move back when the primary returns', async () => {
  const { createNet } = await import('./net-failover.js')
  const quiet = { host: '127.0.0.1', log: () => {}, dataDir: null }
  let r1 = createRelay({ port: 0, ...quiet })
  const { port: p1, url: u1 } = await r1.listen()
  const r2 = createRelay({ port: 0, ...quiet })
  const { url: u2 } = await r2.listen()
  const mk = (id) => {
    const seen = []
    const net = createNet({
      urls: [u1, u2], hello: () => ({ t: 'hello', v: 2, id, room: 'fo', dock: 'right' }), onMessage: (m) => seen.push(m),
      probeMs: 200, openTimeoutMs: 1000, random: () => 0
    })
    net.connect()
    return { net, seen }
  }
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(25) } }
  const a = mk('fo-a'); const b = mk('fo-b')
  await until(() => a.net.connected && b.net.connected)
  assert.equal(a.net.index, 0); assert.equal(b.net.index, 0)

  await r1.close() // primary goes away
  await until(() => a.net.connected && b.net.connected && a.net.index === 1 && b.net.index === 1)
  assert.equal(a.net.url, u2)
  await until(() => [...r2.rooms.get('fo')?.members.values() ?? []].filter((m) => m.online).length === 2)

  r1 = createRelay({ port: p1, ...quiet }) // primary is back: both probe it and move home
  await r1.listen()
  await until(() => a.net.connected && b.net.connected && a.net.index === 0 && b.net.index === 0)
  await until(() => [...r1.rooms.get('fo')?.members.values() ?? []].filter((m) => m.online).length === 2)
  a.net.close(); b.net.close()
  await r1.close(); await r2.close()
})

test('no room, a legacy auto room and an explicit dde-ldn all land in the one room; an explicit code wins', async () => {
  const a = await client({ id: 'ur-a', room: null, dock: 'right' })
  const b = await client({ id: 'ur-b', room: 'net-3ba5f34a', dock: 'right' })
  const c = await client({ id: 'ur-c', room: 'DDE-LDN', dock: 'right' })
  const d = await client({ id: 'ur-d', room: 'team-rex', dock: 'none' })
  assert.equal(DEFAULT_ROOM, 'dde-ldn')
  for (const x of [a, b, c]) assert.equal(x.welcome.room, DEFAULT_ROOM)
  assert.ok(c.welcome.peers.some((p) => p.id === 'ur-a') && c.welcome.peers.some((p) => p.id === 'ur-b'))
  assert.equal(d.welcome.room, 'team-rex')
  assert.equal(d.welcome.peers.length, 0)
  // test clients (a probe, test: true, a test --profile) never land in the shared room: they get the scratch room
  const p = await client({ id: 'ur-p', room: null, dock: 'none' })
  const q = await client({ id: 'ur-q', room: 'dde-ldn', dock: 'right', test: true })
  const s1 = await client({ id: 'ur-s1', room: null, dock: 'left', profile: 's1-pack' })
  for (const x of [p, q, s1]) assert.equal(x.welcome.room, SCRATCH_ROOM)
  const real = await client({ id: 'ur-real', room: null, dock: 'right', profile: 'work' })
  assert.equal(real.welcome.room, DEFAULT_ROOM)
  assert.ok(!real.welcome.agents.some((x) => ['ur-p', 'ur-q', 'ur-s1'].includes(x.id)))
  await p.close()
  const e = await client({ id: 'ur-e', room: null, dock: 'none' })
  assert.ok(!e.welcome.away.some((x) => x.id === 'ur-p'), 'a headless probe leaves nothing behind')
  await Promise.all([a.close(), q.close(), s1.close(), real.close()])
  await Promise.all([b.close(), c.close(), d.close(), e.close()])
})

test('busy room: dock auto-link pairs the most recent opposite dock within the window', async () => {
  const r = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir: null, dockPairWindowMs: 300, sameIpCowork: false })
  const u = (await r.listen()).url
  const r1 = await client({ id: 'bz-r1', room: null, dock: 'right' }, u)
  await sleep(30)
  const r2 = await client({ id: 'bz-r2', room: null, dock: 'right' }, u)
  await sleep(30)
  const l1 = await client({ id: 'bz-l1', room: null, dock: 'left' }, u)
  const s = await r1.next((m) => m.t === 'seat' && m.why === 'dock')
  assert.deepEqual(s.links, [['bz-r2', 'bz-l1']], 'most recent right-docked laptop wins')
  assert.equal(s.seats['bz-l1'], s.seats['bz-r2'] + 1)
  await sleep(400) // r1 is now outside the window
  const l2 = await client({ id: 'bz-l2', room: null, dock: 'left' }, u)
  assert.deepEqual(l2.welcome.links, [['bz-r2', 'bz-l1']], 'nobody fresh to pair with: a free seat at the end')
  const maxSeat = Math.max(...Object.values(l2.welcome.seats))
  assert.equal(l2.welcome.you.seat, maxSeat)
  const r3 = await client({ id: 'bz-r3', room: null, dock: 'right' }, u)
  const s3 = await r1.next((m) => m.t === 'seat' && m.why === 'dock' && m.links.length === 2)
  assert.deepEqual(s3.links, [['bz-r2', 'bz-l1'], ['bz-r3', 'bz-l2']])
  assert.equal(s3.seats['bz-l2'], s3.seats['bz-r3'] + 1)
  assert.equal(r3.welcome.room, DEFAULT_ROOM)
  await Promise.all([r1.close(), r2.close(), l1.close(), l2.close(), r3.close()])
  await r.close()
})

test('never duplicated: the same id again takes the agent over, no leave/join churn, the old client stops', async () => {
  const { createNet } = await import('./net-failover.js')
  const b = await client({ id: 'dup-b', room: 'dup' })
  const statuses = []
  const old = createNet({ urls: [url], hello: () => ({ t: 'hello', v: 2, id: 'dup-a', room: 'dup', name: 'Rex' }), onStatus: (s) => statuses.push(s), random: () => 0 })
  old.connect()
  await b.next((m) => m.t === 'join' && m.peer.id === 'dup-a')
  while (!old.connected) await sleep(10) // its welcome may land just after b sees the join
  old.send({ t: 'state', x: 9.5, z: 1.25, facing: -1, anim: 'run', status: 'working' })
  await b.next(has('dup-a'))
  const second = await client({ id: 'dup-a', room: 'dup', x: 0, z: 0 }) // e.g. a second pane, sending its home
  assert.equal(second.welcome.you.takeover, true)
  assert.equal(second.welcome.you.resumed, true)
  assert.deepEqual([second.welcome.you.x, second.welcome.you.z, second.welcome.you.facing], [9.5, 1.25, -1])
  const third = await client({ id: 'dup-a', room: 'dup' }) // e.g. an MCP-launched overlay
  assert.equal(await second.closed(), 4409)
  await sleep(1500) // longer than the old client's first reconnect delay
  assert.equal(old.status, 'replaced'); assert.ok(!old.connected, 'the replaced client does not fight back')
  assert.ok(await b.none((m) => (m.t === 'leave' || m.t === 'join') && (m.id === 'dup-a' || m.peer?.id === 'dup-a'), 50), 'no churn')
  const room = relay.rooms.get('dup')
  assert.equal([...room.members.values()].filter((m) => m.id === 'dup-a').length, 1)
  assert.equal([...room.members.values()].filter((m) => m.online).length, 2, 'one live agent per id')
  await third.close(); await b.close(); old.close()
})

test('absolute positions: an agent naps where it stopped and resumes there next session', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-registry-'))
  let r = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir, saveMs: 20, posSaveMs: 20 })
  let u = (await r.listen()).url
  const a = await client({ id: 'pos-a', room: 'pos', x: 0, z: 0 }, u)
  const b = await client({ id: 'pos-b', room: 'pos' }, u)
  assert.equal(a.welcome.you.resumed, false)
  a.send({ t: 'state', x: 23.5, z: -2, facing: -1, anim: 'run', status: 'working' })
  await b.next(has('pos-a'))
  await a.close()
  const lv = await b.next((m) => m.t === 'leave' && m.id === 'pos-a')
  assert.deepEqual([lv.away, lv.x, lv.z], [true, 23.5, -2])
  const nap = await b.next((m) => m.t === 'state' && m.pets.some((p) => p.id === 'pos-a' && p.away))
  assert.equal(nap.pets.find((p) => p.id === 'pos-a').x, 23.5)
  const c = await client({ id: 'pos-c', room: 'pos' }, u)
  const ag = c.welcome.agents.find((x) => x.id === 'pos-a')
  assert.deepEqual([ag.away, ag.online, ag.x, ag.z, ag.facing], [true, false, 23.5, -2, -1])
  assert.equal(c.welcome.away.find((x) => x.id === 'pos-a').x, 23.5)
  await b.close(); await c.close()
  await sleep(50)
  await r.close() // a relay restart in between: the registry is on disk
  r = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir })
  u = (await r.listen()).url
  const a2 = await client({ id: 'pos-a', room: 'pos', x: 0, z: 0 }, u) // its client sends home; the registry wins
  assert.equal(a2.welcome.you.resumed, true)
  assert.deepEqual([a2.welcome.you.x, a2.welcome.you.z, a2.welcome.you.facing], [23.5, -2, -1])
  await a2.close(); await r.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('a spectator sees every agent on every seat, read-only, with no seat', async () => {
  const r = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir: null, chunkFilterAbove: 1 })
  const u = (await r.listen()).url
  const a = await client({ id: 'sp-1', room: null }, u)
  const b = await client({ id: 'sp-2', room: null }, u)
  const s = await client({ id: 'ignored', room: null, spectator: true }, u)
  assert.equal(s.welcome.room, DEFAULT_ROOM)
  assert.equal(s.welcome.you.spectator, true); assert.equal(s.welcome.you.seat, null)
  assert.deepEqual(new Set(s.welcome.agents.map((x) => x.id)), new Set(['sp-1', 'sp-2']))
  assert.ok(!('ignored' in s.welcome.seats))
  assert.ok(await a.none((m) => m.t === 'join' && m.peer.id !== 'sp-2', 100), 'a spectator is not an agent: no join')
  a.send({ t: 'state', x: 140, z: 0, facing: 1, anim: 'run', status: 'idle' }) // chunk 10: filtered for b, not for s
  const st = await s.next(has('sp-1'))
  assert.equal(st.pets.find((p) => p.id === 'sp-1').x, 140)
  b.send({ t: 'fx', kind: 'wave' })
  assert.equal((await s.next((m) => m.t === 'fx')).from, 'sp-2')
  s.send({ t: 'state', x: 1, z: 1, facing: 1, anim: 'run', status: 'idle' })
  s.send({ t: 'fx', kind: 'say', text: 'hi' })
  assert.ok(await b.none((m) => m.t === 'fx' && m.kind === 'say', 200), 'spectators send nothing')
  const h = await (await fetch(u.replace('ws:', 'http:').replace('/ws', '/healthz'))).json()
  assert.equal(h.online, 2); assert.equal(h.spectators, 1)
  await b.close()
  const lv = await s.next((m) => m.t === 'leave' && m.id === 'sp-2')
  assert.equal(lv.away, true)
  await Promise.all([a.close(), s.close()])
  await r.close()
})

test("battleships: two 'across' panes share one seat, the later one flipped; side panes are unaffected", async () => {
  const r = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir: null, dockPairWindowMs: 300, sameIpCowork: false })
  const u = (await r.listen()).url
  const side = await client({ id: 'ac-side', room: 'across', dock: 'left' }, u)
  await sleep(400) // the side pane is out of the window (and no same-IP inference here)
  const a = await client({ id: 'ac-a', room: 'across', sit: 'across', dock: 'right' }, u)
  const b = await client({ id: 'ac-b', room: 'across', sit: 'across', dock: 'left' }, u)
  const s = await a.next((m) => m.t === 'seat' && m.why === 'across')
  assert.equal(s.seats['ac-a'], s.seats['ac-b'], 'one seat for the pair')
  assert.deepEqual(s.flipped, { 'ac-b': true })
  assert.deepEqual(s.across, [['ac-a', 'ac-b']])
  assert.equal(b.welcome.you.flipped, true); assert.equal(b.welcome.you.seat, s.seats['ac-a'])
  assert.deepEqual(s.links, [], 'across panes never dock-link with the side pane')
  assert.notEqual(s.seats['ac-side'], s.seats['ac-a'])

  // a third across pane outside the window gets its own seat; "share seat N facing the other way" via arrows fails
  // on a seat that already has a pair, and works on a lone seat
  await sleep(400)
  const c = await client({ id: 'ac-c', room: 'across', sit: 'across' }, u)
  assert.equal(c.welcome.you.flipped, false)
  c.send({ t: 'seat', op: 'move', to: s.seats['ac-a'], flip: true })
  const shrug = await c.next((m) => m.t === 'seat' && m.why === 'move')
  assert.ok(!shrug.flipped['ac-c'], 'a full pair takes no third pane')
  c.send({ t: 'seat', op: 'share', to: s.seats['ac-side'] })
  const shared = await c.next((m) => m.t === 'seat' && m.why === 'move' && m.flipped['ac-c'])
  assert.equal(shared.seats['ac-c'], shared.seats['ac-side'])

  // a plain sit that contradicts the pair is corrected (pair kept); only an explicit unlink splits it
  b.send({ t: 'sit', sit: 'side' })
  const fix = await b.next((m) => m.t === 'sit' && m.corrected)
  assert.equal(fix.sit, 'across')
  b.send({ t: 'sit', sit: 'side', unlink: true }) // switching back to side for real: the flipped pane gets its own seat
  const back = await a.next((m) => m.t === 'seat' && m.why === 'sit')
  assert.ok(!back.flipped['ac-b']); assert.notEqual(back.seats['ac-b'], back.seats['ac-a'])
  assert.deepEqual(back.across, [['ac-side', 'ac-c']])
  await Promise.all([side.close(), a.close(), b.close(), c.close()])
  await r.close()
})

test('co-work: nextTo seats me beside the target on my dock side, the target stays; full when both sides are taken', async () => {
  // joined far apart (window 50 ms, no same-IP fallback): no auto pairing, so they start far apart
  const r = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir: null, dockPairWindowMs: 50, sameIpCowork: false })
  const u = (await r.listen()).url
  const mac = await client({ id: 'cw-mac', room: 'cowork', dock: 'left', name: 'Rex' }, u)
  await sleep(100)
  const x1 = await client({ id: 'cw-x1', room: 'cowork', dock: 'right' }, u)
  await sleep(100)
  const win = await client({ id: 'cw-win', room: 'cowork', dock: 'right' }, u)
  const macSeat = mac.welcome.you.seat
  assert.ok(win.welcome.you.seat > macSeat + 1, 'far apart before co-working')
  win.send({ t: 'seat', op: 'nextTo', target: 'rex' }) // by name; docked right -> I sit LEFT of Rex
  const s = await mac.next((m) => m.t === 'seat' && m.why === 'cowork')
  assert.deepEqual(s.cowork, ['cw-win', 'cw-mac'])
  assert.equal(s.seats['cw-win'] + 1, s.seats['cw-mac'])
  assert.deepEqual(s.neighbours['cw-win'], { left: null, right: 'cw-mac', across: null })
  assert.deepEqual(s.neighbours['cw-mac'], { left: 'cw-win', right: null, across: null })
  assert.ok(Math.abs(s.seats['cw-x1'] - s.seats['cw-mac']) >= 2 || s.seats['cw-x1'] < s.seats['cw-win'] - 1, 'others keep an empty chunk')

  // x1 (docked right) wants Rex's left too: taken by win -> it takes Rex's right side instead
  x1.send({ t: 'seat', op: 'nextTo', target: 'cw-mac' })
  const s2 = await mac.next((m) => m.t === 'seat' && m.why === 'cowork' && m.cowork?.includes('cw-x1'))
  assert.deepEqual(s2.cowork, ['cw-mac', 'cw-x1'])
  assert.deepEqual(s2.neighbours['cw-mac'], { left: 'cw-win', right: 'cw-x1', across: null })
  assert.equal(s2.seats['cw-x1'], s2.seats['cw-mac'] + 1)

  // a floating fourth pane: both sides of Rex are taken by co-workers -> nearest free seat, why 'full'
  const f = await client({ id: 'cw-f', room: 'cowork', dock: 'none' }, u)
  f.send({ t: 'seat', op: 'nextTo', target: 'cw-mac' })
  const full = await mac.next((m) => m.t === 'seat' && m.why === 'full')
  assert.deepEqual(full.ids, ['cw-f', 'cw-mac'])
  assert.equal(full.neighbours['cw-f'].left, null); assert.equal(full.neighbours['cw-f'].right, null)
  const taken = Object.entries(full.seats).filter(([id]) => id !== 'cw-f').map(([, v]) => v)
  assert.ok(taken.every((v) => Math.abs(v - full.seats['cw-f']) >= 2), 'an empty chunk around the full fallback')
  f.send({ t: 'seat', op: 'nextTo', target: 'nobody-here' })
  const miss = await f.next((m) => m.t === 'seat' && m.shrug)
  assert.equal(miss.reason, 'not found')
  await Promise.all([mac.close(), x1.close(), win.close(), f.close()])
  await r.close()
})

test('auto co-work: opposite docks on the same public IP pair even outside the window', async () => {
  const r = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir: null, dockPairWindowMs: 50 })
  const u = (await r.listen()).url
  const a = await client({ id: 'ip-a', room: 'nat', dock: 'right' }, u)
  await sleep(150) // outside the window; same IP (127.0.0.1) as the venue NAT
  const b = await client({ id: 'ip-b', room: 'nat', dock: 'left' }, u)
  const s = await a.next((m) => m.t === 'seat' && m.why === 'dock')
  assert.deepEqual(s.cowork, ['ip-a', 'ip-b'])
  assert.equal(s.seats['ip-b'], s.seats['ip-a'] + 1)
  assert.equal(s.seats['ip-a'], a.welcome.you.seat, 'the earlier laptop stays put')
  assert.deepEqual(b.welcome.neighbours['ip-b'], { left: 'ip-a', right: null, across: null })
  await Promise.all([a.close(), b.close()])
  await r.close()
})

test('layout: one source of truth, monotonic version, heartbeat heals a missed update, pairs agree, reconnect keeps it', async () => {
  const r = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir: null, layoutHeartbeatMs: 150 })
  const u = (await r.listen()).url
  const a = await client({ id: 'ly-a', room: 'layout', dock: 'right', sit: 'side' }, u)
  assert.ok(a.welcome.layout.v > 0 && a.welcome.layout.seats['ly-a'] === a.welcome.you.seat, 'welcome carries the full layout')
  const v0 = a.welcome.layout.v
  // B docks face to face on the same IP and sits across: they pair, the initiator's across wins, A is corrected
  const b = await client({ id: 'ly-b', room: 'layout', dock: 'left', sit: 'across' }, u)
  const l1 = await a.next((m) => m.t === 'layout' && !m.beat && m.seats['ly-b'] !== undefined)
  assert.ok(l1.v > v0, 'version goes up')
  assert.deepEqual(l1.flipped, { 'ly-b': true }); assert.deepEqual(l1.across, [['ly-a', 'ly-b']])
  assert.deepEqual(l1.sits, { 'ly-a': 'across', 'ly-b': 'across' }, 'the pair agrees')
  assert.equal(l1.seats['ly-a'], l1.seats['ly-b'])
  const fix = await a.next((m) => m.t === 'sit' && m.corrected)
  assert.equal(fix.sit, 'across')
  assert.equal(b.welcome.layout.v, l1.v); assert.equal(b.welcome.you.flipped, true)

  // A contradicts its pair: corrected, not split
  a.send({ t: 'sit', sit: 'side' })
  assert.equal((await a.next((m) => m.t === 'sit' && m.corrected)).sit, 'across')

  // C joins: A "misses" that layout; the heartbeat shows a different v, A asks layout? and heals
  const c = await client({ id: 'ly-c', room: 'layout', dock: 'right' }, u)
  const missed = await a.next((m) => m.t === 'layout' && !m.beat && m.seats['ly-c'] !== undefined) // dropped on purpose
  const beat = await a.next((m) => m.t === 'layout' && m.beat && m.v === missed.v)
  assert.ok(beat.v > l1.v && beat.seats === undefined, 'a heartbeat carries only v')
  a.send({ t: 'layout?' })
  const healed = await a.next((m) => m.t === 'layout' && !m.beat && m.v === beat.v)
  assert.deepEqual(healed.seats, missed.seats)

  // reconnect: B drops and returns (its saved sit even says side): same seat, still flipped, still across
  await b.close()
  const b2 = await client({ id: 'ly-b', room: 'layout', dock: 'left', sit: 'side' }, u)
  assert.equal(b2.welcome.you.seat, healed.seats['ly-a']); assert.equal(b2.welcome.you.flipped, true)
  assert.equal(b2.welcome.you.sit, 'across'); assert.equal(b2.welcome.you.sitCorrected, true)
  assert.ok(b2.welcome.layout.v > healed.v)
  const vs = [v0, l1.v, missed.v, b2.welcome.layout.v]
  assert.deepEqual([...vs].sort((x, y) => x - y), vs, 'monotonic')
  await Promise.all([a.close(), b2.close(), c.close()])
  await r.close()
})

test('a legacy per-network room on disk folds into the one room as away members', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-legacy-'))
  const item = { ref: 'skill:pdf', kind: 'skill', title: 'pdf', summary: 'read pdfs', bytes: 1, sha: 'p1', mtime: 1 }
  fs.writeFileSync(path.join(dataDir, 'rooms.json'), JSON.stringify({
    v: 1, rooms: [{ name: 'net-0123abcd', links: [], members: [{ id: 'lg-a', name: 'Rex', color: '#fff', dock: 'right', skills: [], catalog: [item], seat: 0, lastSeen: Date.now() }] },
      { name: 'dde-ldn', links: [], members: [{ id: '4faf1f36-d56f-4101-aea9-7d475950daee', name: 'Dot', dock: 'right', catalog: [], seat: null, lastSeen: Date.now() }] }]
  }))
  const r = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, dataDir })
  const u = (await r.listen()).url
  const c = await client({ id: 'lg-c', room: null, dock: 'right' }, u)
  assert.deepEqual(c.welcome.away.find((x) => x.id === 'lg-a')?.catalog, [item])
  assert.ok(!r.rooms.has('net-0123abcd'))
  assert.ok(!c.welcome.agents.some((x) => x.name === 'Dot'), 'purged devbox test agents stay gone')
  await c.close(); await r.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
