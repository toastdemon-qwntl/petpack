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

test('search and meet helpers', () => {
  const owners = [{ id: 'rex', name: 'Rex', online: false, catalog: REX.catalog }]
  const [hit] = searchCatalogs('windows click through', owners, { now: 0 })
  assert.equal(hit.id, 'rex/memory:click-through')
  assert.equal(hit.online, false)
  assert.equal(meetLandmark('skill', 1).x, 0, 'the Workshop one chunk away')
  assert.equal(meetLandmark('memory', 1).x, CHUNK_W)
  assert.equal(meetLandmark('resource', 1).x, CHUNK_W, 'no Campfire within one chunk: the owner\'s own landmark')
})
