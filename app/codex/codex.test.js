// T2 codex core: `node --test app/codex/codex.test.js`. Synthetic fixtures in temp dirs; no network, no real ~/.codex.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { codexHomes, codexHome } from './home.js'
import { getPet, imageInfo, atlasOf, tuiPetFromToml, appPetFromToml, loadBuiltin } from './pets.js'
import { listSkills, packSkill, parseFrontmatter } from './skills.js'
import { installSkill, skillSlug } from './install.js'
import { readStatus, createStatusTracker, watchStatus, currentTask, compressTitle } from './status.js'
import { createCodex, codexEventMessage, releasePet } from './index.js'
import { openCodex, codexThreadUrl } from './open.js'

const made = []
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `petpack-${name}-`)); made.push(d); return d }
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data) }

// ---------- image fixtures ----------

function crc32 (buf) {
  let c = ~0
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
  return (~c) >>> 0
}
function pngChunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
// A real, fully transparent RGBA PNG.
function makePng (w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}
function riff (chunks) {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks])
  const head = Buffer.alloc(8); head.write('RIFF', 0); head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}
function webpChunk (tag, data) {
  const h = Buffer.alloc(8); h.write(tag, 0); h.writeUInt32LE(data.length, 4)
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}
// Header-only WebP (VP8X extended format), enough for the dimension parser.
function makeWebpX (w, h) {
  const d = Buffer.alloc(10); d[0] = 0x10; d.writeUIntLE(w - 1, 4, 3); d.writeUIntLE(h - 1, 7, 3)
  return riff([webpChunk('VP8X', d), webpChunk('ALPH', Buffer.alloc(4))])
}
// Header-only lossless WebP (VP8L).
function makeWebpL (w, h) {
  const d = Buffer.alloc(9); d[0] = 0x2f
  d.writeUInt32LE(((w - 1) | ((h - 1) << 14) | (1 << 28)) >>> 0, 1)
  return riff([webpChunk('VP8L', d)])
}
function makePet (home, folder, manifest, sheetName, sheet) {
  const dir = path.join(home, 'pets', folder)
  if (manifest !== undefined) write(path.join(dir, 'pet.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  if (sheet) write(path.join(dir, sheetName), sheet)
  return dir
}
const touch = (file, msAgo) => { const t = (Date.now() - msAgo) / 1000; fs.utimesSync(file, t, t) }

// A tiny asar archive (Electron's format) with one file under webview/assets/.
function makeAsar (file, name, data) {
  const header = { files: { webview: { files: { assets: { files: { [name]: { size: data.length, offset: '0' } } } } } } }
  const json = Buffer.from(JSON.stringify(header))
  const padded = Math.ceil(json.length / 4) * 4
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0); head.writeUInt32LE(8 + padded, 4); head.writeUInt32LE(4 + padded, 8); head.writeUInt32LE(json.length, 12)
  write(file, Buffer.concat([head, json, Buffer.alloc(padded - json.length), data]))
}

// ---------- home ----------

test('home: CODEX_HOME first, Windows also tries %USERPROFILE%\\.codex', () => {
  const r = (...p) => path.resolve(...p)
  assert.deepEqual(codexHomes({ env: { CODEX_HOME: '/x/codex' }, platform: 'linux', homedir: '/home/u' }), [r('/x/codex'), r('/home/u/.codex')])
  assert.deepEqual(codexHomes({ env: { CODEX_HOME: '~/alt' }, platform: 'linux', homedir: '/home/u' })[0], r('/home/u/alt'))
  assert.deepEqual(codexHomes({ env: {}, platform: 'linux', homedir: '/home/u' }), [r('/home/u/.codex')])
  const win = codexHomes({ env: { CODEX_HOME: '/x/codex', USERPROFILE: '/users/u' }, platform: 'win32', homedir: '/home/u' })
  assert.deepEqual(win, [r('/x/codex'), r('/users/u/.codex'), r('/home/u/.codex')])
  assert.equal(codexHomes({ env: { USERPROFILE: '/Home/U' }, platform: 'win32', homedir: '/home/u' }).length, 1)
  const h = tmp('home')
  assert.equal(codexHome({ env: { CODEX_HOME: path.join(h, 'missing') }, platform: 'linux', homedir: h }), path.join(h, 'missing'))
  fs.mkdirSync(path.join(h, '.codex'))
  assert.equal(codexHome({ env: { CODEX_HOME: path.join(h, 'missing') }, platform: 'linux', homedir: h }), path.join(h, '.codex'))
})

// ---------- pets ----------

const P = { homes: undefined, fetch: false, appAsars: [] }
const opt = (home, extra = {}) => ({ ...P, homes: [home], cacheDir: path.join(home, '.petcache'), ...extra })

test('pets: header parser reads PNG, VP8X and VP8L sizes', () => {
  assert.deepEqual(imageInfo(makePng(32, 45)), { width: 32, height: 45, mime: 'image/png' })
  assert.deepEqual(imageInfo(makeWebpX(1536, 1872)), { width: 1536, height: 1872, mime: 'image/webp' })
  assert.deepEqual(imageInfo(makeWebpL(768, 936)), { width: 768, height: 936, mime: 'image/webp' })
  assert.equal(imageInfo(Buffer.from('not an image at all, really')), null)
  assert.equal(atlasOf({ width: 1000, height: 1000 }), null)
  assert.equal(atlasOf({ width: 1536, height: 2288 }).rows, 11)
})

test('pets: no pets -> spriteUrl null (Dot)', async () => {
  const home = tmp('nopets')
  const r = await getPet(opt(home))
  assert.equal(r.spriteUrl, null)
  assert.equal(r.source, 'none')
  const r2 = await getPet(opt(path.join(home, 'does-not-exist')))
  assert.equal(r2.spriteUrl, null)
})

test('pets: two atlas sizes, selection from the app and from the TUI config', async () => {
  const home = tmp('pets2')
  makePet(home, 'big', { id: 'big', displayName: 'Big Boi', spritesheetPath: 'spritesheet.webp' }, 'spritesheet.webp', makeWebpX(1536, 1872))
  makePet(home, 'small', { displayName: 'Small Fry', spritesheetPath: 'spritesheet.webp' }, 'spritesheet.webp', makeWebpL(768, 936))
  // TUI selection picks the small one
  write(path.join(home, 'config.toml'), 'model = "x"\n\n[tui]\npet = "custom:small" # chosen\n')
  let r = await getPet(opt(home))
  assert.equal(r.petName, 'small')
  assert.equal(r.displayName, 'Small Fry')
  assert.equal(r.source, 'selected')
  assert.match(r.spriteUrl, /^data:image\/webp;base64,/)
  assert.deepEqual([r.atlas.cellW, r.atlas.cellH, r.atlas.rows], [96, 104, 9])
  // the desktop app's selection wins over the TUI's
  write(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'selected-avatar-id': 'custom:big', other: 1 }))
  r = await getPet(opt(home))
  assert.equal(r.petName, 'big')
  assert.equal(r.displayName, 'Big Boi')
  assert.deepEqual([r.atlas.width, r.atlas.height, r.atlas.cellW, r.atlas.cellH], [1536, 1872, 192, 208])
  // the app's key in config.toml, even where the app bug appends it inside the last table (openai/codex#32685)
  write(path.join(home, 'config.toml'), '[tui]\npet = "custom:big"\n\n[tui.model_availability_nux]\n"x" = 1\nselected-avatar-id = "custom:small"\n')
  assert.equal((await getPet(opt(home))).petName, 'small')
  assert.equal(appPetFromToml('selected-avatar-id = "codex"\n[tui]\npet = "dewey"\n'), 'codex')
  assert.equal(tuiPetFromToml('[tui]\npet = "dewey"\n'), 'dewey')
  assert.equal(tuiPetFromToml('[other]\npet = "dewey"\n'), null)
})

test('pets: a declared frame grid and a path-valued selection', async () => {
  const home = tmp('petsframe')
  const dir = path.join(tmp('petsframe-elsewhere'), 'odd')
  write(path.join(dir, 'pet.json'), JSON.stringify({ displayName: 'Odd', frame: { width: 64, height: 64, columns: 8, rows: 9 } }))
  write(path.join(dir, 'spritesheet.png'), makePng(512, 576))
  write(path.join(home, 'config.toml'), `[tui]\npet = ${JSON.stringify(dir)}\n`)
  const r = await getPet(opt(home))
  assert.equal(r.displayName, 'Odd')
  assert.deepEqual([r.atlas.cellW, r.atlas.cellH, r.atlas.cols, r.atlas.rows], [64, 64, 8, 9])
  assert.equal((await getPet(opt(home, { pet: 'disabled' }))).displayName, 'Odd')
})

test('pets: PNG pet, v2 (8x11) pet, newest custom pet when nothing is selected', async () => {
  const home = tmp('petspng')
  const png = makePet(home, 'pngpet', { displayName: 'Pinga', spritesheetPath: 'art/sheet.png' }, 'art/sheet.png', makePng(32, 45))
  touch(path.join(png, 'pet.json'), 60_000); touch(path.join(png, 'art/sheet.png'), 60_000)
  const v2 = makePet(home, 'tallpet', { displayName: 'Tall', spriteVersionNumber: 2 }, 'spritesheet.webp', makeWebpX(1536, 2288))
  touch(path.join(v2, 'pet.json'), 600_000); touch(path.join(v2, 'spritesheet.webp'), 600_000)
  let r = await getPet(opt(home))
  assert.equal(r.petName, 'pngpet')
  assert.equal(r.source, 'custom')
  assert.match(r.spriteUrl, /^data:image\/png;base64,/)
  assert.deepEqual(imageInfo(Buffer.from(r.spriteUrl.split(',')[1], 'base64')), { width: 32, height: 45, mime: 'image/png' })
  r = await getPet(opt(home, { pet: 'Tall' }))
  assert.equal(r.petName, 'tallpet')
  assert.equal(r.atlas.rows, 11)
  assert.equal(r.atlas.version, 2)
})

test('pets: malformed pets are skipped, never thrown', async () => {
  const home = tmp('petsbad')
  makePet(home, 'badjson', '{ this is not json', 'nothing.txt', 'x')
  makePet(home, 'baddims', { displayName: 'Square' }, 'spritesheet.webp', makeWebpX(1000, 1000))
  makePet(home, 'missing', { displayName: 'Ghost', spritesheetPath: 'nope.webp' })
  makePet(home, 'garbage', { displayName: 'Garbage' }, 'spritesheet.webp', Buffer.from('RIFF....WEBPjunk'))
  write(path.join(home, 'pets', 'not-a-dir'), 'file')
  write(path.join(home, 'config.toml'), '[tui]\npet = "custom:baddims"\n')
  write(path.join(home, '.codex-global-state.json'), '{ broken')
  let r = await getPet(opt(home))
  assert.equal(r.spriteUrl, null)
  // a good one next to them still loads, and a pet.json that isn't valid JSON still lends its sheet
  makePet(home, 'okay', '[1,2', 'spritesheet.webp', makeWebpX(384, 468))
  r = await getPet(opt(home))
  assert.equal(r.petName, 'okay')
  assert.equal(r.displayName, 'okay')
  assert.ok(r.spriteUrl)
})

test('pets: --pet override by folder path, sheet file and name', async () => {
  const home = tmp('petsov')
  const elsewhere = tmp('petsdrop')
  const drop = makePet(elsewhere, 'drop', { displayName: 'Dropped' }, 'spritesheet.webp', makeWebpX(1536, 1872))
  makePet(home, 'mine', { displayName: 'Mine' }, 'spritesheet.webp', makeWebpX(1536, 1872))
  assert.equal((await getPet(opt(home, { pet: drop }))).displayName, 'Dropped')
  assert.equal((await getPet(opt(home, { pet: path.join(drop, 'spritesheet.webp') }))).displayName, 'Dropped')
  assert.equal((await getPet(opt(home, { pet: 'mine' }))).source, 'override')
  // an override that resolves to nothing falls through to the normal lookup
  assert.equal((await getPet(opt(home, { pet: 'no-such-pet' }))).petName, 'mine')
})

test('pets: built-in pets from the CLI cache and from the desktop app bundle', async () => {
  const home = tmp('petsbuiltin')
  write(path.join(home, 'config.toml'), '[tui]\npet = "dewey"\n')
  assert.equal((await getPet(opt(home))).spriteUrl, null)
  write(path.join(home, 'cache', 'tui-pets', 'assets', 'dewey-spritesheet-v4.webp'), makeWebpX(1536, 1872))
  let r = await getPet(opt(home))
  assert.equal(r.petName, 'dewey')
  assert.equal(r.displayName, 'Dewey')
  assert.equal(r.source, 'selected')
  const asar = path.join(home, 'App', 'resources', 'app.asar')
  makeAsar(asar, 'hoots-spritesheet-v8-21cacd193ace.webp', makeWebpX(1536, 2288))
  r = await loadBuiltin('hoots', opt(home, { appAsars: [asar] }))
  assert.equal(r.petName, 'hoots')
  assert.equal(r.atlas.rows, 11)
  assert.match(r.spriteUrl, /^data:image\/webp;base64,/)
  assert.equal(await loadBuiltin('../etc', opt(home)), null)
})

// ---------- skills: pack / install round trip (T2) ----------

test('skills: pack in one CODEX_HOME, install in another, no overwrite', async () => {
  const a = tmp('homeA'); const b = tmp('homeB'); const agents = tmp('agents')
  const skill = path.join(a, 'skills', 'hello-world')
  const md = '---\nname: hello-world\ndescription: >\n  Says hello\n  to the world.\n---\n\n# Hello\n'
  write(path.join(skill, 'SKILL.md'), md)
  write(path.join(skill, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')
  write(path.join(skill, 'assets', 'logo.bin'), Buffer.from([0, 1, 2, 255]))
  write(path.join(skill, '.git', 'HEAD'), 'ref')
  write(path.join(a, 'skills', '.system', 'hidden', 'SKILL.md'), '---\nname: hidden\ndescription: no\n---\n')
  write(path.join(agents, 'quoted', 'SKILL.md'), '---\nname: "quoted-one"\ndescription: "With \\"quotes\\""\n---\n')

  const listed = listSkills({ homes: [a], agentsDir: agents })
  assert.deepEqual(listed.map((s) => s.id), ['hello-world', 'quoted'])
  assert.equal(listed[0].description, 'Says hello to the world.')
  assert.equal(listed[1].name, 'quoted-one')
  assert.equal(listed[1].description, 'With "quotes"')

  const pkg = await packSkill('hello-world', { homes: [a], agentsDir: agents })
  assert.equal(pkg.name, 'hello-world')
  assert.equal(pkg.files[0].path, 'SKILL.md')
  assert.deepEqual(pkg.files.map((f) => f.path).sort(), ['SKILL.md', 'assets/logo.bin', 'scripts/run.sh'])
  assert.equal(pkg.truncated, false)

  const wire = JSON.parse(JSON.stringify(pkg)) // what crosses the relay
  wire.files.push({ path: '../escape.txt', b64: Buffer.from('no').toString('base64') })
  const res = await installSkill(wire, 'Rex', { home: b })
  assert.equal(res.installed, true)
  assert.equal(res.path, path.join(b, 'skills', 'petpack-hello-world'))
  assert.equal(fs.readFileSync(path.join(res.path, 'SKILL.md'), 'utf8'), md)
  assert.deepEqual(fs.readFileSync(path.join(res.path, 'assets', 'logo.bin')), Buffer.from([0, 1, 2, 255]))
  assert.equal(fs.existsSync(path.join(b, 'skills', 'escape.txt')), false)
  const meta = JSON.parse(fs.readFileSync(path.join(res.path, '.petpack.json'), 'utf8'))
  assert.equal(meta.from, 'Rex')
  assert.equal(meta.name, 'hello-world')

  const inB = listSkills({ homes: [b], agentsDir: tmp('empty') })
  assert.equal(inB.length, 1)
  assert.equal(inB[0].id, 'petpack-hello-world')
  assert.equal(inB[0].installedFrom, 'Rex')

  const again = await installSkill(wire, 'Rex', { home: b })
  assert.deepEqual(again, { installed: false, path: res.path, reason: 'exists' })

  // repacking an installed skill leaves its .petpack.json behind
  const repack = await packSkill('petpack-hello-world', { homes: [b], agentsDir: tmp('empty') })
  assert.ok(!repack.files.some((f) => f.path === '.petpack.json'))
})

test('skills: frontmatter is added when missing, packs are capped, bad input never throws', async () => {
  const b = tmp('homeC')
  const r = await installSkill({ name: 'No Front Matter!', description: 'Plain body', files: [{ path: 'SKILL.md', b64: Buffer.from('# Just text\n').toString('base64') }] }, 'Ana', { home: b })
  assert.equal(r.installed, true)
  assert.equal(path.basename(r.path), 'petpack-no-front-matter')
  const fm = parseFrontmatter(fs.readFileSync(path.join(r.path, 'SKILL.md'), 'utf8'))
  assert.equal(fm.name, 'no-front-matter')
  assert.equal(fm.description, 'Plain body')
  assert.equal((await installSkill(null, 'x', { home: b })).installed, false)
  assert.equal((await installSkill({ name: 'nofiles' }, 'x', { home: b })).installed, true)
  assert.equal(skillSlug('Ünïcode Skill_Name  v2'), 'unicode-skill-name-v2')

  const a = tmp('homeD')
  write(path.join(a, 'skills', 'big', 'SKILL.md'), '---\nname: big\ndescription: big one\n---\n')
  write(path.join(a, 'skills', 'big', 'blob.bin'), Buffer.alloc(4096))
  const pkg = await packSkill('big', { homes: [a], agentsDir: tmp('empty'), maxBytes: 1024 })
  assert.equal(pkg.truncated, true)
  assert.deepEqual(pkg.files.map((f) => f.path), ['SKILL.md'])
  await assert.rejects(packSkill('nope', { homes: [a], agentsDir: tmp('empty') }))
})

// ---------- status fixtures (all five) ----------

const pad = (n) => String(n).padStart(2, '0')
function sessionsDir (home) {
  const d = new Date()
  return path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const line = (msAgo, type, payload) => JSON.stringify({ timestamp: iso(msAgo), type, payload }) + '\n'
const meta = (source = 'exec') => line(120_000, 'session_meta', { id: 'x', cwd: '/work/proj', originator: 'codex_exec', cli_version: '0.166.0', source, base_instructions: { text: 'long '.repeat(50) } })
const started = (msAgo, turn = 't1') => line(msAgo, 'event_msg', { type: 'task_started', turn_attribution: { turn_id: turn }, turn_id: turn })
const complete = (msAgo, turn = 't1', error) => line(msAgo, 'event_msg', { type: 'task_complete', root_turn_id: turn, turn_id: turn, last_agent_message: 'ok', ...(error ? { error } : {}) })
const call = (msAgo, id, args) => line(msAgo, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify(args), call_id: id })
const output = (msAgo, id) => line(msAgo, 'response_item', { type: 'function_call_output', call_id: id, output: 'done' })
function rollout (home, name, text, mtimeAgo) {
  const f = path.join(sessionsDir(home), `rollout-2026-01-01T00-00-00-${name}.jsonl`)
  write(f, text)
  if (mtimeAgo) touch(f, mtimeAgo)
  return f
}

test('status: working, waiting, done, failed, idle', async () => {
  const cases = {
    working: meta() + started(5000) + call(4000, 'c1', { cmd: 'ls' }) + output(3000, 'c1'),
    waiting: meta() + started(9000) + call(8000, 'c2', { cmd: 'rm -rf build', sandbox_permissions: 'require_escalated' }),
    done: meta() + started(90_000) + complete(60_000),
    failed: meta() + started(90_000) + complete(60_000, 't1', { codex_error_info: 'other', message: 'boom' }),
    idle: meta() + started(40 * 60_000) + complete(30 * 60_000)
  }
  for (const [want, text] of Object.entries(cases)) {
    const home = tmp(`st-${want}`)
    rollout(home, want, text, want === 'idle' ? 30 * 60_000 : 0)
    const s = await readStatus({ homes: [home] })
    assert.equal(s.status, want, `fixture ${want}`)
  }
  // no sessions at all
  assert.equal((await readStatus({ homes: [tmp('st-empty')] })).status, 'idle')
  // an interrupted turn is idle; a stale open turn (file untouched > 10 min) is idle
  const h2 = tmp('st-more')
  rollout(h2, 'aborted', meta() + started(9000) + line(5000, 'event_msg', { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' }))
  assert.equal((await readStatus({ homes: [h2] })).status, 'idle')
  const h3 = tmp('st-stale')
  rollout(h3, 'stale', meta() + started(12 * 60_000), 11 * 60_000)
  assert.equal((await readStatus({ homes: [h3] })).status, 'idle')
})

test('status: subagent rollouts are ignored, several sessions combine', async () => {
  const home = tmp('st-multi')
  rollout(home, 'sub', meta({ subagent: { thread_spawn: { depth: 1 } } }) + started(3000))
  assert.equal((await readStatus({ homes: [home] })).status, 'idle')
  rollout(home, 'done', meta() + started(90_000) + complete(60_000))
  assert.equal((await readStatus({ homes: [home] })).status, 'done')
  rollout(home, 'work', meta() + started(3000))
  const s = await readStatus({ homes: [home] })
  assert.equal(s.status, 'working')
  assert.equal(s.cwd, '/work/proj')
})

test('status: incremental tracker and watcher follow a turn from working to done', async () => {
  const home = tmp('st-live')
  const f = rollout(home, 'live', meta() + started(1000))
  const tracker = createStatusTracker({ homes: [home] })
  assert.equal((await tracker.poll()).status, 'working')
  fs.appendFileSync(f, call(500, 'c9', { cmd: 'sudo x', sandbox_permissions: 'require_escalated' }))
  assert.equal((await tracker.poll()).status, 'working') // pending < 2 s
  assert.equal((await createStatusTracker({ homes: [home], now: () => Date.now() + 3000 }).poll()).status, 'waiting')
  fs.appendFileSync(f, output(100, 'c9'))
  fs.appendFileSync(f, complete(0))
  assert.equal((await tracker.poll()).status, 'done')

  const seen = []
  const f2 = rollout(home, 'live2', meta() + started(0, 't2'))
  const stop = watchStatus((s) => seen.push(s.status), { homes: [home], intervalMs: 50 })
  await new Promise((resolve) => setTimeout(resolve, 200))
  fs.appendFileSync(f2, complete(0, 't2'))
  await new Promise((resolve) => setTimeout(resolve, 300))
  stop()
  assert.deepEqual(seen, ['working', 'done'])
})

test('pets: [desktop] selection, the app default pet, cloud ids, picker and saved choice', async () => {
  const home = tmp('picker')
  const asar = path.join(home, 'App', 'resources', 'app.asar')
  makeAsar(asar, 'codex-spritesheet-v6-51045ae208c0.webp', makeWebpX(1536, 2288))
  // nothing selected, no custom pets, the desktop app installed -> its default pet, Codex
  let r = await getPet(opt(home, { appAsars: [asar] }))
  assert.equal(r.petName, 'codex')
  assert.equal(r.source, 'default')
  // no app -> the built-in pixel pet
  assert.equal((await getPet(opt(home))).source, 'none')
  // the app writes its pick under [desktop]
  makePet(home, 'mochi', { displayName: 'Mochi' }, 'spritesheet.webp', makeWebpX(1536, 1872))
  makePet(home, 'other', { displayName: 'Other' }, 'spritesheet.webp', makeWebpX(1536, 1872))
  touch(path.join(home, 'pets', 'mochi', 'spritesheet.webp'), 600_000); touch(path.join(home, 'pets', 'mochi', 'pet.json'), 600_000)
  write(path.join(home, 'config.toml'), 'model = "m"\n[desktop]\nselected-avatar-id = "custom:mochi"\n')
  r = await getPet(opt(home, { appAsars: [asar] }))
  assert.equal(r.displayName, 'Mochi')
  // a cloud pet with no local sheet falls through to local pets
  write(path.join(home, 'config.toml'), '[desktop]\nselected-avatar-id = "pet_abc123"\n')
  assert.equal((await getPet(opt(home, { appAsars: [asar] }))).displayName, 'Other')

  // the picker: candidates, choose, persisted, back to Codex's choice
  const ud = tmp('userdata')
  const codex = createCodex({ home, cacheDir: path.join(ud, 'pets'), fetchPets: false, appAsars: [asar] })
  const list = await codex.listPets({ sprites: false })
  assert.deepEqual(list.filter((p) => p.source === 'custom').map((p) => p.displayName).sort(), ['Mochi', 'Other'])
  assert.ok(list.some((p) => p.source === 'builtin' && p.id === 'codex' && p.available === 'yes'))
  assert.equal(list.filter((p) => p.current).length, 1)
  assert.equal(list[0].spriteUrl, undefined)
  // with sprites (the default): every usable pet carries its sheet, e.g. for demo bots
  const dressed = (await codex.listPets()).filter((p) => p.spriteUrl)
  assert.deepEqual(dressed.map((p) => p.displayName).sort(), ['Codex', 'Mochi', 'Other'])
  assert.ok(dressed.every((p) => /^data:image\/(webp|png);base64,/.test(p.spriteUrl) && p.atlas))
  const changed = []
  codex.onPetChange((p) => changed.push(p.displayName))
  const chosen = await codex.choosePet('codex')
  assert.equal(chosen.petName, 'codex')
  assert.equal(chosen.source, 'chosen')
  assert.deepEqual(changed, ['Codex'])
  const again = createCodex({ home, cacheDir: path.join(ud, 'pets'), fetchPets: false, appAsars: [asar] })
  assert.equal((await again.getPet()).petName, 'codex')
  await assert.rejects(again.choosePet(path.join(home, 'nowhere')))
  await again.choosePet(path.join(home, 'pets', 'mochi'))
  assert.equal((await again.getPet()).displayName, 'Mochi')
  await again.choosePet(null)
  assert.equal((await again.getPet()).displayName, 'Other') // follows Codex again (pet_abc123 -> newest local pet)
  assert.equal(fs.existsSync(path.join(ud, 'pet-choice.json')), false)
  codex.dispose(); again.dispose()
})

const userMsg = (msAgo, text) => line(msAgo, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })

test('task: title from the thread name, else the latest prompt; live counts and approvals', async () => {
  const home = tmp('task')
  const id = '01a19767-face-7e51-a985-28abe7a6db26'
  const f = path.join(sessionsDir(home), `rollout-2026-01-01T00-00-00-${id}.jsonl`)
  write(f, meta() + userMsg(9000, '# AGENTS.md instructions\n\n<INSTRUCTIONS>x</INSTRUCTIONS>') + userMsg(8900, '<environment_context>cwd</environment_context>') +
    userMsg(8000, 'please fix the flaky login test in auth.spec.ts and then run the whole suite again to be sure') + started(7000))
  let t = await currentTask({ homes: [home] })
  assert.equal(t.status, 'working')
  assert.equal(t.title, 'Fix the flaky login test in auth.spec.ts and…')
  assert.ok(t.title.length <= 48)
  assert.equal(t.sessions, 1)
  assert.equal(t.approvalPending, false)
  assert.equal(t.threadId, id)
  write(path.join(home, 'session_index.jsonl'), JSON.stringify({ id, thread_name: 'Fix flaky login test', updated_at: 'x' }) + '\n')
  fs.appendFileSync(f, call(5000, 'c1', { cmd: 'sudo rm -rf /tmp/x', sandbox_permissions: 'require_escalated' }))
  t = await currentTask({ homes: [home] })
  assert.equal(t.title, 'Fix flaky login test')
  assert.equal(t.status, 'waiting')
  assert.equal(t.approvalPending, true)
  assert.equal(compressTitle('Run the tests. Then deploy.'), 'Run the tests')
})

test('events: started, waiting, done and failed on transitions only', async () => {
  const home = tmp('events')
  rollout(home, 'old', meta() + started(90_000) + complete(60_000)) // already done at start-up: no event
  const events = []
  const tracker = createStatusTracker({ homes: [home], onEvent: (e) => events.push(`${e.type}:${e.title}`) })
  await tracker.poll()
  assert.deepEqual(events, [])
  const f = rollout(home, 'new', meta() + userMsg(1000, 'Ship the release notes') + started(900))
  await tracker.poll()
  fs.appendFileSync(f, complete(0))
  await tracker.poll()
  const g = rollout(home, 'gate', meta() + userMsg(10_000, 'Clean the build dir') + started(9000) + call(8000, 'c7', { cmd: 'rm', sandbox_permissions: 'require_escalated' }))
  await tracker.poll()
  fs.appendFileSync(g, output(10, 'c7') + complete(0, 't1', { codex_error_info: 'x', message: 'boom' }))
  await tracker.poll()
  assert.deepEqual(events, ['started:Ship the release notes', 'done:Ship the release notes', 'waiting:Clean the build dir', 'failed:Clean the build dir'])
  assert.deepEqual(codexEventMessage({ type: 'done', title: 'Ship it' }), { title: 'Codex finished', body: 'Ship it' })
  assert.equal(codexEventMessage({ type: 'waiting' }).title, 'Codex needs you')

  // createCodex: onCodexEvent shares the poller and carries the notification text
  const home2 = tmp('events2')
  const codex = createCodex({ home: home2, fetchPets: false, intervalMs: 40 })
  const got = []
  const off = codex.onCodexEvent((e) => got.push(e))
  await new Promise((resolve) => setTimeout(resolve, 120))
  const h = rollout(home2, 'live', meta() + userMsg(100, 'Write the README') + started(50))
  await new Promise((resolve) => setTimeout(resolve, 150))
  fs.appendFileSync(h, complete(0))
  await new Promise((resolve) => setTimeout(resolve, 150))
  off(); codex.dispose()
  assert.deepEqual(got.map((e) => e.type), ['started', 'done'])
  assert.deepEqual(got[1].message, { title: 'Codex finished', body: 'Write the README' })
})

test('openCodex: codex:// deep link to the thread, then the app by name', async () => {
  const id = '01a19767-face-7e51-a985-28abe7a6db26'
  assert.equal(codexThreadUrl(`/x/rollout-2026-11-01T13-58-56-${id}.jsonl`), `codex://threads/${id}`)
  assert.equal(codexThreadUrl(null), 'codex://launch')
  const mac = await openCodex({ session: `rollout-2026-11-01T13-58-56-${id}.jsonl`, platform: 'darwin', dryRun: true })
  assert.deepEqual(mac.tried[0], ['open', [`codex://threads/${id}`]])
  assert.deepEqual(mac.tried[1], ['open', ['-a', 'Codex']])
  const win = await openCodex({ threadId: id, platform: 'win32', dryRun: true })
  assert.ok(win.tried.some(([c, a]) => c === 'explorer.exe' && a[0].startsWith('shell:AppsFolder\\OpenAI.Codex_')))
})

test('takeover: Codex pet off on desktop and CLI, same pet in petpack, exact restore, idempotent, crash-safe', async () => {
  const home = tmp('takeover')
  const ud = tmp('takeover-ud')
  const cfg = 'model = "gpt"\n\n[tui]\npet = "custom:mochi"\nanimations = true\n\n[desktop]\nselected-avatar-id = "custom:mochi"\npet-visibility = "always-visible"\n'
  const gs = JSON.stringify({ 'electron-avatar-overlay-open': true, other: { a: 1 } })
  write(path.join(home, 'config.toml'), cfg)
  write(path.join(home, '.codex-global-state.json'), gs)
  makePet(home, 'mochi', { displayName: 'Mochi' }, 'spritesheet.webp', makeWebpX(1536, 1872))
  makePet(home, 'zed', { displayName: 'Zed' }, 'spritesheet.webp', makeWebpX(1536, 1872))
  touch(path.join(home, 'pets', 'mochi', 'spritesheet.webp'), 600_000); touch(path.join(home, 'pets', 'mochi', 'pet.json'), 600_000)
  const codex = createCodex({ home, cacheDir: path.join(ud, 'pets'), fetchPets: false, appAsars: [] })

  const r = codex.takeOverPet()
  assert.equal(r.ok, true)
  let now = fs.readFileSync(path.join(home, 'config.toml'), 'utf8')
  assert.match(now, /\[desktop\]\navatar-overlay-pet-visible = false\nselected-avatar-id = "custom:mochi"/)
  assert.match(now, /\[tui\]\npet = "disabled"/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.codex-global-state.json'), 'utf8'))['electron-avatar-overlay-open'], false)
  assert.equal(codex.takeoverActive(), true)
  // petpack still shows the pet that was selected, also when only the CLI had it
  assert.equal((await codex.getPet()).displayName, 'Mochi')
  write(path.join(home, 'config.toml'), now.replace('selected-avatar-id = "custom:mochi"\n', ''))
  assert.equal((await codex.refreshPet()).displayName, 'Mochi')
  write(path.join(home, 'config.toml'), now)

  // twice is the same as once, and a second instance (a relaunch after a crash) keeps the first originals
  codex.takeOverPet()
  const again = createCodex({ home, cacheDir: path.join(ud, 'pets'), fetchPets: false, appAsars: [] })
  again.takeOverPet()
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), now)

  const back = again.releasePet()
  assert.equal(back.ok, true)
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), cfg)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.codex-global-state.json'), 'utf8')), JSON.parse(gs))
  assert.equal(again.takeoverActive(), false)
  assert.deepEqual(again.releasePet(), { ok: true, restored: [] })

  // no [desktop] table and no CLI pet: the table is added, then removed again; --no-takeover restores a stale marker
  const plain = 'model = "gpt"\n'
  write(path.join(home, 'config.toml'), plain)
  fs.rmSync(path.join(home, '.codex-global-state.json'))
  codex.takeOverPet()
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'model = "gpt"\n\n[desktop]\navatar-overlay-pet-visible = false\n')
  const off = createCodex({ home, cacheDir: path.join(ud, 'pets'), fetchPets: false, appAsars: [] }).takeOverPet({ enabled: false })
  assert.equal(off.released.ok, true)
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), plain)
  // an existing visible=true line comes back as it was
  const vis = '[desktop]\navatar-overlay-pet-visible = true # mine\n'
  write(path.join(home, 'config.toml'), vis)
  codex.takeOverPet()
  assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /avatar-overlay-pet-visible = false/)
  releasePet({ userData: ud })
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), vis)
})

test('index: createCodex wires the pieces for main.js', async () => {
  const home = tmp('idx')
  write(path.join(home, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: first\n---\n')
  makePet(home, 'buddy', { displayName: 'Buddy' }, 'spritesheet.webp', makeWebpX(1536, 1872))
  const codex = createCodex({ home, fetchPets: false })
  const me = await codex.getMe('abc')
  assert.equal(me.id, 'abc')
  assert.equal(me.displayName, 'Buddy')
  assert.ok(me.skills.some((s) => s.id === 'one'))
  const got = await new Promise((resolve) => { const un = codex.onStatus((s) => { un(); resolve(s) }) })
  assert.equal(got.status, 'idle')
  codex.dispose()
})
