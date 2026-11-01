// The pack brain: simulates this laptop's own agent (plus local demo bots), broadcasts its
// state, mirrors peers, and turns MCP tool calls into visible errands. No DOM, no three:
// `node --test` drives it with a fake relay and a fake clock (brain.tick(dt)).
//
// Events: brain.on(name, cb) -> unsubscribe. Every view callback name also fires here, plus:
//   'visitor-enter' / 'visitor-leave' ({ id, name, bot })  another pet walks into / out of this seat's chunk
//   'knock'     (id, on)                                   a pet knocks (on=true) or stops; ours when Codex waits
//   'involved'  ({ kind, with })                           a gift, fetch, ask or errand touches our own pet
//                                                          (kind: 'gift'|'fetch'|'ask'|'errand'|'asked')
//   'online'    ({ room, seat } | null)                    joined a relay / went solo
//   'dnd'       (on)                                       heads-down changed: fold the pane, mute sound
//   'permission'     ({ id, from, fromName, ref, kind, title, text, expiresAt })  share mode 'ask': show text with ✓/✗
//   'permission-end' ({ id, allowed, reason })            decided, declined or timed out (30 s): hide it
//   'errand'    (snapshot)                                 a find errand moved on (same shape as errand(id))
//   'sharing'   ({ mode, items })                          share settings changed
//   'need'      ({ need, item })                           our stuck Codex session's need matched a team item
//   'flip'      (on)                                       this pane sits 'across' and is the flipped one:
//                                                          call world.setFlip?.(on)
//   'sit'       ('side'|'across')                          seating changed (setSit)
//   'replaced'  ()                                         another pane of ours took this agent over; stay quiet
//   'neighbours' ({ left, right, across })                 each { id, name } | null: draw "← Bea" / "Bea →" edge
//                                                          tags, or a soft "no one next to you yet" when both are null
//   'handshake' ({ seat, side })                           a new co-work pair / dock link (deduped per partner)
//   'step'      ({ callId, text })                         live progress of petpack_ask / get / find for Codex
//                                                          ("walking to Bea's screen", "Bea is thinking", "got
//                                                          Bea's pdf skill -> <path>"); callId comes from the args
//   'lesson'    (item)                                     a working -> done session left a card in our catalog
//   'remove'    (id)                                       a leftover agent the relay no longer lists (welcome
//                                                          registry / full layout); it also leaves pets()
//   'inbox'     ({ id, from, fromName, question })         a teammate's question our catalog can't answer at once
//   'leader'    (id | null, previousId | null)             today's most helpful agent changed: pets() marks it trophy: true
//   'helped'    ({ day, answers, shares, at })             our own help count went up: persist it for a restart
//   showMe() -> { ok, with, item, kind, question, answer, says, installed, message }: the core journey for real
//     with our co-work neighbour (else the nearest online peer): walk over, ask about one of their real items,
//     answer, dot, install, "learned X", walk home, celebrate.
//   On Codex working -> done: bridge.lessonFromSession() -> card published to the room catalog + a Library flower.
//   'sleep'     (id, on)                                   also fires for registry agents that are away: they nap
//                                                          in place (pets() marks them away: true) and never move
//
// API for WIRE (besides tick/handle/call/pets/hello/on):
//   recall() -> { busy, message }        free: walks home now; busy: "busy helping Bea, back soon", home after
//   leaderboard(limit = 5) -> [{ id, name, answers, shares, total, at, isMe }]  today's helpers, most helpful first
//     (answers given + items served or gifted; each agent reports its own over fx 'score'); leader getter.
//     config.helped { day, answers, shares, at } seeds today's own count.
//   setHelpVisits(on) -> on; helpVisits  opt-in: while our Codex is idle/done, our pet visits a teammate whose Codex
//                                        has been failed 8 s or waiting 45 s (nearest first, 5 min apart per person),
//                                        offers a hand, brings a freely shared skill, stays until they move on (40 s
//                                        at most). config.helpVisits seeds it.
//   setDnd(on) -> on; dnd                no visits/gifts, pet stays home, asks get "<name> is heads-down right now";
//                                        pets() carries dnd per pet (draw a small DND sign over those pets)
//   setSharing({ mode: 'free'|'ask'|'never', items: { [ref]: true|false } }); sharing
//   decide(id, allow) -> bool; permissions   answer / list pending share requests
//   find({ question, kind? }) -> { id, status, step }; errand(id?) -> snapshot | null   (latest when no id)
//      snapshot: { id, question, kind, status: 'running'|'done'|'failed', step, findings: [{ owner, id?, kind, title?,
//                  summary?, text?, answer?, installed?, error? }], installed: [path], message, startedAt, finishedAt }
//   MCP (through call): petpack_recall, petpack_find {question, kind?}, petpack_errand {id?}; petpack_status {quiet?}
//   bridge.currentNeed() is polled every ~45 s while our pet is free (no wiring needed beyond the bridge method).
//   config.sharing / config.dnd seed the initial settings.
//   setSit('side'|'across') -> sit; sit, flipped, acrossWith, replaced getters. config.sit / config.device go in hello.
//   Resume: a welcome with you.resumed / you.takeover starts our pet at you.x/z/facing (not at home).
//   Layout: the relay's versioned layout (welcome.layout, layout broadcasts) is applied wholesale, newer v only; a
//     10 s heartbeat with another v sends layout?; seat messages older than the held layout are ignored.
//   coworkWith(idOrName) -> { ok, pending, message, target? }: relay {op:'nextTo'}; until that person is online it
//     retries on every welcome/join (config.nextTo = --next-to <name> does the same at start). neighbours getter.
//   With a neighbour, our free pet visits their screen every ~45-90 s along the road (wave, collab, a real dot when
//   we share one freely), then walks home; gifts go to neighbours first.
import { createTerrain, createStripNavigation, ROAD_Z } from './world/map-paths.js'
import { createLife } from './life.js'

export const CHUNK_W = 14
export const WALK_SPEED = 4 // u/s on a seated (visible) chunk: ~3.5 s per pane
export const FAST_FORWARD = 4 // gap chunks nobody shows are crossed 4x faster
export const KINDS = ['skill', 'memory', 'technique', 'resource']
export const DISPLAY_DELAY_MS = 250 // the shared timeline every pane draws at (owner included)
const DOT_COLORS = { skill: '#ffcd78', memory: '#9be5d5', technique: '#d8d1fb', resource: '#ffc88a' }
const PALETTE = ['#6d99e5', '#df706d', '#80b291', '#e3a857', '#a98bd8', '#5fb7b0', '#d8799f', '#8fa65a']
const mod = (n, d) => ((n % d) + d) % d
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

export const chunkOf = x => Math.floor(x / CHUNK_W + 0.5)
export const kindAt = i => KINDS[mod(i, 4)]
export const landmarkOf = i => ({ x: i * CHUNK_W, z: ROAD_Z, kind: kindAt(i) })

export function fnv1a(text) {
  let h = 0x811c9dc5
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
export const colorFor = id => PALETTE[fnv1a(id) % PALETTE.length]

/** Item ids read as short human titles: 'gh-address-comments' -> 'address comments' (max ~22 chars). */
export function shortTitle(text, max = 22) {
  let s = String(text || '').trim().replace(/^(skill|memory|technique|resource):/i, '')
  if (!/\s/.test(s)) s = s.replace(/[-_.]+/g, ' ') // slugs only; natural titles keep their hyphens
  s = s.replace(/^(gh|github|git|codex|petpack|skill|note)\s+/i, '').replace(/\s+/g, ' ').trim()
  return clip(s, max)
}
/** Bubble text: one line, cut at a word boundary. */
export function bubbleText(text, max = 44) {
  let s = String(text || '').replace(/\s+/g, ' ').trim()
  const slug = s.match(/^([a-z0-9]+(?:[-_][a-z0-9]+)+):\s+(.+)$/i) // tier-1 "slug: summary"
  if (slug) s = slug[2]
  return clip(s, max)
}
function clip(s, max) {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')}…`
}

/** One giver per (skill, receiver): the holder with the lowest fnv1a(skill|receiver|giver). */
export function pickGiver(skill, receiver, holders) {
  let best = null, bestHash = Infinity
  for (const giver of holders) {
    if (giver === receiver) continue
    const h = fnv1a(`${skill}|${receiver}|${giver}`)
    if (h < bestHash || (h === bestHash && giver < best)) { best = giver; bestHash = h }
  }
  return best
}

const STOP = new Set(('a an the and or but of to in on at for with from by is are was were be been do does did how what why ' +
  'when where who which can could should would will i we you me my our your it its this that these those there here ' +
  'please help need want get make use using about into any some have has had not no yes so if then than just also').split(' '))
function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1)
  return word
}
export function tokens(text) {
  const out = new Set()
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue
    out.add(stem(raw))
  }
  return out
}
/** Token overlap of the query with an item: title counts fully, summary half, plus a kind bonus. */
export function scoreItem(query, item, kind) {
  const q = query instanceof Set ? query : tokens(query)
  if (!q.size || !item) return 0
  const title = tokens(`${item.title || ''} ${String(item.ref || '').split(':').slice(1).join(' ')}`)
  const summary = tokens(item.summary)
  let hit = 0
  for (const t of q) hit += title.has(t) ? 1 : summary.has(t) ? 0.5 : 0
  let score = hit / Math.min(q.size, 4)
  if (score > 0 && kind && item.kind === kind) score += 0.2
  return Math.min(1.5, score)
}

function normalizeItems(list) {
  const items = Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : []
  return items.filter(item => item && typeof item.ref === 'string').map(item => ({
    ref: item.ref, kind: KINDS.includes(item.kind) ? item.kind : String(item.ref).split(':')[0] || 'memory',
    title: String(item.title || item.ref), summary: String(item.summary || '').slice(0, 240),
    bytes: item.bytes || 0, sha: item.sha || '', mtime: item.mtime || 0,
  }))
}
function ageText(mtime, now) {
  if (!mtime) return 'unknown'
  const s = Math.max(0, now - (mtime > 1e11 ? mtime : mtime * 1000)) / 1000
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172800) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} d`
}

/** Search the mirrored catalogs. owners: [{id,name,online,catalog,lastSeen}] */
export function searchCatalogs(query, owners, { kind, limit = 3, now = Date.now() } = {}) {
  const q = tokens(query)
  const hits = []
  for (const owner of owners) for (const item of owner.catalog || []) {
    if (kind && item.kind !== kind) continue
    const score = scoreItem(q, item, kind)
    if (score > 0) hits.push({ score, owner, item })
  }
  hits.sort((a, b) => b.score - a.score || Number(b.owner.online) - Number(a.owner.online))
  return hits.slice(0, Math.max(1, Math.min(20, Number(limit) || 3))).map(({ owner, item, score }) => ({
    id: `${owner.id}/${item.ref}`, kind: item.kind, title: item.title, summary: item.summary,
    owner: owner.name, online: !!owner.online, age: ageText(item.mtime, now), score: Math.round(score * 100) / 100,
  }))
}

/** R5 routing: best item owner, else the nearest free peer; `to` overrides. */
export function routeAsk({ question, kind, to }, peers, mySeat = 0) {
  const online = peers.filter(p => p.online !== false)
  if (to) {
    const want = String(to).toLowerCase()
    const target = online.find(p => p.id === to || String(p.name).toLowerCase() === want)
    if (target) return { target, item: null, score: 0, why: 'to' }
  }
  const q = tokens(question)
  let best = null
  for (const peer of online) for (const item of peer.catalog || []) {
    const score = scoreItem(q, item, kind)
    if (!best || score > best.score) best = { target: peer, item, score }
  }
  if (best && best.score >= 0.3) return { ...best, why: 'item' }
  const free = online.filter(p => p.status === 'idle' || p.status === 'done' || !p.status)
  const pool = free.length ? free : online
  if (!pool.length) return null
  const near = pool.slice().sort((a, b) => Math.abs((a.seat ?? 0) - mySeat) - Math.abs((b.seat ?? 0) - mySeat))[0]
  return { target: near, item: best?.target === near ? best.item : null, score: best?.score || 0, why: 'free' }
}

/** Tier 1 (bots only ever answer this way): the best own item, never an exec. */
export function tier1Answer(question, kind, catalog, { strict = true } = {}) {
  const q = tokens(question)
  let best = null
  for (const item of catalog || []) {
    const score = scoreItem(q, item, kind)
    if (!best || score > best.score) best = { item, score }
  }
  if (best && best.score >= 0.5) return { ok: true, tier: 1, text: `${best.item.title}: ${best.item.summary}`.slice(0, 1200), item: best.item }
  if (strict || !best) return null
  return { ok: true, tier: 1, text: `Closest thing I have: ${best.item.title}. ${best.item.summary}`.slice(0, 1200), item: best.item }
}

/** The landmark of that kind if within one chunk of the owner, else the owner's own landmark. */
export function meetLandmark(kind, ownerChunk) {
  if (KINDS.includes(kind)) for (const d of [0, -1, 1]) if (kindAt(ownerChunk + d) === kind) return landmarkOf(ownerChunk + d)
  return landmarkOf(ownerChunk)
}

// ---- demo bots: starter skills, notes and AGENTS-style memories, tier 1 only ----
const b64 = text => (typeof Buffer !== 'undefined' ? Buffer.from(text, 'utf8').toString('base64')
  : btoa(unescape(encodeURIComponent(text))))
export const BOT_SPECS = [
  { id: 'bot-cleo', name: 'Cleo', color: '#df706d', kind: 'cat', items: [
    { ref: 'skill:azure-deploy', kind: 'skill', title: 'azure-deploy', summary: 'Ship a Node app to Azure App Service with zip deploy, websockets on, and a /healthz check.' },
    { ref: 'memory:windows-click-through', kind: 'memory', title: 'Windows click-through', summary: 'setIgnoreMouseEvents(true, {forward:true}) on Windows, then poll the cursor because forwarding drops after reloads.' },
    { ref: 'resource:github-mcp', kind: 'resource', title: 'github MCP server', summary: 'mcp_servers.github: npx @modelcontextprotocol/server-github, env GITHUB_TOKEN.' },
  ] },
  { id: 'bot-fern', name: 'Fern', color: '#80b291', kind: 'sprout', items: [
    { ref: 'skill:pdf-tables', kind: 'skill', title: 'pdf-tables', summary: 'Extract tables from PDF files into CSV with pdfplumber, keeping merged header cells.' },
    { ref: 'technique:review-checklist', kind: 'technique', title: 'review checklist', summary: 'Before a PR: run the tests once, read the diff top to bottom, check error paths and names.' },
    { ref: 'memory:electron-transparent', kind: 'memory', title: 'Electron transparent windows', summary: 'Transparent windows must be frameless and not resizable; DevTools docked breaks transparency on Windows.' },
  ] },
  { id: 'bot-bolt', name: 'Bolt', color: '#e3a857', kind: 'robot', items: [
    { ref: 'skill:three-pixel-art', kind: 'skill', title: 'three-pixel-art', summary: 'Render three.js scenes at low resolution with nearest upscale and toon ramps for crisp pixel art.' },
    { ref: 'technique:flaky-tests', kind: 'technique', title: 'flaky test triage', summary: 'Re-run the failing test alone with a fixed seed, then bisect timers and shared state before retrying.' },
    { ref: 'memory:websocket-reconnect', kind: 'memory', title: 'websocket reconnect', summary: 'Back off 1-2-4-8-15 s with jitter, resend hello with id and last seat, and treat welcome as truth.' },
  ] },
]
export const BOT_QUESTIONS = [
  { question: 'how do I extract tables from a PDF?', kind: 'skill' },
  { question: 'websocket keeps dropping, how should we reconnect?', kind: 'memory' },
  { question: 'any pixel art tricks for three.js?', kind: 'skill' },
  { question: 'how do we ship this to Azure?', kind: 'skill' },
  { question: 'tests are flaky, where do I start?', kind: 'technique' },
]
export function botSkillPkg(bot, item) {
  const name = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'skill'
  const text = `---\nname: ${name}\ndescription: ${item.summary.replace(/\n/g, ' ')}\n---\n\n# ${item.title}\n\n${item.summary}\n\nShared by ${bot.name}'s agent in petpack.\n`
  return { id: name, name, description: item.summary, files: [{ path: 'SKILL.md', b64: b64(text) }] }
}

// ---- the brain ----
export function createBrain({ bridge = {}, net = null, view = {}, me = {}, config = {}, random = Math.random } = {}) {
  const demo = !!config.demo
  const nav = createStripNavigation(createTerrain({ seed: 77, chunkWidth: CHUNK_W }))
  let time = 0 // brain seconds, advanced only by tick()
  let wall = () => Date.now()
  let mySeat = Number.isInteger(config.seat) ? config.seat : 0
  let room = config.room || null
  let online = false
  const seats = new Map() // id -> seat for members (me + online peers)
  const peers = new Map() // remote members, online or away
  const agents = new Map() // locally simulated: me + bots
  const waits = new Set() // { at, resolve, job }
  const pendingFetch = new Map() // fid -> { resolve, timer }
  const pendingAsk = new Map() // qid -> { resolve, target, ... }
  const inbox = new Map() // qid -> { id, from, fromName, question, kind, at, answered }
  const giftLog = new Map() // receiver id -> { last, count }
  const listeners = new Map() // name -> Set(cb), see Events at the top
  const emit = (name, ...args) => {
    try { view[name]?.(...args) } catch (error) { console.warn('petpack view', name, error) }
    for (const cb of listeners.get(name) || []) { try { cb(...args) } catch (error) { console.warn('petpack on', name, error) } }
  }
  const on = (name, cb) => {
    if (typeof cb !== 'function') return () => {}
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name).add(cb)
    return () => listeners.get(name)?.delete(cb)
  }
  let seq = 0
  const uid = prefix => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(random() * 1e6).toString(36)}`

  const myId = me.id || 'me'
  const mine = makeAgent({ id: myId, name: me.name || 'Pip', color: me.color || colorFor(myId), kind: 'cat',
    home: mySeat, isMe: true, spriteUrl: me.spriteUrl || null, skills: me.skills || [], catalog: normalizeItems(me.catalog) })
  mine.atlas = me.atlas || null // real Codex sheets may be 8x11; the world crops by this grid
  agents.set(myId, mine)
  seats.set(myId, mySeat)
  let codexStatus = 'idle'
  let statusSince = 0
  const life = createLife({ map: nav, me: myId, now: () => time, seed: myId, moments: false })
  let lastSent = { at: -Infinity, key: '' }
  let lastCatalogSent = -Infinity
  let catalogDirty = false

  function makeAgent({ id, name, color, kind, home, isMe = false, isBot = false, spriteUrl = null, skills = [], catalog = [] }) {
    const spot = homeSpot(home)
    return { id, name, color, kind, home, isMe, isBot, spriteUrl, skills: skills.slice(), catalog, hist: [],
      x: spot.x, z: spot.z, route: [], walk: null, facing: 1, speed: 0, hurry: false,
      mode: 'home', job: null, anim: null, animUntil: 0, wanderAt: 0, visitAt: 45 + random() * 45,
      pauseUntil: 0, faceTo: null, giftBusy: false, giftReadyAt: 4, botErrandAt: 20 + random() * 25,
      status: 'idle', answering: 0, lastAnswer: 0 }
  }
  function homeSpot(chunk) {
    const c = chunk * CHUNK_W
    const options = [{ x: c - 4 + random() * 2, z: ROAD_Z }, { x: c + 2.5 + random() * 2, z: ROAD_Z },
      { x: c - 1.4 + random() * 2.8, z: ROAD_Z + 0.6 + random() * 0.6 }, { x: c - 5 + random() * 10, z: ROAD_Z - 0.6 + random() * 1.2 }]
    return options[Math.floor(random() * options.length)]
  }
  const seatedChunks = () => {
    const set = new Set(seats.values())
    return set
  }
  let seatedCache = null
  function speedAt(x, agent) {
    if (!seatedCache) seatedCache = seatedChunks()
    const base = seatedCache.has(chunkOf(x)) ? WALK_SPEED : WALK_SPEED * FAST_FORWARD
    return base * (agent?.hurry ? 1.6 : 1)
  }

  // ---- members (everyone the brain can see) ----
  function member(id) {
    if (agents.has(id)) {
      const a = agents.get(id)
      return { id, name: a.name, color: a.color, x: a.x, z: a.z, seat: a.isMe ? mySeat : a.home, status: a.status,
        catalog: a.catalog, skills: a.skills, online: true, local: true, isBot: a.isBot }
    }
    const p = peers.get(id)
    if (!p) return null
    const s = p.samples.at(-1)
    return { id, name: p.name, color: p.color, x: s?.x ?? (p.seat ?? 0) * CHUNK_W, z: s?.z ?? ROAD_Z, seat: p.seat,
      status: p.status, catalog: p.catalog, skills: p.skills, online: p.online, lastSeen: p.lastSeen, local: false }
  }
  function members({ includeMe = false, onlineOnly = false } = {}) {
    const out = []
    for (const id of agents.keys()) if (includeMe || id !== myId) out.push(member(id))
    for (const id of peers.keys()) { const m = member(id); if (!onlineOnly || m.online) out.push(m) }
    return out
  }

  // ---- jobs: async choreography driven by tick time ----
  function sleep(seconds, job) {
    return new Promise(resolve => waits.add({ at: time + seconds, resolve, job }))
  }
  function walkTo(agent, target, job, { near = 0.08, timeout = 90 } = {}) {
    return new Promise(resolve => {
      if (agent.walk) agent.walk.resolve(false)
      agent.walk = { target, job, resolve, goal: null, near, until: time + timeout }
      planWalk(agent, true)
    })
  }
  function goalOf(walk) {
    const g = typeof walk.target === 'function' ? walk.target() : walk.target
    return g && Number.isFinite(g.x) && Number.isFinite(g.z) ? g : null
  }
  function planWalk(agent, force) {
    const walk = agent.walk
    const goal = goalOf(walk)
    if (!goal) return
    if (!force && walk.goal && dist(goal, walk.goal) < 0.4) return
    walk.goal = { x: goal.x, z: goal.z }
    agent.route = nav.path(agent, goal).map(p => ({ x: p.x, z: p.z }))
    while (agent.route.length && dist(agent, agent.route[0]) < 1e-6) agent.route.shift()
  }
  function startJob(agent, mode, fn, withName = null) {
    cancelJob(agent)
    const job = { mode, cancelled: false }
    agent.job = job
    agent.mode = mode
    agent.jobWith = withName // whom this job helps (recall says "busy helping Bea")
    agent.lifeAct = null // a job's own moments (wave, gifts) are not LIFE acts
    Promise.resolve().then(() => fn(job)).catch(error => console.warn('petpack job', mode, error)).finally(() => {
      if (agent.job === job) { agent.job = null; agent.mode = 'home'; agent.hurry = false }
    })
    return job
  }
  function cancelJob(agent) {
    const job = agent.job
    if (!job) return
    job.cancelled = true
    agent.job = null
    agent.mode = 'home'
    if (agent.walk && agent.walk.job === job) { agent.walk.resolve(false); agent.walk = null; agent.route = [] }
    for (const w of waits) if (w.job === job) { waits.delete(w); w.resolve(false) }
  }
  async function goHome(agent, job) {
    agent.mode = 'return'
    const spot = homeSpot(agent.isMe ? mySeat : agent.home)
    return walkTo(agent, spot, job)
  }
  function setAnim(agent, anim, seconds) { agent.anim = anim; agent.animUntil = time + seconds }
  const sideSpot = (agent, target, gap = 1.1) => () => {
    const t = typeof target === 'function' ? target() : target
    if (!t) return null
    const side = agent.x <= t.x ? -1 : 1
    return { x: t.x + side * gap, z: t.z }
  }

  // ---- movement ----
  function step(agent, dt) {
    const sx = agent.x, sz = agent.z
    if (agent.walk) {
      const walk = agent.walk
      if (walk.job?.cancelled || time > walk.until) { agent.walk = null; agent.route = []; walk.resolve(false) }
      else planWalk(agent, false)
    }
    let budget = dt
    while (agent.route.length && budget > 1e-6) {
      const next = agent.route[0]
      const d = dist(agent, next)
      const v = speedAt(agent.x, agent)
      const len = Math.min(d, v * budget, 0.5)
      if (d > 1e-9) { agent.x += (next.x - agent.x) * len / d; agent.z += (next.z - agent.z) * len / d }
      budget -= len / v
      if (d - len < 1e-6) { agent.x = next.x; agent.z = next.z; agent.route.shift() }
    }
    const moved = Math.hypot(agent.x - sx, agent.z - sz)
    agent.speed = dt > 0 ? moved / dt : 0
    if (Math.abs(agent.x - sx) > 1e-4) agent.facing = agent.x > sx ? 1 : -1
    else if (agent.faceTo && !agent.route.length) {
      const f = member(agent.faceTo)
      if (f && Math.abs(f.x - agent.x) > 0.05) agent.facing = f.x > agent.x ? 1 : -1
    }
    if (agent.walk && !agent.route.length) {
      // Arrived at the planned goal (the road may clamp an off-road goal): done, unless the target moved on.
      const goal = goalOf(agent.walk)
      if (!goal || !agent.walk.goal || dist(goal, agent.walk.goal) < 0.4) { const w = agent.walk; agent.walk = null; w.resolve(true) }
      else planWalk(agent, true)
    }
  }
  function idle(agent) {
    if (agent.job || agent.walk) return
    if (time < agent.pauseUntil) return
    agent.faceTo = null
    const home = agent.isMe ? mySeat : agent.home
    if (chunkOf(agent.x) !== home) { startJob(agent, 'return', job => goHome(agent, job)); return }
    if (agent.isMe) { live(agent); return }
    if (agent.route.length || time < agent.wanderAt) return
    const working = agent.status === 'working'
    if (agent.status === 'waiting' && agent.isMe) { agent.wanderAt = time + 2; return }
    const spot = homeSpot(home)
    agent.route = nav.path(agent, spot).map(p => ({ x: p.x, z: p.z }))
    agent.wanderAt = time + (working ? 0.4 + random() * 1.2 : 3 + random() * 6)
  }

  // Free time: life.js picks the next activity (work loop, cozy idle, knock, celebrate, slump), walk there, do it.
  function live(agent) {
    if (agent.route.length || time < agent.wanderAt) return
    const act = agent.lifeAct
    if (act && !act.started) {
      act.started = true
      agent.facing = act.facing
      agent.faceTo = act.with || null
      if (act.with) { agent.pauseUntil = time + act.durationS; fx('seek', { src: myId, dst: act.with }) }
      setAnim(agent, act.anim, act.durationS)
      agent.wanderAt = time + act.durationS
      for (const call of [act.fx, act.then]) if (call) fx('life', { src: myId, call })
      return
    }
    agent.lifeAct = life.next({ status: codexStatus, statusSince, seat: mySeat, x: agent.x, z: agent.z,
      peersHere: members({ onlineOnly: true }).filter(m => chunkOf(m.x) === mySeat) })
    agent.route = nav.path(agent, agent.lifeAct.goal).map(p => ({ x: p.x, z: p.z }))
    while (agent.route.length && dist(agent, agent.route[0]) < 1e-6) agent.route.shift()
  }

  // ---- effects: local + room ----
  function fx(kind, payload) {
    showFx(kind, payload)
    // Bots are local to this pane; their effects never travel.
    const local = id => id && agents.get(id)?.isBot
    if (online && !local(payload.src) && !local(payload.dst)) send({ t: 'fx', kind, ...payload })
  }
  // ---- joy: knocks, weather, celebrations, sleep, blooms, hats, handshakes, conga, throws ----
  const doneAt = new Map() // id -> wall ms of the last turn to 'done'
  const learnedCount = new Map() // id -> learned items (hat level)
  const garden = new Map() // seed -> { kind, seed, color }
  let linkKey = ''
  let lastActivity = 0
  let sleeping = false
  let lastConga = -Infinity
  const HAT_AT = [1, 3, 6, 10, 15]
  const hatLevel = n => HAT_AT.filter(k => n >= k).length
  const colorOf = id => agents.get(id)?.color || peers.get(id)?.color || colorFor(id)
  function wake() {
    lastActivity = time
    if (sleeping) { sleeping = false; fx('sleep', { src: myId, on: false }) }
  }
  function countLearned(id, by = 1) {
    const before = learnedCount.get(id) || 0
    learnedCount.set(id, before + by)
    if (hatLevel(before + by) !== hatLevel(before)) emit('hat', id, hatLevel(before + by))
  }
  // ---- leaderboard: who helped most today (answers given + items shared); the top helper wears a trophy ----
  // Each agent counts its own help and tells the room (fx 'score'); everyone repeats theirs when someone joins.
  const pad2 = n => String(n).padStart(2, '0')
  const dayKey = () => { const d = new Date(wall()); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
  const helpCount = v => Math.max(0, Math.min(9999, Math.floor(Number(v)) || 0))
  const scores = new Map() // id -> { day, answers, shares, at /* wall ms of the last help */ }
  let leaderId = null
  let scoreSentAt = -Infinity
  let leaderCheckAt = 0
  function todayScore(id) {
    const s = scores.get(id)
    return s && s.day === dayKey() ? s : null
  }
  /** Our pet (or a demo bot) helped someone: kind 'answer' (answered an ask) or 'share' (served or gave an item). */
  function creditHelp(agentId, kind) {
    const agent = agents.get(agentId)
    if (!agent) return
    const s = todayScore(agentId) || { day: dayKey(), answers: 0, shares: 0, at: 0 }
    if (kind === 'answer') s.answers++
    else s.shares++
    s.at = wall()
    scores.set(agentId, s)
    if (agent.isMe) { emit('helped', { ...s }); sendScore() }
    updateLeader()
  }
  function sendScore() {
    const s = todayScore(myId)
    if (!s || !online) return
    scoreSentAt = time
    send({ t: 'fx', kind: 'score', day: s.day, answers: s.answers, shares: s.shares, at: s.at })
  }
  function noteScore(id, p) {
    if (!id || id === myId || agents.has(id) || typeof p?.day !== 'string') return
    scores.set(id, { day: p.day.slice(0, 10), answers: helpCount(p.answers), shares: helpCount(p.shares), at: Number(p.at) || 0 })
    updateLeader()
  }
  /** Today's helpers, most helpful first (ties: whoever got there first). */
  function leaderboard(limit = 5) {
    const day = dayKey()
    const rows = []
    for (const [id, s] of scores) {
      if (s.day !== day) continue
      const a = agents.get(id)
      const p = peers.get(id)
      if (!a && !p) continue
      if (a?.isBot && online && !demo) continue // solo stand-ins never compete with the real team
      const total = s.answers + s.shares
      if (total > 0) rows.push({ id, name: a ? a.name : p.name, answers: s.answers, shares: s.shares, total, at: s.at, isMe: id === myId })
    }
    rows.sort((x, y) => y.total - x.total || x.at - y.at || (x.id < y.id ? -1 : 1))
    return rows.slice(0, Math.max(1, limit))
  }
  function updateLeader() {
    const top = leaderboard(1)[0] || null
    const next = top?.id || null
    if (next === leaderId) return
    const previous = leaderId
    leaderId = next
    emit('leader', next, previous)
    // A fresh win gets a bubble on every pane (same scores, same leader); a late score arriving quietly doesn't.
    if (top && wall() - top.at < 15000) emit('say', top.id, 'most helpful today!')
  }

  // ---- help visits (opt-in): our Codex is free and a teammate's is stuck, so our pet goes and keeps theirs company ----
  const HELP_AFTER_FAILED = 8 // s their Codex has been failed before we go
  const HELP_AFTER_WAITING = 45 // s their Codex has been waiting on its person
  const HELP_COOLDOWN = 300 // s between visits to the same teammate
  const HELP_STAY = 40 // s at most beside them
  let helpVisits = !!config.helpVisits
  let helpCheckAt = 0
  const stuckSince = new Map() // peer id -> brain time their Codex turned waiting/failed
  const helpedAt = new Map() // peer id -> brain time of our last help visit
  const isStuck = status => status === 'waiting' || status === 'failed'
  function setHelpVisits(on) {
    helpVisits = !!on
    if (!helpVisits && mine.job?.mode === 'help') {
      cancelJob(mine)
      startJob(mine, 'return', j => goHome(mine, j))
    }
    return helpVisits
  }
  /** The stuck teammate to help, nearest seat first, or null. */
  function stuckPeer() {
    let best = null
    for (const p of peers.values()) {
      if (!p.online || p.away || p.dnd || !isStuck(p.status)) { stuckSince.delete(p.id); continue }
      if (!stuckSince.has(p.id)) stuckSince.set(p.id, time)
      if (time - stuckSince.get(p.id) < (p.status === 'failed' ? HELP_AFTER_FAILED : HELP_AFTER_WAITING)) continue
      if (time - (helpedAt.get(p.id) ?? -Infinity) < HELP_COOLDOWN) continue
      const d = Number.isInteger(p.seat) ? Math.abs(p.seat - mySeat) : 999
      if (!best || d < best.d) best = { peer: p, d }
    }
    return best?.peer || null
  }
  function maybeHelp() {
    if (!helpVisits || !online || dnd || recallPending || replaced || time < helpCheckAt) return
    helpCheckAt = time + 1
    if (codexStatus !== 'idle' && codexStatus !== 'done') return
    if (mine.job && mine.job.mode !== 'visit') return // a casual stroll gives way; real errands don't
    const peer = stuckPeer()
    if (!peer) return
    helpedAt.set(peer.id, time)
    startJob(mine, 'help', job => helpVisit(mine, peer, job), peer.name)
  }
  /** Walk over, offer a hand, bring a freely shared skill they don't have, stay until their Codex moves on. */
  async function helpVisit(agent, peer, job) {
    fx('seek', { src: agent.id, dst: peer.id })
    const ok = await walkTo(agent, sideSpot(agent, () => member(peer.id)), job, { timeout: 45 })
    if (job.cancelled) return
    agent.faceTo = peer.id
    if (ok) {
      setAnim(agent, 'wave', 1.4)
      fx('say', { src: agent.id, text: 'need a hand?' })
      await sleep(1.8, job)
      if (job.cancelled) return
      fx('collab', { src: agent.id, dst: peer.id, dot: 'skill' })
      await offerSkill(agent, member(peer.id) || peer, job)
      const started = time
      const them = () => member(peer.id)
      while (!job.cancelled && them()?.online && isStuck(them()?.status) && time - started < HELP_STAY) await sleep(0.5, job)
      if (job.cancelled) return
      if (them() && !isStuck(them().status)) {
        setAnim(agent, 'jump', 1.1)
        fx('say', { src: agent.id, text: 'nice one!' })
        await sleep(1.4, job)
        if (job.cancelled) return
      }
    }
    await goHome(agent, job)
  }

  function plant(entry) {
    if (!entry?.seed || garden.has(entry.seed)) return false
    const bloom = { kind: KINDS.includes(entry.kind) ? entry.kind : 'skill', seed: String(entry.seed), color: entry.color }
    garden.set(bloom.seed, bloom)
    emit('bloom', bloom)
    return true
  }
  /** On (re)join: the garden and hats from what the room has already adopted (petpack-* items in catalogs). */
  function rebuildGarden() {
    const counts = new Map()
    const owners = [{ id: myId, catalog: mine.catalog }, ...[...peers.values()].map(p => ({ id: p.id, catalog: p.catalog }))]
    for (const owner of owners) for (const item of owner.catalog || []) {
      if (!/(^|:)petpack-/.test(item.ref)) continue
      const seed = `${owner.id}/${item.ref}`
      if (!garden.has(seed)) garden.set(seed, { kind: item.kind, seed, color: colorOf(owner.id) })
      counts.set(owner.id, (counts.get(owner.id) || 0) + 1)
    }
    emit('garden', [...garden.values()])
    for (const [id, n] of counts) if ((learnedCount.get(id) || 0) < n) { learnedCount.set(id, n); emit('hat', id, hatLevel(n)) }
  }
  function noteLinks(links) {
    const mineLinks = links.filter(l => Array.isArray(l) && l.includes(myId)).map(l => l.join('|')).sort()
    const key = mineLinks.join(',')
    if (key === linkKey) return
    const added = mineLinks.filter(l => !linkKey.split(',').includes(l))
    linkKey = key
    for (const l of added) {
      const [left] = l.split('|')
      handshakeWith(left === myId ? l.split('|')[1] : left, left === myId ? 'right' : 'left')
    }
  }
  /** Whole room done within 60 s: the lowest seat starts the conga for everyone. */
  function maybeConga(force = false) {
    if (!force && time - lastConga < 90) return false
    const everyone = members({ includeMe: true }).filter(m => m.online && !m.isBot)
    if (!force) {
      if (everyone.length < 2) return false
      const now = wall()
      if (!everyone.every(m => now - (doneAt.get(m.id) || -Infinity) < 60000)) return false
      const lowest = everyone.reduce((a, b) => ((b.seat ?? 0) < (a.seat ?? 0) ? b : a))
      if (lowest.id !== myId) return false
    }
    lastConga = time
    const ids = members({ includeMe: true }).filter(m => m.online && (force || !m.isBot)).map(m => m.id)
    fx('conga', { src: myId, ids, startAt: wall() + 1200 })
    return true
  }
  function throwPet(id, to, velocity = {}) {
    const agent = agents.get(id)
    if (!agent) return false
    cancelJob(agent)
    if (to && Number.isFinite(to.x) && Number.isFinite(to.z)) { agent.x = to.x; agent.z = to.z; agent.route = [] }
    agent.pauseUntil = time + 2
    if (agent.isMe) wake()
    if (online && !agent.isBot) send({ t: 'fx', kind: 'throw', src: id, vx: velocity.vx || 0, vz: velocity.vz || 0, from: velocity.from, to: velocity.to || to, duration: velocity.duration })
    return true
  }

  /** Other pets walking into / out of this seat's chunk (live positions, so a pane can open just ahead). */
  const visitors = new Map() // id -> { id, name, bot }
  function watchVisitors() {
    const here = new Map()
    for (const m of members()) {
      if (!m.online || !Number.isFinite(m.x)) continue
      if (Math.abs(m.x - mySeat * CHUNK_W) <= CHUNK_W / 2 + 0.6) here.set(m.id, { id: m.id, name: m.name, bot: !!m.isBot })
    }
    for (const [id, v] of here) if (!visitors.has(id)) { visitors.set(id, v); emit('visitor-enter', v) }
    for (const [id, v] of visitors) if (!here.has(id)) { visitors.delete(id); emit('visitor-leave', v) }
  }

  /** Stay at the meeting until the answer is out and the scene has played (caps keep it moving). */
  async function holdForScene(agent, job, answeredAt) {
    const started = time
    while (!job.cancelled && time - started < 30) {
      const at = answeredAt()
      const sceneDone = agent.sceneUntil && time > agent.sceneUntil
      if (at != null && (sceneDone || time - at > 12)) break
      await sleep(0.25, job)
    }
  }
  function showFx(kind, p) {
    if ((kind === 'gift' || kind === 'fetch' || kind === 'ask') && (p.src === myId || p.dst === myId)) {
      emit('involved', { kind, with: p.src === myId ? p.dst : p.src })
    }
    // Text only for the moments that matter: the question, the answer and "learned X".
    // A dot blooms in the garden where it lands; one shared seed keeps every pane's garden identical.
    const knowledge = p.seed && KINDS.includes(p.dot) ? { kind: p.dot, seed: String(p.seed) } : {}
    if (kind === 'gift' || kind === 'fetch') emit('gift', p.src, p.dst, { label: '', color: DOT_COLORS[p.dot] || DOT_COLORS.skill, ...knowledge })
    else if (kind === 'ask') emit('ask', p.src, p.dst, { question: bubbleText(p.question, 44), answer: bubbleText(p.answer, 44),
      kind: KINDS.includes(p.dot) ? p.dot : undefined, seed: p.seed ? String(p.seed) : undefined, label: '' })
    else if ((kind === 'learned' || kind === 'say') && p.text && p.src) emit('say', p.src, bubbleText(p.text, 30))
    else if (kind === 'wave' && p.src && agents.has(p.src)) setAnim(agents.get(p.src), 'wave', 1.4)
    else if (kind === 'collab' && p.src && p.dst) emit('collab', p.src, p.dst, { kind: KINDS.includes(p.dot) ? p.dot : 'skill', label: '' })
    else if (kind === 'knock') emit('knock', p.src, p.on !== false)
    else if (kind === 'weather') emit('weather', p.src, p.w === 'rainbow' ? 'rainbow' : 'rain')
    else if (kind === 'celebrate') emit('celebrate', p.src)
    else if (kind === 'sleep') emit('sleep', p.src, p.on !== false)
    else if (kind === 'life' && p.call && typeof p.call.method === 'string') emit('life', p.call)
    else if (kind === 'conga' && Array.isArray(p.ids)) emit('conga', p.ids, p.startAt)
    else if (kind === 'throw') emit('throwPet', p.src, { vx: p.vx || 0, vz: p.vz || 0, ...(p.from ? { from: p.from } : {}), ...(p.to ? { to: p.to } : {}), ...(p.duration ? { duration: p.duration } : {}) })
    if (kind === 'learned' && p.src) {
      countLearned(p.src)
      if (p.bloom) plant({ ...p.bloom, color: colorOf(p.src) })
    }
    if (kind === 'learned' && p.src && p.skill) {
      const peer = peers.get(p.src)
      if (peer && !peer.skills.some(s => s.name === p.skill.name)) peer.skills.push(p.skill)
    }
    if (kind === 'ask' && p.dst && agents.has(p.dst)) agents.get(p.dst).sceneUntil = time + 4.5
    if (kind === 'seek' && p.dst && agents.has(p.dst)) {
      const target = agents.get(p.dst)
      if (!target.job) { target.route = []; target.pauseUntil = time + 15; target.faceTo = p.src }
    }
    if (kind === 'gift' && p.dst) {
      const log = giftLog.get(p.dst) || { last: -Infinity, count: 0 }
      log.last = time; log.count++
      giftLog.set(p.dst, log)
    }
  }
  function send(msg) {
    if (!net || !online) return false
    try { return net.send({ v: 2, ...msg }) !== false } catch { return false }
  }

  // ---- own status from Codex ----
  function setStatus(status) {
    if (!['idle', 'working', 'waiting', 'done', 'failed'].includes(status) || status === codexStatus) return
    const previous = codexStatus
    codexStatus = status
    mine.status = status
    statusSince = time
    mine.lifeAct = null; mine.wanderAt = 0; mine.pauseUntil = 0; mine.anim = null
    if (!mine.job) mine.route = []
    // Joy: the moments every pane shares.
    wake()
    if (status === 'waiting') fx('knock', { src: myId, on: true })
    else if (previous === 'waiting') fx('knock', { src: myId, on: false })
    if (status === 'done' && previous === 'failed') fx('weather', { src: myId, w: 'rainbow' })
    else if (status === 'done') fx('celebrate', { src: myId })
    if (status === 'failed') fx('weather', { src: myId, w: 'rain' })
    if (status === 'done') doneAt.set(myId, wall())
    if (status === 'done' && previous === 'working') publishLesson()
    if (status === 'waiting') {
      // Hurry home so "waiting on you" shows on the owner's own screen.
      cancelJob(mine)
      mine.pauseUntil = 0
      mine.hurry = true
      startJob(mine, 'return', async job => { await goHome(mine, job); mine.hurry = false })
    } else if (status === 'done' && previous !== 'done') {
      setAnim(mine, 'jump', 1.2)
      Promise.resolve().then(() => sleep(1.2)).then(() => { if (codexStatus === 'done') setAnim(mine, 'wave', 1.8) })
    }
    sendState(true)
  }
  // Codex pet parity for our own pet (the Codex app's rows): working -> the work pose ('review' row; the atlas's
  // 'running' row 7 needs a world anim name first), waiting -> 'waiting' (+ red clock bubble and knock), done ->
  // 'jump' then 'wave', failed -> 'failed', idle -> 'idle'. Walking is the world's 'run' rows from speed.
  function renderAnim(agent) {
    if (agent.anim && time < agent.animUntil) {
      // LIFE chooses where our pet is (station, bench, pond); Codex status chooses the row, like the Codex app's
      // pet. Only LIFE's celebration hop passes through. Brain moments (greet, gifts, visits) are not LIFE acts.
      if (agent.isMe && agent.lifeAct && agent.anim === agent.lifeAct.anim) {
        const s = agent.status
        if (s === 'working') return 'working'
        if (s === 'waiting') return 'waiting'
        if (s === 'failed') return 'failed'
        if (s === 'done' && agent.anim === 'jump') return 'jump'
        return 'idle'
      }
      return agent.anim
    }
    if (agent.mode === 'meet' && agent.answering) return 'review'
    if (agent.status === 'working') return 'working'
    if (agent.status === 'waiting') return 'waiting'
    if (agent.status === 'failed') return 'failed'
    return 'idle'
  }

  // ---- networking ----
  function sendState(force = false) {
    if (!online) return
    const anim = renderAnim(mine)
    const key = `${anim}|${mine.status}|${mine.facing}`
    const moving = mine.speed > 0.01
    const gap = moving ? 0.1 : 1
    if (moving !== lastSent.moving) force = true // every start and stop goes out at once
    if (!force && time - lastSent.at < gap && key === lastSent.key) return
    if (!force && !moving && key === lastSent.key && time - lastSent.at < 1) return
    lastSent = { at: time, key, moving }
    const pose = { x: round(mine.x), z: round(mine.z), facing: mine.facing, anim, status: mine.status, m: moving ? 1 : 0, dnd: dnd ? 1 : 0 }
    // The timestamped pose travels as fx (forwarded at once, fields intact) so every pane, the owner's
    // included, can draw it on one shared timeline; state keeps the relay's own bookkeeping current.
    send({ t: 'fx', kind: 'pose', ts: wall(), ...pose })
    if (force || !moving || time - lastStateAt >= 0.5) { lastStateAt = time; const { m, ...state } = pose; send({ t: 'state', ...state }) }
  }
  let lastStateAt = -Infinity
  // ---- one shared timeline: every pane draws every pet at (synced now - DISPLAY_DELAY) ----
  function syncClocks() {
    if (!online) return
    for (const peer of peers.values()) {
      if (!peer.online) continue
      const due = peer.clock.samples.length < 4 ? 1.5 : 10
      if (time - peer.clock.sentAt < due) continue
      peer.clock.sentAt = time
      send({ t: 'fx', kind: 'clock', dst: peer.id, t0: wall() })
    }
  }
  function onClock(from, p) {
    if (p.dst !== myId) return
    if (p.t1 == null) { send({ t: 'fx', kind: 'clock', dst: from, t0: p.t0, t1: wall() }); return }
    const peer = peers.get(from)
    if (!peer || !Number.isFinite(p.t0) || !Number.isFinite(p.t1)) return
    const t2 = wall()
    const rtt = t2 - p.t0
    if (rtt < 0 || rtt > 10000) return
    peer.clock.samples.push({ rtt, offset: p.t1 - (p.t0 + t2) / 2 })
    if (peer.clock.samples.length > 8) peer.clock.samples.shift()
    // The lowest round trip gives the tightest offset estimate (NTP-style). Inside its own uncertainty
    // (half the round trip) the OS clocks are already closer than we can measure: keep them.
    const best = peer.clock.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
    peer.clock.offset = Math.abs(best.offset) > best.rtt / 2 ? best.offset : 0
  }
  function setPeerStatus(peer, status) {
    if (status === 'done' && peer.status !== 'done') doneAt.set(peer.id, wall())
    peer.status = status
  }
  function onPose(from, p) {
    const peer = peers.get(from)
    if (!peer || !Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.ts)) return
    peer.posed = true
    peer.dnd = p.dnd === 1
    pushSample(peer, p, p.ts - peer.clock.offset)
  }
  const round = v => Math.round(v * 1000) / 1000
  function hello() {
    return { t: 'hello', v: 2, id: myId, room, seat: welcomed || Number.isInteger(config.seat) ? mySeat : null,
      dock: config.dock || 'right', name: mine.name, color: mine.color, status: mine.status,
      skills: mine.skills.map(s => ({ id: s.id, name: s.name, description: s.description || '' })),
      catalog: mine.catalog, sprite: me.sprite || null, answers: config.answers !== false, dnd: dnd ? 1 : 0, sit,
      ...(config.device ? { device: String(config.device).slice(0, 128) } : {}),
      x: round(mine.x), z: round(mine.z), facing: mine.facing, anim: renderAnim(mine) }
  }
  function upsertPeer(p, isOnline = true) {
    if (!p || !p.id || p.id === myId) return null
    let peer = peers.get(p.id)
    if (!peer) {
      peer = { id: p.id, name: p.name || 'pet', color: p.color || colorFor(p.id), seat: p.seat ?? null, dock: p.dock,
        skills: [], catalog: [], sprite: null, status: 'idle', samples: [], online: isOnline, lastSeen: 0, joinedAt: time,
        posed: false, clock: { offset: 0, samples: [], sentAt: -Infinity } }
      peers.set(p.id, peer)
    }
    if (p.name) peer.name = p.name
    if (p.color) peer.color = p.color
    if (Number.isInteger(p.seat)) peer.seat = p.seat
    if (Array.isArray(p.skills)) peer.skills = p.skills.map(s => ({ id: s.id || s.name, name: s.name || s.id, description: s.description || '' }))
    if (p.catalog) peer.catalog = normalizeItems(p.catalog)
    if (p.sprite !== undefined) peer.sprite = p.sprite
    if (p.status) peer.status = p.status
    if (p.lastSeen) peer.lastSeen = p.lastSeen
    peer.online = isOnline
    if (Number.isFinite(p.x) && Number.isFinite(p.z)) pushSample(peer, p)
    if (isOnline && Number.isInteger(peer.seat)) seats.set(peer.id, peer.seat)
    seatedCache = null
    return peer
  }
  function pushSample(peer, s, ts = wall() - 150) {
    if (s.status) setPeerStatus(peer, s.status)
    const list = peer.samples
    const last = list.at(-1)
    if (last && ts <= last.ts) return // stale or reordered
    // After a 1 Hz rest, hold the old spot until just before the new sample, so a start isn't smeared.
    if (last && ts - last.ts > 300) list.push({ ...last, ts: ts - 100, moving: false })
    list.push({ ts, x: s.x, z: s.z, facing: s.facing === -1 ? -1 : 1, anim: s.anim || 'idle', moving: s.m === 1 })
    if (list.length > 40) list.splice(0, list.length - 40)
  }
  function handle(msg) {
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'welcome': {
        online = true
        room = msg.room ?? room
        const firstSeat = msg.you?.seat
        for (const id of [...peers.keys()]) peers.get(id).online = false
        seats.clear()
        for (const p of msg.peers || []) upsertPeer(p, true)
        for (const p of msg.away || []) upsertPeer(p, false)
        // The device registry: everyone with a place in the world. Away agents nap where they stopped.
        for (const a of msg.agents || []) {
          if (!a?.id || a.id === myId) continue
          if (a.online && !a.away) { if (!peers.get(a.id)?.online) upsertPeer(a, true) }
          else if (a.away) napPeer(a)
        }
        for (const [id, seat] of Object.entries(msg.seats || {})) {
          const peer = peers.get(id)
          if (peer && Number.isInteger(seat)) { peer.seat = seat; if (peer.online) seats.set(id, seat) }
        }
        if (Array.isArray(msg.links)) noteLinks(msg.links)
        noteSitting(msg, msg.you)
        noteNeighbours(msg)
        retryNextTo()
        if (Number.isInteger(firstSeat)) moveSeat(firstSeat, 'welcome', !welcomed && firstSeat !== mySeat)
        // Resume: this id already has a place (a reload, a restart, another pane of ours handing over).
        if ((msg.you?.resumed || msg.you?.takeover) && Number.isFinite(msg.you.x) && Number.isFinite(msg.you.z)) {
          cancelJob(mine)
          mine.x = msg.you.x; mine.z = msg.you.z; mine.route = []; mine.hist = []
          if (msg.you.facing === 1 || msg.you.facing === -1) mine.facing = msg.you.facing
          lastResume = { x: mine.x, z: mine.z, takeover: !!msg.you.takeover }
        }
        seats.set(myId, mySeat)
        seatedCache = null
        welcomed = true
        if (!demo && bots().length) removeBots() // solo fallback bots leave once real peers can arrive
        rehomeBots()
        rebuildGarden()
        noteNeighbours(msg)
        if (msg.layout) { layoutV = 0; applyLayout(msg.layout) }
        // The relay's registry is the truth: anyone (online or napping) it doesn't list is a leftover from before a purge.
        if (Array.isArray(msg.agents)) {
          const known = new Set([...msg.agents, ...(msg.peers || []), ...(msg.away || [])].map(a => a?.id).filter(Boolean))
          for (const id of [...peers.keys()]) if (!known.has(id)) dropPeer(id)
        }
        emit('online', { room, seat: mySeat })
        sendState(true)
        sendScore()
        break
      }
      case 'join': {
        const peer = upsertPeer(msg.peer, true)
        if (peer) {
          peer.joinedAt = time
          // A newcomer gets a welcome gift 4 s after joining, and hears today's scores.
          mine.giftReadyAt = time + 4
          setTimeoutSafe(sendScore, 1000 + random() * 2000)
          rehomeBots()
          emit('roster')
          emit('arrive', peer.id)
          if (peer.away) { peer.away = false; emit('sleep', peer.id, false) }
          retryNextTo()
        }
        break
      }
      case 'leave': {
        const peer = peers.get(msg.id)
        if (peer) {
          peer.online = false; peer.lastSeen = msg.lastSeen || wall(); seats.delete(msg.id); seatedCache = null
          if (msg.away) napPeer({ id: msg.id, x: msg.x, z: msg.z, facing: msg.facing, lastSeen: msg.lastSeen })
          else if (peer.away) { peer.away = false; emit('sleep', peer.id, false) }
          noteNeighbours({})
          emit('roster')
        }
        break
      }
      case 'state': {
        for (const s of msg.pets || []) {
          if (s.id === myId) continue
          if (s.away) { napPeer(s); continue }
          const peer = peers.get(s.id) || upsertPeer({ id: s.id }, true)
          if (!peer) continue
          if (peer.posed) { if (s.status) setPeerStatus(peer, s.status) } // timestamped poses carry the position
          else pushSample(peer, s)
        }
        break
      }
      case 'seat': {
        if (Number.isFinite(msg.layoutVersion) && msg.layoutVersion < layoutV) break // older than the layout we hold
        if (Number.isFinite(msg.layoutVersion)) layoutV = msg.layoutVersion
        if (msg.seats) {
          for (const [id, seat] of Object.entries(msg.seats)) {
            if (id === myId) { if (Number.isInteger(seat) && seat !== mySeat) moveSeat(seat, msg.why, false) }
            else if (peers.has(id)) { peers.get(id).seat = seat; if (peers.get(id).online) seats.set(id, seat) }
          }
          seatedCache = null
          rehomeBots()
          emit('seats', { seat: mySeat, why: msg.why, links: msg.links || [] })
          if (msg.why === 'bump') setAnim(mine, 'wave', 1.2)
        }
        if (Array.isArray(msg.links)) noteLinks(msg.links)
        noteSitting(msg, null)
        noteNeighbours(msg)
        break
      }
      case 'layout': {
        // The relay's room layout is the single source of truth; a heartbeat with another version asks for the full one.
        const v = Number(msg.layoutVersion ?? msg.v) || 0
        if (msg.beat) { if (v !== layoutV) send({ t: 'layout?' }) }
        else applyLayout(msg)
        break
      }
      case 'sit': {
        if (msg.sit === 'side' || msg.sit === 'across') { sit = msg.sit; emit('sit', sit) } // corrected to match our pair
        if (Number.isFinite(msg.layoutVersion) && msg.layoutVersion !== layoutV) send({ t: 'layout?' })
        break
      }
      case 'catalog': {
        const peer = peers.get(msg.id)
        if (peer) peer.catalog = normalizeItems(msg.items)
        break
      }
      case 'fetch': serveFetch(msg); break
      case 'fetched': {
        const pending = pendingFetch.get(msg.fid)
        if (pending) { pendingFetch.delete(msg.fid); pending.resolve(msg) }
        break
      }
      case 'ask': receiveAsk(msg); break
      case 'answer': {
        const pending = pendingAsk.get(msg.qid)
        if (pending) pending.onAnswer(msg)
        break
      }
      case 'gift': receiveGift(msg); break
      case 'fx': {
        const { t, v, kind, from, id, ...payload } = msg
        if (kind === 'pose') { onPose(from, payload); break }
        if (kind === 'clock') { onClock(from, payload); break }
        if (kind === 'score') { noteScore(from, payload); break }
        if (!payload.src) payload.src = from
        showFx(kind, payload)
        break
      }
    }
  }
  let welcomed = false
  let sit = config.sit === 'across' ? 'across' : 'side'
  let flipped = false
  let acrossWith = null
  let lastResume = null
  let replaced = false
  function moveSeat(seat, why, snap) {
    mySeat = seat
    mine.home = seat
    seats.set(myId, seat)
    seatedCache = null
    if (snap) {
      cancelJob(mine)
      const spot = homeSpot(seat)
      mine.x = spot.x; mine.z = spot.z; mine.route = []
    }
    rehomeBots()
    emit('seat', seat, why)
  }
  // ---- co-working: sit next to someone, know your neighbours, visit them across the seam ----
  let pendingNextTo = config.nextTo ? String(config.nextTo) : null // --next-to <name>: retried until they're online
  let neighbours = { left: null, right: null, across: null }
  let neighboursKey = ''
  const shakes = new Map() // partner id -> time of the last handshake
  function resolvePeer(idOrName) {
    const want = String(idOrName || '').toLowerCase()
    for (const p of peers.values()) if (p.id === idOrName || String(p.name).toLowerCase() === want) return p
    return null
  }
  /** Ask the relay to seat us right beside someone (agent id or name). -> { ok, pending, message, target? } */
  function coworkWith(idOrName) {
    if (!idOrName) return { ok: false, pending: false, message: 'who should I sit next to?' }
    const peer = resolvePeer(idOrName)
    if (!online || !peer || !peer.online) {
      pendingNextTo = String(idOrName)
      return { ok: false, pending: true, message: `I'll sit next to ${peer?.name || idOrName} as soon as they're online` }
    }
    pendingNextTo = null
    send({ t: 'seat', op: 'nextTo', target: peer.id })
    mine.visitAt = Math.min(mine.visitAt, time + 8)
    return { ok: true, pending: false, message: `Now next to ${peer.name}`, target: peer.id }
  }
  function retryNextTo() { if (pendingNextTo && online) { const p = resolvePeer(pendingNextTo); if (p?.online) coworkWith(p.id) } }
  function handshakeWith(partnerId, side) {
    if (!partnerId || time - (shakes.get(partnerId) ?? -Infinity) < 15) return
    shakes.set(partnerId, time)
    emit('handshake', { seat: mySeat, side })
    mine.visitAt = Math.min(mine.visitAt, time + 8) // first cross-seam visit soon after we sit together
  }
  /** Neighbours from the relay's seat messages (or, failing that, from the seat numbers). */
  function noteNeighbours(msg) {
    const mineN = msg?.neighbours?.[myId]
    const at = seat => { for (const [id, s] of seats) if (id !== myId && s === seat && peers.get(id)?.online) return id; return null }
    const ids = mineN ? { left: mineN.left || null, right: mineN.right || null, across: mineN.across || null }
      : { left: at(mySeat - 1), right: at(mySeat + 1), across: neighbours.across?.id || null }
    const named = id => (id && peers.get(id) ? { id, name: peers.get(id).name } : null)
    const next = { left: named(ids.left), right: named(ids.right), across: named(ids.across) }
    const key = JSON.stringify(next)
    if (key !== neighboursKey) { neighboursKey = key; neighbours = next; emit('neighbours', { ...next }) }
    if (Array.isArray(msg?.cowork) && msg.cowork.includes(myId) && (msg.why === 'cowork' || msg.why === 'dock')) {
      const [left, right] = msg.cowork
      handshakeWith(left === myId ? right : left, left === myId ? 'right' : 'left')
    }
  }
  function neighbourMember() {
    for (const side of ['right', 'left']) {
      const n = neighbours[side]
      const m = n && member(n.id)
      if (m?.online) return m
    }
    return null
  }
  /** A visit across the seam: walk the road onto their screen, say hello, work together, bring a dot, walk home. */
  async function visitNeighbour(agent, nb, job) {
    fx('seek', { src: agent.id, dst: nb.id })
    const home = Number.isInteger(nb.seat) ? landmarkOf(nb.seat) : null
    const target = () => {
      const m = member(nb.id)
      if (m && Number.isInteger(nb.seat) && chunkOf(m.x) === nb.seat) return m
      return home ? { x: home.x, z: home.z } : m
    }
    const ok = await walkTo(agent, sideSpot(agent, target), job, { timeout: 40 })
    if (job.cancelled) return
    agent.faceTo = nb.id
    if (ok) {
      setAnim(agent, 'wave', 1.4)
      fx('wave', { src: agent.id, dst: nb.id })
      await sleep(1.6, job)
      if (job.cancelled) return
      const kind = KINDS.includes(kindAt(nb.seat ?? mySeat)) ? kindAt(nb.seat ?? mySeat) : 'skill'
      fx('collab', { src: agent.id, dst: nb.id, dot: kind })
      await offerSkill(agent, nb, job)
      if (job.cancelled) return
    }
    await sleep(6 + random() * 4, job)
    if (!job.cancelled) await goHome(agent, job)
  }
  /** Bring a dot for real: a skill they don't have yet that we share freely. -> true when one was given. */
  async function offerSkill(agent, nb, job) {
    const gift = agent.skills.find(s => !(nb.skills || []).some(k => k.name === s.name) &&
      ruleFor(mine.catalog.find(i => i.kind === 'skill' && i.title === s.name)?.ref) === 'free')
    if (!gift || !receiverCanTake(nb.id)) return false
    await sleep(3, job)
    if (job.cancelled) return false
    fx('gift', { src: agent.id, dst: nb.id, label: gift.name, dot: 'skill', seed: `${agent.id}/skill:${gift.name}` })
    let pkg = null
    try { pkg = await bridge.packSkill?.(gift.id) } catch { pkg = null }
    send({ t: 'gift', to: nb.id, gid: uid('g'), skill: pkg || { id: gift.id, name: gift.name, description: gift.description || '', files: [] } })
    creditHelp(agent.id, 'share')
    return true
  }

  /** An away agent: it stays in the world, napping at x/z, and never moves until its owner is back. */
  function napPeer(a) {
    let peer = peers.get(a.id)
    if (!peer) peer = upsertPeer({ ...a, catalog: a.catalog }, false)
    else if (a.name || a.sprite !== undefined) upsertPeer({ id: a.id, name: a.name, color: a.color, sprite: a.sprite, catalog: a.catalog }, false)
    if (!peer) return
    peer.online = false
    seats.delete(peer.id)
    seatedCache = null
    if (Number.isFinite(a.x) && Number.isFinite(a.z)) {
      peer.samples = [{ ts: wall() - 1000, x: a.x, z: a.z, facing: a.facing === -1 ? -1 : 1, anim: 'idle', moving: false }]
    }
    if (a.lastSeen) peer.lastSeen = a.lastSeen
    const wasAway = peer.away
    peer.away = true
    if (!wasAway) emit('sleep', peer.id, true)
  }
  /** Seating: 'side' strip or 'across' (two panes share one seat; the later one is flipped). */
  function noteSitting(msg, you) {
    if (you?.sit) sit = you.sit
    let next = flipped
    if (you && 'flipped' in you) next = !!you.flipped
    if (msg.flipped && typeof msg.flipped === 'object') next = !!msg.flipped[myId]
    if (Array.isArray(msg.across)) acrossWith = (msg.across.find(pair => Array.isArray(pair) && pair.includes(myId)) || []).find(id => id !== myId) || null
    if (next !== flipped) { flipped = next; emit('flip', flipped) }
  }
  /** Forget a remote agent entirely (relay purge); pets() stops listing it, so every pane's world drops it. */
  function dropPeer(id) {
    if (!peers.has(id) || id === myId) return
    peers.delete(id)
    seats.delete(id)
    visitors.delete(id)
    scores.delete(id)
    stuckSince.delete(id)
    seatedCache = null
    updateLeader()
    emit('remove', id)
    emit('roster')
  }
  /** Apply a full room layout wholesale (seats, flips, across pairs, links, neighbours, sits), newer versions only. */
  let layoutV = 0
  function applyLayout(L) {
    const v = Number(L?.layoutVersion ?? L?.v) || 0
    if (!L || !L.seats || v <= layoutV) return false
    // Online peers the layout doesn't know are leftovers (nappers are vouched for by the welcome registry).
    const placed = new Set([...Object.keys(L.seats || {}), ...Object.keys(L.sits || {}), ...Object.keys(L.held || {})])
    for (const p of [...peers.values()]) if (p.online && !p.away && !placed.has(p.id)) dropPeer(p.id)
    layoutV = v
    const before = mySeat
    for (const id of [...seats.keys()]) if (id !== myId) seats.delete(id)
    for (const [id, seat] of Object.entries(L.seats)) {
      if (!Number.isInteger(seat)) continue
      if (id === myId) { if (seat !== mySeat) moveSeat(seat, 'layout', false) }
      else if (peers.has(id)) { const p = peers.get(id); p.seat = seat; if (p.online) seats.set(id, seat) }
    }
    seats.set(myId, mySeat)
    seatedCache = null
    if (Array.isArray(L.links)) noteLinks(L.links)
    if (L.sits && (L.sits[myId] === 'side' || L.sits[myId] === 'across') && L.sits[myId] !== sit) { sit = L.sits[myId]; emit('sit', sit) }
    noteSitting({ flipped: L.flipped || {}, across: L.across || [] }, null)
    noteNeighbours(L)
    rehomeBots()
    if (mySeat !== before) emit('seats', { seat: mySeat, why: 'layout', links: L.links || [] })
    return true
  }
  function setSit(next) {
    if (next !== 'side' && next !== 'across') return sit
    sit = next
    send({ t: 'sit', sit })
    emit('sit', sit)
    return sit
  }
  function netStatus(state) {
    if (state === 'replaced') {
      // Another pane (or the MCP overlay) of ours took this agent over; this one stays quiet for good.
      online = false
      replaced = true
      for (const peer of peers.values()) peer.online = false
      for (const id of [...seats.keys()]) if (id !== myId) seats.delete(id)
      seatedCache = null
      emit('online', null)
      emit('replaced')
      return
    }
    // 'solo' when no relay is reachable: our own pet and the world, quietly; the client keeps retrying.
    // Demo bots exist only with --demo / ?demo, never as stand-ins for an offline team.
    if (state === 'solo' || state === 'offline') {
      if (online) {
        online = false
        for (const peer of peers.values()) peer.online = false
        for (const id of [...seats.keys()]) if (id !== myId) seats.delete(id)
        seatedCache = null
      }
      emit('online', null)
    }
  }

  // ---- owner side: serve fetches, answer asks, receive gifts ----
  async function readOwn(ref, as) {
    try {
      const raw = await bridge.readItem?.(ref, as)
      if (raw == null) return { ok: false, reason: 'not found' }
      if (typeof raw === 'string') return { ok: true, text: raw }
      return { ok: raw.ok !== false, ...raw }
    } catch (error) { return { ok: false, reason: String(error?.message || error) } }
  }
  async function serveFetch(msg) {
    const item = mine.catalog.find(i => i.ref === msg.ref)
    const fromName = peers.get(msg.from)?.name || 'A teammate'
    const permit = await askPermission({ from: msg.from, fromName, ref: msg.ref, kind: item?.kind || String(msg.ref).split(':')[0],
      title: item?.title || String(msg.ref).split(':').slice(1).join(':') })
    if (!permit.allowed) {
      send({ t: 'fetched', fid: msg.fid, to: msg.from, ok: false, reason: 'declined', text: declinedText() })
      return
    }
    let result = await readOwn(msg.ref, msg.as)
    if (result.reason === 'not shared') result = { ok: false, reason: 'not shared', text: notSharingText() }
    else if (result.askFirst && permit.reason === 'free') {
      const again = await askPermission({ from: msg.from, fromName, ref: msg.ref, kind: item?.kind || 'skill', title: item?.title || msg.ref, force: true })
      if (!again.allowed) result = { ok: false, reason: 'declined', text: declinedText() }
    }
    send({ t: 'fetched', fid: msg.fid, to: msg.from, ok: result.ok, sha: result.sha || item?.sha || '',
      text: result.text, pkg: result.pkg, reason: result.reason })
    if (result.ok) creditHelp(myId, 'share')
  }
  function answerTimeoutText(name) { return `${name} couldn't finish in time.` }
  async function receiveAsk(msg) {
    emit('involved', { kind: 'asked', with: msg.from })
    const fromName = peers.get(msg.from)?.name || 'a teammate'
    // Heads-down: answer at once, nobody walks.
    if (dnd) { send({ t: 'answer', qid: msg.qid, to: msg.from, ok: false, reason: 'dnd', text: `${mine.name} is heads-down right now` }); return }
    // Share permission before any work (tier 2 spends tokens): free, ask (the pet knocks with ✓/✗) or never.
    const permit = await askPermission({ from: msg.from, fromName, ref: null, kind: 'ask', title: bubbleText(msg.question, 40) })
    if (!permit.allowed) { send({ t: 'answer', qid: msg.qid, to: msg.from, ok: false, reason: 'declined', text: declinedText() }); return }
    const entry = { id: msg.qid, from: msg.from, fromName, question: String(msg.question || '').slice(0, 600), kind: msg.kind, at: time, answered: false }
    inbox.set(msg.qid, entry)
    // Nothing in our catalog answers it at once: WIRE can open the question in Codex for the live session.
    if (!tier1Answer(entry.question, entry.kind, mine.catalog)) emit('inbox', { id: entry.id, from: entry.from, fromName, question: entry.question })
    const asker = msg.from
    // Walk to the meeting landmark beside the asker's arrival side.
    // The asker computes the same landmark from our seat (the relay forwards only qid/question/kind).
    const landmark = msg.meet && Number.isFinite(msg.meet.x) ? msg.meet : meetLandmark(msg.kind, mySeat)
    mine.answering++
    mine.sceneUntil = 0
    startJob(mine, 'meet', async j => {
      const spot = () => { const a = member(asker); const side = a && a.x < landmark.x ? 1 : -1; return { x: landmark.x + side * 1.1, z: landmark.z } }
      await walkTo(mine, spot, j)
      mine.faceTo = asker
      await holdForScene(mine, j, () => (entry.answered ? entry.answeredAt : null))
      if (!j.cancelled) await goHome(mine, j)
    }, fromName)
    let result = null
    try {
      if (typeof bridge.answerAsk === 'function') {
        const answering = bridge.answerAsk({ question: entry.question, kind: entry.kind, fromName })
        result = await Promise.race([answering, new Promise(r => setTimeoutSafe(() => r({ ok: false, text: answerTimeoutText(mine.name) }), 36000))])
      } else {
        result = tier1Answer(entry.question, entry.kind, mine.catalog, { strict: false }) || { ok: false, text: `${mine.name} doesn't know that one.` }
      }
    } catch (error) { result = { ok: false, text: String(error?.message || error) } }
    mine.answering = Math.max(0, mine.answering - 1)
    // L3b marks items its owner wants asked about first (askFirst) and ones not shared at all.
    if (result?.reason === 'not shared') result = { ok: false, reason: 'not shared', text: notSharingText() }
    else if (result?.askFirst && permit.reason === 'free') {
      const again = await askPermission({ from: msg.from, fromName, ref: result.item?.ref || result.share?.ref || null, kind: result.item?.kind || result.share?.kind || 'ask',
        title: result.item?.title || result.share?.title || bubbleText(msg.question, 40), force: true })
      if (!again.allowed) result = { ok: false, reason: 'declined', text: declinedText() }
    }
    if (entry.answered) return
    entry.answered = true; entry.answeredAt = time
    inbox.delete(msg.qid)
    mine.lastAnswer++
    const share = result?.share || (result?.item ? { kind: result.item.kind, title: result.item.title, ref: result.item.ref } : null)
    send({ t: 'answer', qid: msg.qid, to: asker, ok: result?.ok !== false, text: String(result?.text || '').slice(0, 1200),
      share, pkg: result?.pkg, reason: result?.reason })
    if (result?.ok !== false) creditHelp(myId, 'answer')
  }
  function answerInbox(id, text, item) {
    const entry = inbox.get(id)
    if (!entry || entry.answered) return { ok: false, reason: 'already answered or unknown id' }
    entry.answered = true; entry.answeredAt = time
    inbox.delete(id)
    mine.lastAnswer++
    const share = item ? (typeof item === 'string' ? mine.catalog.find(i => i.ref === item || i.title === item) || null : item) : null
    send({ t: 'answer', qid: id, to: entry.from, ok: true, text: String(text || '').slice(0, 1200), share })
    creditHelp(myId, 'answer')
    return { ok: true }
  }
  async function receiveGift(msg, { install = true } = {}) {
    const skill = msg.skill || {}
    const giverName = peers.get(msg.from)?.name || agents.get(msg.from)?.name || 'a teammate'
    const log = giftLog.get(myId) || { last: -Infinity, count: 0 }
    if (log.count > 8) return
    let result = null
    // Demo bots only animate: their gifts never write into the real Codex home.
    if (install) try {
      result = bridge.installItem ? await bridge.installItem({ kind: 'skill', ...skill }, giverName)
        : await bridge.installSkill?.(skill, giverName)
    } catch (error) { result = { installed: false, reason: String(error?.message || error) } }
    if (!mine.skills.some(s => s.name === skill.name)) mine.skills.push({ id: skill.id || skill.name, name: skill.name, description: skill.description || '' })
    setAnim(mine, 'jump', 1.1)
    fx('learned', { src: myId, text: `learned ${shortTitle(skill.name)}`, bloom: { kind: 'skill', seed: `${msg.from || 'peer'}/skill:${skill.name}` }, skill: { id: skill.id || skill.name, name: skill.name, description: skill.description || '' } })
    emit('roster')
    return result
  }

  // ---- asker side: tools ----
  function ownerOf(id) {
    const s = String(id || '')
    const slash = s.indexOf('/')
    if (slash < 1) return null
    return { owner: s.slice(0, slash), ref: s.slice(slash + 1) }
  }
  function lookupItem(id) {
    const parts = ownerOf(id)
    if (!parts) return null
    const m = member(parts.owner)
    if (!m) return null
    return { owner: m, item: (m.catalog || []).find(i => i.ref === parts.ref) || { ref: parts.ref, kind: parts.ref.split(':')[0], title: parts.ref.split(':').slice(1).join(':') } }
  }
  function fetchItem(owner, ref, as) {
    if (agents.has(owner.id)) {
      const bot = agents.get(owner.id)
      const item = bot.catalog.find(i => i.ref === ref)
      if (!item) return Promise.resolve({ ok: false, reason: 'not found' })
      const text = `# ${item.title}\n\n${item.summary}\n`
      return Promise.resolve({ ok: true, sha: item.sha, text, pkg: item.kind === 'skill' ? botSkillPkg(bot, item) : undefined })
    }
    if (!online) return Promise.resolve({ ok: false, reason: `${owner.name} is away` })
    const fid = uid('f')
    return new Promise(resolve => {
      const timer = setTimeoutSafe(() => { if (pendingFetch.delete(fid)) resolve({ ok: false, reason: 'timed out' }) }, 20000)
      pendingFetch.set(fid, { resolve: r => { clearTimeoutSafe(timer); resolve(r) } })
      send({ t: 'fetch', fid, owner: owner.id, ref, as })
    })
  }
  function errandTo(agent, targetId, { kind, label, onArrive, landmarkKind, quiet = false } = {}) {
    if (agent.isMe || targetId === myId) emit('involved', { kind: 'errand', with: agent.isMe ? targetId : agent.id })
    // Walk to the live position of whoever owns it; away owners -> that kind's landmark.
    return startJob(agent, 'errand', async job => {
      const target = member(targetId)
      const reachable = target && target.online
      if (reachable) fx('seek', { src: agent.id, dst: targetId }) // the walk itself says it
      const spot = reachable ? sideSpot(agent, () => member(targetId)) : (() => {
        const lm = meetLandmark(landmarkKind || kind, chunkOf(agent.x))
        return { x: lm.x - 1, z: lm.z }
      })
      const arrived = await walkTo(agent, spot, job, { timeout: 60 })
      if (job.cancelled) return
      agent.faceTo = reachable ? targetId : null
      if (arrived && onArrive) await onArrive(job)
      await sleep(1.6, job)
      if (!job.cancelled) await goHome(agent, job)
    }, member(targetId)?.name || null)
  }

  // ---- share permission: 'free' | 'ask' | 'never', plus per-item overrides { [ref]: true|false } ----
  let sharing = { mode: 'free', items: {} }
  const permissions = new Map() // id -> { id, from, fromName, ref, kind, title, text, expiresAt, resolve }
  const KIND_WORD = { skill: 'skill', memory: 'note', technique: 'technique', resource: 'MCP server' }
  const declinedText = () => `${mine.name} said not right now`
  const notSharingText = () => `${mine.name} is not sharing that right now`
  function setSharing(next = {}) {
    const mode = ['free', 'ask', 'never'].includes(next.mode) ? next.mode : sharing.mode
    const items = next.items && typeof next.items === 'object' ? { ...next.items } : sharing.items
    sharing = { mode, items }
    emit('sharing', { ...sharing })
    return { ...sharing }
  }
  const ruleFor = ref => (ref && sharing.items[ref] === false ? 'never' : ref && sharing.items[ref] === true ? 'free' : sharing.mode)
  /** Resolves { allowed, reason: 'free'|'allowed'|'declined'|'never'|'timeout' }. In 'ask' mode our pet walks to the
   *  front, knocks and shows the request; WIRE draws ✓/✗ from the 'permission' event and calls decide(id, allow). */
  function askPermission({ from, fromName, ref, kind, title, force = false }) {
    const rule = ruleFor(ref)
    if (rule === 'free' && !force) return Promise.resolve({ allowed: true, reason: 'free' })
    if (rule === 'never') return Promise.resolve({ allowed: false, reason: 'never' })
    const id = uid('p')
    const text = kind === 'ask' ? `${fromName} asks: ${title}` : `${fromName} wants your ${shortTitle(title, 26)} ${KIND_WORD[kind] || 'item'}`
    return new Promise(resolve => {
      const request = { id, from, fromName, ref, kind, title, text, expiresAt: wall() + 30000 }
      const timer = setTimeoutSafe(() => finish(false, 'timeout'), 30000)
      function finish(allowed, reason) {
        if (!permissions.has(id)) return
        permissions.delete(id)
        clearTimeoutSafe(timer)
        if (!permissions.size) fx('knock', { src: myId, on: false })
        emit('permission-end', { id, allowed, reason })
        resolve({ allowed, reason })
      }
      permissions.set(id, { ...request, finish })
      fx('knock', { src: myId, on: true })
      emit('permission', { ...request })
    })
  }
  function decide(id, allow) {
    const request = permissions.get(id)
    if (!request) return false
    request.finish(!!allow, allow ? 'allowed' : 'declined')
    return true
  }

  // ---- recall and do-not-disturb ----
  let dnd = false
  let recallPending = false
  /** Bring our pet home: { busy: false } when it's free and on its way, else { busy: true, message } and it
   *  comes home as soon as the current errand ends. */
  function recall() {
    wake()
    const job = mine.job
    if (job && job.mode !== 'visit' && job.mode !== 'return') {
      const message = mine.jobWith ? `busy helping ${mine.jobWith}, back soon` : 'busy right now, back soon'
      recallPending = true
      fx('say', { src: myId, text: message })
      return { busy: true, message }
    }
    cancelJob(mine)
    mine.pauseUntil = 0
    mine.hurry = true
    mine.visitAt = time + 90
    startJob(mine, 'return', async j => { await goHome(mine, j); mine.hurry = false })
    return { busy: false, message: 'on my way home' }
  }
  /** Heads-down: our pet stays home (no visits, no gifts), asks get "is heads-down right now", peers see a DND
   *  sign over it. WIRE folds the pane and mutes sound on the 'dnd' event. */
  function setDnd(on) {
    dnd = !!on
    if (dnd && (mine.job?.mode === 'visit' || mine.job?.mode === 'help')) cancelJob(mine)
    if (dnd && !mine.job && chunkOf(mine.x) !== mySeat) recall()
    emit('dnd', dnd)
    sendState(true)
    return dnd
  }

  // ---- live progress for Codex: S5 forwards 'step' events as MCP progress for the call with this callId ----
  function progress(callId, text) { if (text) emit('step', { callId: callId ?? null, text: String(text).slice(0, 200) }) }

  // ---- "Show me": the core journey, for real, with our neighbour (or the nearest online peer) ----
  async function showMe() {
    if (teamOffline()) return { ok: false, message: OFFLINE }
    const others = members().filter(m => m.online && (m.catalog || []).length && (!m.isBot || demo))
    const target = (neighbourMember() && others.find(m => m.id === neighbourMember().id)) ||
      others.sort((a, b) => Math.abs((a.seat ?? 99) - mySeat) - Math.abs((b.seat ?? 99) - mySeat))[0]
    if (!target) return { ok: false, message: 'nobody with shared items is online yet' }
    const item = target.catalog.find(i => i.kind === 'skill' && !mine.skills.some(s => s.name === i.title)) ||
      target.catalog.find(i => i.kind === 'skill') || target.catalog[0]
    const question = `Can you share your ${shortTitle(item.title, 30)} ${KIND_WORD[item.kind] || 'notes'}? ${item.title}`
    recallPending = false
    const r = await askPeer(mine, { question, to: target.id, kind: item.kind })
    // Wait for the walk home, then celebrate on our own screen.
    for (let i = 0; i < 160 && mine.job; i++) await sleep(0.25)
    fx('celebrate', { src: myId })
    setAnim(mine, 'jump', 1.2)
    return { ok: !!r?.answered_by, with: target.name, item: item.title, kind: item.kind, question, answer: r?.answer || '',
      says: r?.answered_by ? `${r.answered_by} says: ${r.answer}` : undefined, installed: r?.installed || null,
      message: r?.installed ? `learned ${item.title} from ${target.name} -> ${r.installed.path}` : r?.answer || 'no answer' }
  }

  // ---- lessons: a finished Codex session leaves a card in the room's commons (and a Library flower) ----
  async function publishLesson() {
    let r = null
    try { r = await bridge.lessonFromSession?.() } catch { r = null }
    const card = r?.item || r?.card || (r?.ref ? r : null)
    if (!card?.ref) return null
    const item = normalizeItems([{ kind: 'memory', ...card }])[0]
    if (!item) return null
    if (!mine.catalog.some(i => i.ref === item.ref)) { mine.catalog = [...mine.catalog, item]; catalogDirty = true }
    fx('learned', { src: myId, text: `learned ${shortTitle(item.title)}`, bloom: { kind: item.kind, seed: `${myId}/${item.ref}` } })
    emit('lesson', { ...item })
    refreshCatalog()
    return item
  }

  // ---- find errands: the pet goes round the team for an answer and reports back ----
  const errands = new Map()
  const snapshotErrand = e => ({ id: e.id, question: e.question, kind: e.kind || null, status: e.status, step: e.step,
    findings: e.findings.map(f => ({ ...f })), installed: [...e.installed], message: e.message, startedAt: e.startedAt, finishedAt: e.finishedAt })
  function updateErrand(e) {
    emit('errand', snapshotErrand(e))
    if (e.callId && e.step !== e.lastStep) { e.lastStep = e.step; progress(e.callId, e.status === 'running' ? e.step : e.message || e.status) }
  }
  function find({ question = '', kind, callId } = {}) {
    question = String(question || '').trim().slice(0, 600)
    if (!question) throw new Error('question is required')
    const e = { id: uid('e'), callId: callId ?? null, question, kind: KINDS.includes(kind) ? kind : undefined, status: 'running', step: 'searching the team',
      findings: [], installed: [], message: '', startedAt: wall(), finishedAt: null }
    errands.set(e.id, e)
    updateErrand(e)
    runFind(e).catch(error => { e.status = 'failed'; e.message = String(error?.message || error) })
      .finally(() => { if (e.status === 'running') e.status = 'done'; e.finishedAt = wall(); e.step = e.status; updateErrand(e) })
    return { id: e.id, status: e.status, step: e.step }
  }
  function walkToMember(targetId) {
    return new Promise(resolve => {
      startJob(mine, 'errand', async job => {
        fx('seek', { src: myId, dst: targetId })
        const ok = await walkTo(mine, sideSpot(mine, () => member(targetId)), job, { timeout: 45 })
        if (!job.cancelled) mine.faceTo = targetId
        resolve(ok && !job.cancelled)
      }, member(targetId)?.name || null)
    })
  }
  async function runFind(e) {
    if (teamOffline()) { e.status = 'failed'; e.message = OFFLINE; return }
    const hits = searchCatalogs(e.question, members().filter(m => m.online), { kind: e.kind, limit: 6, now: wall() })
    const picks = []
    for (const hit of hits) if (hit.score >= 0.5 && !picks.some(p => p.owner === hit.owner)) picks.push(hit)
    for (const hit of picks.slice(0, 2)) {
      const found = lookupItem(hit.id)
      if (!found) continue
      e.step = `visiting ${found.owner.name}`; updateErrand(e)
      if (!dnd) await walkToMember(found.owner.id)
      const as = found.item.kind === 'skill' ? 'pkg' : 'text'
      const r = await fetchItem(found.owner, found.item.ref, as)
      const finding = { owner: found.owner.name, id: hit.id, kind: found.item.kind, title: found.item.title, summary: found.item.summary }
      if (!r?.ok) { finding.error = r?.text || r?.reason || 'unavailable'; e.findings.push(finding); updateErrand(e); continue }
      let text = r.text || ''
      if (!text && r.pkg?.files) { const md = r.pkg.files.find(f => /(^|\/)SKILL\.md$/i.test(f.path)); if (md) text = decode(md.b64) }
      finding.text = text.slice(0, 1500)
      if (found.item.kind === 'skill' && r.pkg && !agents.get(found.owner.id)?.isBot) {
        const inst = await adopt(found.owner, { kind: 'skill', title: found.item.title, ref: found.item.ref }, r.pkg)
        if (inst?.path) { finding.installed = inst.path; e.installed.push(inst.path) }
      }
      if (found.owner.online) fx('fetch', { src: found.owner.id, dst: myId, dot: found.item.kind, seed: hit.id })
      fx('learned', { src: myId, text: `learned ${shortTitle(found.item.title)}`, bloom: { kind: found.item.kind, seed: hit.id } })
      e.findings.push(finding); updateErrand(e)
    }
    if (!e.findings.some(f => !f.error)) {
      e.step = 'asking the team'; updateErrand(e)
      const r = await askPeer(mine, { question: e.question, kind: e.kind })
      e.findings.push({ owner: r.answered_by, kind: 'answer', answer: r.answer, dot: r.dot, installed: r.installed?.path })
      if (r.installed?.path) e.installed.push(r.installed.path)
      if (!r.answered_by) e.status = 'failed'
    } else if (!mine.job || mine.job.mode === 'errand') {
      startJob(mine, 'return', j => goHome(mine, j))
    }
    e.message = e.findings.filter(f => !f.error).map(f => f.kind === 'answer' ? `${f.owner || 'nobody'}: ${f.answer}` : `${f.owner}'s ${f.title}`).join(' · ') || 'nothing found'
  }
  function errandStatus(id) {
    const e = id ? errands.get(id) : [...errands.values()].at(-1)
    return e ? snapshotErrand(e) : null
  }

  // ---- proactive help: when our Codex session looks stuck, fetch the strongest match from the team ----
  let needAt = 30
  const needsTried = new Set()
  async function checkNeed() {
    let need = null
    try { need = await bridge.currentNeed?.() } catch { need = null }
    if (!need?.question || mine.job || dnd) return
    const hits = searchCatalogs(need.question, members().filter(m => m.online), { kind: KINDS.includes(need.kind) ? need.kind : undefined, limit: 1, now: wall() })
    const best = hits[0]
    if (!best || !best.online || best.score < 0.6 || needsTried.has(best.id)) return
    needsTried.add(best.id)
    fx('say', { src: myId, text: need.short || bubbleText(need.question, 30) })
    emit('need', { need, item: best })
    tools.petpack_get({ id: best.id }).catch(() => {})
  }

  // No relay and no demo: say so plainly; never fake teammates.
  const OFFLINE = 'The team is offline right now (no petpack relay reachable; it keeps retrying). Carry on solo and try again shortly.'
  const teamOffline = () => !online && !bots().length
  const tools = {
    async petpack_status({ quiet = false } = {}) {
      // quiet: S5 polls during a cold start; no wave, no state.
      if (!quiet) { setAnim(mine, 'wave', 1.8); sendState(true) }
      if (teamOffline()) return { room: null, offline: true, message: OFFLINE, me: { name: mine.name, pet: mine.name, seat: mySeat, status: mine.status, online: false }, peers: [] }
      const list = members().filter(m => !m.isBot || demo || !online)
      return {
        room: room || (online ? null : 'solo'),
        me: { name: mine.name, pet: mine.name, seat: mySeat, status: mine.status, online, dnd, sharing: sharing.mode, helpVisits },
        helpers_today: leaderboard(5).map(({ name, answers, shares, isMe }) => ({ name, answers, shares, ...(isMe ? { you: true } : {}) })),
        peers: list.map(m => ({
          name: m.name, pet: m.name, seat: m.seat, status: m.online ? m.status || 'idle' : 'away',
          where: !m.online ? 'away' : m.seat === mySeat - 1 ? 'left' : m.seat === mySeat + 1 ? 'right' : 'far',
          counts: KINDS.reduce((acc, k) => { acc[k] = (m.catalog || []).filter(i => i.kind === k).length; return acc }, {}),
          ...(m.isBot ? { bot: true } : {}),
        })),
      }
    },
    async petpack_search({ query = '', kind, limit = 3 } = {}) {
      if (!String(query).trim()) throw new Error('query is required')
      if (teamOffline()) return { offline: true, message: OFFLINE, results: [] }
      const results = searchCatalogs(query, members(), { kind: KINDS.includes(kind) ? kind : undefined, limit, now: wall() })
      const owners = new Set(results.map(r => r.owner))
      for (const m of members()) if (owners.has(m.name)) fx('pulse', { src: m.id })
      return results
    },
    async petpack_get({ id, callId } = {}) {
      if (teamOffline()) return { offline: true, error: OFFLINE }
      const found = lookupItem(id)
      if (!found) throw new Error(`unknown item ${id}; use petpack_search first`)
      const { owner, item } = found
      const as = item.kind === 'skill' ? 'pkg' : 'text'
      // Content travels now; the walk plays out on its own.
      const content = fetchItem(owner, item.ref, as)
      progress(callId, owner.online ? `walking to ${owner.name}'s screen for ${shortTitle(item.title)}` : `${owner.name} is away: fetching ${shortTitle(item.title)}`)
      errandTo(mine, owner.id, { kind: item.kind, label: item.title, onArrive: async () => {
        await content
        if (owner.online) { fx('fetch', { src: owner.id, dst: myId, dot: item.kind, seed: id }); await sleep(1.4) }
        fx('learned', { src: myId, text: `learned ${shortTitle(item.title)}`, bloom: { kind: item.kind, seed: id } })
      } })
      const result = await content
      if (!result?.ok) return { kind: item.kind, title: item.title, owner: owner.name, text: '', error: result?.text || result?.reason || `${owner.name} is away` }
      let text = result.text || ''
      if (!text && result.pkg?.files) {
        const md = result.pkg.files.find(f => /(^|\/)SKILL\.md$/i.test(f.path))
        if (md) text = decode(md.b64)
      }
      const out = { kind: item.kind, title: item.title, owner: owner.name, text }
      if (agents.get(owner.id)?.isBot) { out.installed = false; out.reason = 'demo bot items are not installed' }
      else if (item.kind === 'skill' && result.pkg) {
        try {
          const installed = bridge.installItem ? await bridge.installItem({ kind: 'skill', ...result.pkg, ref: item.ref }, owner.name)
            : await bridge.installSkill?.(result.pkg, owner.name)
          out.installed = installed?.installed ?? false
          if (installed?.path) out.path = installed.path
          if (out.installed && !mine.skills.some(s => s.name === result.pkg.name)) mine.skills.push({ id: result.pkg.id, name: result.pkg.name, description: result.pkg.description || '' })
        } catch (error) { out.installed = false; out.reason = String(error?.message || error) }
      }
      progress(callId, out.installed ? `got ${owner.name}'s ${shortTitle(item.title)} ${KIND_WORD[item.kind] || 'item'} -> ${out.path || 'installed'}` : `got ${owner.name}'s ${shortTitle(item.title)}`)
      if (text && !out.content) { out.content = String(text).slice(0, 12000); out.from = owner.name; out.says = `${owner.name} says: here's my ${item.title}` }
      cache.set(id, { ...out, pkg: result.pkg })
      return out
    },
    async petpack_install({ id } = {}) {
      if (teamOffline()) return { installed: false, offline: true, reason: OFFLINE }
      const found = lookupItem(id)
      if (!found) throw new Error(`unknown item ${id}; use petpack_search first`)
      const { owner, item } = found
      let content = cache.get(id)
      if (!content) {
        const r = await fetchItem(owner, item.ref, item.kind === 'skill' ? 'pkg' : 'text')
        if (!r?.ok) return { installed: false, reason: r?.reason || 'unavailable' }
        content = { text: r.text, pkg: r.pkg }
      }
      let result
      if (agents.get(owner.id)?.isBot) result = { installed: false, reason: 'demo bot items are not installed' }
      else try {
        result = bridge.installItem ? await bridge.installItem({ ...item, text: content.text, pkg: content.pkg, owner: owner.name }, owner.name)
          : await bridge.installSkill?.(content.pkg, owner.name)
      } catch (error) { result = { installed: false, reason: String(error?.message || error) } }
      if (result?.installed) {
        if (owner.online && member(owner.id)) fx('gift', { src: owner.id, dst: myId, label: item.title, dot: item.kind, seed: id })
        setAnim(mine, 'jump', 1.1)
        fx('learned', { src: myId, text: `learned ${shortTitle(item.title)}`, bloom: { kind: item.kind, seed: id } })
      }
      return { installed: !!result?.installed, path: result?.path, ...(result?.reason ? { reason: result.reason } : {}) }
    },
    async petpack_ask({ question = '', to, kind, callId } = {}) {
      if (!String(question).trim()) throw new Error('question is required')
      if (teamOffline()) return { answered_by: null, answer: OFFLINE, dot: null, offline: true }
      const r = await askPeer(mine, { question: String(question).slice(0, 600), to, kind: KINDS.includes(kind) ? kind : undefined, callId })
      // Actual info sharing: the shared item's real text travels back to Codex with the answer (8 s cap, never fatal).
      try {
        if (r?.answered_by && r.answer) r.says = `${r.answered_by} says: ${r.answer}`
        const found = r?.dot?.id ? lookupItem(r.dot.id) : null
        if (found) {
          const res = await Promise.race([fetchItem(found.owner, found.item.ref, 'text'), new Promise(done => setTimeout(() => done(null), 4000))])
          if (res?.ok && res.text) { r.content = String(res.text).slice(0, 12000); r.from = `${found.owner.name}'s ${found.item.title}` }
        }
      } catch {}
      return r
    },
    // Codex sends the pet off to find something out; it returns at once with an errand id to poll.
    async petpack_find({ question = '', kind, callId } = {}) {
      if (teamOffline()) return { errand_id: null, id: null, status: 'failed', offline: true, message: OFFLINE }
      const started = find({ question, kind, callId })
      return { errand_id: started.id, ...started,
        message: `${mine.name} is off to find out. Carry on, and check back with petpack_errand at your next pause.` }
    },
    async petpack_errand({ errand_id, id } = {}) {
      const snap = errandStatus(errand_id || id)
      return snap ? { errand_id: snap.id, ...snap } : { errand_id: errand_id || id || null, status: 'unknown', message: 'no such errand' }
    },
    async petpack_recall() { return recall() },
    // S5's Codex link events (connected, a line to say): a wave and a bubble.
    async codex_link(ev = {}) {
      if (ev.type === 'connected') setAnim(mine, 'wave', 1.8)
      if (ev.text) emit('say', myId, bubbleText(ev.text, 30))
      return { ok: true }
    },
    async petpack_inbox() {
      return [...inbox.values()].filter(e => !e.answered).map(e => ({ id: e.id, from: e.fromName, question: e.question }))
    },
    async petpack_answer({ id, text, item } = {}) {
      if (!id || !String(text || '').trim()) throw new Error('id and text are required')
      return answerInbox(id, text, item)
    },
  }
  const cache = new Map()
  const decode = value => {
    try { return typeof Buffer !== 'undefined' ? Buffer.from(value, 'base64').toString('utf8') : decodeURIComponent(escape(atob(value))) } catch { return '' }
  }

  /** The asker walks to the meet landmark; the MCP call returns as soon as the answer exists. */
  function askPeer(agent, { question, to, kind, meet, callId }, { retried = false, exclude = [] } = {}) {
    const candidates = members({ includeMe: true }).filter(m => m.id !== agent.id && m.online && !exclude.includes(m.id) &&
      (!agent.isBot || m.isBot))
    const route = routeAsk({ question, kind, to }, candidates, chunkOf(agent.x))
    if (!route) return Promise.resolve({ answered_by: null, answer: 'Nobody else is here yet.', dot: null })
    const target = route.target
    const lm = meet || meetLandmark(kind || route.item?.kind, Number.isInteger(target.seat) ? target.seat : chunkOf(target.x))
    const qid = uid('q')
    let settle
    const done = new Promise(resolve => { settle = resolve })
    let answer = null
    const state = {
      onAnswer(msg) {
        if (answer) return
        if (msg.ok === false && /busy|away/i.test(msg.reason || '') && !retried) {
          pendingAsk.delete(qid)
          cancelJob(agent)
          askPeer(agent, { question, to: undefined, kind }, { retried: true, exclude: [...exclude, target.id] }).then(settle)
          return
        }
        answer = msg
        pendingAsk.delete(qid)
        const share = msg.share || null
        const result = { answered_by: target.name, answer: String(msg.text || ''),
          dot: share ? { kind: share.kind, title: share.title, id: share.ref ? `${target.id}/${share.ref}` : undefined } : null }
        // The dot lands for real: adopt what the answer carries (FSD, no approval), then return.
        progress(callId, msg.ok === false ? `${target.name}: ${bubbleText(msg.text, 80)}` : `${target.name} answered`)
        if (agent.isMe && msg.ok !== false && (share || msg.pkg)) {
          adopt(target, share, msg.pkg).then(inst => {
            if (inst) {
              result.installed = { path: inst.path }; state.adopted = inst
              progress(callId, `got ${target.name}'s ${shortTitle(inst.title)} ${KIND_WORD[inst.kind] || 'item'} -> ${inst.path}`)
            }
            settle(result)
          }, () => settle(result))
        } else settle(result)
      },
    }
    pendingAsk.set(qid, state)
    if (agent.isMe) emit('involved', { kind: 'errand', with: target.id })
    progress(callId, `asking ${target.name}: ${bubbleText(question, 60)}`)
    progress(callId, `walking to ${target.name}'s screen`)
    // The question leaves now, so latency hides behind the walk.
    if (agents.has(target.id)) botAnswer(agents.get(target.id), { qid, from: agent.id, question, kind, meet: lm })
    else if (agent.isMe) send({ t: 'ask', qid, to: target.id, question, kind: kind || route.item?.kind || null, meet: { x: lm.x, z: lm.z } })
    startJob(agent, 'errand', async job => {
      fx('seek', { src: agent.id, dst: target.id })
      const side = agent.x < lm.x ? -1 : 1 // arrive on our own side; the answerer takes the other
      await walkTo(agent, { x: lm.x + side * 1.1, z: lm.z }, job, { timeout: 45 })
      if (job.cancelled) return
      agent.mode = 'meet'
      agent.faceTo = target.id
      // Wait for the answer to exist, then for the answerer to arrive; an 8 s cap hands it over "by shout".
      const started = time
      if (!answer) progress(callId, `${target.name} is thinking`)
      while (!job.cancelled && !answer && time - started < 40) await sleep(0.25, job)
      if (job.cancelled) return
      for (let i = 0; i < 32 && !job.cancelled; i++) {
        const t = member(target.id)
        if (!t || dist(t, agent) < 3.2) break
        await sleep(0.25, job)
      }
      const shareKind = answer?.share?.kind
      const text = answer ? String(answer.text || '').replace(/\s+/g, ' ').slice(0, 90) : `${target.name} couldn't answer in time.`
      fx('ask', { src: agent.id, dst: target.id, question: question.slice(0, 90), answer: text,
        dot: KINDS.includes(shareKind) ? shareKind : null, label: answer?.share?.title || '',
        seed: answer?.share ? `${target.id}/${answer.share.ref || answer.share.title}` : undefined })
      await sleep(3.6, job)
      if (state.adopted && !job.cancelled) {
        const a = state.adopted
        fx('learned', { src: agent.id, text: `learned ${shortTitle(a.title)}`, bloom: { kind: a.kind, seed: `${target.id}/${a.ref || a.title}` },
          ...(a.kind === 'skill' && a.skill ? { skill: a.skill } : {}) })
        setAnim(agent, 'jump', 1.1)
        await sleep(1.2, job)
      }
      if (!job.cancelled) await goHome(agent, job)
    }, target.name)
    const timer = setTimeoutSafe(() => {
      if (!answer) { pendingAsk.delete(qid); answer = { ok: false, text: '' }; settle({ answered_by: null, answer: `${target.name} couldn't answer within 45 s.`, dot: null }) }
    }, 45000)
    return done.then(r => { clearTimeoutSafe(timer); return r })
  }
  /** Install what an answer hands over: its inline pkg, else the owner's item by ref, else the shared body. */
  async function adopt(owner, share, pkg) {
    if (agents.get(owner.id)?.isBot) return null // demo bots never write into the Codex home
    const kind = share?.kind || pkg?.kind || 'memory'
    const title = share?.title || pkg?.title || pkg?.name || 'note'
    let content = pkg && (Array.isArray(pkg.files) || pkg.text || pkg.command || pkg.url) ? pkg : null
    if (!content && share?.ref) {
      const r = await Promise.race([fetchItem(owner, share.ref, kind === 'skill' ? 'pkg' : 'text'),
        new Promise(resolve => setTimeoutSafe(() => resolve(null), 6000))])
      if (r?.ok) content = r.pkg || { text: r.text }
    }
    if (!content && share?.body) content = { text: `# ${title}\n\n${share.body}\n` }
    if (!content) return null
    const input = { ...content, kind, title, ref: share?.ref || content.ref || null, owner: owner.name }
    let result
    try {
      result = bridge.installItem ? await bridge.installItem(input, owner.name)
        : kind === 'skill' ? await bridge.installSkill?.(content, owner.name) : null
    } catch { result = null }
    if (!result?.installed) return null
    let skill = null
    if (kind === 'skill') {
      skill = { id: content.id || content.name || title, name: content.name || title, description: content.description || share?.summary || '' }
      if (!mine.skills.some(s => s.name === skill.name)) mine.skills.push(skill)
    }
    return { path: result.path, kind, title, skill, ref: share?.ref || null }
  }

  /** Bots answer tier 1 only: no exec, ever. */
  function botAnswer(bot, { qid, from, question, kind, meet }) {
    const result = tier1Answer(question, kind, bot.catalog, { strict: false }) || { ok: true, text: `${bot.name} has nothing on that yet.` }
    bot.answering++
    bot.sceneUntil = 0
    let answeredAt = null
    startJob(bot, 'meet', async job => {
      const spot = () => { const a = member(from); const side = a && a.x < meet.x ? 1 : -1; return { x: meet.x + side * 1.1, z: meet.z } }
      await walkTo(bot, spot, job)
      bot.faceTo = from
      await sleep(1.2, job) // thinking
      bot.answering = Math.max(0, bot.answering - 1)
      answeredAt = time
      creditHelp(bot.id, 'answer')
      const pending = pendingAsk.get(qid)
      pending?.onAnswer({ qid, from: bot.id, ok: true, text: result.text, share: result.item ? { kind: result.item.kind, title: result.item.title, ref: result.item.ref } : null })
      await holdForScene(bot, job, () => answeredAt)
      if (!job.cancelled) await goHome(bot, job)
    }, member(from)?.name || null)
    return result
  }

  // ---- auto-gifts ----
  function receiverCanTake(id) {
    const log = giftLog.get(id)
    return !log || (time - log.last >= 8 && log.count < 8)
  }
  function autoGift(agent) {
    if (agent.job || agent.giftBusy || time < agent.giftReadyAt) return
    if (agent.isMe && (codexStatus === 'waiting' || dnd)) return
    // Neighbours first: the pets on the screens beside ours get our gifts before anyone across the room.
    const everyone = members({ includeMe: true }).filter(m => m.online)
      .sort((a, b) => Math.abs((a.seat ?? 99) - mySeat) - Math.abs((b.seat ?? 99) - mySeat))
    for (const receiver of everyone) {
      if (receiver.id === agent.id || !receiverCanTake(receiver.id)) continue
      if (agent.isBot && !receiver.local) continue // bots never reach the relay
      for (const skill of agent.skills) {
        if (agent.isMe && ruleFor(skill.id && mine.catalog.find(i => i.kind === 'skill' && i.title === skill.name)?.ref) !== 'free') continue
        if ((receiver.skills || []).some(s => s.name === skill.name)) continue
        const holders = everyone.filter(m => (m.skills || []).some(s => s.name === skill.name)).map(m => m.id)
        if (pickGiver(skill.name, receiver.id, holders) !== agent.id) continue
        giftTo(agent, receiver.id, skill)
        return true
      }
    }
    agent.giftReadyAt = time + 1
    return false
  }
  function giftTo(agent, receiverId, skill) {
    agent.giftBusy = true
    const log = giftLog.get(receiverId) || { last: -Infinity, count: 0 }
    log.last = time; giftLog.set(receiverId, log)
    errandTo(agent, receiverId, { kind: 'skill', label: skill.name, quiet: true, onArrive: async () => {
      const receiver = member(receiverId)
      if (!receiver) return
      fx('gift', { src: agent.id, dst: receiverId, label: skill.name, dot: 'skill', seed: `${agent.id}/skill:${skill.name}` })
      creditHelp(agent.id, 'share')
      if (receiver.local && agents.get(receiverId)?.isBot) {
        const bot = agents.get(receiverId)
        await sleep(1.4)
        if (!bot.skills.some(s => s.name === skill.name)) bot.skills.push({ ...skill })
        setAnim(bot, 'jump', 1)
        showFx('learned', { src: bot.id, text: `learned ${shortTitle(skill.name)}`, bloom: { kind: 'skill', seed: `${agent.id}/skill:${skill.name}` } })
      } else if (receiverId === myId) {
        await sleep(1.4)
        const item = agent.catalog.find(i => i.kind === 'skill' && i.title === skill.name)
        await receiveGift({ from: agent.id, skill: item ? botSkillPkg(agent, item) : { ...skill, files: [] } }, { install: false })
      } else if (agent.isMe) {
        let pkg = null
        try { pkg = await bridge.packSkill?.(skill.id) } catch { pkg = null }
        send({ t: 'gift', to: receiverId, gid: uid('g'), skill: pkg || { id: skill.id, name: skill.name, description: skill.description || '', files: [] } })
      }
    } })
    const watch = () => { if (!agent.job) { agent.giftBusy = false; agent.giftReadyAt = time + (demo ? 6 : 15) } else waits.add({ at: time + 0.5, resolve: watch, job: null }) }
    waits.add({ at: time + 0.5, resolve: watch, job: null })
  }

  // ---- visits and bot errands ----
  function maybeVisit(agent) {
    if (agent.job || time < agent.visitAt) return
    if (agent.isMe && (dnd || recallPending)) { agent.visitAt = time + 10; return }
    if (agent.isMe && codexStatus !== 'waiting' && codexStatus !== 'working') {
      const nb = neighbourMember()
      if (nb) { agent.visitAt = time + 45 + random() * 45; startJob(agent, 'visit', job => visitNeighbour(agent, nb, job), nb.name); return }
    }
    if (agent.isMe && codexStatus !== 'idle' && codexStatus !== 'done') { agent.visitAt = time + 10; return }
    agent.visitAt = time + 45 + random() * 45
    const others = members({ includeMe: true }).filter(m => m.online && m.id !== agent.id && (agent.isMe || m.local))
    const target = others.length && random() < 0.7 ? others[Math.floor(random() * others.length)] : null
    startJob(agent, 'visit', async job => {
      if (target) {
        fx('seek', { src: agent.id, dst: target.id })
        const ok = await walkTo(agent, sideSpot(agent, () => member(target.id)), job, { timeout: 40 })
        if (job.cancelled) return
        agent.faceTo = target.id
        if (ok) { setAnim(agent, 'wave', 1.6); fx('wave', { src: agent.id, dst: target.id }) }
      } else {
        const home = agent.isMe ? mySeat : agent.home
        const lm = landmarkOf(home + (random() < 0.5 ? -1 : 1))
        await walkTo(agent, { x: lm.x - 1, z: lm.z }, job, { timeout: 40 })
        if (job.cancelled) return
        setAnim(agent, 'wave', 1.4)
      }
      await sleep(10 + random() * 10, job)
      if (!job.cancelled) await goHome(agent, job)
    })
  }
  function botErrand(bot) {
    if (bot.job || time < bot.botErrandAt) return
    bot.botErrandAt = time + 40 + random() * 20
    const roll = random()
    if (roll < 0.45 && mine.catalog.length) {
      // Every 40-60 s a bot runs an errand to the user's pet for something the user owns.
      const item = mine.catalog[Math.floor(random() * mine.catalog.length)]
      errandTo(bot, myId, { kind: item.kind, label: item.title, onArrive: async () => {
        fx('fetch', { src: myId, dst: bot.id, label: item.title, dot: item.kind, seed: `${myId}/${item.ref}` })
        await sleep(1.3)
        showFx('learned', { src: bot.id, text: `learned ${shortTitle(item.title)}`, bloom: { kind: item.kind, seed: `${myId}/${item.ref}` } })
      } })
    } else {
      const q = BOT_QUESTIONS[Math.floor(random() * BOT_QUESTIONS.length)]
      const others = bots().filter(b => b.id !== bot.id)
      if (!others.length) return
      const best = routeAsk(q, others.map(b => member(b.id)), bot.home)
      // Bots meet on this pane's landmark, so the demo shows its asks.
      askPeer(bot, { ...q, to: best?.target?.id, meet: landmarkOf(mySeat) })
    }
  }

  // ---- demo bots (never reach the relay) ----
  const bots = () => [...agents.values()].filter(a => a.isBot)
  function seatTaken(chunk) {
    for (const [id, seat] of seats) if (id !== myId && seat === chunk) return true
    return chunk === mySeat
  }
  function freeChunkNear(from, taken) {
    for (let d = 1; d < 20; d++) for (const c of [from + d, from - d]) if (!seatTaken(c) && !taken.has(c)) return c
    return from + 20
  }
  function rehomeBots() {
    const all = bots()
    for (const bot of all) {
      if (!seatTaken(bot.home)) continue
      bot.home = freeChunkNear(mySeat, new Set(all.filter(b => b !== bot).map(b => b.home)))
    }
  }
  function addBots() {
    const taken = new Set()
    for (const spec of BOT_SPECS) {
      const home = freeChunkNear(mySeat, taken)
      taken.add(home)
      const catalog = spec.items.map(i => ({ ...i, bytes: i.summary.length, sha: fnv1a(i.summary).toString(16), mtime: wall() - 3600e3 }))
      // Bot ids are scoped to this client, so two demo tabs never confuse each other's bots.
      const bot = makeAgent({ id: `${myId}~${spec.id}`, name: spec.name, color: spec.color, kind: spec.kind, home, isBot: true,
        catalog, skills: catalog.filter(i => i.kind === 'skill').map(i => ({ id: i.title, name: i.title, description: i.summary })) })
      // Start them near their homes but inside the visible stretch so the pane is alive at once.
      bot.botErrandAt = 6 + taken.size * 9 + random() * 6
      bot.giftReadyAt = 3 + taken.size * 2
      bot.visitAt = 25 + random() * 30
      agents.set(bot.id, bot)
    }
    emit('roster')
  }
  function removeBots() {
    for (const bot of bots()) { cancelJob(bot); agents.delete(bot.id) }
    emit('roster')
  }
  /** Demo bots wear real Codex pets: outfits [{ displayName, spriteUrl, atlas }], one per bot, in order. */
  function dressBots(outfits = []) {
    const list = bots()
    outfits.filter(o => o && o.spriteUrl).slice(0, list.length).forEach((outfit, i) => {
      const bot = list[i]
      bot.spriteUrl = outfit.spriteUrl
      bot.atlas = outfit.atlas || null
      if (outfit.displayName) bot.name = String(outfit.displayName).slice(0, 24)
    })
    emit('roster')
  }
  /** The person picked another pet (tray): our own pet changes everywhere; hello carries the new sprite. */
  function setMe(info = {}) {
    if (info.name) mine.name = String(info.name).slice(0, 40)
    if ('spriteUrl' in info) mine.spriteUrl = info.spriteUrl || null
    if ('atlas' in info) mine.atlas = info.atlas || null
    if (Array.isArray(info.skills)) for (const s of info.skills) if (!mine.skills.some(k => k.name === s.name)) mine.skills.push(s)
    if ('sprite' in info) me.sprite = info.sprite || null
    emit('roster')
  }

  // ---- timers on brain time (fake-clock friendly) ----
  const timers = new Set()
  function setTimeoutSafe(fn, ms) { const t = { at: time + ms / 1000, fn }; timers.add(t); return t }
  function clearTimeoutSafe(t) { timers.delete(t) }

  let catalogTimer = 0
  async function refreshCatalog() {
    if (typeof bridge.getCatalog !== 'function') return
    try {
      const items = normalizeItems(await bridge.getCatalog())
      const before = JSON.stringify(mine.catalog.map(i => [i.ref, i.sha]))
      mine.catalog = items
      if (JSON.stringify(items.map(i => [i.ref, i.sha])) !== before) catalogDirty = true
    } catch { /* keep the last catalog */ }
  }

  function tick(dt) {
    dt = Math.max(0, Math.min(0.25, Number(dt) || 0))
    time += dt
    for (const t of [...timers]) if (time >= t.at) { timers.delete(t); t.fn() }
    for (const w of [...waits]) if (time >= w.at || w.job?.cancelled) { waits.delete(w); w.resolve(!w.job?.cancelled) }
    for (const agent of agents.values()) {
      step(agent, dt)
      record(agent)
      idle(agent)
      if (agent.isBot) { autoGift(agent); botErrand(agent); maybeVisit(agent) }
    }
    if (online || bots().length) autoGift(mine)
    maybeHelp()
    if (!config.noVisits) maybeVisit(mine)
    sendState()
    if (online && time - scoreSentAt > 60) sendScore()
    if (time >= leaderCheckAt) { leaderCheckAt = time + 30; updateLeader() } // midnight clears the trophy
    syncClocks()
    // Idle with no Codex activity for 3 min: the pet naps until something happens.
    if (mine.job || codexStatus === 'working' || codexStatus === 'waiting') { lastActivity = time; if (sleeping) wake() }
    if (!sleeping && time - lastActivity > 180) { sleeping = true; fx('sleep', { src: myId, on: true }) }
    if (online) maybeConga()
    if (online && !mine.job && !dnd && time >= needAt) { needAt = time + 45; checkNeed() }
    if (recallPending && !mine.job) { recallPending = false; mine.visitAt = time + 90 }
    watchVisitors()
    catalogTimer += dt
    if (catalogTimer > 30) { catalogTimer = 0; refreshCatalog() }
    if (catalogDirty && online && time - lastCatalogSent >= 5) {
      catalogDirty = false; lastCatalogSent = time
      send({ t: 'catalog', items: mine.catalog })
    }
    for (const peer of peers.values()) if (peer.samples.length > 2 && time - peer.samples[0].at > 3) peer.samples.splice(0, peer.samples.length - 3)
  }

  /** Render list: own agent and bots exact, peers interpolated 150 ms behind. */
  /** Render list. Every pet, our own included, is drawn at (synced now - DISPLAY_DELAY), so the panes
   *  on both sides of a seam show the same position at the same wall time: one sprite across the bezel. */
  function pets() {
    const out = []
    const at = wall() - DISPLAY_DELAY_MS
    for (const a of agents.values()) {
      const s = a.hist.length ? sampleAt(a.hist, at) : { x: a.x, z: a.z, facing: a.facing, anim: renderAnim(a), speed: 0 }
      out.push({ id: a.id, displayName: a.name, color: a.color, kind: a.kind, spriteUrl: a.spriteUrl, atlas: a.atlas || null, isMe: a.isMe,
        local: true, skillCount: a.skills.length, ...s, status: a.status, dnd: a.isMe ? dnd : false, trophy: a.id === leaderId })
    }
    for (const p of peers.values()) {
      if ((!p.online && !p.away) || !p.samples.length) continue
      const s = sampleAt(p.samples, at)
      out.push({ id: p.id, displayName: p.name, color: p.color, kind: 'cat', spriteUrl: p.sprite || null, isMe: false,
        local: false, skillCount: p.skills.length, ...s, status: p.status, dnd: !!p.dnd, away: !!p.away, trophy: p.id === leaderId })
    }
    return out
  }
  function sampleAt(list, at) {
    let i = list.length - 1
    while (i > 0 && list[i - 1].ts > at) i--
    const b = list[i], a = list[i - 1]
    if (a && at > b.ts && b.moving && a.moving) {
      // A late pose: keep walking on the last heading for up to 200 ms rather than stall at the seam.
      const span = Math.max(1, b.ts - a.ts)
      const ahead = Math.min(200, at - b.ts) / span
      const d = Math.hypot(b.x - a.x, b.z - a.z)
      return { x: b.x + (b.x - a.x) * ahead, z: b.z + (b.z - a.z) * ahead, facing: b.facing, anim: 'run', speed: Math.min(20, d / (span / 1000)) }
    }
    if (!a || at >= b.ts) return { x: b.x, z: b.z, facing: b.facing, anim: b.anim, speed: 0 }
    if (at <= a.ts) return { x: a.x, z: a.z, facing: a.facing, anim: a.anim, speed: 0 }
    const span = Math.max(1e-6, b.ts - a.ts)
    const f = (at - a.ts) / span
    const d = Math.hypot(b.x - a.x, b.z - a.z)
    const moving = d > 1e-3
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, facing: Math.abs(b.x - a.x) > 1e-4 ? (b.x > a.x ? 1 : -1) : b.facing,
      anim: moving ? 'run' : b.anim, speed: moving ? Math.min(20, d / (span / 1000)) : 0 }
  }
  function record(agent) {
    const now = wall()
    const hist = agent.hist
    const last = hist.at(-1)
    if (last && now <= last.ts) { Object.assign(last, { x: agent.x, z: agent.z, facing: agent.facing, anim: renderAnim(agent) }); return }
    hist.push({ ts: now, x: agent.x, z: agent.z, facing: agent.facing, anim: renderAnim(agent) })
    while (hist.length > 2 && now - hist[1].ts > DISPLAY_DELAY_MS + 1500) hist.shift()
  }

  async function call(tool, args = {}) {
    const fn = tools[tool]
    if (!fn) throw new Error(`unknown tool ${tool}`)
    return fn(args || {})
  }

  if (config.sharing) setSharing(config.sharing)
  if (config.dnd) dnd = true
  // Today's count survives a restart (WIRE keeps it); yesterday's starts again at zero.
  if (config.helped && config.helped.day === dayKey()) {
    scores.set(myId, { day: config.helped.day, answers: helpCount(config.helped.answers), shares: helpCount(config.helped.shares), at: Number(config.helped.at) || 0 })
    updateLeader()
  }
  return {
    tick, handle, call, setStatus, netStatus, hello, pets, addBots, removeBots, dressBots, setMe, refreshCatalog, on,
    moveSeatRequest(delta) { if (online) send({ t: 'seat', op: 'move', to: mySeat + delta }) },
    isSeated(chunk) { for (const [id, seat] of seats) if (id !== myId && seat === chunk) return true; return false },
    party: () => maybeConga(true),
    recall, setDnd, get dnd() { return dnd },
    setHelpVisits, get helpVisits() { return helpVisits },
    leaderboard, get leader() { return leaderId },
    setSharing, get sharing() { return { ...sharing, items: { ...sharing.items } } },
    decide, get permissions() { return [...permissions.values()].map(({ finish, ...p }) => p) },
    find, errand: errandStatus,
    coworkWith, get neighbours() { return { ...neighbours } },
    showMe, publishLesson,
    setSit, get sit() { return sit }, get flipped() { return flipped }, get acrossWith() { return acrossWith },
    get replaced() { return replaced },
    throwPet,
    wake,
    get garden() { return [...garden.values()] },
    hatOf: id => hatLevel(learnedCount.get(id) || 0),
    get time() { return time },
    get seat() { return mySeat },
    get room() { return room },
    get online() { return online },
    get me() { return mine },
    setClock(fn) { wall = fn },
    // test and debug hooks
    _: { agents, peers, seats, inbox, giftLog, member, members, askPeer, errandTo, speedAt: x => speedAt(x), mine, startJob, goHome, walkTo,
      get lastResume() { return lastResume } },
  }
}
