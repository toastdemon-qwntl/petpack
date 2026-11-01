#!/usr/bin/env node
// petpack relay (L1). Node + ws, one process, rooms in memory. Protocol: ../shared/protocol.js (v2).
//
//   node server/relay.js            listens on $PORT (App Service) or 8787
//   GET /healthz                    200 JSON
//   GET /s/<sha>.webp               sprite bytes by sha256 (immutable, CORS open)
//   WS  /ws                         the protocol
//
// Env: PORT, PETPACK_PUBLIC_URL (sprite URL base),
//      PETPACK_DATA (snapshot dir; defaults to /home/data/petpack on App Service, none elsewhere),
//      PETPACK_RELAY_NAME (shown in /healthz). Rooms are per relay: clients fail over in the order of P.RELAYS.

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as P from '../shared/protocol.js'

const HARD_MAX = P.MAX_FRAME * 4 // ws itself closes (1009) above this; between MAX_FRAME and this we close 4413

class Lru {
  constructor (maxBytes, ttlMs, now, onDrop = null) { this.max = maxBytes; this.ttl = ttlMs; this.now = now; this.onDrop = onDrop; this.bytes = 0; this.map = new Map() }
  get (k) {
    const v = this.map.get(k)
    if (!v) return undefined
    if (this.ttl && this.now() - v.at > this.ttl) { this.delete(k); return undefined }
    this.map.delete(k); this.map.set(k, v)
    return v
  }
  delete (k, replacing = false) {
    const v = this.map.get(k)
    if (v) { this.bytes -= v.size; this.map.delete(k); if (!replacing) this.onDrop?.(k, v) }
  }
  set (k, v, size) {
    this.delete(k, true)
    v.size = size; v.at = v.at ?? this.now()
    this.map.set(k, v); this.bytes += size
    while (this.bytes > this.max && this.map.size > 1) this.delete(this.map.keys().next().value)
  }
  get size () { return this.map.size }
}

// ---- persistence: catalogs, seats, fetched content and sprites survive a restart (App Service /home is durable) ----

const keyFile = (k) => crypto.createHash('sha1').update(k).digest('hex') + '.json'

function writeAtomic (file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function defaultDataDir () {
  if (process.env.PETPACK_DATA) return process.env.PETPACK_DATA
  if (process.env.WEBSITE_SITE_NAME) return '/home/data/petpack' // App Service: /home is persistent storage
  return null
}

const str = (v, max = 200, dflt = '') => (typeof v === 'string' ? v.slice(0, max) : dflt)
const num = (v, dflt) => (Number.isFinite(v) ? v : dflt)
const arr = (v) => (Array.isArray(v) ? v : [])

function sniffMime (buf) {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  return 'image/webp'
}

export function createRelay (opts = {}) {
  const cfg = {
    port: opts.port ?? Number(process.env.PORT || 8787),
    host: opts.host,
    dockPairWindowMs: opts.dockPairWindowMs ?? P.DOCK_PAIR_WINDOW_MS,
    publicUrl: opts.publicUrl ?? process.env.PETPACK_PUBLIC_URL ?? null,
    now: opts.now ?? Date.now,
    batchMs: opts.batchMs ?? P.STATE_BATCH_MS,
    bumpWindowMs: opts.bumpWindowMs ?? P.BUMP_WINDOW_MS,
    bumpAmbiguousMs: opts.bumpAmbiguousMs ?? P.BUMP_AMBIGUOUS_MS,
    seatHoldMs: opts.seatHoldMs ?? P.SEAT_HOLD_MS,
    awayTtlMs: opts.awayTtlMs ?? P.AWAY_TTL_MS,
    answerTtlMs: opts.answerTtlMs ?? P.ANSWER_TTL_MS,
    pingMs: opts.pingMs ?? P.PING_MS,
    maxFrame: opts.maxFrame ?? P.MAX_FRAME,
    chunkFilterAbove: opts.chunkFilterAbove ?? P.CHUNK_FILTER_ABOVE,
    log: opts.log ?? ((...a) => console.log(new Date().toISOString(), ...a)),
    dataDir: opts.dataDir !== undefined ? opts.dataDir : defaultDataDir(),
    saveMs: opts.saveMs ?? 1000,
    name: opts.name ?? process.env.PETPACK_RELAY_NAME ?? process.env.WEBSITE_SITE_NAME ?? process.env.CONTAINER_APP_NAME ?? 'local',
    region: opts.region ?? process.env.PETPACK_REGION ?? process.env.REGION_NAME ?? null
  }
  const now = cfg.now
  const startedAt = now()
  const rooms = new Map() // name -> room
  const byId = new Map() // member id -> room name (one live record per id)
  const dirs = cfg.dataDir
    ? { root: cfg.dataDir, cache: path.join(cfg.dataDir, 'cache'), sprites: path.join(cfg.dataDir, 'sprites') }
    : null
  const unlinkQuiet = (file) => fs.unlink(file, () => {})
  const sprites = new Lru(200 * 1024 * 1024, 0, now, dirs && ((k) => unlinkQuiet(path.join(dirs.sprites, k))))
  const fetchCache = new Lru(P.FETCH_CACHE_BYTES, P.AWAY_TTL_MS, now, dirs && ((k) => unlinkQuiet(path.join(dirs.cache, keyFile(k)))))
  const timers = []
  let saveTimer = null
  let closing = false

  function persistSprite (sha, buf) {
    if (!dirs) return
    fs.writeFile(path.join(dirs.sprites, sha), buf, (e) => e && cfg.log('sprite save failed', e.message))
  }
  function persistFetched (key, v) {
    if (!dirs) return
    const body = JSON.stringify({ key, sha: v.sha, text: v.text, pkg: v.pkg, at: v.at })
    fs.writeFile(path.join(dirs.cache, keyFile(key)), body, (e) => e && cfg.log('cache save failed', e.message))
  }
  function markDirty () {
    if (!dirs || saveTimer || closing) return
    saveTimer = setTimeout(() => { saveTimer = null; saveRooms() }, cfg.saveMs)
    saveTimer.unref?.()
  }
  function saveRooms () {
    if (!dirs) return
    clearTimeout(saveTimer); saveTimer = null
    try {
      const data = {
        v: 1, savedAt: now(),
        rooms: [...rooms.values()].map((r) => ({
          name: r.name, links: r.links,
          members: [...r.members.values()].map((m) => ({
            id: m.id, name: m.name, color: m.color, dock: m.dock, skills: m.skills, catalog: m.catalog,
            sprite: m.sprite, seat: m.seat, lastSeen: m.online ? now() : m.lastSeen
          }))
        }))
      }
      writeAtomic(path.join(dirs.root, 'rooms.json'), JSON.stringify(data))
    } catch (e) { cfg.log('rooms save failed', e.message) }
  }
  function load () {
    if (!dirs) return
    try {
      for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
    } catch (e) { cfg.log('data dir unavailable', e.message); return }
    const t = now()
    let nRooms = 0; let nCache = 0; let nSprites = 0
    try {
      const file = path.join(dirs.root, 'rooms.json')
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        // legacy per-network rooms fold into DEFAULT_ROOM as away members (no seats/links), after the real rooms
        const legacy = (r) => P.LEGACY_AUTO_ROOM.test(String(r?.name))
        for (const r of [...arr(data.rooms).filter((x) => !legacy(x)), ...arr(data.rooms).filter(legacy)]) {
          const fold = legacy(r)
          const name = fold ? P.DEFAULT_ROOM : r.name
          const room = getRoom(name)
          for (const s of arr(r.members)) {
            if (!s || typeof s.id !== 'string' || t - (s.lastSeen || 0) > cfg.awayTtlMs || (fold && room.members.has(s.id))) continue
            room.members.set(s.id, {
              id: s.id, name: str(s.name, 64, 'pet'), color: str(s.color, 32, '#7c5cff'), dock: P.DOCKS.includes(s.dock) ? s.dock : 'right',
              skills: arr(s.skills), catalog: arr(s.catalog), sprite: typeof s.sprite === 'string' ? s.sprite : null,
              seat: !fold && Number.isInteger(s.seat) ? s.seat : null, lastSeen: s.lastSeen || t,
              heldUntil: t + cfg.seatHoldMs, // a restart is not their fault: everyone gets a fresh hold
              online: false, ws: null, dirty: false, answers: true, status: 'idle', anim: 'idle', facing: 1,
              x: P.seatCenterX(Number.isInteger(s.seat) ? s.seat : 0), z: 0
            })
            byId.set(s.id, name)
          }
          if (!fold) room.links = arr(r.links).filter((l) => Array.isArray(l) && room.members.has(l[0]) && room.members.has(l[1]))
          if (!room.members.size) rooms.delete(name); else if (!fold) nRooms++
        }
      }
    } catch (e) { cfg.log('rooms load failed', e.message) }
    try {
      for (const f of fs.readdirSync(dirs.cache)) {
        try {
          const v = JSON.parse(fs.readFileSync(path.join(dirs.cache, f), 'utf8'))
          if (!v.key || t - (v.at || 0) > cfg.awayTtlMs) { unlinkQuiet(path.join(dirs.cache, f)); continue }
          const size = (typeof v.text === 'string' ? v.text.length : 0) + (v.pkg ? JSON.stringify(v.pkg).length : 0) + 64
          fetchCache.set(v.key, { sha: v.sha ?? null, text: v.text, pkg: v.pkg, at: v.at }, size)
          nCache++
        } catch { unlinkQuiet(path.join(dirs.cache, f)) }
      }
      for (const f of fs.readdirSync(dirs.sprites)) {
        if (!/^[a-f0-9]{64}$/.test(f)) continue
        const buf = fs.readFileSync(path.join(dirs.sprites, f))
        sprites.set(f, { buf, mime: sniffMime(buf) }, buf.length)
        nSprites++
      }
    } catch (e) { cfg.log('cache load failed', e.message) }
    cfg.log(`loaded ${nRooms} rooms, ${nCache} cached items, ${nSprites} sprites from ${dirs.root}`)
  }

  // ---- rooms and members -----------------------------------------------------------------------------------------

  function getRoom (name) {
    let r = rooms.get(name)
    if (!r) {
      r = { name, members: new Map(), links: [], bumps: [], fetches: new Map(), asks: new Map() }
      rooms.set(name, r)
    }
    return r
  }

  const online = (room) => [...room.members.values()].filter((m) => m.online)
  const seated = (room) => [...room.members.values()].filter((m) => m.seat != null)

  function peerView (m) {
    return {
      id: m.id, name: m.name, color: m.color, seat: m.seat, dock: m.dock, skills: m.skills, catalog: m.catalog,
      sprite: m.sprite, x: m.x, z: m.z, facing: m.facing, anim: m.anim, status: m.status, answers: m.answers
    }
  }

  function send (m, msg) {
    if (!m || !m.ws || m.ws.readyState !== 1) return
    m.ws.send(typeof msg === 'string' ? msg : P.encode(msg))
  }

  function broadcast (room, msg, exceptId = null) {
    const data = P.encode(msg)
    for (const m of room.members.values()) if (m.online && m.id !== exceptId) send(m, data)
  }

  // ---- seats: chains of linked laptops, one empty chunk between chains, never compacted ---------------------------

  const rightOf = (room, id) => room.links.find(([a]) => a === id)?.[1] ?? null
  const leftOf = (room, id) => room.links.find(([, b]) => b === id)?.[0] ?? null

  function chain (room, id) {
    let s = id
    const seen = new Set([s])
    for (let l = leftOf(room, s); l && !seen.has(l); l = leftOf(room, s)) { s = l; seen.add(l) }
    const out = [s]
    for (let r = rightOf(room, s); r && !out.includes(r); r = rightOf(room, out.at(-1))) out.push(r)
    return out
  }

  function layout (room) {
    const done = new Set()
    const chains = []
    for (const m of seated(room).sort((a, b) => a.seat - b.seat)) {
      if (done.has(m.id)) continue
      const c = chain(room, m.id).map((id) => room.members.get(id)).filter((x) => x && x.seat != null)
      for (const x of c) done.add(x.id)
      if (!c.some((x) => x.id === m.id)) { c.push(m); done.add(m.id) }
      chains.push(c)
    }
    chains.sort((a, b) => a[0].seat - b[0].seat)
    let next = 0
    for (const c of chains) {
      const start = Math.max(c[0].seat, next)
      c.forEach((m, i) => { m.seat = start + i })
      next = start + c.length + 1
    }
  }

  function link (room, l, r) {
    if (!l || !r || l === r) return false
    if (chain(room, l).includes(r)) return false
    room.links = room.links.filter(([a, b]) => a !== l && b !== r)
    const L = room.members.get(l)
    chain(room, r).forEach((id, i) => { room.members.get(id).seat = L.seat + 1 + i })
    room.links.push([l, r])
    layout(room)
    return true
  }

  function adjLink (room, m) {
    const s = seated(room)
    const left = s.find((x) => x.seat === m.seat - 1)
    const right = s.find((x) => x.seat === m.seat + 1)
    if (left && !rightOf(room, left.id) && !leftOf(room, m.id) && !chain(room, left.id).includes(m.id)) room.links.push([left.id, m.id])
    if (right && !leftOf(room, right.id) && !rightOf(room, m.id) && !chain(room, m.id).includes(right.id)) room.links.push([m.id, right.id])
  }

  function unlinkAll (room, id) {
    const before = room.links.length
    room.links = room.links.filter(([a, b]) => a !== id && b !== id)
    return room.links.length !== before
  }

  function seatMsg (room, why, extra = {}) {
    const seats = {}
    const held = {}
    for (const m of seated(room)) (m.online ? seats : held)[m.id] = m.seat
    return { t: 'seat', seats, held, links: room.links.map((l) => [...l]), why, ...extra }
  }

  function snapshot (room) { return JSON.stringify([seated(room).map((m) => [m.id, m.seat]), room.links]) }

  // One busy room: a laptop that just joined (or re-docked) pairs with the most recent unlinked laptop docked to the
  // opposite edge that joined within dockPairWindowMs of it; the right-docked one sits on the left. Anyone else keeps
  // a free seat at the end of the strip and can move with arrows or bump.
  function dockAutoLink (room, m) {
    const loose = (x) => x.online && x.seat != null && !room.links.some(([a, b]) => a === x.id || b === x.id)
    if (!m || !loose(m) || (m.dock !== 'left' && m.dock !== 'right')) return false
    const want = m.dock === 'right' ? 'left' : 'right'
    const partner = online(room)
      .filter((x) => x.id !== m.id && x.dock === want && loose(x) && Math.abs((m.dockAt ?? 0) - (x.dockAt ?? 0)) <= cfg.dockPairWindowMs)
      .sort((a, b) => (b.dockAt ?? 0) - (a.dockAt ?? 0))[0]
    if (!partner) return false
    return m.dock === 'right' ? link(room, m.id, partner.id) : link(room, partner.id, m.id)
  }

  function bump (room, m, side) {
    const t = now()
    room.bumps = room.bumps.filter((b) => t - b.at <= cfg.bumpWindowMs && b.id !== m.id && room.members.get(b.id)?.online)
    const want = side === 'right' ? 'left' : 'right'
    const cands = room.bumps.filter((b) => b.side === want).sort((a, b) => (t - a.at) - (t - b.at))
    if (!cands.length) {
      const entry = { id: m.id, side, at: t }
      room.bumps.push(entry)
      const timer = setTimeout(() => {
        const i = room.bumps.indexOf(entry)
        if (i < 0) return
        room.bumps.splice(i, 1)
        broadcast(room, seatMsg(room, 'bump', { ids: [m.id], shrug: true }))
      }, cfg.bumpWindowMs + 10)
      timer.unref?.()
      return
    }
    if (cands.length > 1 && (t - cands[1].at) - (t - cands[0].at) < cfg.bumpAmbiguousMs) {
      room.bumps = room.bumps.filter((b) => !cands.includes(b))
      broadcast(room, seatMsg(room, 'bump', { ids: [m.id, ...cands.map((b) => b.id)], shrug: true }))
      return
    }
    const partner = cands[0]
    room.bumps = room.bumps.filter((b) => b !== partner)
    const [l, r] = side === 'right' ? [m.id, partner.id] : [partner.id, m.id]
    const ok = link(room, l, r)
    broadcast(room, seatMsg(room, 'bump', ok ? { ids: [l, r] } : { ids: [l, r], shrug: true }))
  }

  // ---- connection lifecycle --------------------------------------------------------------------------------------

  function baseUrl (req) {
    if (cfg.publicUrl) return cfg.publicUrl.replace(/\/$/, '')
    const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim()
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim()
    return `${proto}://${host}`
  }

  function takeSprite (sprite, req) {
    if (!sprite || typeof sprite !== 'object') return null
    let sha = null
    if (typeof sprite.b64 === 'string' && sprite.b64.length) {
      const buf = Buffer.from(sprite.b64.replace(/^data:[^,]*,/, ''), 'base64')
      if (!buf.length) return null
      sha = crypto.createHash('sha256').update(buf).digest('hex')
      if (!sprites.get(sha)) { sprites.set(sha, { buf, mime: sniffMime(buf) }, buf.length); persistSprite(sha, buf) }
    } else if (typeof sprite.sha === 'string' && /^[a-f0-9]{64}$/.test(sprite.sha) && sprites.get(sprite.sha)) {
      sha = sprite.sha
    }
    return sha ? P.spriteUrl(baseUrl(req), sha) : null
  }

  function onHello (ws, req, h) {
    const id = /^[\w.-]{1,64}$/.test(h.id || '') ? h.id : P.rid('p')
    const roomName = P.roomFor(h.room) // no room or a legacy 'net-…' auto room: the one shared DEFAULT_ROOM

    // one live record per id: a reconnect replaces the old socket; another room drops the old record
    const prevRoomName = byId.get(id)
    if (prevRoomName && prevRoomName !== roomName) {
      const pr = rooms.get(prevRoomName)
      const old = pr?.members.get(id)
      if (old) {
        if (old.ws && old.ws !== ws) { old.ws._petpackReplaced = true; old.ws.close(P.CLOSE.replaced, 'replaced') }
        pr.members.delete(id)
        unlinkAll(pr, id)
        if (old.online) { broadcast(pr, { t: 'leave', id, lastSeen: now() }); broadcast(pr, seatMsg(pr, 'leave')) }
      }
    }
    const room = getRoom(roomName)
    let m = room.members.get(id)
    if (m && m.ws && m.ws !== ws) { m.ws._petpackReplaced = true; m.ws.close(P.CLOSE.replaced, 'replaced') }
    const wasOnline = !!m?.online
    const prevDock = m?.dock
    const before = snapshot(room)
    if (!m) {
      m = { id, seat: null, skills: [], catalog: [] }
      room.members.set(id, m)
    }
    byId.set(id, roomName)
    Object.assign(m, {
      ws, online: true, lastSeen: now(), heldUntil: 0, dirty: false,
      name: str(h.name, 64, 'pet'), color: str(h.color, 32, '#7c5cff'),
      dock: P.DOCKS.includes(h.dock) ? h.dock : 'right',
      skills: arr(h.skills), catalog: arr(h.catalog),
      status: P.STATUSES.includes(h.status) ? h.status : 'idle',
      answers: h.answers !== false,
      sprite: takeSprite(h.sprite, req)
    })
    if (m.seat == null) {
      const req = Number.isInteger(h.seat) && h.seat >= 0 ? h.seat : null
      if (req != null && !seated(room).some((x) => x.seat === req)) {
        m.seat = req
        adjLink(room, m)
        layout(room)
      } else {
        const s = seated(room)
        m.seat = s.length ? Math.max(...s.map((x) => x.seat)) + 2 : 0
      }
    }
    ws._petpack = { room, m }
    if (!wasOnline || m.dockAt == null || prevDock !== m.dock) m.dockAt = now() // joined or re-docked
    const docked = dockAutoLink(room, m)
    const fresh = m.x == null
    m.x = num(h.x, fresh ? P.seatCenterX(m.seat) : m.x)
    m.z = num(h.z, fresh ? 0 : m.z)
    m.facing = h.facing === -1 ? -1 : 1
    m.anim = P.ANIMS.includes(h.anim) ? h.anim : 'idle'

    send(m, {
      t: 'welcome', room: roomName, you: { id, seat: m.seat },
      peers: online(room).filter((x) => x.id !== id).map(peerView),
      away: [...room.members.values()].filter((x) => !x.online && now() - x.lastSeen <= cfg.awayTtlMs)
        .map((x) => ({ id: x.id, name: x.name, color: x.color, catalog: x.catalog, lastSeen: x.lastSeen })),
      links: room.links.map((l) => [...l]),
      seats: seatMsg(room, 'join').seats, held: seatMsg(room, 'join').held
    })
    if (!wasOnline) broadcast(room, { t: 'join', peer: peerView(m) }, id)
    if (docked || snapshot(room) !== before || !wasOnline) broadcast(room, seatMsg(room, docked ? 'dock' : 'join'))
    cfg.log('hello', roomName, id, 'seat', m.seat, docked ? 'dock-linked' : '')
    markDirty()
  }

  function onClose (ws) {
    const ctx = ws._petpack
    if (!ctx || ws._petpackReplaced) return
    const { room, m } = ctx
    if (m.ws !== ws) return
    m.ws = null; m.online = false; m.lastSeen = now(); m.heldUntil = now() + cfg.seatHoldMs
    room.bumps = room.bumps.filter((b) => b.id !== m.id)
    for (const [k, f] of room.fetches) {
      if (f.owner === m.id) { room.fetches.delete(k); send(room.members.get(f.requester), { t: 'fetched', from: m.id, fid: f.fid, ok: false, reason: 'away', lastSeen: m.lastSeen }) }
      else if (f.requester === m.id) room.fetches.delete(k)
    }
    for (const [k, a] of room.asks) {
      if (a.target === m.id) { room.asks.delete(k); send(room.members.get(a.asker), { t: 'answer', from: m.id, qid: a.qid, ok: false, text: '', reason: 'away' }) }
    }
    if (m.dock === 'none' && !m.catalog.length) {
      // a headless probe (smoke, status): it leaves nothing behind in the shared room
      room.members.delete(m.id); unlinkAll(room, m.id)
      if (byId.get(m.id) === room.name) byId.delete(m.id)
    }
    broadcast(room, { t: 'leave', id: m.id, lastSeen: m.lastSeen })
    broadcast(room, seatMsg(room, 'leave'))
    cfg.log('leave', room.name, m.id)
    markDirty()
  }

  function onMessage (ws, req, data, isBinary) {
    if (data.length > cfg.maxFrame) { ws.close(P.CLOSE.tooBig, 'too big'); return }
    const msg = isBinary ? null : P.decode(data)
    if (!msg) { ws.close(P.CLOSE.badFrame, 'bad frame'); return }
    const ctx = ws._petpack
    if (!ctx) {
      if (msg.t !== 'hello') { ws.close(P.CLOSE.badFrame, 'hello first'); return }
      onHello(ws, req, msg)
      return
    }
    const { room, m } = ctx
    if (m.ws !== ws) return
    m.lastSeen = now()
    switch (msg.t) {
      case 'state': {
        m.x = num(msg.x, m.x); m.z = num(msg.z, m.z)
        if (msg.facing === 1 || msg.facing === -1) m.facing = msg.facing
        if (typeof msg.anim === 'string') m.anim = msg.anim.slice(0, 32)
        if (typeof msg.status === 'string') m.status = msg.status.slice(0, 32)
        m.dirty = true
        break
      }
      case 'seat': {
        const before = snapshot(room)
        if (msg.op === 'bump' && (msg.side === 'left' || msg.side === 'right')) { bump(room, m, msg.side); break }
        let why = null
        if (msg.op === 'move' && Number.isFinite(msg.to)) { move(room, m, msg.to); why = 'move' } else if (msg.op === 'unlink') { unlinkAll(room, m.id); layout(room); why = 'unlink' }
        if (why) broadcast(room, seatMsg(room, why, snapshot(room) === before ? { ids: [m.id] } : {}))
        break
      }
      case 'catalog': {
        m.catalog = arr(msg.items)
        broadcast(room, { t: 'catalog', id: m.id, items: m.catalog }, m.id)
        break
      }
      case 'fetch': onFetch(room, m, msg); break
      case 'fetched': onFetched(room, m, msg); break
      case 'ask': {
        const qid = str(msg.qid, 80)
        const target = room.members.get(msg.to)
        if (!qid) break
        if (!target?.online) { send(m, { t: 'answer', from: msg.to ?? null, qid, ok: false, text: '', reason: 'away' }); break }
        room.asks.set(`${target.id}|${qid}`, { qid, asker: m.id, target: target.id, at: now() })
        send(target, { t: 'ask', from: m.id, qid, question: msg.question, kind: msg.kind ?? null })
        break
      }
      case 'answer': {
        const key = `${m.id}|${msg.qid}`
        const a = room.asks.get(key)
        if (!a || a.asker !== msg.to || now() - a.at > cfg.answerTtlMs) break // unsolicited or late: dropped
        room.asks.delete(key)
        send(room.members.get(a.asker), { t: 'answer', from: m.id, qid: a.qid, ok: msg.ok !== false, text: msg.text ?? '', share: msg.share, pkg: msg.pkg, reason: msg.reason })
        break
      }
      case 'gift': {
        const target = room.members.get(msg.to)
        if (target?.online && target.id !== m.id) send(target, { t: 'gift', from: m.id, gid: msg.gid, skill: msg.skill })
        break
      }
      case 'fx': {
        if (msg.kind === 'learned' && msg.skill && typeof msg.skill === 'object') {
          const s = { id: str(msg.skill.id, 200), name: str(msg.skill.name, 200), description: str(msg.skill.description, 1024) }
          if (!m.skills.some((k) => (s.id && k.id === s.id) || (s.name && k.name === s.name))) m.skills = [...m.skills, s]
        }
        const { v, t, ...rest } = msg
        broadcast(room, { ...rest, t: 'fx', from: m.id }, m.id)
        break
      }
      case 'hello': break // one hello per socket
      default: break // forward-compatible: unknown types are ignored
    }
    if (msg.t === 'catalog' || msg.t === 'seat' || (msg.t === 'fx' && msg.kind === 'learned')) markDirty()
  }

  function move (room, m, to) {
    to = Math.max(0, Math.floor(to))
    if (to === m.seat) return false
    const holder = seated(room).find((x) => x.id !== m.id && x.seat === to)
    const from = m.seat
    room.links = room.links.filter(([a, b]) => a !== m.id && b !== m.id && (!holder || (a !== holder.id && b !== holder.id)))
    m.seat = to
    if (holder) holder.seat = from
    for (const x of holder ? [m, holder] : [m]) adjLink(room, x)
    layout(room)
    return true
  }

  function onFetch (room, m, msg) {
    const fid = str(msg.fid, 80)
    const ref = str(msg.ref, 400)
    const as = msg.as === 'pkg' ? 'pkg' : 'text'
    const owner = room.members.get(msg.owner)
    if (!fid || !ref) return
    if (!owner) { send(m, { t: 'fetched', from: msg.owner ?? null, fid, ok: false, reason: 'unknown' }); return }
    const sha = owner.catalog.find((i) => i && i.ref === ref)?.sha ?? null
    const hit = fetchCache.get(`${owner.id}|${ref}|${as}`)
    if (hit && (!owner.online || !sha || hit.sha === sha)) {
      send(m, { t: 'fetched', from: owner.id, fid, ok: true, sha: hit.sha, text: hit.text, pkg: hit.pkg, cached: true })
      return
    }
    if (!owner.online) { send(m, { t: 'fetched', from: owner.id, fid, ok: false, reason: 'away', lastSeen: owner.lastSeen }); return }
    room.fetches.set(`${owner.id}|${fid}`, { fid, owner: owner.id, requester: m.id, ref, as, at: now() })
    send(owner, { t: 'fetch', from: m.id, fid, ref, as })
  }

  function onFetched (room, m, msg) {
    const key = `${m.id}|${msg.fid}`
    const f = room.fetches.get(key)
    if (!f || (msg.to != null && msg.to !== f.requester)) return
    room.fetches.delete(key)
    const ok = msg.ok !== false
    if (ok) {
      const size = (typeof msg.text === 'string' ? msg.text.length : 0) + (msg.pkg ? JSON.stringify(msg.pkg).length : 0) + 64
      const key = `${m.id}|${f.ref}|${f.as}`
      const v = { sha: msg.sha ?? null, text: msg.text, pkg: msg.pkg }
      fetchCache.set(key, v, size)
      persistFetched(key, v)
    }
    send(room.members.get(f.requester), { t: 'fetched', from: m.id, fid: f.fid, ok, sha: msg.sha ?? null, text: msg.text, pkg: msg.pkg, reason: msg.reason })
  }

  // ---- state batches, housekeeping -------------------------------------------------------------------------------

  function flushState () {
    for (const room of rooms.values()) {
      const changed = []
      for (const m of room.members.values()) if (m.dirty && m.online) { m.dirty = false; changed.push(m) }
      if (!changed.length) continue
      const live = online(room)
      const filter = live.length > cfg.chunkFilterAbove
      const pet = (m) => ({ id: m.id, x: m.x, z: m.z, facing: m.facing, anim: m.anim, status: m.status })
      const all = filter ? null : changed.map(pet)
      for (const r of live) {
        const pets = filter
          ? changed.filter((m) => m.id !== r.id && Math.abs(P.chunkOf(m.x) - (r.seat ?? 0)) <= 1).map(pet)
          : all.filter((p) => p.id !== r.id)
        if (pets.length) send(r, { t: 'state', pets })
      }
    }
  }

  function housekeep () {
    const t = now()
    for (const [name, room] of rooms) {
      let seatsChanged = false
      for (const m of [...room.members.values()]) {
        if (m.online) continue
        if (m.seat != null && t >= m.heldUntil) { m.seat = null; unlinkAll(room, m.id); seatsChanged = true }
        if (t - m.lastSeen > cfg.awayTtlMs) { room.members.delete(m.id); if (byId.get(m.id) === name) byId.delete(m.id) }
      }
      for (const [k, a] of room.asks) if (t - a.at > cfg.answerTtlMs) room.asks.delete(k)
      for (const [k, f] of room.fetches) if (t - f.at > cfg.answerTtlMs) room.fetches.delete(k)
      if (seatsChanged) { broadcast(room, seatMsg(room, 'leave')); markDirty() }
      if (!room.members.size) rooms.delete(name)
    }
  }

  // ---- HTTP + WS -------------------------------------------------------------------------------------------------

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
    if (url.pathname === '/healthz') {
      let members = 0
      for (const r of rooms.values()) members += online(r).length
      res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
      let away = 0
      for (const r of rooms.values()) for (const m of r.members.values()) if (!m.online) away++
      res.end(JSON.stringify({
        ok: true, v: P.PROTOCOL_VERSION, name: cfg.name, region: cfg.region, rooms: rooms.size, online: members, away,
        cached: fetchCache.size, sprites: sprites.size, persisted: !!dirs, uptimeS: Math.round((now() - startedAt) / 1000)
      }))
      return
    }
    const sm = url.pathname.match(/^\/s\/([a-f0-9]{64})(?:\.\w+)?$/)
    if (sm && (req.method === 'GET' || req.method === 'HEAD')) {
      const s = sprites.get(sm[1])
      if (!s) { res.writeHead(404, cors); res.end(); return }
      res.writeHead(200, {
        ...cors, 'content-type': s.mime, 'content-length': s.buf.length,
        'cache-control': 'public, max-age=31536000, immutable', 'cross-origin-resource-policy': 'cross-origin'
      })
      res.end(req.method === 'HEAD' ? undefined : s.buf)
      return
    }
    if (url.pathname === '/') { res.writeHead(200, { ...cors, 'content-type': 'text/plain' }); res.end('petpack relay v2\n'); return }
    res.writeHead(404, cors); res.end()
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: HARD_MAX })
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://x').pathname
    if (pathname !== P.WS_PATH && pathname !== '/') { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (ws, req) => {
    ws._alive = true
    ws.on('pong', () => { ws._alive = true })
    ws.on('message', (data, isBinary) => {
      try { onMessage(ws, req, data, isBinary) } catch (e) { cfg.log('message error', e?.stack || e); ws.close(P.CLOSE.badFrame, 'bad frame') }
    })
    ws.on('close', () => { try { onClose(ws) } catch (e) { cfg.log('close error', e?.stack || e) } })
    ws.on('error', () => {})
  })

  function start () {
    timers.push(setInterval(flushState, cfg.batchMs))
    timers.push(setInterval(housekeep, 5000))
    timers.push(setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws._alive) { ws.terminate(); continue }
        ws._alive = false
        try { ws.ping() } catch {}
      }
    }, cfg.pingMs))
  }

  load()

  return {
    server, wss, rooms, cfg,
    save: saveRooms,
    listen () {
      return new Promise((resolve) => {
        server.listen(cfg.port, cfg.host, () => {
          start()
          const { port } = server.address()
          resolve({ port, url: `ws://127.0.0.1:${port}${P.WS_PATH}`, http: `http://127.0.0.1:${port}` })
        })
      })
    },
    close () {
      if (!closing) saveRooms() // online members are written with lastSeen = now
      closing = true
      for (const t of timers) clearInterval(t)
      for (const ws of wss.clients) ws.terminate()
      return new Promise((resolve) => { wss.close(); server.close(() => resolve()) })
    },
    housekeep, flushState
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const relay = createRelay()
  relay.listen().then(({ port }) => relay.cfg.log(`petpack relay v${P.PROTOCOL_VERSION} listening on ${port}`))
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => relay.close().then(() => process.exit(0)))
}
