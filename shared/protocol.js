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
// @typedef {{ id: string, name: string, color: string, sprite: string|null, spriteSha: string|null, seat: number|null,
//             x: number, z: number, facing: 1|-1, status: string, lastSeen: number, online: boolean, away: boolean }} Agent
//             // the device registry: one agent per id, absolute world position, kept 24 h after its owner leaves.
//             // welcome.you.resumed = this id is in the registry: start your agent at you.x/z/facing, not at home.
// @typedef {[string, string]} Link     // [leftId, rightId]: two laptops physically side by side, left one first
//
// Client -> server
//   hello   { t, v, id, room|null, seat|null, dock, name, color, status, skills, catalog,
//             sprite: { sha, b64 } | { sha } | null, answers, x?, z?, facing?, anim?, device?, spectator?, sit? }
//           sit: 'side' (default, dock-linked strip) | 'across' (battleships: two 'across' panes that join or switch
//           within DOCK_PAIR_WINDOW_MS share ONE seat; the later one gets flipped: true). Agents are unaffected.
//           id = the device's stable agent id (persisted per profile). device = optional fingerprint string (<= 128,
//           e.g. sha256(machine id + profile)); used to derive the id ('d-' + 24 hex) only when id is missing.
//           One live agent per id: a second hello with the same id (reconnect, second pane, MCP overlay, restart)
//           takes the agent over; the old socket closes 4409 'replaced' and must NOT reconnect; the room sees no
//           leave/join. spectator: true = read-only watcher (no seat, not an agent): gets welcome + every room
//           broadcast and all state unfiltered, sends nothing (anything it sends is ignored).
//           room null (or a legacy auto room 'net-<8 hex>') = DEFAULT_ROOM 'dde-ldn', the one room everyone shares;
//           an explicit --room code wins and sticks. dock 'none' = headless/probe client: never dock-linked.
//           seat = the last seat (reconnect) or --seat; welcome is authoritative.
//           sprite: send b64 once; afterwards { sha } alone is enough if the relay still has it.
//   state   { t, x, z, facing, anim, status }      <= 10 Hz while moving, 1 Hz heartbeat otherwise
//   seat    { t, op: 'bump', side: 'left'|'right' } pet dragged onto that edge of its own pane; a matched bump follows
//                                                 the nextTo rule (the later bumper moves beside the other)
//           { t, op: 'move', to }                   arrows / tray Seat: swap with whoever holds seat `to`
//           { t, op: 'nextTo', target }             co-work: sit me right beside target (agent id or name); the
//                                                 target stays. Docked right -> I sit on its LEFT, docked left ->
//                                                 RIGHT, floating -> whichever side is free (right first). If my
//                                                 side has a co-worker I take the other; both taken -> nearest free
//                                                 seat, why 'full'. Unknown target: a seat to me only, shrug, reason.
//           { t, op: 'share', to } or { t, op: 'move', to, flip: true }   share seat `to` facing the other way
//           { t, op: 'bump', side, share: true }    bump fallback for 'across': the later bumper shares the seat
//           { t, op: 'unlink' }                     tray Unlink: drop this laptop's links and any across pairing
//   sit     { t, sit: 'side'|'across', unlink? }   change how this pane sits; in a pair, only with unlink: true
//   catalog { t, items: Item[] }                    on change, at most every 5 s
//   fetch   { t, fid, owner, ref, as: 'text'|'pkg' }
//   fetched { t, fid, to, ok, sha, text?, pkg?, reason? }    owner's reply to a forwarded fetch
//   ask     { t, qid, to, question, kind? }
//   answer  { t, qid, to, ok, text, share?, pkg?, reason? }  reason 'busy' = re-route once
//   gift    { t, to, gid, skill: { id, name, description, files: [{ path, b64 }] } }
//   fx      { t, kind: FX_KINDS[number], ...anything }  learned: { kind:'learned', skill: Skill } also updates skills
//   layout? { t: 'layout?' }                       ask for the full layout (send when a layout heartbeat's v differs
//                                                 from the last v you applied; spectators may send it too)
//
// Server -> client
//   welcome { t, v, room, you: { id, seat, x, z, facing, resumed, takeover }, peers: Peer[] /* online, not you */,
//             away: Away[] /* + x, z, facing, sprite, seat, status, away: true */, agents: Agent[] /* registry, not you */,
//             links: Link[],
//             seats: { [id]: seat } /* online */, held: { [id]: seat } /* away, seat held 10 min */ }
//   join    { t, v, peer: Peer }
//   leave   { t, v, id, lastSeen, away?, x?, z?, facing? }   away: true = it stays in the world, napping at x/z
//           (catalog stays searchable) for 24 h; it never moves until its owner is back. No away = gone (a probe).
//   state   { t, v, pets: [{ id, x, z, facing, anim, status, away? }] }   room batch every 100 ms, changed pets only,
//                                                 never your own; above 16 members only pets in your chunk +-1
//   seat    { t, v, seats, held, flipped: { [id]: true }, across: [[hostId, flippedId]], links, why, ids?,
//             neighbours: { [paneId]: { left: id|null, right: id|null, across: id|null } }, cowork?: [leftId, rightId],
//             via?: 'bump', shrug?, reason? }
//           why 'cowork' (nextTo or bump) / 'dock' (auto co-work) with cowork = the new pair: play the handshake.
//           Auto co-work on join: opposite docks within DOCK_PAIR_WINDOW_MS, else the same public IP (venue NAT).
//           two panes may hold the same seat only as an across pair (exactly one flipped). welcome carries the
//           same seats/held/flipped/across, and you.flipped / you.sit.
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
//   layout  { t, v /* = LAYOUT version, not the protocol version */, layoutVersion, seats, held, flipped, across,
//             links, neighbours, sits: { [id]: 'side'|'across' } }   the relay is the single source of truth for the
//           room layout; every change bumps v (monotonic per room, persisted, never below the wall clock) and sends
//           one full layout. Every 10 s a heartbeat { t:'layout', v, layoutVersion, beat: true } carries only v: if it
//           differs from yours, send layout? and apply the full reply. welcome.layout carries the full layout too, and
//           seat messages carry layoutVersion. Apply a layout wholesale (it replaces seats/flips/links/sits).
//   sit     { t, sit, corrected: true }       the relay corrected your sit to match your pair (apply it; don't fight)
//           Pairs agree: the initiator's sit wins (nextTo/bump/share/auto); a sit that contradicts your pair is
//           corrected, not split. To leave a pair send { t:'sit', sit, unlink: true } or seat { op:'unlink' }.
//           Auto pairing on join: face to face (opposite docks) within the window or on the same public IP; both side
//           -> co-work link; either across -> both across (one seat, the newcomer flipped).
//
// HTTP on the same host: GET /healthz -> 200 JSON; GET /s/<sha>.webp -> sprite bytes (immutable, CORS open).
// ---------------------------------------------------------------------------------------------------------------

export const PROTOCOL_VERSION = 2
export const V = PROTOCOL_VERSION

// Relays in failover order. Rooms are per relay, so every client must walk this list in the same order:
// start at RELAYS[0] on every (re)connect round, move to the next one only when a connect fails (no open within
// OPEN_TIMEOUT_MS, or closed before welcome), and while on a later relay probe RELAYS[0]/healthz every
// PRIMARY_PROBE_MS and move back when it answers. Two laptops on the same list therefore land on the same relay.
// PETPACK_RELAY / --relay replaces the list (a comma-separated value is a list).
export const RELAYS = Object.freeze([
  'wss://petpack-relay.azurewebsites.net/ws', // primary: App Service, centralus
  'wss://petpack-relay-2.jollystone-fb76cb03.eastus2.azurecontainerapps.io/ws' // secondary: Container Apps, eastus2
])
export const DEFAULT_RELAY = RELAYS[0]
export const WS_PATH = '/ws'
// One unified room for the hackathon (operator, 14:4xZ): every client without an explicit --room lands here.
export const DEFAULT_ROOM = 'dde-ldn'
export const LEGACY_AUTO_ROOM = /^net-[a-f0-9]{8}$/
// Test clients never land in (or persist into) the shared room: dock 'none' (headless probes), test: true, or a
// --profile that looks like a test run go to SCRATCH_ROOM, which is never written to the relay's snapshot.
export const SCRATCH_ROOM = 'dde-ldn-scratch'
export const TEST_PROFILE = /^(it-|s1|rel|smoke|l2|pair)/i
export function isTestHello (h) {
  return !!h && (h.test === true || h.dock === 'none' || (typeof h.profile === 'string' && TEST_PROFILE.test(h.profile)))
}
export const LAYOUT_HEARTBEAT_MS = 10000
export const OPEN_TIMEOUT_MS = 4000
export const PRIMARY_PROBE_MS = 15000

/** The relay list for an override (string, comma-separated string or array); no override = RELAYS. */
export function relayList (override) {
  const list = Array.isArray(override) ? override : String(override ?? '').split(',')
  const out = list.map((s) => String(s).trim()).filter(Boolean)
  return out.length ? out : [...RELAYS]
}

/** http(s) health URL of a relay ws URL. */
export function healthUrl (wsUrl) {
  const base = relayHttpBase(wsUrl)
  return base ? `${base}/healthz` : null
}

export const CHUNK_W = 14

export const T = Object.freeze({
  hello: 'hello', welcome: 'welcome', join: 'join', leave: 'leave',
  state: 'state', seat: 'seat', catalog: 'catalog',
  fetch: 'fetch', fetched: 'fetched', ask: 'ask', answer: 'answer',
  gift: 'gift', fx: 'fx', sit: 'sit'
})

export const CLIENT_TYPES = Object.freeze(['hello', 'state', 'seat', 'catalog', 'fetch', 'fetched', 'ask', 'answer', 'gift', 'fx', 'sit', 'layout?'])
export const SERVER_TYPES = Object.freeze(['welcome', 'join', 'leave', 'state', 'seat', 'layout', 'sit', 'catalog', 'fetch', 'fetched', 'ask', 'answer', 'gift', 'fx'])

export const FX_KINDS = Object.freeze(['seek', 'gift', 'learned', 'ask', 'think', 'answer', 'fetch', 'pulse', 'bump', 'wave', 'say'])
export const SEAT_OPS = Object.freeze(['bump', 'move', 'share', 'nextTo', 'unlink'])
export const SEAT_WHY = Object.freeze(['dock', 'cowork', 'full', 'across', 'bump', 'move', 'join', 'leave', 'unlink', 'sit'])
export const ITEM_KINDS = Object.freeze(['skill', 'memory', 'technique', 'resource'])
export const LANDMARK_OF = Object.freeze({ skill: 'workshop', memory: 'library', technique: 'dojo', resource: 'campfire' })
export const STATUSES = Object.freeze(['idle', 'working', 'waiting', 'done', 'failed'])
export const ANIMS = Object.freeze(['idle', 'run', 'wave', 'jump', 'failed', 'waiting', 'review'])
export const DOCKS = Object.freeze(['left', 'right', 'none'])
// How a pane sits with its neighbour: 'side' = the dock-linked strip (one seat each, side by side); 'across' =
// battleships, back to back: two panes share ONE seat/chunk, the later one flipped: true (sees it mirrored).
export const SITS = Object.freeze(['side', 'across'])
export const DOCK_PAIR_WINDOW_MS = 60 * 1000 // dock auto-link pairs right+left docked laptops that joined this close

export const CLOSE = Object.freeze({
  normal: 1000,
  badFrame: 4400,
  replaced: 4409,   // the same id connected again; the newer socket wins and the old client stops (no reconnect)
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

/** Normalise a room code: lower-case, [a-z0-9_-], <= 48 chars; '' -> null (= DEFAULT_ROOM). */
export function normalizeRoom (room) {
  if (room == null) return null
  const r = String(room).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return r || null
}

/** The room a hello lands in: an explicit code wins; none, or a legacy per-network 'net-<8 hex>' room, is DEFAULT_ROOM. */
export function roomFor (room) {
  const r = normalizeRoom(room)
  return !r || LEGACY_AUTO_ROOM.test(r) ? DEFAULT_ROOM : r
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
  nextTo: (target) => ({ t: 'seat', op: 'nextTo', target }),
  share: (to) => ({ t: 'seat', op: 'share', to }),
  sit: (sit) => ({ t: 'sit', sit }),
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
