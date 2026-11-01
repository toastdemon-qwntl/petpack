// petpack relay protocol v2 (owner: L1 relay). Plain ES module, no imports: loads in Node and in the renderer.
//
// One WebSocket per client at `wss://<relay>/ws`. JSON text frames, every frame carries `t` (type) and `v: 2`.
// The relay stamps `from` (sender id) on everything it forwards. Bad JSON or a frame without `t` closes the socket
// with 4400; a frame above MAX_FRAME closes it with 4413. Only that socket closes; the room carries on.
//
// World: one strip of chunks, CHUNK_W wide. Seat `i`'s pane shows chunk `i`, centred on x = i * CHUNK_W
// (so chunkOf(x) = round(x / CHUNK_W)). A pet's (x, z) is in world units; its owner simulates it and is authoritative.
//
// ---------------------------------------------------------------------------------------------------------------
// Shapes (JSDoc; the relay and the brain both code against these)
//
// @typedef {{ id: string, name: string, description: string }} Skill
// @typedef {{ ref: string,            // '<kind>:<slug>', unique per owner
//             kind: 'skill'|'memory'|'technique'|'resource',
//             title: string, summary: string /* <= 240 */, bytes: number, sha: string, mtime: number }} Item
//             // global id of an item: `${ownerId}/${ref}` (see itemId / parseItemId)
// @typedef {{ id: string, name: string, color: string, seat: number|null, dock: 'left'|'right',
//             skills: Skill[], catalog: Item[], sprite: string|null /* absolute URL /s/<sha>.webp */,
//             x: number, z: number, facing: 1|-1, anim: string, status: string,
//             answers: boolean /* true: this peer answers `ask` (Q4, --no-answer turns it off) */ }} Peer
// @typedef {{ id: string, name: string, color: string, catalog: Item[], lastSeen: number /* ms epoch */ }} Away
// @typedef {[string, string]} Link     // [leftId, rightId]: two laptops physically side by side, left one first
//
// Client -> server
//   hello   { t, v, id, room|null, seat|null, dock, name, color, status, skills, catalog,
//             sprite: { sha, b64 } | { sha } | null, answers, x?, z?, facing?, anim? }
//           room null = auto room for this network ('net-<8 hex>'); a code from --room sticks.
//           seat = the last seat (reconnect) or --seat; welcome is authoritative.
//           sprite: send b64 once; afterwards { sha } alone is enough if the relay still has it.
//   state   { t, x, z, facing, anim, status }      <= 10 Hz while moving, 1 Hz heartbeat otherwise
//   seat    { t, op: 'bump', side: 'left'|'right' } pet dragged onto that edge of its own pane
//           { t, op: 'move', to }                   arrows / tray Seat: swap with whoever holds seat `to`
//           { t, op: 'unlink' }                     tray Unlink: drop this laptop's links
//   catalog { t, items: Item[] }                    on change, at most every 5 s
//   fetch   { t, fid, owner, ref, as: 'text'|'pkg' }
//   fetched { t, fid, to, ok, sha, text?, pkg?, reason? }    owner's reply to a forwarded fetch
//   ask     { t, qid, to, question, kind? }
//   answer  { t, qid, to, ok, text, share?, pkg?, reason? }  reason 'busy' = re-route once
//   gift    { t, to, gid, skill: { id, name, description, files: [{ path, b64 }] } }
//   fx      { t, kind: FX_KINDS[number], ...anything }  learned: { kind:'learned', skill: Skill } also updates skills
//
// Server -> client
//   welcome { t, v, room, you: { id, seat }, peers: Peer[] /* online, not you */, away: Away[], links: Link[],
//             seats: { [id]: seat } /* online */, held: { [id]: seat } /* away, seat held 10 min */ }
//   join    { t, v, peer: Peer }
//   leave   { t, v, id, lastSeen }               the leaver's catalog stays as `away` for 24 h
//   state   { t, v, pets: [{ id, x, z, facing, anim, status }] }   room batch every 100 ms, changed pets only,
//                                                 never your own; above 16 members only pets in your chunk +-1
//   seat    { t, v, seats, held, links, why: SEAT_WHY[number], ids? }
//           why 'bump' with nothing changed = shrug (ids = the pets that shrug). After any seat message every pane
//           flashes its seat number for 2 s.
//   catalog { t, v, id, items }
//   fetch   { t, v, from, fid, ref, as }         to the owner only
//   fetched { t, v, from /* owner */, fid, ok, sha, text?, pkg?, reason?, cached?, lastSeen? }  requester only;
//           owner gone and nothing cached: { ok:false, reason:'away', lastSeen }
//   ask     { t, v, from, qid, question, kind }  target only
//   answer  { t, v, from, qid, ok, text, share?, pkg?, reason? }   asker only, first answer to a forwarded qid
//           within 60 s; target not online: { ok:false, reason:'away' } from the relay at once
//   gift    { t, v, from, gid, skill }           target only
//   fx      { t, v, from, kind, ... }            room except the sender
//
// HTTP on the same host: GET /healthz -> 200 JSON; GET /s/<sha>.webp -> sprite bytes (immutable, CORS open).
// ---------------------------------------------------------------------------------------------------------------

export const PROTOCOL_VERSION = 2
export const V = PROTOCOL_VERSION

export const DEFAULT_RELAY = 'wss://petpack-relay.azurewebsites.net/ws'
export const WS_PATH = '/ws'

export const CHUNK_W = 14

export const T = Object.freeze({
  hello: 'hello', welcome: 'welcome', join: 'join', leave: 'leave',
  state: 'state', seat: 'seat', catalog: 'catalog',
  fetch: 'fetch', fetched: 'fetched', ask: 'ask', answer: 'answer',
  gift: 'gift', fx: 'fx'
})

export const CLIENT_TYPES = Object.freeze(['hello', 'state', 'seat', 'catalog', 'fetch', 'fetched', 'ask', 'answer', 'gift', 'fx'])
export const SERVER_TYPES = Object.freeze(['welcome', 'join', 'leave', 'state', 'seat', 'catalog', 'fetch', 'fetched', 'ask', 'answer', 'gift', 'fx'])

export const FX_KINDS = Object.freeze(['seek', 'gift', 'learned', 'ask', 'think', 'answer', 'fetch', 'pulse', 'bump', 'wave', 'say'])
export const SEAT_OPS = Object.freeze(['bump', 'move', 'unlink'])
export const SEAT_WHY = Object.freeze(['dock', 'bump', 'move', 'join', 'leave', 'unlink'])
export const ITEM_KINDS = Object.freeze(['skill', 'memory', 'technique', 'resource'])
export const LANDMARK_OF = Object.freeze({ skill: 'workshop', memory: 'library', technique: 'dojo', resource: 'campfire' })
export const STATUSES = Object.freeze(['idle', 'working', 'waiting', 'done', 'failed'])
export const ANIMS = Object.freeze(['idle', 'run', 'wave', 'jump', 'failed', 'waiting', 'review'])
export const DOCKS = Object.freeze(['left', 'right'])

export const CLOSE = Object.freeze({
  normal: 1000,
  badFrame: 4400,
  replaced: 4409,   // the same id connected again; the newer socket wins
  tooBig: 4413
})

// Limits and timings (the relay's only caps are the ones that stop a crash).
export const MAX_FRAME = 4 * 1024 * 1024           // ws maxPayload on both ends
export const STATE_BATCH_MS = 100
export const STATE_MOVE_HZ = 10
export const STATE_HEARTBEAT_MS = 1000
export const CHUNK_FILTER_ABOVE = 16               // members; above this, state is filtered to chunk +-1
export const BUMP_WINDOW_MS = 1500
export const BUMP_AMBIGUOUS_MS = 300
export const SEAT_HOLD_MS = 10 * 60 * 1000
export const AWAY_TTL_MS = 24 * 60 * 60 * 1000
export const ANSWER_TTL_MS = 60 * 1000
export const FETCH_CACHE_BYTES = 300 * 1024 * 1024
export const CATALOG_MIN_INTERVAL_MS = 5000
export const PING_MS = 25000
export const RECONNECT_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 15000])
export const SOLO_AFTER_MS = 3000
export const SEAT_FLASH_MS = 2000

// ---- helpers --------------------------------------------------------------------------------------------------

/** Serialise a message, adding v: 2. */
export function encode (msg) {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...msg })
}

/** Parse a frame; returns the message object or null when it isn't a valid protocol frame. */
export function decode (data) {
  let text = data
  if (typeof text !== 'string') {
    if (text && typeof text.toString === 'function') text = text.toString()
    else return null
  }
  let msg
  try { msg = JSON.parse(text) } catch { return null }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return null
  return msg
}

/** Which chunk (= seat pane) a world x falls in. */
export function chunkOf (x, chunkW = CHUNK_W) {
  return Math.round((Number(x) || 0) / chunkW)
}

/** World x at the centre of seat `seat`'s chunk. */
export function seatCenterX (seat, chunkW = CHUNK_W) {
  return (Number(seat) || 0) * chunkW
}

/** Global item id `<ownerId>/<ref>`. */
export function itemId (owner, ref) {
  return `${owner}/${ref}`
}

/** Split a global item id; refs may contain '/', owner ids never do. */
export function parseItemId (id) {
  const s = String(id || '')
  const i = s.indexOf('/')
  if (i <= 0) return null
  const owner = s.slice(0, i)
  const ref = s.slice(i + 1)
  const k = ref.indexOf(':')
  return { owner, ref, kind: k > 0 ? ref.slice(0, k) : null }
}

/** https base of a relay given its ws(s) URL: wss://h/ws -> https://h */
export function relayHttpBase (wsUrl = DEFAULT_RELAY) {
  try {
    const u = new URL(wsUrl)
    u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol
    return `${u.protocol}//${u.host}`
  } catch { return null }
}

/** Sprite URL for a sha on a relay. */
export function spriteUrl (base, sha) {
  return `${String(base).replace(/\/$/, '')}/s/${sha}.webp`
}

/** Normalise a room code: lower-case, [a-z0-9_-], <= 48 chars; '' -> null (auto room). */
export function normalizeRoom (room) {
  if (room == null) return null
  const r = String(room).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return r || null
}

// ---- message builders (client -> server) ----------------------------------------------------------------------

export const msg = Object.freeze({
  hello: ({ id, room = null, seat = null, dock = 'right', name, color, status = 'idle', skills = [], catalog = [],
    sprite = null, answers = true, x, z, facing, anim }) =>
    ({ t: 'hello', v: PROTOCOL_VERSION, id, room, seat, dock, name, color, status, skills, catalog, sprite, answers, x, z, facing, anim }),
  state: ({ x, z, facing, anim, status }) => ({ t: 'state', x, z, facing, anim, status }),
  bump: (side) => ({ t: 'seat', op: 'bump', side }),
  move: (to) => ({ t: 'seat', op: 'move', to }),
  unlink: () => ({ t: 'seat', op: 'unlink' }),
  catalog: (items) => ({ t: 'catalog', items }),
  fetch: ({ fid, owner, ref, as = 'text' }) => ({ t: 'fetch', fid, owner, ref, as }),
  fetched: ({ fid, to, ok, sha, text, pkg, reason }) => ({ t: 'fetched', fid, to, ok, sha, text, pkg, reason }),
  ask: ({ qid, to, question, kind = null }) => ({ t: 'ask', qid, to, question, kind }),
  answer: ({ qid, to, ok, text, share, pkg, reason }) => ({ t: 'answer', qid, to, ok, text, share, pkg, reason }),
  gift: ({ to, gid, skill }) => ({ t: 'gift', to, gid, skill }),
  fx: (kind, fields = {}) => ({ t: 'fx', kind, ...fields })
})

/** Short random id for fid / qid / gid. */
export function rid (prefix = '') {
  const a = new Uint8Array(8)
  globalThis.crypto.getRandomValues(a)
  return prefix + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}
