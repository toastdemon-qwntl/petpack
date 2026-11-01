// T4 brain (SCOPE-backend): node --test app/renderer/brain.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createBrain, pickGiver, fnv1a, routeAsk, searchCatalogs, tier1Answer, chunkOf, meetLandmark,
  CHUNK_W, WALK_SPEED, FAST_FORWARD,
} from './brain.js'

function seeded(seed = 7) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296)
}
function fakeNet() {
  return { sent: [], send(msg) { this.sent.push(msg); return true }, last(t) { return this.sent.filter(m => m.t === t).at(-1) } }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
async function run(brain, seconds, dt = 0.1, each) {
  for (let t = 0; t < seconds; t += dt) {
    brain.tick(dt)
    await flush()
    if (each) each()
  }
}
const item = (ref, title, summary, kind = ref.split(':')[0]) => ({ ref, kind, title, summary, bytes: summary.length, sha: 'x', mtime: 0 })
const REX = { id: 'rex', name: 'Rex', color: '#df706d', seat: 3, x: 3 * CHUNK_W + 1, z: 1.5, status: 'idle', skills: [],
  catalog: [item('skill:azure-deploy', 'azure-deploy', 'Ship a Node app to Azure App Service with zip deploy.'),
    item('memory:click-through', 'Windows click-through', 'setIgnoreMouseEvents forward on Windows.')] }
const BEA = { id: 'bea', name: 'Bea', color: '#80b291', seat: 1, x: CHUNK_W, z: 1.5, status: 'working', skills: [],
  catalog: [item('skill:pdf-tables', 'pdf-tables', 'Extract tables from PDF files into CSV.')] }
function welcome(brain, peers = [REX, BEA], seat = 0) {
  brain.handle({ t: 'welcome', v: 2, room: 'net-test', you: { id: 'me', seat }, peers, away: [], links: [] })
}
function makeBrain({ bridge = {}, demo = false, net = fakeNet() } = {}) {
  const brain = createBrain({ bridge, net, me: { id: 'me', name: 'Pip', skills: [], catalog: [] },
    config: { demo, seat: 0, dock: 'right', noVisits: true }, random: seeded(11) })
  return { brain, net }
}

test('the giver choice is deterministic and independent of holder order', () => {
  const holders = ['amy', 'bob', 'cat', 'dan']
  const giver = pickGiver('pdf', 'eve', holders)
  assert.equal(giver, pickGiver('pdf', 'eve', holders.slice().reverse()))
  assert.equal(giver, pickGiver('pdf', 'eve', ['dan', 'amy', 'cat', 'bob']))
  const expected = holders.slice().sort((a, b) => fnv1a(`pdf|eve|${a}`) - fnv1a(`pdf|eve|${b}`))[0]
  assert.equal(giver, expected)
  assert.notEqual(pickGiver('pdf', 'amy', holders), 'amy', 'the receiver never gives to itself')
})

test('ask routes to the best item owner; below 0.3 to the nearest free peer; `to` overrides', async () => {
  const peers = [{ ...BEA, online: true }, { ...REX, online: true }]
  assert.equal(routeAsk({ question: 'how do we ship to Azure?' }, peers, 0).target.id, 'rex')
  assert.equal(routeAsk({ question: 'extract the tables in this pdf' }, peers, 0).target.id, 'bea')
  const vague = routeAsk({ question: 'what is love' }, peers, 0)
  assert.equal(vague.target.id, 'rex', 'Bea is working, so the free peer answers')
  assert.equal(routeAsk({ question: 'how do we ship to Azure?', to: 'Bea' }, peers, 0).target.id, 'bea')

  const installs = []
  const bridge = { installItem: async (input, from) => { installs.push({ input, from }); return { installed: true, path: `/codex/skills/petpack-${input.name || input.title}` } } }
  const { brain, net } = makeBrain({ bridge })
  welcome(brain)
  const pending = brain.call('petpack_ask', { question: 'how do we ship to Azure?', kind: 'skill' })
  await flush()
  const ask = net.last('ask')
  assert.equal(ask.to, 'rex')
  assert.equal(ask.question, 'how do we ship to Azure?')
  // The answer names an item by ref only: the asker fetches the package and adopts it before returning.
  brain.handle({ t: 'answer', from: 'rex', qid: ask.qid, ok: true, text: 'Use my azure-deploy skill.', share: { kind: 'skill', title: 'azure-deploy', ref: 'skill:azure-deploy' } })
  await flush()
  const fetch = net.last('fetch')
  assert.deepEqual([fetch.owner, fetch.ref, fetch.as], ['rex', 'skill:azure-deploy', 'pkg'])
  brain.handle({ t: 'fetched', fid: fetch.fid, ok: true, sha: 's', pkg: { kind: 'skill', id: 'azure-deploy', name: 'azure-deploy', description: 'ship', files: [{ path: 'SKILL.md', b64: 'eA==' }] } })
  const result = await pending
  assert.equal(result.answered_by, 'Rex')
  assert.match(result.answer, /azure-deploy/)
  assert.equal(result.dot.id, 'rex/skill:azure-deploy')
  assert.deepEqual(result.installed, { path: '/codex/skills/petpack-azure-deploy' })
  assert.equal(installs[0].from, 'Rex')
  assert.ok(brain.me.skills.some(s => s.name === 'azure-deploy'))

  // A tier-2 answer carries its note inline: installed at once, no fetch.
  const fetches = net.sent.filter(m => m.t === 'fetch').length
  const second = brain.call('petpack_ask', { question: 'anything on pane alignment?', to: 'Bea' })
  await flush()
  const ask2 = net.last('ask')
  brain.handle({ t: 'answer', from: 'bea', qid: ask2.qid, ok: true, text: 'Use tray Align.', share: { kind: 'technique', title: 'pane alignment', body: 'Tray Align moves 8 DIP.' },
    pkg: { kind: 'technique', ref: null, title: 'pane alignment', text: '# pane alignment\n\nTray Align moves 8 DIP.\n' } })
  const r2 = await second
  assert.equal(r2.installed.path, '/codex/skills/petpack-pane alignment')
  assert.equal(installs[1].input.kind, 'technique')
  assert.match(installs[1].input.text, /Tray Align/)
  assert.equal(net.sent.filter(m => m.t === 'fetch').length, fetches)
})

test('an errand crosses every intermediate chunk and fast-forwards through unseated ones', async () => {
  const { brain } = makeBrain()
  welcome(brain) // seats: me 0, Bea 1, Rex 3; chunk 2 is a gap nobody shows
  assert.equal(brain._.speedAt(0), WALK_SPEED)
  assert.equal(brain._.speedAt(2 * CHUNK_W), WALK_SPEED * FAST_FORWARD)
  const visited = []
  const timeIn = new Map()
  brain.call('petpack_get', { id: 'rex/skill:azure-deploy' }) // never answered: the walk goes on regardless
  await run(brain, 12, 0.05, () => {
    const c = chunkOf(brain.me.x)
    if (visited.at(-1) !== c) visited.push(c)
    if (brain.me.speed > 0.5) timeIn.set(c, (timeIn.get(c) || 0) + 0.05)
  })
  assert.deepEqual(visited.slice(0, 4), [0, 1, 2, 3], `visited ${visited}`)
  assert.ok(Math.abs(brain.me.x - REX.x) < 1.6, `arrived beside Rex (x=${brain.me.x})`)
  // A full seated chunk takes 14/4 = 3.5 s; the unseated gap chunk 14/16 = 0.875 s.
  assert.ok(Math.abs(timeIn.get(1) - 3.5) < 0.3, `seated chunk 1 took ${timeIn.get(1)}`)
  assert.ok(Math.abs(timeIn.get(2) - 0.875) < 0.2, `gap chunk 2 took ${timeIn.get(2)}`)
})

test('waiting sends the pet home, and its state says so', async () => {
  const { brain, net } = makeBrain()
  welcome(brain)
  brain.call('petpack_get', { id: 'rex/skill:azure-deploy' })
  await run(brain, 5)
  assert.ok(chunkOf(brain.me.x) >= 1, 'the pet is out on its errand')
  brain.setStatus('waiting')
  await run(brain, 8)
  assert.equal(chunkOf(brain.me.x), 0, `home again (x=${brain.me.x})`)
  assert.notEqual(brain.me.mode, 'errand')
  assert.equal(net.last('state').status, 'waiting')
  assert.equal(net.last('state').anim, 'waiting')
})

test('tool handlers work against a fake relay and clock', async () => {
  const installs = []
  const bridge = {
    installItem: async (pkg, from) => { installs.push({ pkg, from }); return { installed: true, path: `/codex/skills/petpack-${from.toLowerCase()}-${pkg.name}` } },
    answerAsk: () => new Promise(() => {}), // a slow exec: the live session answers first
    readItem: async ref => ({ ok: true, sha: 's1', text: `content of ${ref}` }),
  }
  const { brain, net } = makeBrain({ bridge })
  welcome(brain)

  const status = await brain.call('petpack_status')
  assert.equal(status.room, 'net-test')
  assert.deepEqual(status.peers.map(p => [p.name, p.where]).sort(), [['Bea', 'right'], ['Rex', 'far']])
  assert.equal(status.peers.find(p => p.name === 'Rex').counts.skill, 1)

  const hits = await brain.call('petpack_search', { query: 'azure deploy' })
  assert.equal(hits[0].id, 'rex/skill:azure-deploy')
  assert.equal(hits[0].owner, 'Rex')
  assert.equal(hits[0].online, true)
  assert.deepEqual(await brain.call('petpack_search', { query: 'pdf', kind: 'memory' }), [])

  const getting = brain.call('petpack_get', { id: 'rex/skill:azure-deploy' })
  await flush()
  const fetch = net.last('fetch')
  assert.deepEqual([fetch.owner, fetch.ref, fetch.as], ['rex', 'skill:azure-deploy', 'pkg'])
  const skillMd = Buffer.from('---\nname: azure-deploy\ndescription: ship\n---\n# azure').toString('base64')
  brain.handle({ t: 'fetched', fid: fetch.fid, ok: true, sha: 's', pkg: { id: 'azure-deploy', name: 'azure-deploy', description: 'ship', files: [{ path: 'SKILL.md', b64: skillMd }] } })
  const got = await getting
  assert.equal(got.installed, true)
  assert.match(got.text, /name: azure-deploy/)
  assert.equal(installs[0].from, 'Rex')
  assert.ok(brain.me.skills.some(s => s.name === 'azure-deploy'), 'the adopted skill is now ours')

  // The relay serves the owner's fetches.
  brain.handle({ t: 'fetch', from: 'bea', fid: 'f9', ref: 'memory:x', as: 'text' })
  await flush(); await flush()
  assert.deepEqual([net.last('fetched').fid, net.last('fetched').to, net.last('fetched').text], ['f9', 'bea', 'content of memory:x'])

  // A question from a peer lands in the inbox; the live session's answer wins.
  brain.handle({ t: 'ask', from: 'bea', qid: 'q1', question: 'how do I align the panes?', kind: 'technique' })
  await flush()
  assert.deepEqual(await brain.call('petpack_inbox'), [{ id: 'q1', from: 'Bea', question: 'how do I align the panes?' }])
  assert.deepEqual(await brain.call('petpack_answer', { id: 'q1', text: 'Tray Align, 8 DIP per click.' }), { ok: true })
  assert.deepEqual([net.last('answer').qid, net.last('answer').to, net.last('answer').text], ['q1', 'bea', 'Tray Align, 8 DIP per click.'])
  assert.equal((await brain.call('petpack_answer', { id: 'q1', text: 'again' })).ok, false, 'first answer wins')
  assert.deepEqual(await brain.call('petpack_inbox'), [])

  // A memory installs as a note.
  const installing = brain.call('petpack_install', { id: 'rex/memory:click-through' })
  await flush()
  const noteFetch = net.last('fetch')
  assert.deepEqual([noteFetch.ref, noteFetch.as], ['memory:click-through', 'text'])
  brain.handle({ t: 'fetched', fid: noteFetch.fid, ok: true, sha: 's', text: 'setIgnoreMouseEvents(true, {forward:true})' })
  const install = await installing
  assert.equal(install.installed, true)
  assert.equal(installs.at(-1).pkg.text, 'setIgnoreMouseEvents(true, {forward:true})')
  // The ask times out on the fake clock instead of hanging the tool call.
  const asking = brain.call('petpack_ask', { question: 'anyone know pdf tables?' })
  await run(brain, 46, 0.25)
  const timedOut = await asking
  assert.equal(timedOut.answered_by, null)
})

test('bots answer tier 1 only, never through answerAsk (exec)', async () => {
  let execs = 0
  const { brain } = makeBrain({ bridge: { answerAsk: async () => { execs++; return { ok: true, text: 'exec' } } }, demo: true })
  brain.addBots()
  brain.netStatus('solo')
  const asking = brain.call('petpack_ask', { question: 'how do I extract tables from a PDF?', kind: 'skill' })
  let result = null
  asking.then(r => { result = r })
  await run(brain, 30, 0.1, () => {})
  assert.ok(result, 'the bot answered within the walk')
  assert.equal(result.answered_by, 'Fern')
  assert.match(result.answer, /^pdf-tables: /)
  assert.equal(result.dot.kind, 'skill')
  assert.equal(execs, 0)
  const answer = tier1Answer('how do we ship this to Azure?', 'skill', [item('skill:azure-deploy', 'azure-deploy', 'zip deploy')])
  assert.equal(answer.tier, 1)
  assert.equal(tier1Answer('what is love', null, [item('skill:azure-deploy', 'azure-deploy', 'zip deploy')]), null)
})

test('demo bot gifts animate and say "learned", but never write into the Codex home', async () => {
  const installs = []
  const bridge = { installItem: async (...a) => { installs.push(a); return { installed: true } }, installSkill: async (...a) => { installs.push(a); return { installed: true } } }
  const says = []
  const brain = createBrain({ bridge, net: fakeNet(), view: { say: (id, text) => says.push([id, text]) },
    me: { id: 'me', name: 'Pip', skills: [], catalog: [] }, config: { demo: true, seat: 0, noVisits: true }, random: seeded(3) })
  brain.addBots()
  brain.netStatus('solo')
  await run(brain, 40, 0.1)
  assert.ok(brain.me.skills.length >= 1, 'a bot gift arrived')
  assert.ok(says.some(([id, text]) => id === 'me' && /^learned /.test(text)))
  assert.equal(installs.length, 0)
  const got = await brain.call('petpack_get', { id: `${[...brain._.agents.keys()].find(k => k.endsWith('bot-fern'))}/skill:pdf-tables` })
  assert.equal(got.installed, false)
  assert.equal(installs.length, 0)
})

test('joy: status moments, hats and blooms, handshake on link, conga when the whole room is done', async () => {
  const seen = []
  const view = new Proxy({}, { get: (_, name) => (...args) => seen.push([name, ...args]) })
  const net = fakeNet()
  const brain = createBrain({ bridge: {}, net, view, me: { id: 'me', name: 'Pip', skills: [], catalog: [] },
    config: { seat: 0, noVisits: true }, random: seeded(5) })
  welcome(brain, [{ ...REX, seat: 1 }])
  brain.handle({ t: 'seat', seats: { me: 0, rex: 1 }, links: [['me', 'rex']], why: 'dock' })
  assert.deepEqual(seen.find(e => e[0] === 'handshake')?.[1], { seat: 0, side: 'right' })

  brain.setStatus('working'); brain.setStatus('failed'); brain.setStatus('done'); brain.setStatus('waiting'); brain.setStatus('idle')
  const names = seen.map(e => e[0])
  assert.deepEqual(seen.filter(e => e[0] === 'weather').map(e => e[2]), ['rain', 'rainbow'])
  assert.deepEqual(seen.filter(e => e[0] === 'knock').map(e => e[2]), [true, false])
  assert.ok(names.includes('weather') && net.sent.some(m => m.t === 'fx' && m.kind === 'weather'), 'shared with the room')
  brain.setStatus('working'); brain.setStatus('done')
  assert.ok(seen.some(e => e[0] === 'celebrate' && e[1] === 'me'))

  for (let i = 0; i < 3; i++) brain.handle({ t: 'fx', from: 'rex', kind: 'learned', src: 'rex', text: `learned x${i}`, bloom: { kind: 'skill', seed: `me/skill:x${i}` } })
  assert.deepEqual(seen.filter(e => e[0] === 'hat').map(e => e.slice(1)), [['rex', 1], ['rex', 2]])
  assert.equal(seen.filter(e => e[0] === 'bloom').length, 3)
  assert.equal(seen.find(e => e[0] === 'bloom')[1].color, REX.color)

  // Rex finishes too: the lowest seat (us) starts the conga for the room.
  brain.handle({ t: 'fx', from: 'rex', kind: 'pose', ts: Date.now(), x: 15, z: 1.5, status: 'done', m: 0 })
  brain.tick(0.1)
  const conga = net.sent.find(m => m.t === 'fx' && m.kind === 'conga')
  assert.ok(conga, 'conga broadcast')
  assert.deepEqual(conga.ids.sort(), ['me', 'rex'])
  assert.ok(seen.some(e => e[0] === 'conga'))
})

test('no relay and no demo: a quiet solo pane, no bots, and tools say the team is offline', async () => {
  let execs = 0
  const { brain, net } = makeBrain({ bridge: { answerAsk: async () => { execs++; return { ok: true, text: 'x' } } } })
  brain.netStatus('solo')
  await run(brain, 20, 0.25)
  assert.deepEqual(brain.pets().map(p => p.id), ['me'], 'only our own pet')
  const status = await brain.call('petpack_status')
  assert.equal(status.offline, true)
  assert.deepEqual(status.peers, [])
  const search = await brain.call('petpack_search', { query: 'pdf tables' })
  assert.deepEqual([search.offline, search.results], [true, []])
  const ask = await brain.call('petpack_ask', { question: 'how do I extract tables from a PDF?' })
  assert.equal(ask.answered_by, null)
  assert.match(ask.answer, /offline/)
  assert.equal((await brain.call('petpack_get', { id: 'rex/skill:azure-deploy' })).offline, true)
  assert.equal(execs, 0)
  assert.equal(net.sent.length, 0)
  // Once a relay answers, the team is back.
  welcome(brain)
  assert.equal((await brain.call('petpack_search', { query: 'azure deploy' }))[0].owner, 'Rex')
})

test('events for the window collapse: visitors entering/leaving our chunk, involvement', async () => {
  const { brain } = makeBrain()
  const seen = []
  for (const name of ['visitor-enter', 'visitor-leave', 'involved']) brain.on(name, e => seen.push([name, e]))
  welcome(brain, [{ ...REX, seat: 1, x: 14 }])
  brain.tick(0.1)
  assert.equal(seen.length, 0, 'Rex is on his own screen')
  brain.handle({ t: 'fx', from: 'rex', kind: 'pose', ts: Date.now(), x: 5, z: 1.5, m: 1 })
  brain.tick(0.1)
  assert.deepEqual(seen.at(-1), ['visitor-enter', { id: 'rex', name: 'Rex', bot: false }])
  brain.handle({ t: 'fx', from: 'rex', kind: 'pose', ts: Date.now() + 1, x: 12, z: 1.5, m: 1 })
  brain.tick(0.1)
  assert.equal(seen.at(-1)[0], 'visitor-leave')
  brain.handle({ t: 'fx', from: 'rex', kind: 'gift', src: 'rex', dst: 'me', dot: 'skill' })
  assert.deepEqual(seen.at(-1), ['involved', { kind: 'gift', with: 'rex' }])
})

test('quiet status polls stay still; demo bots wear real pets; a new pet of ours goes into hello', async () => {
  const { brain, net } = makeBrain({ demo: true })
  welcome(brain)
  const sent = net.sent.length
  const quiet = await brain.call('petpack_status', { quiet: true })
  assert.equal(quiet.room, 'net-test')
  assert.equal(net.sent.length, sent, 'no state, no wave')
  brain.addBots()
  brain.dressBots([{ displayName: 'Dewey', spriteUrl: 'data:image/webp;base64,AA', atlas: { cols: 8, rows: 11 } }, { displayName: 'Fireball', spriteUrl: 'data:image/png;base64,AA' }])
  const bots = brain.pets().filter(p => p.id.includes('~bot-'))
  assert.deepEqual(bots.slice(0, 2).map(p => [p.displayName, p.spriteUrl.split(';')[0], p.atlas?.rows ?? null]), [['Dewey', 'data:image/webp', 11], ['Fireball', 'data:image/png', null]])
  assert.equal(bots[2].spriteUrl, null, 'no third outfit: a built-in pixel pet')
  brain.setMe({ name: 'Rocky', spriteUrl: 'data:image/webp;base64,BB', atlas: null, sprite: { sha: 'abc', b64: 'BB' } })
  assert.equal(brain.hello().name, 'Rocky')
  assert.deepEqual(brain.hello().sprite, { sha: 'abc', b64: 'BB' })
  assert.equal(brain.pets().find(p => p.isMe).spriteUrl, 'data:image/webp;base64,BB')
})

test('recall: free pets walk home; busy pets say who they are helping and come home after', async () => {
  const { brain } = makeBrain()
  welcome(brain)
  brain.call('petpack_get', { id: 'rex/skill:azure-deploy' })
  await run(brain, 3)
  const busy = await brain.call('petpack_recall')
  assert.deepEqual(busy, { busy: true, message: 'busy helping Rex, back soon' })
  await run(brain, 30, 0.25)
  assert.equal(chunkOf(brain.me.x), 0, 'home once the errand gave up')
  // A free pet out on a visit comes straight back.
  brain._.startJob(brain.me, 'visit', job => brain._.walkTo(brain.me, { x: 30, z: 1.5 }, job))
  await run(brain, 3)
  assert.ok(chunkOf(brain.me.x) >= 1)
  assert.equal((await brain.call('petpack_recall')).busy, false)
  await run(brain, 10, 0.25)
  assert.equal(chunkOf(brain.me.x), 0)
})

test('do not disturb: asks get "heads-down", peers see the sign, no visits or gifts', async () => {
  const { brain, net } = makeBrain()
  welcome(brain)
  const seen = []
  brain.on('dnd', on => seen.push(on))
  brain.setDnd(true)
  assert.deepEqual(seen, [true])
  assert.equal(net.last('fx')?.dnd ?? net.sent.filter(m => m.kind === 'pose').at(-1).dnd, 1)
  brain.handle({ t: 'ask', from: 'bea', qid: 'q9', question: 'help?', kind: null })
  await flush()
  assert.deepEqual([net.last('answer').ok, net.last('answer').reason, net.last('answer').text], [false, 'dnd', 'Pip is heads-down right now'])
  assert.equal((await brain.call('petpack_status', { quiet: true })).me.dnd, true)
  brain.handle({ t: 'fx', from: 'rex', kind: 'pose', ts: Date.now(), x: 42, z: 1.5, m: 0, dnd: 1 })
  assert.equal(brain.pets().find(p => p.id === 'rex').dnd, true)
})

test('share permission: ask shows a request and waits; declines say "not right now"; never declines at once', async () => {
  const bridge = { readItem: async ref => ({ ok: true, sha: 's', text: `content of ${ref}` }) }
  const { brain, net } = makeBrain({ bridge })
  welcome(brain)
  const requests = []
  brain.on('permission', r => requests.push(r))
  brain.setSharing({ mode: 'ask' })
  brain.handle({ t: 'fetch', from: 'bea', fid: 'f1', ref: 'skill:azure-deploy', as: 'text' })
  await flush()
  assert.equal(requests.length, 1)
  assert.match(requests[0].text, /^Bea wants your azure deploy skill$/)
  assert.ok(net.sent.some(m => m.kind === 'knock' && m.on === true), 'our pet knocks')
  brain.decide(requests[0].id, false)
  await flush(); await flush()
  assert.deepEqual([net.last('fetched').ok, net.last('fetched').text], [false, 'Pip said not right now'])
  brain.handle({ t: 'fetch', from: 'bea', fid: 'f2', ref: 'skill:azure-deploy', as: 'text' })
  await flush()
  brain.decide(brain.permissions[0].id, true)
  await flush(); await flush(); await flush()
  assert.deepEqual([net.last('fetched').fid, net.last('fetched').ok, net.last('fetched').text], ['f2', true, 'content of skill:azure-deploy'])
  brain.handle({ t: 'fetch', from: 'bea', fid: 'f3', ref: 'skill:x', as: 'text' })
  await flush()
  await run(brain, 32, 0.25)
  assert.deepEqual([net.last('fetched').fid, net.last('fetched').ok], ['f3', false], 'timed out as declined')
  brain.setSharing({ mode: 'never' })
  brain.handle({ t: 'ask', from: 'bea', qid: 'q1', question: 'anything?' })
  await flush(); await flush()
  assert.deepEqual([net.last('answer').ok, net.last('answer').reason], [false, 'declined'])
  brain.setSharing({ mode: 'never', items: { 'skill:open': true } })
  brain.handle({ t: 'fetch', from: 'bea', fid: 'f4', ref: 'skill:open', as: 'text' })
  await flush(); await flush(); await flush()
  assert.equal(net.last('fetched').ok, true, 'a per-item toggle beats the mode')
})

test('find errands: returns an id at once, visits the best owners, adopts skills, reports via errand(id)', async () => {
  const installs = []
  const bridge = { installItem: async input => { installs.push(input); return { installed: true, path: `/skills/petpack-${input.name || input.title}` } } }
  const { brain, net } = makeBrain({ bridge })
  welcome(brain)
  const events = []
  brain.on('errand', e => events.push(e.status))
  const started = await brain.call('petpack_find', { question: 'how do we deploy to Azure?', kind: 'skill' })
  assert.equal(started.status, 'running')
  // Answer every fetch the errand sends, as the relay would.
  for (let i = 0; i < 200 && brain.errand(started.id).status === 'running'; i++) {
    brain.tick(0.1)
    await flush()
    const fetch = net.sent.find(m => m.t === 'fetch' && !m.answered)
    if (fetch) {
      fetch.answered = true
      brain.handle({ t: 'fetched', fid: fetch.fid, ok: true, sha: 's', pkg: { kind: 'skill', id: 'azure-deploy', name: 'azure-deploy', description: 'ship', files: [{ path: 'SKILL.md', b64: Buffer.from('# azure').toString('base64') }] } })
    }
  }
  const done = await brain.call('petpack_errand', { id: started.id })
  assert.equal(done.status, 'done')
  assert.equal(done.findings[0].owner, 'Rex')
  assert.deepEqual(done.installed, ['/skills/petpack-azure-deploy'])
  assert.match(done.message, /Rex's azure-deploy/)
  assert.ok(events.includes('done'))
})

test('a stuck Codex session: the pet fetches the strongest team match on its own', async () => {
  const bridge = { currentNeed: async () => ({ question: 'how do I deploy this to Azure App Service?', short: 'deploy to Azure?', kind: 'skill' }) }
  const says = []
  const net = fakeNet()
  const brain = createBrain({ bridge, net, view: { say: (id, text) => says.push(text) }, me: { id: 'me', name: 'Pip', skills: [], catalog: [] },
    config: { seat: 0, noVisits: true }, random: seeded(2) })
  welcome(brain)
  await run(brain, 31, 0.25)
  assert.ok(says.includes('deploy to Azure?'))
  assert.equal(net.last('fetch')?.ref, 'skill:azure-deploy')
})

test('owner-side askFirst and not-shared results; S5 tool shapes (errand_id, codex_link)', async () => {
  const bridge = { readItem: async ref => (ref === 'skill:secret' ? { ok: false, reason: 'not shared' } : { ok: true, sha: 's', text: 'body', askFirst: true }) }
  const { brain, net } = makeBrain({ bridge })
  welcome(brain)
  const asks = []
  brain.on('permission', r => asks.push(r))
  brain.handle({ t: 'fetch', from: 'bea', fid: 'f1', ref: 'skill:azure-deploy', as: 'text' })
  for (let i = 0; i < 4; i++) await flush()
  assert.equal(asks.length, 1, 'askFirst prompts even in free mode')
  brain.decide(asks[0].id, false)
  for (let i = 0; i < 3; i++) await flush()
  assert.deepEqual([net.last('fetched').ok, net.last('fetched').text], [false, 'Pip said not right now'])
  brain.handle({ t: 'fetch', from: 'bea', fid: 'f2', ref: 'skill:secret', as: 'text' })
  for (let i = 0; i < 3; i++) await flush()
  assert.deepEqual([net.last('fetched').fid, net.last('fetched').text], ['f2', 'Pip is not sharing that right now'])
  const started = await brain.call('petpack_find', { question: 'azure deploy' })
  assert.ok(started.errand_id && /petpack_errand/.test(started.message))
  assert.equal((await brain.call('petpack_errand', { errand_id: started.errand_id })).errand_id, started.errand_id)
  assert.deepEqual(await brain.call('codex_link', { type: 'connected', text: 'Codex is linked' }), { ok: true })
})

test('registry: resume our place, away agents nap in place, leave without away removes, across seating flips', async () => {
  const { brain, net } = makeBrain()
  const seen = []
  for (const name of ['sleep', 'flip', 'replaced']) brain.on(name, (...a) => seen.push([name, ...a]))
  brain.handle({ t: 'welcome', room: 'dde-ldn', you: { id: 'me', seat: 0, x: 3.25, z: 2.1, facing: -1, resumed: true, flipped: false, sit: 'side' },
    peers: [{ ...REX }], away: [],
    agents: [{ ...REX, online: true, away: false }, { id: 'old', name: 'Old', color: '#888888', sprite: null, seat: null, x: 30, z: 1.5, facing: 1, status: 'idle', lastSeen: 1, online: false, away: true }],
    seats: { me: 0, rex: 3 }, links: [] })
  assert.deepEqual([brain.me.x, brain.me.z, brain.me.facing], [3.25, 2.1, -1], 'resumed where it was')
  const old = brain.pets().find(p => p.id === 'old')
  assert.deepEqual([old.x, old.away], [30, true])
  assert.deepEqual(seen.find(e => e[0] === 'sleep'), ['sleep', 'old', true])
  assert.equal(brain._.member('old').online, false, 'nappers are never routed asks')
  // Rex leaves for a while: napping at its last place; a probe that leaves without away is gone.
  brain.handle({ t: 'leave', id: 'rex', away: true, x: 43, z: 1.5, facing: 1, lastSeen: 5 })
  assert.deepEqual([brain.pets().find(p => p.id === 'rex')?.x, brain.pets().find(p => p.id === 'rex')?.away], [43, true])
  brain.handle({ t: 'join', peer: { ...REX, x: 43 } })
  assert.equal(brain.pets().find(p => p.id === 'rex').away, false)
  assert.ok(seen.some(e => e[0] === 'sleep' && e[1] === 'rex' && e[2] === false), 'woken on return')
  brain.handle({ t: 'leave', id: 'rex' })
  assert.equal(brain.pets().find(p => p.id === 'rex'), undefined)
  // Battleships: we sit across and are the flipped pane.
  assert.equal(brain.hello().sit, 'side')
  brain.setSit('across')
  assert.deepEqual(net.last('sit'), { v: 2, t: 'sit', sit: 'across' })
  brain.handle({ t: 'seat', seats: { me: 0, bea: 0 }, flipped: { me: true }, across: [['bea', 'me']], links: [], why: 'move' })
  assert.deepEqual([brain.flipped, brain.acrossWith], [true, 'bea'])
  assert.ok(seen.some(e => e[0] === 'flip' && e[1] === true))
  brain.netStatus('replaced')
  assert.deepEqual([brain.online, brain.replaced], [false, true])
  assert.ok(seen.some(e => e[0] === 'replaced'))
})

test('co-work: nextTo (pending until online), neighbours, one handshake, and visits across the seam and back', async () => {
  const net = fakeNet()
  const seen = []
  const view = new Proxy({}, { get: (_, name) => (...args) => seen.push([name, ...args]) })
  const brain = createBrain({ bridge: {}, net, view, me: { id: 'me', name: 'Pip', skills: [], catalog: [] },
    config: { seat: 0, nextTo: 'Bea' }, random: seeded(4) })
  welcome(brain, [REX]) // Bea isn't here yet
  assert.equal(net.sent.filter(m => m.t === 'seat').length, 0)
  assert.equal(brain.coworkWith('Bea').pending, true)
  brain.handle({ t: 'join', peer: { ...BEA, seat: 2, x: 28 } })
  assert.deepEqual(net.last('seat'), { v: 2, t: 'seat', op: 'nextTo', target: 'bea' }, 'retried once Bea is online')
  brain.handle({ t: 'seat', seats: { me: 0, bea: 1, rex: 3 }, links: [['me', 'bea']], why: 'cowork', cowork: ['me', 'bea'],
    neighbours: { me: { left: null, right: 'bea', across: null } } })
  assert.deepEqual(seen.filter(e => e[0] === 'neighbours').at(-1)[1], { left: null, right: { id: 'bea', name: 'Bea' }, across: null })
  assert.equal(seen.filter(e => e[0] === 'handshake').length, 1, 'cowork + link = one handshake')
  assert.deepEqual(seen.find(e => e[0] === 'handshake')[1], { seat: 0, side: 'right' })
  // Bea now sits at seat 1: within ~90 s our free pet walks onto her screen and comes home again.
  brain.handle({ t: 'fx', from: 'bea', kind: 'pose', ts: Date.now(), x: 13, z: 1.5, m: 0 })
  const chunks = []
  await run(brain, 60, 0.25, () => { const c = chunkOf(brain.me.x); if (chunks.at(-1) !== c) chunks.push(c) })
  assert.deepEqual(chunks.slice(0, 3), [0, 1, 0], `visited Bea and came home (${chunks})`)
  assert.ok(net.sent.some(m => m.t === 'fx' && m.kind === 'collab' && m.dst === 'bea'))
})

test('layout: newer versions apply wholesale, heartbeats resync, stale seat messages are ignored', async () => {
  const { brain, net } = makeBrain()
  const seen = []
  for (const name of ['flip', 'neighbours', 'seat']) brain.on(name, (...a) => seen.push([name, ...a]))
  brain.handle({ t: 'welcome', room: 'r', you: { id: 'me', seat: 0 }, peers: [REX, BEA], away: [], links: [],
    layout: { v: 100, layoutVersion: 100, seats: { me: 0, rex: 3, bea: 1 }, flipped: {}, across: [], links: [['me', 'bea']],
      neighbours: { me: { left: null, right: 'bea', across: null } }, sits: { me: 'side' } } })
  assert.deepEqual(brain.neighbours.right, { id: 'bea', name: 'Bea' })
  // A newer layout moves us and pairs us across with Bea (we are the flipped one).
  brain.handle({ t: 'layout', v: 101, layoutVersion: 101, seats: { me: 1, bea: 1, rex: 3 }, flipped: { me: true }, across: [['bea', 'me']],
    links: [], neighbours: { me: { left: null, right: null, across: 'bea' } }, sits: { me: 'across', bea: 'across' } })
  assert.deepEqual([brain.seat, brain.flipped, brain.sit, brain.acrossWith], [1, true, 'across', 'bea'])
  // An older layout or seat message changes nothing.
  brain.handle({ t: 'layout', v: 99, layoutVersion: 99, seats: { me: 5 }, flipped: {}, across: [], links: [] })
  brain.handle({ t: 'seat', layoutVersion: 98, seats: { me: 7 }, links: [], why: 'move' })
  assert.equal(brain.seat, 1)
  // Heartbeats: same version -> quiet; another version -> ask for the full layout.
  const asks = () => net.sent.filter(m => m.t === 'layout?').length
  brain.handle({ t: 'layout', v: 101, layoutVersion: 101, beat: true })
  assert.equal(asks(), 0)
  brain.handle({ t: 'layout', v: 102, layoutVersion: 102, beat: true })
  assert.equal(asks(), 1)
  brain.handle({ t: 'sit', sit: 'side', corrected: true })
  assert.equal(brain.sit, 'side')
})

test('Codex pet parity: LIFE places our pet, Codex status picks the row', async () => {
  const { brain } = makeBrain()
  const mine = brain._.mine
  const act = anim => { mine.lifeAct = { anim, started: true }; mine.anim = anim; mine.animUntil = brain.time + 10 }
  const row = () => brain.hello().anim
  brain.setStatus('working'); act('wave'); assert.equal(row(), 'working', 'a working pet shows the work pose at any station')
  mine.anim = null; assert.equal(row(), 'working', 'between stations too')
  brain.setStatus('waiting'); act('idle'); assert.equal(row(), 'waiting')
  brain.setStatus('failed'); act('review'); assert.equal(row(), 'failed')
  brain.setStatus('idle'); act('review'); assert.equal(row(), 'idle', 'fishing while idle is not working')
  brain.setStatus('done'); assert.equal(row(), 'jump', 'done hops first')
  act('jump'); assert.equal(row(), 'jump', "LIFE's celebration hop passes")
  await brain.call('codex_link', { type: 'connected' }); assert.equal(row(), 'wave', 'greets on Codex connect')
})

test('demo polish: step events carry the callId, showMe runs the journey for real, lessons publish a card', async () => {
  const installs = []
  let lessons = 0
  const bridge = {
    installItem: async input => { installs.push(input); return { installed: true, path: `/skills/petpack-${input.name || input.title}` } },
    lessonFromSession: async () => { lessons++; return { item: { ref: 'memory:lesson-pdf', kind: 'memory', title: 'PDF tables lesson', summary: 'pdfplumber keeps merged headers' } } },
  }
  const { brain, net } = makeBrain({ bridge })
  const steps = []
  brain.on('step', s => steps.push(s))
  welcome(brain)
  // petpack_ask with a callId: progress steps for Codex.
  const asking = brain.call('petpack_ask', { question: 'how do we ship to Azure?', to: 'Rex', callId: 'c1' })
  await flush()
  const ask = net.last('ask')
  brain.handle({ t: 'answer', from: 'rex', qid: ask.qid, ok: true, text: 'Use azure-deploy.', share: { kind: 'skill', title: 'azure-deploy', ref: 'skill:azure-deploy' },
    pkg: { kind: 'skill', id: 'azure-deploy', name: 'azure-deploy', description: 'ship', files: [{ path: 'SKILL.md', b64: Buffer.from('# azure').toString('base64') }] } })
  for (let i = 0; i < 6; i++) await flush()
  const texts = steps.filter(s => s.callId === 'c1').map(s => s.text)
  assert.ok(texts.some(t => /^walking to Rex's screen/.test(t)) && texts.includes('Rex answered') && texts.some(t => /^got Rex's azure deploy skill -> \/skills\/petpack-azure-deploy$/.test(t)), texts.join(' | '))
  const answered = await Promise.race([asking, new Promise(r => setTimeout(() => r(null), 5000))])
  assert.equal(answered?.says, 'Rex says: Use azure-deploy.')
  // showMe (a fresh pane): picks a real item of our neighbour, walks over, asks for it, installs it, comes home.
  const show = makeBrain({ bridge })
  welcome(show.brain)
  let shown = null
  show.brain.showMe().then(r => { shown = r })
  for (let i = 0; i < 400 && !shown; i++) {
    show.brain.tick(0.25); await flush()
    const q = show.net.sent.filter(m => m.t === 'ask').at(-1)
    if (q && !q.answered) {
      q.answered = true
      show.brain.handle({ t: 'answer', from: q.to, qid: q.qid, ok: true, text: 'here you go', share: { kind: 'skill', title: 'pdf-tables', ref: 'skill:pdf-tables' },
        pkg: { kind: 'skill', id: 'pdf-tables', name: 'pdf-tables', description: 'pdf', files: [{ path: 'SKILL.md', b64: 'eA==' }] } })
    }
  }
  assert.equal(shown?.ok, true)
  assert.equal(shown.with, 'Bea', 'Bea sits next to us (seat 1)')
  assert.match(shown.message, /^learned pdf-tables from Bea -> /)
  // A finished Codex session leaves a lesson card in our catalog, and the room hears about it.
  brain.setStatus('working'); brain.setStatus('done')
  for (let i = 0; i < 4; i++) await flush()
  assert.equal(lessons, 1)
  await run(brain, 6, 0.25)
  assert.ok(net.sent.some(m => m.t === 'catalog' && m.items.some(i => i.ref === 'memory:lesson-pdf')), 'catalog published')
  assert.ok(net.sent.some(m => m.t === 'fx' && m.kind === 'learned' && m.bloom?.kind === 'memory'), 'a Library flower')
})

test('search and meet helpers', () => {
  const owners = [{ id: 'rex', name: 'Rex', online: false, catalog: REX.catalog }]
  const [hit] = searchCatalogs('windows click through', owners, { now: 0 })
  assert.equal(hit.id, 'rex/memory:click-through')
  assert.equal(hit.online, false)
  assert.equal(meetLandmark('skill', 1).x, 0, 'the Workshop one chunk away')
  assert.equal(meetLandmark('memory', 1).x, CHUNK_W)
  assert.equal(meetLandmark('resource', 1).x, CHUNK_W, 'no Campfire within one chunk: the owner\'s own landmark')
})
