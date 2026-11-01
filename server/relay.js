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

// One-off purge (conductor, 15:2xZ): napping agents in dde-ldn left by devbox test runs before the operator's first
// real join (15:08Z): the 19 "Dot" fallbacks and 3 "Codex" test profiles. Dropped from the snapshot at load; if one
// ever reconnects it simply registers again (test clients now go to SCRATCH_ROOM).
const PURGED = new Set([
  '4faf1f36-d56f-4101-aea9-7d475950daee', '44b8df68-504f-4350-8253-4a8618f9d9d2', '65ccfa60-128c-4121-a2be-adfb77ce68bb',
  '1c871607-693d-462f-9f40-bf375846188d', '267d7ab1-3d0c-467a-b35f-481df78a0e53', '1897f812-0194-467d-9d44-a685bd8dcd9a',
  'c20487f7-240f-4ba2-8946-fbf5686465f5', 'df4d672b-e356-474a-ad3a-69df56625bdb', 'ee107cda-0559-4a8b-9dc2-86e4358a932e',
  '7c7ac1fc-426c-46b9-ac06-104923270124', 'dfdff2e9-ece9-43ec-a1f3-65eb25e993ff', 'ab0c5319-2d78-481d-ad9e-e5b1beed4883',
  '310947df-223c-4b2f-b199-529161b71feb', 'bcaad74f-f4fe-4b54-af7b-2f94a3a3f56a', '0a84059c-be98-4bae-93c1-5a32cba0bee8',
  '78b50b20-4a58-47ef-8edf-6bcee0cdb417', '4eda69eb-5582-4c02-9f12-fe5751440b9a', '51761670-9aeb-461a-ad7e-6fa303b99bf8',
  '0fc0559f-8fc8-495a-b706-5015501ccf21',
  'cbe4e8a7-e042-4cb7-bd6c-6b35bafc8ba6', '33027189-4663-404a-83ba-2cf4ae4f213b', 'a497d79f-3935-4ee9-993b-d267a3ecc2d7',
  // 16:4xZ (operator: "kill any leftover agents should just be the active laptops"): every napper except the two
  // laptops online at 16:37Z (Stacky b9070b77, Duet 2431e572).
  'b8ac966b-7c5e-4ac4-8de0-a109636a9f5b', '8d29267b-1bc7-453a-a004-d4bf330adaf7', '39192ce6-6d12-44a5-919a-60bab784c975',
  '9ae687f3-c4ea-4dca-ae0b-ae320181f58a', '1a3dfe7c-7a34-4333-99b2-abdb91752ccb', 'd6abd780-52d8-48c8-b7b0-1a690d5f39ba',
  'd4f3f501-9cf7-489b-a96f-dfd5b3340845', '132c7c4c-266d-4511-9112-fa0933789fe9', 'e44233fc-0600-4b2d-b5e4-6fd71420e48f',
  'c85438cb-6f54-4c50-8b3e-e0efc7883535', 'cf4a66b5-bf11-4a53-8b62-38936c778ced', '2b27af9b-20f0-4558-a4da-69b44b49b0af',
  'd426ec44-a4c2-42c6-b3a1-7fa6b8b7c587', '64a74aec-2aa2-4f4a-baf7-aee4b2568e31', '5fe4f152-0fb1-43ce-949c-a7ad9eeb22b1',
  '74cb8a9b-59ad-4b19-b9c6-70950cc24897'
])

// short one-way tag of a client IP, kept per agent (<= 8) so a later purge can find devbox-only agents
const ipTag = (ip) => (ip ? crypto.createHash('sha256').update(`petpack-ip:${ip}`).digest('hex').slice(0, 16) : null)

// public client IP (first X-Forwarded-For hop on App Service / Container Apps); laptops behind one venue NAT share it
function clientIp (req) {
  const xff = req.headers['x-forwarded-for']
  let ip = String(Array.isArray(xff) ? xff[0] : xff || '').split(',')[0].trim() || req.socket.remoteAddress || ''
  let m
  if ((m = ip.match(/^\[([^\]]+)\](?::\d+)?$/))) ip = m[1]
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, '')
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (ip.includes(':')) ip = ip.split(':').slice(0, 4).join(':') // IPv6: same /64
  return ip || null
}

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
    sameIpCowork: opts.sameIpCowork ?? true,
    layoutHeartbeatMs: opts.layoutHeartbeatMs ?? P.LAYOUT_HEARTBEAT_MS,
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
    posSaveMs: opts.posSaveMs ?? 5000,
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
  function markDirty (delay = cfg.saveMs) {
    if (!dirs || saveTimer || closing) return
    saveTimer = setTimeout(() => { saveTimer = null; saveRooms() }, delay)
    saveTimer.unref?.()
  }
  function saveRooms () {
    if (!dirs) return
    clearTimeout(saveTimer); saveTimer = null
    try {
      const data = {
        v: 1, savedAt: now(),
        rooms: [...rooms.values()].filter((r) => r.name !== P.SCRATCH_ROOM).map((r) => ({
          name: r.name, links: r.links, layoutVersion: r.layoutVersion || 0,
          members: [...r.members.values()].filter((m) => !m.test).map((m) => ({
            id: m.id, name: m.name, color: m.color, dock: m.dock, skills: m.skills, catalog: m.catalog,
            sprite: m.sprite, spriteSha: m.spriteSha ?? null, device: m.device ?? null, seat: m.seat, lastSeen: m.online ? now() : m.lastSeen,
            x: m.x, z: m.z, facing: m.facing, status: m.status, sit: m.sit || 'side', shareWith: m.shareWith ?? null, ips: m.ips || []
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
    let nRooms = 0; let nCache = 0; let nSprites = 0; let nPurged = 0
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
            if (name === P.DEFAULT_ROOM && PURGED.has(s.id)) { nPurged++; continue } // devbox test agents (15:2xZ purge)
            room.members.set(s.id, {
              id: s.id, name: str(s.name, 64, 'pet'), color: str(s.color, 32, '#7c5cff'), dock: P.DOCKS.includes(s.dock) ? s.dock : 'right',
              skills: arr(s.skills), catalog: arr(s.catalog), sprite: typeof s.sprite === 'string' ? s.sprite : null,
              seat: !fold && Number.isInteger(s.seat) ? s.seat : null, lastSeen: s.lastSeen || t,
              heldUntil: t + cfg.seatHoldMs, // a restart is not their fault: everyone gets a fresh hold
              online: false, ws: null, dirty: false, answers: true, status: P.STATUSES.includes(s.status) ? s.status : 'idle', anim: 'idle',
              facing: s.facing === -1 ? -1 : 1, spriteSha: typeof s.spriteSha === 'string' ? s.spriteSha : null, device: typeof s.device === 'string' ? s.device : null,
              x: Number.isFinite(s.x) ? s.x : P.seatCenterX(Number.isInteger(s.seat) ? s.seat : 0), z: Number.isFinite(s.z) ? s.z : 0,
              sit: P.SITS.includes(s.sit) ? s.sit : 'side', shareWith: !fold && typeof s.shareWith === 'string' ? s.shareWith : null, flipped: !fold && typeof s.shareWith === 'string',
              ips: arr(s.ips).filter((x) => typeof x === 'string').slice(0, 8)
            })
            byId.set(s.id, name)
          }
          if (!fold) room.links = arr(r.links).filter((l) => Array.isArray(l) && room.members.has(l[0]) && room.members.has(l[1]))
          if (!fold && Number.isFinite(r.layoutVersion)) room.layoutVersion = Math.max(room.layoutVersion || 0, r.layoutVersion)
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
    cfg.log(`loaded ${nRooms} rooms, ${nCache} cached items, ${nSprites} sprites from ${dirs.root}; purged ${nPurged} test agents`)
  }

  // ---- rooms and members -----------------------------------------------------------------------------------------

  function getRoom (name) {
    let r = rooms.get(name)
    if (!r) {
      r = { name, members: new Map(), links: [], bumps: [], fetches: new Map(), asks: new Map(), spectators: new Set() }
      rooms.set(name, r)
    }
    return r
  }

  const online = (room) => [...room.members.values()].filter((m) => m.online)
  // seated = seat owners (side strip); an 'across' guest shares its host's seat, flipped, and follows it
  const seated = (room) => [...room.members.values()].filter((m) => m.seat != null && !m.shareWith)
  const hosting = (room, m) => [...room.members.values()].some((x) => x.shareWith === m.id)
  const freeSeat = (room) => { const s = seated(room); return s.length ? Math.max(...s.map((x) => x.seat)) + 2 : 0 }

  function peerView (m) {
    return {
      id: m.id, name: m.name, color: m.color, seat: m.seat, dock: m.dock, skills: m.skills, catalog: m.catalog,
      sprite: m.sprite, x: m.x, z: m.z, facing: m.facing, anim: m.anim, status: m.status, answers: m.answers,
      sit: m.sit || 'side', flipped: !!m.flipped,
      ...(m.online ? {} : { away: true, lastSeen: m.lastSeen })
    }
  }

  // the device registry: one agent per id, with its absolute world position, online or napping where it stopped
  function agentView (m) {
    return {
      id: m.id, name: m.name, color: m.color, sprite: m.sprite, spriteSha: m.spriteSha ?? null, seat: m.seat,
      x: m.x, z: m.z, facing: m.facing, status: m.status, lastSeen: m.lastSeen, online: !!m.online, away: !m.online
    }
  }

  const awayView = (m) => ({
    id: m.id, name: m.name, color: m.color, catalog: m.catalog, lastSeen: m.lastSeen, away: true,
    sprite: m.sprite, seat: m.seat, x: m.x, z: m.z, facing: m.facing, status: m.status, skills: m.skills
  })

  function send (m, msg) {
    if (!m || !m.ws || m.ws.readyState !== 1) return
    m.ws.send(typeof msg === 'string' ? msg : P.encode(msg))
  }

  function sendWs (ws, data) { if (ws.readyState === 1) ws.send(data) }

  function broadcast (room, msg, exceptId = null) {
    if (msg.t === 'seat') { commitLayout(room); msg = { ...msg, layoutVersion: room.layoutVersion } }
    const data = P.encode(msg)
    for (const m of room.members.values()) if (m.online && m.id !== exceptId) send(m, data)
    for (const ws of room.spectators) sendWs(ws, data) // spectators see everything the room sees
  }

  // ---- the room LAYOUT: the relay is its single source of truth ----------------------------------------------------
  // seats, flips, across pairs, links, neighbours and each pane's sit. Every change bumps layoutVersion (monotonic,
  // persisted; never below the wall clock so a restart can't go backwards) and broadcasts one `layout` message.

  function layoutOf (room) {
    const s = seatMsg(room, 'layout')
    const sits = {}
    for (const m of room.members.values()) if (m.seat != null) sits[m.id] = m.sit || 'side'
    return { seats: s.seats, held: s.held, flipped: s.flipped, across: s.across, links: s.links, neighbours: s.neighbours, sits }
  }

  // in a `layout` message, v is the LAYOUT version (not the protocol version); layoutVersion repeats it
  const layoutMsg = (room) => ({ t: 'layout', ...layoutOf(room), v: room.layoutVersion || 0, layoutVersion: room.layoutVersion || 0 })

  function commitLayout (room, { exceptId = null, quiet = false } = {}) {
    const l = layoutOf(room)
    const key = JSON.stringify([l.seats, l.held, l.flipped, l.links, l.sits])
    if (key === room.layoutKey) return false
    room.layoutKey = key
    room.layoutVersion = Math.max((room.layoutVersion || 0) + 1, now())
    if (!quiet) {
      const data = P.encode(layoutMsg(room))
      for (const m of room.members.values()) if (m.online && m.id !== exceptId) send(m, data)
      for (const ws of room.spectators) sendWs(ws, data)
    }
    markDirty()
    return true
  }

  function layoutBeat () {
    for (const room of rooms.values()) {
      if (!room.spectators.size && !online(room).length) continue
      const data = P.encode({ t: 'layout', v: room.layoutVersion || 0, layoutVersion: room.layoutVersion || 0, beat: true })
      for (const m of room.members.values()) if (m.online) send(m, data)
      for (const ws of room.spectators) sendWs(ws, data)
    }
  }

  // the other pane of a pair gets a corrective sit (in the same layout version) when the pair's sit wins over its own
  function correctSit (room, m, sit) {
    if (!m || m.sit === sit) return
    m.sit = sit; m.sitAt = now()
    send(m, { t: 'sit', sit, corrected: true })
  }
  const pairedAcross = (room, m) => !!m.shareWith || hosting(room, m)
  const pairedSide = (room, m) => room.links.some(([a, b]) => a === m.id || b === m.id)
  // a side (co-work) pair: the initiator is side now; the other follows unless it is in an across pair of its own
  function pairSide (room, m, other) {
    correctSit(room, m, 'side')
    const o = other?.shareWith ? room.members.get(other.shareWith) : other
    if (o && !pairedAcross(room, o)) correctSit(room, o, 'side')
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
    syncGuests(room)
  }

  // 'across' (battleships, back to back): a guest shares its host's seat facing the other way
  function syncGuests (room) {
    for (const g of room.members.values()) {
      if (!g.shareWith) continue
      const h = room.members.get(g.shareWith)
      if (h && h.seat != null && !h.shareWith) { g.seat = h.seat; g.flipped = true; continue }
      g.shareWith = null; g.flipped = false // host gone: the guest gets its own seat at the end
      g.seat = g.online ? freeSeat(room) : null
    }
  }

  function makeGuest (room, g, h) {
    if (!g || !h || g.id === h.id || h.shareWith || h.seat == null || hosting(room, h) || hosting(room, g)) return false
    unlinkAll(room, g.id)
    g.shareWith = h.id; g.flipped = true; g.seat = h.seat; h.flipped = false
    layout(room)
    return true
  }

  function unpair (room, m) {
    let changed = false
    for (const g of room.members.values()) {
      if (g.shareWith && (g.id === m.id || g.shareWith === m.id)) {
        g.shareWith = null; g.flipped = false; g.seat = g.online ? freeSeat(room) : null; changed = true
      }
    }
    if (changed) layout(room)
    return changed
  }

  // two 'across' panes that joined (or switched to across) within the pair window share one seat, the later one flipped
  function acrossPair (room, m) {
    const free = (x) => x.online && x.seat != null && x.sit === 'across' && !x.shareWith && !hosting(room, x)
    if (!m || !free(m)) return false
    const partner = online(room)
      .filter((x) => x.id !== m.id && free(x) && Math.abs((m.sitAt ?? 0) - (x.sitAt ?? 0)) <= cfg.dockPairWindowMs)
      .sort((a, b) => (b.sitAt ?? 0) - (a.sitAt ?? 0))[0]
    return partner ? makeGuest(room, m, partner) : false
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
    const flipped = {}
    const across = []
    for (const m of room.members.values()) {
      if (m.seat == null) continue
      ;(m.online ? seats : held)[m.id] = m.seat
      if (m.shareWith) { flipped[m.id] = true; across.push([m.shareWith, m.id]) }
    }
    return { t: 'seat', seats, held, flipped, across, neighbours: neighbours(room), links: room.links.map((l) => [...l]), why, ...extra }
  }

  function snapshot (room) {
    return JSON.stringify([[...room.members.values()].filter((m) => m.seat != null).map((m) => [m.id, m.seat, m.shareWith ?? null]), room.links])
  }

  // ---- co-work: sit me right beside a target pane; the target stays where it is ----------------------------------

  // the side of the target I sit on: docked right -> my pane is on the LEFT of theirs; docked left -> RIGHT
  const sideFor = (dock) => (dock === 'right' ? 'left' : dock === 'left' ? 'right' : null)

  // nearest seat to `s` with an empty chunk on both sides (so it touches no chain)
  function nearestFree (room, s, exceptId) {
    const taken = new Set(seated(room).filter((x) => x.id !== exceptId).map((x) => x.seat))
    const ok = (x) => x >= 0 && !taken.has(x - 1) && !taken.has(x) && !taken.has(x + 1)
    for (let d = 2; d < 10000; d++) { if (ok(s + d)) return s + d; if (ok(s - d)) return s - d }
    return freeSeat(room)
  }

  // returns { ok, pair: [leftId, rightId] } | { full: true } | { ok: false, reason }
  function coworkPlace (room, me, target, side) {
    if (!me || !target || me.id === target.id || me.seat == null) return { ok: false, reason: 'not found' }
    const anchor = target.shareWith ? room.members.get(target.shareWith) : target
    if (!anchor || anchor.seat == null || anchor.id === me.id) return { ok: false, reason: 'no seat' }
    if (leftOf(room, anchor.id) === me.id) return { ok: true, pair: [me.id, anchor.id], already: true }
    if (rightOf(room, anchor.id) === me.id) return { ok: true, pair: [anchor.id, me.id], already: true }
    if (me.shareWith || hosting(room, me)) unpair(room, me)
    unlinkAll(room, me.id) // I leave my old spot; a guest across from me would follow me
    for (const sd of side ? [side, side === 'left' ? 'right' : 'left'] : ['right', 'left']) {
      if (sd === 'left' && !leftOf(room, anchor.id)) {
        me.seat = anchor.seat - 1; room.links.push([me.id, anchor.id]); layout(room)
        return { ok: true, pair: [me.id, anchor.id] }
      }
      if (sd === 'right' && !rightOf(room, anchor.id)) {
        me.seat = anchor.seat + 1; room.links.push([anchor.id, me.id]); layout(room)
        return { ok: true, pair: [anchor.id, me.id] }
      }
    }
    me.seat = nearestFree(room, anchor.seat, me.id) // both sides taken by co-workers
    layout(room)
    return { full: true, ids: [me.id, anchor.id] }
  }

  function findAgent (room, target) {
    if (typeof target !== 'string' || !target) return null
    const byIdHit = room.members.get(target)
    if (byIdHit) return byIdHit
    const name = target.trim().toLowerCase()
    return [...room.members.values()].filter((x) => String(x.name || '').toLowerCase() === name)
      .sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen))[0] ?? null
  }

  // Auto co-work on join (or re-dock): a docked laptop with a free facing side pairs with an opposite-docked laptop
  // whose facing side is free: first the most recent one that joined within dockPairWindowMs; failing that, one on
  // the same public IP (the venue NAT), nearest in time. The newcomer moves beside the partner, who stays put.
  function dockAutoLink (room, m) {
    const usable = (x) => x.online && x.seat != null && !x.shareWith && !hosting(room, x)
    if (!m || !usable(m) || (m.dock !== 'left' && m.dock !== 'right')) return null
    if (room.links.some(([a, b]) => a === m.id || b === m.id)) return null
    const want = m.dock === 'right' ? 'left' : 'right'
    const linked = (x) => room.links.some(([a, b]) => a === x.id || b === x.id)
    const facingFree = (x) => !(x.dock === 'left' ? leftOf(room, x.id) : rightOf(room, x.id))
    // an across partner must be wholly free (it will share a seat); a side partner needs only its facing side free
    const cands = online(room).filter((x) => x.id !== m.id && x.dock === want && usable(x) &&
      (m.sit === 'across' || x.sit === 'across' ? !linked(x) : facingFree(x)))
    const dt = (x) => Math.abs((m.dockAt ?? 0) - (x.dockAt ?? 0))
    let partner = cands.filter((x) => dt(x) <= cfg.dockPairWindowMs).sort((a, b) => (b.dockAt ?? 0) - (a.dockAt ?? 0))[0]
    if (!partner && cfg.sameIpCowork && m.ip) partner = cands.filter((x) => x.ip === m.ip).sort((a, b) => dt(a) - dt(b))[0]
    if (!partner) return null
    if (m.sit === 'across' || partner.sit === 'across') {
      // smart inference: face to face and one of them sits across -> both across, sharing one seat (newcomer flipped)
      if (!makeGuest(room, m, partner)) return null
      correctSit(room, partner, 'across'); m.sit = 'across'; m.sitAt = now() // the newcomer learns it in its welcome
      return { ok: true, across: true, pair: [partner.id, m.id] }
    }
    const r = coworkPlace(room, m, partner, sideFor(m.dock))
    return r.ok ? r : null
  }

  function neighbours (room) {
    const out = {}
    for (const m of room.members.values()) {
      if (m.seat == null) continue
      const guest = [...room.members.values()].find((x) => x.shareWith === m.id)
      out[m.id] = { left: leftOf(room, m.id), right: rightOf(room, m.id), across: m.shareWith ?? guest?.id ?? null }
    }
    return out
  }

  function bump (room, m, side, share = false) {
    const t = now()
    room.bumps = room.bumps.filter((b) => t - b.at <= cfg.bumpWindowMs && b.id !== m.id && room.members.get(b.id)?.online)
    const want = side === 'right' ? 'left' : 'right'
    const cands = room.bumps.filter((b) => b.side === want).sort((a, b) => (t - a.at) - (t - b.at))
    if (!cands.length) {
      const entry = { id: m.id, side, at: t, share }
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
    const pm = room.members.get(partner.id)
    if (share || partner.share || m.sit === 'across') {
      // battleships bump: the later bumper (the initiator, whose sit wins) shares the other's seat, facing the other way
      const ok = makeGuest(room, m, pm)
      if (ok) { correctSit(room, m, 'across'); correctSit(room, pm, 'across') }
      broadcast(room, seatMsg(room, 'bump', ok ? { ids: [pm.id, m.id] } : { ids: [pm.id, m.id], shrug: true }))
      return
    }
    // same rule as nextTo: the later bumper sits beside the earlier one (who stays), on the edge it bumped
    const r = coworkPlace(room, m, pm, side === 'right' ? 'left' : 'right')
    if (r.ok) { pairSide(room, m, pm); broadcast(room, seatMsg(room, 'cowork', { cowork: r.pair, ids: r.pair, via: 'bump' })) }
    else if (r.full) broadcast(room, seatMsg(room, 'full', { ids: r.ids, via: 'bump' }))
    else broadcast(room, seatMsg(room, 'bump', { ids: [m.id, partner.id], shrug: true }))
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

  function registryViews (room) {
    const t = now()
    const all = [...room.members.values()].filter((x) => x.online || t - x.lastSeen <= cfg.awayTtlMs)
    return {
      peers: all.filter((x) => x.online).map(peerView),
      away: all.filter((x) => !x.online).map(awayView),
      agents: all.map(agentView),
      links: room.links.map((l) => [...l]),
      ...(({ seats, held, flipped, across, neighbours }) => ({ seats, held, flipped, across, neighbours }))(seatMsg(room, 'join')),
    }
  }

  function onSpectator (ws, h) {
    const roomName = P.roomFor(h.room)
    const room = getRoom(roomName)
    room.spectators.add(ws)
    ws._petpack = { room, spectator: true }
    sendWs(ws, P.encode({ t: 'welcome', room: roomName, you: { id: null, spectator: true, seat: null }, ...registryViews(room) }))
    cfg.log('spectator', roomName, room.spectators.size)
  }

  function onHello (ws, req, h) {
    if (h.spectator === true) { onSpectator(ws, h); return }
    const device = typeof h.device === 'string' && h.device ? h.device.slice(0, 128) : null
    const id = /^[\w.-]{1,64}$/.test(h.id || '') ? h.id
      : device ? 'd-' + crypto.createHash('sha256').update(device).digest('hex').slice(0, 24) : P.rid('p')
    const test = P.isTestHello(h) // probes, test: true and test profiles never touch the shared room
    const asked = P.roomFor(h.room) // no room or a legacy 'net-…' auto room: the one shared DEFAULT_ROOM
    const roomName = test && asked === P.DEFAULT_ROOM ? P.SCRATCH_ROOM : asked

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
    const known = !!m && Number.isFinite(m.x) && Number.isFinite(m.z) // in the registry: resume where it stopped
    if (!m) {
      m = { id, seat: null, skills: [], catalog: [], sprite: null }
      room.members.set(id, m)
    }
    byId.set(id, roomName)
    const sprite = takeSprite(h.sprite, req) ?? (h.sprite === undefined || h.sprite === null ? m.sprite : null)
    Object.assign(m, {
      ws, online: true, lastSeen: now(), heldUntil: 0, dirty: false,
      name: str(h.name, 64, m.name || 'pet'), color: str(h.color, 32, m.color || '#7c5cff'),
      dock: P.DOCKS.includes(h.dock) ? h.dock : 'right',
      skills: Array.isArray(h.skills) ? h.skills : m.skills, catalog: Array.isArray(h.catalog) ? h.catalog : m.catalog,
      status: P.STATUSES.includes(h.status) ? h.status : 'idle',
      answers: h.answers !== false,
      sprite, spriteSha: sprite?.match(/\/s\/([a-f0-9]{64})/)?.[1] ?? null,
      device: device ?? m.device ?? null,
      ip: clientIp(req), test,
      ips: [...new Set([ipTag(clientIp(req)), ...(m.ips || [])])].filter(Boolean).slice(0, 8)
    })
    if (m.seat == null) {
      const req = Number.isInteger(h.seat) && h.seat >= 0 ? h.seat : null
      if (req != null && !seated(room).some((x) => x.seat === req)) {
        m.seat = req
        adjLink(room, m)
        layout(room)
      } else {
        m.seat = freeSeat(room)
      }
    }
    ws._petpack = { room, m }
    if (!wasOnline || m.dockAt == null || prevDock !== m.dock) m.dockAt = now() // joined or re-docked
    // a pane already in a pair keeps the pair's sit: a contradicting hello.sit is corrected, not split (unlink splits)
    let sit = P.SITS.includes(h.sit) ? h.sit : (m.sit || 'side')
    let corrected = false
    if (pairedAcross(room, m) && sit !== 'across') { sit = 'across'; corrected = true }
    if (!pairedAcross(room, m) && pairedSide(room, m) && sit !== 'side') { sit = 'side'; corrected = true }
    if (!wasOnline || m.sitAt == null || sit !== m.sit) m.sitAt = now()
    m.sit = sit
    syncGuests(room) // a returning guest follows its host's seat
    const across = m.sit === 'across' ? acrossPair(room, m) : false
    const docked = across || dockAutoLink(room, m)
    const inferredAcross = !!docked?.across
    if (m.sit !== sit) corrected = true
    if (!known) { // a new agent starts where its client says, else at its seat's home
      m.x = num(h.x, P.seatCenterX(m.seat))
      m.z = num(h.z, 0)
      m.facing = h.facing === -1 ? -1 : 1
    } // a known agent resumes at its registry position (absolute, across sessions); the client adopts welcome.you
    m.anim = P.ANIMS.includes(h.anim) ? h.anim : 'idle'

    commitLayout(room, { exceptId: id }) // the newcomer gets the fresh layout inside its welcome
    const views = registryViews(room)
    send(m, {
      t: 'welcome', room: roomName,
      you: { id, seat: m.seat, flipped: !!m.flipped, sit: m.sit, sitCorrected: corrected, x: m.x, z: m.z, facing: m.facing, resumed: known, takeover: wasOnline },
      layout: layoutMsg(room),
      ...views,
      peers: views.peers.filter((p) => p.id !== id),
      agents: views.agents.filter((a) => a.id !== id)
    })
    if (!wasOnline) broadcast(room, { t: 'join', peer: peerView(m) }, id)
    else m.dirty = true // a takeover: no join/leave churn, just a fresh state for everyone
    if (docked || snapshot(room) !== before || !wasOnline) broadcast(room, seatMsg(room, across || inferredAcross ? 'across' : docked ? 'dock' : 'join', docked?.pair ? { cowork: docked.pair } : {}))
    cfg.log('hello', roomName, id, 'seat', m.seat, 'ip', ipTag(m.ip), docked ? 'dock-linked' : '')
    markDirty()
  }

  function onClose (ws) {
    const ctx = ws._petpack
    if (!ctx || ws._petpackReplaced) return
    if (ctx.spectator) { ctx.room.spectators.delete(ws); return }
    const { room, m } = ctx
    if (m.ws !== ws) return
    m.ws = null; m.online = false; m.lastSeen = now(); m.heldUntil = now() + cfg.seatHoldMs
    m.dirty = true // the next state batch carries it as away: it naps where it stopped
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
    const stays = room.members.has(m.id)
    broadcast(room, { t: 'leave', id: m.id, lastSeen: m.lastSeen, ...(stays ? { away: true, x: m.x, z: m.z, facing: m.facing } : {}) })
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
    if (ctx.spectator) { // read-only: a spectator sends nothing but pings and layout?
      if (msg.t === 'layout?') sendWs(ws, P.encode(layoutMsg(ctx.room)))
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
        markDirty(cfg.posSaveMs) // registry position, persisted at most every posSaveMs
        break
      }
      case 'seat': {
        const before = snapshot(room)
        if (msg.op === 'bump' && (msg.side === 'left' || msg.side === 'right')) { bump(room, m, msg.side, msg.share === true); break }
        if (msg.op === 'nextTo') { // co-work: seat me beside target (agent id or name); the target stays put
          const target = findAgent(room, msg.target)
          if (target && m.sit === 'across') { // the initiator's sit wins: an across pane shares the target's seat
            const host = target.shareWith ? room.members.get(target.shareWith) : target
            if (m.shareWith && m.shareWith !== host?.id) unpair(room, m)
            const ok = host && host.id !== m.id && (m.shareWith === host.id || makeGuest(room, m, host))
            if (ok) { correctSit(room, host, 'across'); broadcast(room, seatMsg(room, 'across', { cowork: [host.id, m.id], ids: [host.id, m.id] })) }
            else broadcast(room, seatMsg(room, 'full', { ids: [m.id, target.id] }))
            break
          }
          const r = target ? coworkPlace(room, m, target, sideFor(m.dock)) : { ok: false, reason: 'not found' }
          if (r.ok) { pairSide(room, m, target); broadcast(room, seatMsg(room, 'cowork', { cowork: r.pair, ids: r.pair })) }
          else if (r.full) broadcast(room, seatMsg(room, 'full', { ids: r.ids }))
          else send(m, seatMsg(room, 'cowork', { ids: [m.id], shrug: true, reason: r.reason }))
          break
        }
        let why = null
        if ((msg.op === 'share' || (msg.op === 'move' && msg.flip === true)) && Number.isFinite(msg.to)) {
          // "share seat N facing the other way": become the flipped guest of whoever owns seat N; both sit across
          const host = seated(room).find((x) => x.id !== m.id && x.seat === Math.floor(msg.to))
          if (host && host.id !== m.shareWith) {
            if (m.shareWith) unpair(room, m)
            if (makeGuest(room, m, host)) { correctSit(room, m, 'across'); correctSit(room, host, 'across') }
          }
          why = 'move'
        } else if (msg.op === 'move' && Number.isFinite(msg.to)) {
          if (m.shareWith) unpair(room, m)
          move(room, m, msg.to); why = 'move'
        } else if (msg.op === 'unlink') { unpair(room, m); unlinkAll(room, m.id); layout(room); why = 'unlink' }
        if (why) broadcast(room, seatMsg(room, why, snapshot(room) === before ? { ids: [m.id] } : {}))
        break
      }
      case 'sit': { // { t:'sit', sit, unlink? }: change how this pane sits; a pair keeps its sit unless unlink: true
        if (!P.SITS.includes(msg.sit)) break
        const before = snapshot(room)
        const pairSit = pairedAcross(room, m) ? 'across' : pairedSide(room, m) ? 'side' : null
        if (pairSit && msg.sit !== pairSit && msg.unlink !== true) { // contradicts its pair: corrected, not split
          if (m.sit !== pairSit) { m.sit = pairSit; m.sitAt = now() }
          send(m, { t: 'sit', sit: pairSit, corrected: true, layoutVersion: room.layoutVersion })
          break
        }
        if (msg.unlink === true) { unpair(room, m); unlinkAll(room, m.id); layout(room) }
        if (msg.sit !== m.sit) { m.sit = msg.sit; m.sitAt = now() }
        let paired = null
        if (m.sit === 'across' && !pairedAcross(room, m)) {
          unlinkAll(room, m.id); layout(room)
          paired = acrossPair(room, m) || dockAutoLink(room, m)
        }
        broadcast(room, seatMsg(room, paired ? 'across' : 'sit'))
        break
      }
      case 'layout?': send(m, layoutMsg(room)); break // self-healing: a client whose v differs asks for the full layout
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
    if (msg.t === 'catalog' || msg.t === 'seat' || msg.t === 'sit' || (msg.t === 'fx' && msg.kind === 'learned')) markDirty()
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
      for (const m of room.members.values()) if (m.dirty) { m.dirty = false; changed.push(m) }
      if (!changed.length) continue
      const live = online(room)
      const filter = live.length > cfg.chunkFilterAbove
      const pet = (m) => ({ id: m.id, x: m.x, z: m.z, facing: m.facing, anim: m.anim, status: m.status, ...(m.online ? {} : { away: true }) })
      const all = changed.map(pet)
      for (const r of live) {
        const pets = filter
          ? changed.filter((m) => m.id !== r.id && Math.abs(P.chunkOf(m.x) - (r.seat ?? 0)) <= 1).map(pet)
          : all.filter((p) => p.id !== r.id)
        if (pets.length) send(r, { t: 'state', pets })
      }
      if (room.spectators.size) { // spectators watch every seat, unfiltered
        const data = P.encode({ t: 'state', pets: all })
        for (const ws of room.spectators) sendWs(ws, data)
      }
    }
  }

  function housekeep () {
    const t = now()
    for (const [name, room] of rooms) {
      let seatsChanged = false
      for (const m of [...room.members.values()]) {
        if (m.online) continue
        if (m.seat != null && t >= m.heldUntil) { m.seat = null; m.shareWith = null; m.flipped = false; unlinkAll(room, m.id); seatsChanged = true }
        if (t - m.lastSeen > cfg.awayTtlMs) { room.members.delete(m.id); if (byId.get(m.id) === name) byId.delete(m.id) }
      }
      for (const [k, a] of room.asks) if (t - a.at > cfg.answerTtlMs) room.asks.delete(k)
      for (const [k, f] of room.fetches) if (t - f.at > cfg.answerTtlMs) room.fetches.delete(k)
      if (seatsChanged) { syncGuests(room); broadcast(room, seatMsg(room, 'leave')); markDirty() }
      if (!room.members.size && !room.spectators.size) rooms.delete(name)
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
      let spectators = 0
      for (const r of rooms.values()) spectators += r.spectators.size
      res.end(JSON.stringify({
        ok: true, v: P.PROTOCOL_VERSION, name: cfg.name, region: cfg.region, rooms: rooms.size, online: members, away, spectators,
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
    timers.push(setInterval(layoutBeat, cfg.layoutHeartbeatMs))
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
