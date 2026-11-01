// T3 commons (lane L3b): node --test app/codex/commons.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildCatalog, getCatalog, readItem, installNote, installItem, findCurrentProject, parseToml } from './catalog.js'
import { answerAsk, createAnswerer, scoreItem, rankItems } from './answer.js'

const W = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

function fixture () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-t3-'))
  const codex = path.join(root, 'codex')
  const home = path.join(root, 'home')
  const repo = path.join(root, 'repo')
  const sub = path.join(repo, 'sub')
  const answers = path.join(root, 'answers')
  // skills
  W(path.join(codex, 'skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: "Frobnicate alpha widgets with the widget toolkit."\n---\n\n# Alpha\n\nRun scripts/run.sh to frobnicate.\n')
  W(path.join(codex, 'skills/alpha/scripts/run.sh'), 'echo frob\n')
  fs.writeFileSync(path.join(codex, 'skills/alpha/logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  W(path.join(codex, 'skills/.system/hidden/SKILL.md'), '---\nname: hidden\ndescription: system skill\n---\n')
  W(path.join(codex, 'skills/petpack-bea-gift/SKILL.md'), '---\nname: petpack-bea-gift\ndescription: adopted\n---\n')
  W(path.join(codex, 'skills/petpack-bea-gift/.petpack.json'), '{"from":"Bea"}\n')
  W(path.join(home, '.agents/skills/beta/SKILL.md'), '---\nname: beta\ndescription: >\n  Beta helps with\n  glass panes on Windows.\n---\nBody\n')
  // memories
  W(path.join(codex, 'memories/MEMORY.md'), [
    '# Task Group: glass pane click-through',
    '', 'scope line', '',
    '## Task 1: make the pane click through', '', '### keywords', '', '- glass', '',
    '## User preferences', '', '- the owner likes tea', '',
    '## Reusable knowledge', '', '- setIgnoreMouseEvents needs {forward:true} on Windows.', '',
    '## Failures and how to do differently', '', '- Do not use backdrop-filter for the desktop blur.', ''
  ].join('\n'))
  W(path.join(codex, 'memories/raw_memories.md'), 'raw private stuff\n')
  // prompts (one binary, skipped)
  W(path.join(codex, 'prompts/deploy.md'), '---\ndescription: Deploy the relay\n---\nZip server/ and run az webapp deploy.\n')
  fs.writeFileSync(path.join(codex, 'prompts/blob.md'), Buffer.from([0x23, 0, 0, 0, 0x41]))
  // config.toml with MCP servers
  W(path.join(codex, 'config.toml'), [
    'model = "gpt-5"', '',
    '[mcp_servers.docs-server]', 'command = "node"', 'args = [', '  "server.js",', '  "--port", "7000"', ']',
    'env = { DOCS_TOKEN = "sekrit", REGION = "us" }', 'startup_timeout_sec = 20', '',
    '[mcp_servers."web-search"]', "url = 'https://search.example/mcp'", 'bearer_token_env_var = "SEARCH_KEY"', '',
    '[mcp_servers.petpack]', 'command = "npx"', 'args = ["petpack", "mcp"]', '',
    '[projects."/tmp/x"]', 'trust_level = "trusted"', ''
  ].join('\n'))
  W(path.join(codex, 'AGENTS.md'), '## Commit style\n\nAlways write small commits with a lane prefix.\n')
  // repo with nested AGENTS.md
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  W(path.join(repo, 'AGENTS.md'), '# Repo\n\nIntro.\n\n## Architecture\n\nThe relay is one App Service.\n\n## Testing\n\nRun node --test before committing.\n')
  W(path.join(sub, 'AGENTS.md'), '## Local notes\n\nThe sub folder holds the pane code.\n')
  // a rollout whose session_meta names the project
  W(path.join(codex, 'sessions/2026/11/01/rollout-2026-11-01T10-00-00-abc.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'abc', cwd: sub, base_instructions: { text: 'x'.repeat(5000) } } }) + '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n')
  const opts = { codexHome: codex, homeDir: home, cwd: sub, answersDir: answers, env: { PATH: process.env.PATH } }
  return { root, codex, home, repo, sub, answers, opts }
}

// A stub `codex` on PATH: logs argv (+ the schema it was given) and answers through -o, or hangs.
function stubCodex (root, mode = 'answer') {
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'stub-log.json')
  W(path.join(bin, 'codex-stub.mjs'), `
import fs from 'node:fs'
const args = process.argv.slice(2)
const log = ${JSON.stringify(log)}
const at = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
let stdin = ''
process.stdin.on('data', d => { stdin += d })
process.stdin.on('end', () => {
  const schemaPath = at('--output-schema')
  const schema = schemaPath ? fs.readFileSync(schemaPath, 'utf8') : null
  fs.writeFileSync(log, JSON.stringify({ args, schema, stdin, pid: process.pid, cwd: process.cwd() }))
  if (${JSON.stringify(mode)} === 'hang') { setTimeout(() => {}, 60000); return }
  if (args[0] === 'mcp') return
  fs.writeFileSync(at('-o'), JSON.stringify({ answer: 'stub answer: use forward:true', share: { kind: 'technique', title: 'Forward mouse events', body: 'Pass {forward:true}.' } }))
})
`)
  W(path.join(bin, 'codex'), `#!/usr/bin/env node\nimport(${JSON.stringify(path.join(bin, 'codex-stub.mjs'))})\n`)
  fs.chmodSync(path.join(bin, 'codex'), 0o755)
  W(path.join(bin, 'codex.cmd'), `@node "%~dp0codex-stub.mjs" %*\r\n`)
  return { log, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }
}

test('catalog: a fixture CODEX_HOME plus repo yields the expected refs', async () => {
  const fx = fixture()
  const { items, projects } = await buildCatalog(fx.opts)
  const refs = items.map(i => i.ref).sort()
  assert.deepEqual(projects, [fx.sub])
  assert.deepEqual(refs, [
    'memory:agents-repo-architecture',
    'memory:agents-repo-rules',
    'memory:agents-repo-sub-local-notes',
    'memory:mem-glass-pane-click-through',
    'resource:docs-server',
    'resource:web-search',
    'skill:alpha',
    'skill:beta',
    'technique:agents-repo-testing',
    'technique:avoid-glass-pane-click-through',
    'technique:prompt-deploy',
    'technique:rules-commit-style'
  ])
  for (const it of items) {
    assert.deepEqual(Object.keys(it).sort(), ['bytes', 'kind', 'mtime', 'ref', 'sha', 'summary', 'title'])
    assert.ok(it.summary.length <= 240)
    assert.ok(it.ref.startsWith(it.kind + ':'))
  }
  const beta = items.find(i => i.ref === 'skill:beta')
  assert.equal(beta.summary, 'Beta helps with glass panes on Windows.')
  const docs = items.find(i => i.ref === 'resource:docs-server')
  assert.match(docs.summary, /node server\.js --port 7000/)
  assert.match(docs.summary, /DOCS_TOKEN/)
  assert.ok(!JSON.stringify(items).includes('owner likes tea'), 'User preferences stay home')
  assert.ok(!JSON.stringify(items).includes('raw private'), 'raw memories stay home')
})

test('catalog: current project comes from the newest rollout session_meta', async () => {
  const fx = fixture()
  assert.equal(await findCurrentProject(fx.codex), fx.sub)
  const { projects } = await buildCatalog({ ...fx.opts, cwd: undefined, includeProcessCwd: false })
  assert.deepEqual(projects, [fx.sub])
})

test('catalog: readItem returns section text, skill text and packages, resource snippets', async () => {
  const fx = fixture()
  const mem = await readItem('memory:mem-glass-pane-click-through', 'text', fx.opts)
  assert.equal(mem.ok, true)
  assert.match(mem.text, /setIgnoreMouseEvents needs \{forward:true\}/)
  assert.doesNotMatch(mem.text, /tea/)
  const sk = await readItem('skill:alpha', 'text', fx.opts)
  assert.match(sk.text, /name: alpha/)
  assert.match(sk.text, /Files in this skill:\n- logo\.bin \(6 bytes\)\n- scripts\/run\.sh/)
  const pkg = (await readItem('skill:alpha', 'pkg', fx.opts)).pkg
  assert.equal(pkg.name, 'alpha')
  assert.deepEqual(pkg.files.map(f => f.path).sort(), ['SKILL.md', 'logo.bin', 'scripts/run.sh'])
  assert.equal(Buffer.from(pkg.files.find(f => f.path === 'scripts/run.sh').b64, 'base64').toString(), 'echo frob\n')
  const res = await readItem('resource:docs-server', 'pkg', fx.opts)
  assert.match(res.text, /\[mcp_servers\.docs-server\]\ncommand = "node"\nargs = \["server\.js", "--port", "7000"\]/)
  assert.deepEqual(res.pkg.env_keys, ['DOCS_TOKEN', 'REGION'])
  assert.equal((await readItem('memory:nope', 'text', fx.opts)).ok, false)
})

test('install: a note installs as petpack-note-*, once, and is not re-published', async () => {
  const fx = fixture()
  const other = fixture()
  const { pkg } = await readItem('technique:avoid-glass-pane-click-through', 'pkg', fx.opts)
  const r = await installItem(pkg, 'Bea', other.opts)
  assert.equal(r.installed, true)
  assert.match(path.basename(r.path), /^petpack-note-[a-z0-9-]+$/)
  assert.ok(r.path.startsWith(path.join(other.codex, 'skills')))
  const md = fs.readFileSync(path.join(r.path, 'SKILL.md'), 'utf8')
  assert.match(md, new RegExp(`^---\\nname: ${path.basename(r.path)}\\ndescription: "`))
  assert.match(md, /backdrop-filter/)
  assert.match(md, /From Bea's agent/)
  const again = await installNote(pkg, 'Bea', other.opts)
  assert.equal(again.existed, true)
  assert.equal(again.path, r.path)
  const refs = (await getCatalog(other.opts)).map(i => i.ref)
  assert.ok(!refs.some(ref => ref.includes('petpack-note')), 'adopted notes are not re-published')
})

test('install: a skill package from readItem adopts through installItem, once', async () => {
  const fx = fixture()
  const other = fixture()
  const { pkg } = await readItem('skill:alpha', 'pkg', fx.opts)
  const r = await installItem(pkg, 'Bea', other.opts)
  assert.equal(r.installed, true, r.reason)
  assert.equal(fs.readFileSync(path.join(r.path, 'scripts', 'run.sh'), 'utf8'), 'echo frob\n')
  assert.match(fs.readFileSync(path.join(r.path, 'SKILL.md'), 'utf8'), /name: alpha/)
  const again = await installItem(pkg, 'Bea', other.opts)
  assert.equal(again.installed, true)
  assert.equal(again.existed, true)
})

test('install: a resource installs through codex mcp add', async () => {
  const fx = fixture()
  const other = fixture()
  fs.writeFileSync(path.join(other.codex, 'config.toml'), '')
  const stub = stubCodex(other.root)
  const { pkg } = await readItem('resource:docs-server', 'pkg', fx.opts)
  const r = await installItem(pkg, 'Bea', { ...other.opts, env: stub.env })
  assert.equal(r.installed, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(stub.log, 'utf8')).args, ['mcp', 'add', 'docs-server', '--', 'node', 'server.js', '--port', '7000'])
})

test('answer: tier 1 answers from a matching item and skips exec', async () => {
  const fx = fixture()
  const stub = stubCodex(fx.root)
  const r = await answerAsk({ question: 'how do I frobnicate alpha widgets?', fromName: 'Al' }, { ...fx.opts, env: stub.env })
  assert.equal(r.ok, true)
  assert.equal(r.tier, 1)
  assert.equal(r.item.ref, 'skill:alpha')
  assert.match(r.text, /Frobnicate alpha widgets/)
  assert.equal(r.pkg.name, 'alpha')
  assert.equal(fs.existsSync(stub.log), false, 'no codex exec for tier 1')
})

test('answer: tier 2 runs a read-only ephemeral codex exec with the schema, and saves a card', async () => {
  const fx = fixture()
  const stub = stubCodex(fx.root)
  const r = await answerAsk({ question: 'why does the overlay ignore clicks on Linux?', fromName: 'Al' }, { ...fx.opts, env: stub.env })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.tier, 2)
  assert.equal(r.text, 'stub answer: use forward:true')
  assert.deepEqual(r.share, { kind: 'technique', title: 'Forward mouse events', body: 'Pass {forward:true}.' })
  assert.equal(r.pkg.kind, 'technique')
  const log = JSON.parse(fs.readFileSync(stub.log, 'utf8'))
  const a = log.args
  assert.equal(a[0], 'exec')
  assert.equal(a[a.indexOf('-s') + 1], 'read-only')
  assert.ok(a.includes('--ephemeral'))
  assert.ok(a.includes('--skip-git-repo-check'))
  assert.equal(a[a.indexOf('-C') + 1], fx.sub)
  assert.ok(a.includes('mcp_servers={}'))
  assert.ok(a.includes('-o'))
  assert.equal(a[a.length - 1], '-')
  const schema = JSON.parse(log.schema)
  assert.deepEqual(schema.required, ['answer', 'share'])
  assert.match(log.stdin, /Question: why does the overlay ignore clicks on Linux\?/)
  assert.match(log.stdin, /Al's agent/)
  assert.ok(fs.existsSync(r.card))
  const refs = (await getCatalog(fx.opts)).map(i => i.ref)
  assert.ok(refs.some(ref => ref.startsWith('memory:answer-')), 'the answer becomes a Library card')
})

test('answer: tier 2 is killed at its timeout', async () => {
  const fx = fixture()
  const stub = stubCodex(fx.root, 'hang')
  const t0 = Date.now()
  const r = await answerAsk('why does the overlay ignore clicks on Linux?', { ...fx.opts, env: stub.env, timeoutMs: 1000 })
  const ms = Date.now() - t0
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'timeout')
  assert.equal(r.text, "couldn't finish")
  assert.ok(ms < 4000, `took ${ms} ms`)
  const { pid } = JSON.parse(fs.readFileSync(stub.log, 'utf8'))
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.throws(() => process.kill(pid, 0), 'the stub process is gone')
})

test('answer: one exec at a time, a queue of 1, then busy at once', async () => {
  const fx = fixture()
  const stub = stubCodex(fx.root, 'hang')
  const a = createAnswerer()
  const ctx = { ...fx.opts, env: stub.env, timeoutMs: 1000 }
  const first = a.answerAsk('why does the overlay ignore clicks on Linux?', ctx)
  const second = a.answerAsk('why does the overlay ignore clicks on macOS?', ctx)
  await new Promise(resolve => setTimeout(resolve, 100))
  const t0 = Date.now()
  const third = await a.answerAsk('why does the overlay ignore clicks on BSD?', ctx)
  assert.equal(third.busy, true)
  assert.ok(Date.now() - t0 < 500)
  assert.equal((await first).reason, 'timeout')
  assert.equal((await second).reason, 'timeout')
})

test('answer: noExec (bots, --no-answer) never spawns codex', async () => {
  const fx = fixture()
  const stub = stubCodex(fx.root)
  const r = await answerAsk('something nobody knows about quasars', { ...fx.opts, env: stub.env, noExec: true })
  assert.equal(r.ok, false)
  assert.equal(fs.existsSync(stub.log), false)
})

test('scoring: title hits beat summary hits, kind adds a bonus', () => {
  const items = [
    { ref: 'skill:win-glass-pane', kind: 'skill', title: 'win-glass-pane', summary: 'Click-through glass pane on Windows' },
    { ref: 'memory:other', kind: 'memory', title: 'Relay deploy', summary: 'zip deploy of the relay' }
  ]
  const q = 'make the pane click-through on Windows too'
  assert.ok(scoreItem(q, items[0]) >= 0.5)
  assert.equal(scoreItem(q, items[1]), 0)
  assert.equal(rankItems(q, items)[0].item.ref, 'skill:win-glass-pane')
  assert.ok(scoreItem('relay deploy', items[1], 'memory') > scoreItem('relay deploy', items[1]))
})

test('toml: tables, quoted keys, multi-line arrays and inline tables', () => {
  const t = parseToml('a = 1\n[x."y.z"]\nk = [\n "a", # c\n "b"\n]\nm = { P = "q", R = \'s\' }\n[[arr]]\nn = true\n')
  assert.equal(t.a, 1)
  assert.deepEqual(t.x['y.z'].k, ['a', 'b'])
  assert.deepEqual(t.x['y.z'].m, { P: 'q', R: 's' })
  assert.deepEqual(t.arr, [{ n: true }])
})
