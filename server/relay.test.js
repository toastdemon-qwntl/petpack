// T1 relay (SCOPE-backend.md). node --test server/relay.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import WebSocket from 'ws'
import { createRelay } from './relay.js'

let relay, url
before(async () => {
  relay = createRelay({ port: 0, host: '127.0.0.1', salt: 'test', log: () => {} })
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
          const w = { pred, res, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`${hello.id}: timed out waiting`)) }, ms) }
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
  const s = await p.next((m) => m.t === 'seat' && m.why === 'bump')
  assert.deepEqual(s.links, [['bp-p', 'bp-q']])
  assert.equal(s.seats['bp-q'], s.seats['bp-p'] + 1)
  assert.ok(!s.shrug)

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
  const r1 = createRelay({ port: 0, host: '127.0.0.1', salt: 'test', log: () => {}, dataDir, saveMs: 20 })
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

  const r2 = createRelay({ port: 0, host: '127.0.0.1', salt: 'test', log: () => {}, dataDir, saveMs: 20 })
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
  const quiet = { host: '127.0.0.1', salt: 'test', log: () => {}, dataDir: null }
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

test('auto room groups clients by network', async () => {
  const a = await client({ id: 'ar-a', room: null })
  const b = await client({ id: 'ar-b', room: null })
  assert.match(a.welcome.room, /^net-[a-f0-9]{8}$/)
  assert.equal(a.welcome.room, b.welcome.room)
  await a.close(); await b.close()
})
