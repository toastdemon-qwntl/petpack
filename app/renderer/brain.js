// The pack brain: simulates this laptop's own agent (plus local demo bots), broadcasts its
// state, mirrors peers, and turns MCP tool calls into visible errands. No DOM, no three:
// `node --test` drives it with a fake relay and a fake clock (brain.tick(dt)).
import { createTerrain, createStripNavigation, ROAD_Z } from './world/map-paths.js'

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
  const emit = (name, ...args) => { try { view[name]?.(...args) } catch (error) { console.warn('petpack view', name, error) } }
  let seq = 0
  const uid = prefix => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(random() * 1e6).toString(36)}`

  const myId = me.id || 'me'
  const mine = makeAgent({ id: myId, name: me.name || 'Pip', color: me.color || colorFor(myId), kind: 'cat',
    home: mySeat, isMe: true, spriteUrl: me.spriteUrl || null, skills: me.skills || [], catalog: normalizeItems(me.catalog) })
  mine.atlas = me.atlas || null // real Codex sheets may be 8x11; the world crops by this grid
  agents.set(myId, mine)
  seats.set(myId, mySeat)
  let codexStatus = 'idle'
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
  function startJob(agent, mode, fn) {
    cancelJob(agent)
    const job = { mode, cancelled: false }
    agent.job = job
    agent.mode = mode
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
    if (agent.route.length || time < agent.wanderAt) return
    const working = agent.status === 'working'
    if (agent.status === 'waiting' && agent.isMe) { agent.wanderAt = time + 2; return }
    const spot = homeSpot(home)
    agent.route = nav.path(agent, spot).map(p => ({ x: p.x, z: p.z }))
    agent.wanderAt = time + (working ? 0.4 + random() * 1.2 : 3 + random() * 6)
  }

  // ---- effects: local + room ----
  function fx(kind, payload) {
    showFx(kind, payload)
    // Bots are local to this pane; their effects never travel.
    const local = id => id && agents.get(id)?.isBot
    if (online && !local(payload.src) && !local(payload.dst)) send({ t: 'fx', kind, ...payload })
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
    // Text only for the moments that matter: the question, the answer and "learned X".
    if (kind === 'gift' || kind === 'fetch') emit('gift', p.src, p.dst, { label: '', color: DOT_COLORS[p.dot] || DOT_COLORS.skill, kind: p.dot })
    else if (kind === 'ask') emit('ask', p.src, p.dst, { question: bubbleText(p.question, 44), answer: bubbleText(p.answer, 44), kind: p.dot || undefined, label: '' })
    else if ((kind === 'learned' || kind === 'say') && p.text && p.src) emit('say', p.src, bubbleText(p.text, 30))
    else if (kind === 'wave' && p.src && agents.has(p.src)) setAnim(agents.get(p.src), 'wave', 1.4)
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
  function renderAnim(agent) {
    if (agent.anim && time < agent.animUntil) return agent.anim
    if (agent.mode === 'meet' && agent.answering) return 'review'
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
    const pose = { x: round(mine.x), z: round(mine.z), facing: mine.facing, anim, status: mine.status, m: moving ? 1 : 0 }
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
  function onPose(from, p) {
    const peer = peers.get(from)
    if (!peer || !Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.ts)) return
    peer.posed = true
    pushSample(peer, p, p.ts - peer.clock.offset)
  }
  const round = v => Math.round(v * 1000) / 1000
  function hello() {
    return { t: 'hello', v: 2, id: myId, room, seat: welcomed || Number.isInteger(config.seat) ? mySeat : null,
      dock: config.dock || 'right', name: mine.name, color: mine.color, status: mine.status,
      skills: mine.skills.map(s => ({ id: s.id, name: s.name, description: s.description || '' })),
      catalog: mine.catalog, sprite: me.sprite || null, answers: config.answers !== false,
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
    if (s.status) peer.status = s.status
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
        for (const [id, seat] of Object.entries(msg.seats || {})) {
          const peer = peers.get(id)
          if (peer && Number.isInteger(seat)) { peer.seat = seat; if (peer.online) seats.set(id, seat) }
        }
        if (Number.isInteger(firstSeat)) moveSeat(firstSeat, 'welcome', !welcomed && firstSeat !== mySeat)
        seats.set(myId, mySeat)
        seatedCache = null
        welcomed = true
        if (!demo && bots().length) removeBots() // solo fallback bots leave once real peers can arrive
        rehomeBots()
        emit('online', { room, seat: mySeat })
        sendState(true)
        break
      }
      case 'join': {
        const peer = upsertPeer(msg.peer, true)
        if (peer) {
          peer.joinedAt = time
          // A newcomer gets a welcome gift 4 s after joining.
          mine.giftReadyAt = time + 4
          rehomeBots()
          emit('roster')
        }
        break
      }
      case 'leave': {
        const peer = peers.get(msg.id)
        if (peer) { peer.online = false; peer.lastSeen = msg.lastSeen || wall(); seats.delete(msg.id); seatedCache = null; emit('roster') }
        break
      }
      case 'state': {
        for (const s of msg.pets || []) {
          if (s.id === myId) continue
          const peer = peers.get(s.id) || upsertPeer({ id: s.id }, true)
          if (!peer) continue
          if (peer.posed) { if (s.status) peer.status = s.status } // timestamped poses carry the position
          else pushSample(peer, s)
        }
        break
      }
      case 'seat': {
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
        if (!payload.src) payload.src = from
        showFx(kind, payload)
        break
      }
    }
  }
  let welcomed = false
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
  function netStatus(state) {
    // 'solo' when the relay is unreachable; bots keep the pane alive.
    if (state === 'solo' || state === 'offline') {
      if (online) {
        online = false
        for (const peer of peers.values()) peer.online = false
        for (const id of [...seats.keys()]) if (id !== myId) seats.delete(id)
        seatedCache = null
      }
      if (config.soloBots !== false && !bots().length) addBots()
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
    const result = await readOwn(msg.ref, msg.as)
    send({ t: 'fetched', fid: msg.fid, to: msg.from, ok: result.ok, sha: result.sha || item?.sha || '',
      text: result.text, pkg: result.pkg, reason: result.reason })
  }
  function answerTimeoutText(name) { return `${name} couldn't finish in time.` }
  async function receiveAsk(msg) {
    const fromName = peers.get(msg.from)?.name || 'a teammate'
    const entry = { id: msg.qid, from: msg.from, fromName, question: String(msg.question || '').slice(0, 600), kind: msg.kind, at: time, answered: false }
    inbox.set(msg.qid, entry)
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
    })
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
    if (entry.answered) return
    entry.answered = true; entry.answeredAt = time
    inbox.delete(msg.qid)
    mine.lastAnswer++
    const share = result?.share || (result?.item ? { kind: result.item.kind, title: result.item.title, ref: result.item.ref } : null)
    send({ t: 'answer', qid: msg.qid, to: asker, ok: result?.ok !== false, text: String(result?.text || '').slice(0, 1200),
      share, pkg: result?.pkg, reason: result?.reason })
  }
  function answerInbox(id, text, item) {
    const entry = inbox.get(id)
    if (!entry || entry.answered) return { ok: false, reason: 'already answered or unknown id' }
    entry.answered = true; entry.answeredAt = time
    inbox.delete(id)
    mine.lastAnswer++
    const share = item ? (typeof item === 'string' ? mine.catalog.find(i => i.ref === item || i.title === item) || null : item) : null
    send({ t: 'answer', qid: id, to: entry.from, ok: true, text: String(text || '').slice(0, 1200), share })
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
    fx('learned', { src: myId, text: `learned ${shortTitle(skill.name)}`, skill: { id: skill.id || skill.name, name: skill.name, description: skill.description || '' } })
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
    })
  }

  const tools = {
    async petpack_status() {
      setAnim(mine, 'wave', 1.8)
      sendState(true)
      const list = members().filter(m => !m.isBot || demo || !online)
      return {
        room: room || (online ? null : 'solo'),
        me: { name: mine.name, pet: mine.name, seat: mySeat, status: mine.status, online },
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
      const results = searchCatalogs(query, members(), { kind: KINDS.includes(kind) ? kind : undefined, limit, now: wall() })
      const owners = new Set(results.map(r => r.owner))
      for (const m of members()) if (owners.has(m.name)) fx('pulse', { src: m.id })
      return results
    },
    async petpack_get({ id } = {}) {
      const found = lookupItem(id)
      if (!found) throw new Error(`unknown item ${id}; use petpack_search first`)
      const { owner, item } = found
      const as = item.kind === 'skill' ? 'pkg' : 'text'
      // Content travels now; the walk plays out on its own.
      const content = fetchItem(owner, item.ref, as)
      errandTo(mine, owner.id, { kind: item.kind, label: item.title, onArrive: async () => {
        await content
        if (owner.online) { fx('fetch', { src: owner.id, dst: myId, dot: item.kind }); await sleep(1.4) }
        fx('learned', { src: myId, text: `learned ${shortTitle(item.title)}` })
      } })
      const result = await content
      if (!result?.ok) return { kind: item.kind, title: item.title, owner: owner.name, text: '', error: result?.reason || `${owner.name} is away` }
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
      cache.set(id, { ...out, pkg: result.pkg })
      return out
    },
    async petpack_install({ id } = {}) {
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
      fx('gift', { src: owner.online && member(owner.id) ? owner.id : myId, dst: myId, label: item.title, dot: item.kind })
      setAnim(mine, 'jump', 1.1)
      fx('learned', { src: myId, text: `learned ${shortTitle(item.title)}` })
      return { installed: !!result?.installed, path: result?.path, ...(result?.reason ? { reason: result.reason } : {}) }
    },
    async petpack_ask({ question = '', to, kind } = {}) {
      if (!String(question).trim()) throw new Error('question is required')
      return askPeer(mine, { question: String(question).slice(0, 600), to, kind: KINDS.includes(kind) ? kind : undefined })
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
  function askPeer(agent, { question, to, kind, meet }, { retried = false, exclude = [] } = {}) {
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
        if (agent.isMe && msg.ok !== false && (share || msg.pkg)) {
          adopt(target, share, msg.pkg).then(inst => {
            if (inst) { result.installed = { path: inst.path }; state.adopted = inst }
            settle(result)
          }, () => settle(result))
        } else settle(result)
      },
    }
    pendingAsk.set(qid, state)
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
        dot: KINDS.includes(shareKind) ? shareKind : null, label: answer?.share?.title || '' })
      await sleep(3.6, job)
      if (state.adopted && !job.cancelled) {
        const a = state.adopted
        fx('learned', { src: agent.id, text: `learned ${shortTitle(a.title)}`,
          ...(a.kind === 'skill' && a.skill ? { skill: a.skill } : {}) })
        setAnim(agent, 'jump', 1.1)
        await sleep(1.2, job)
      }
      if (!job.cancelled) await goHome(agent, job)
    })
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
    return { path: result.path, kind, title, skill }
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
      const pending = pendingAsk.get(qid)
      pending?.onAnswer({ qid, from: bot.id, ok: true, text: result.text, share: result.item ? { kind: result.item.kind, title: result.item.title, ref: result.item.ref } : null })
      await holdForScene(bot, job, () => answeredAt)
      if (!job.cancelled) await goHome(bot, job)
    })
    return result
  }

  // ---- auto-gifts ----
  function receiverCanTake(id) {
    const log = giftLog.get(id)
    return !log || (time - log.last >= 8 && log.count < 8)
  }
  function autoGift(agent) {
    if (agent.job || agent.giftBusy || time < agent.giftReadyAt) return
    if (agent.isMe && codexStatus === 'waiting') return
    const everyone = members({ includeMe: true }).filter(m => m.online)
    for (const receiver of everyone) {
      if (receiver.id === agent.id || !receiverCanTake(receiver.id)) continue
      if (agent.isBot && !receiver.local) continue // bots never reach the relay
      for (const skill of agent.skills) {
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
      fx('gift', { src: agent.id, dst: receiverId, label: skill.name, dot: 'skill' })
      if (receiver.local && agents.get(receiverId)?.isBot) {
        const bot = agents.get(receiverId)
        await sleep(1.4)
        if (!bot.skills.some(s => s.name === skill.name)) bot.skills.push({ ...skill })
        setAnim(bot, 'jump', 1)
        showFx('learned', { src: bot.id, text: `learned ${shortTitle(skill.name)}` })
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
        fx('fetch', { src: myId, dst: bot.id, label: item.title, dot: item.kind })
        await sleep(1.3)
        showFx('learned', { src: bot.id, text: `learned ${shortTitle(item.title)}` })
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
    if (!config.noVisits) maybeVisit(mine)
    sendState()
    syncClocks()
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
        local: true, skillCount: a.skills.length, ...s, status: a.status })
    }
    for (const p of peers.values()) {
      if (!p.online || !p.samples.length) continue
      const s = sampleAt(p.samples, at)
      out.push({ id: p.id, displayName: p.name, color: p.color, kind: 'cat', spriteUrl: p.sprite || null, isMe: false,
        local: false, skillCount: p.skills.length, ...s, status: p.status })
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

  return {
    tick, handle, call, setStatus, netStatus, hello, pets, addBots, removeBots, refreshCatalog,
    moveSeatRequest(delta) { if (online) send({ t: 'seat', op: 'move', to: mySeat + delta }) },
    isSeated(chunk) { for (const [id, seat] of seats) if (id !== myId && seat === chunk) return true; return false },
    get time() { return time },
    get seat() { return mySeat },
    get room() { return room },
    get online() { return online },
    get me() { return mine },
    setClock(fn) { wall = fn },
    // test and debug hooks
    _: { agents, peers, seats, inbox, giftLog, member, members, askPeer, errandTo, speedAt: x => speedAt(x), mine, startJob, goHome, walkTo },
  }
}
