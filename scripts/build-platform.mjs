#!/usr/bin/env node
// Build the platform packages petpack lists as optionalDependencies: @qwntllabs/petpack-<platform>-<arch>, each
// holding the prebuilt Electron runtime the pane runs on (the esbuild pattern: npm installs only the one whose
// `os`/`cpu` match, with no install scripts). Runs on the target's own OS in CI (scripts/build-pipeline.yml).
//
//   node scripts/build-platform.mjs [--target darwin-arm64|darwin-x64|win32-x64|linux-x64] [--zip <electron zip>]
//                                   [--out <dir>]          (default: this machine's target, out/pkg)
//
// The runtime is Electron's own release zip, checksum-verified and unmodified, so Apple's signature and notarization
// on Electron.app stay intact. Windows and Linux packages carry the unpacked files under runtime/. npm drops
// symlinks, which the macOS frameworks need, so macOS packages carry the zip itself and bin/runtime.js unpacks it
// once with ditto. Prints one JSON line: { target, name, version, tarball, bytes, ms }.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = {
  'darwin-arm64': { label: 'macOS on Apple silicon', archive: true, executable: 'Electron.app/Contents/MacOS/Electron' },
  'darwin-x64': { label: 'macOS on Intel', archive: true, executable: 'Electron.app/Contents/MacOS/Electron' },
  'win32-x64': { label: 'Windows x64', executable: 'electron.exe' },
  'linux-x64': { label: 'Linux x64', executable: 'electron' },
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const t0 = Date.now()
const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const target = arg('target', `${process.platform}-${process.arch}`)
const spec = TARGETS[target]
if (!spec) throw new Error(`unknown target ${target}; one of ${Object.keys(TARGETS).join(', ')}`)
const [platform, arch] = target.split('-')
const electron = root.petpack?.electron
if (!electron) throw new Error('package.json has no petpack.electron version')
const name = `@qwntllabs/petpack-${target}`
if (root.optionalDependencies?.[name] !== root.version) {
  throw new Error(`package.json optionalDependencies["${name}"] must be exactly ${root.version}`)
}
const out = path.resolve(arg('out', path.join(ROOT, 'out', 'pkg')))
const zipName = `electron-v${electron}-${target}.zip`
const log = (...a) => console.error(`[build ${target} +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

// ---------------------------------------------------------------------------------------------------------------
// 1. Electron's release zip: --zip, Electron's own download cache, or GitHub (one asset), then the checksum.

async function expectedSha() {
  const local = path.join(ROOT, 'node_modules', 'electron')
  try {
    if (JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8')).version === electron) {
      const sums = JSON.parse(fs.readFileSync(path.join(local, 'checksums.json'), 'utf8'))
      if (sums[zipName]) return sums[zipName]
    }
  } catch {}
  const res = await fetch(`https://github.com/electron/electron/releases/download/v${electron}/SHASUMS256.txt`)
  if (!res.ok) throw new Error(`SHASUMS256.txt: HTTP ${res.status}`)
  const line = (await res.text()).split('\n').find(l => l.trim().endsWith(` *${zipName}`) || l.trim().endsWith(` ${zipName}`))
  if (!line) throw new Error(`no checksum for ${zipName}`)
  return line.trim().split(/\s+/)[0]
}

function electronCaches() {
  const home = os.homedir()
  return [process.env.electron_config_cache, path.join(home, '.cache', 'electron'),
    path.join(home, 'Library', 'Caches', 'electron'),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'electron', 'Cache')].filter(Boolean)
}

function findCachedZip() {
  for (const dir of electronCaches()) {
    let subs = []
    try { subs = fs.readdirSync(dir) } catch { continue }
    for (const sub of ['', ...subs]) {
      const file = path.join(dir, sub, zipName)
      if (fs.existsSync(file)) return file
    }
  }
  return null
}

async function download(dest) {
  const url = `https://github.com/electron/electron/releases/download/v${electron}/${zipName}`
  log(`downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
  return dest
}

function sha256(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(8 * 1024 * 1024)
  let n
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n))
  fs.closeSync(fd)
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', windowsHide: true, ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status} ${r.error?.message || ''}`)
  return r.stdout
}

function unzip(zip, dir) {
  if (process.platform === 'win32') return run('tar.exe', ['-xf', zip, '-C', dir])
  if (process.platform === 'darwin') return run('/usr/bin/ditto', ['-x', '-k', zip, dir])
  return run('unzip', ['-q', zip, '-d', dir])
}

const README = `# ${name}

The prebuilt Electron ${electron} runtime that [@qwntllabs/petpack](https://www.npmjs.com/package/@qwntllabs/petpack) runs its pane on,
for ${spec.label}. You don't install this yourself: \`npx @qwntllabs/petpack\` pulls in the one package that matches your
system (npm's \`os\`/\`cpu\` fields), with no install scripts.

It is Electron's own release (${zipName}, sha256-verified, unmodified). Electron is MIT-licensed; Chromium's
licences are in ${spec.archive ? 'the zip' : 'runtime/'}.
`

async function main() {
  const expected = await expectedSha()
  let zip = arg('zip') || findCachedZip()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `petpack-build-${target}-`))
  if (!zip || sha256(zip) !== expected) zip = await download(path.join(work, zipName))
  const actual = sha256(zip)
  if (actual !== expected) throw new Error(`${zipName}: sha256 ${actual}, expected ${expected}`)
  log(`zip ${zip} sha256 ok (${(fs.statSync(zip).size / 1e6).toFixed(1)} MB)`)

  const pkg = path.join(work, 'package')
  fs.mkdirSync(path.join(pkg, 'runtime'), { recursive: true })
  const meta = { electron, executable: spec.archive ? spec.executable : `runtime/${spec.executable}` }
  if (spec.archive) {
    fs.copyFileSync(zip, path.join(pkg, 'runtime', zipName))
    meta.archive = `runtime/${zipName}`
    meta.sha256 = expected
  } else {
    unzip(zip, path.join(pkg, 'runtime'))
    if (!fs.existsSync(path.join(pkg, meta.executable))) throw new Error(`no ${meta.executable} in ${zipName}`)
    // npm keeps the executable bit; drop Electron's TypeScript file, the one thing a runtime doesn't need.
    fs.rmSync(path.join(pkg, 'runtime', 'electron.d.ts'), { force: true })
  }
  const manifest = {
    name,
    version: root.version,
    description: `The prebuilt Electron ${electron} runtime for petpack on ${spec.label}.`,
    license: 'MIT',
    repository: root.repository,
    homepage: root.homepage,
    os: [platform],
    cpu: [arch],
    files: ['runtime', 'README.md'],
    preferUnplugged: true,
    petpack: meta,
  }
  fs.writeFileSync(path.join(pkg, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(path.join(pkg, 'README.md'), README)

  fs.mkdirSync(out, { recursive: true })
  const npm = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'npm']] : ['npm', []]
  const packed = run(npm[0], [...npm[1], 'pack', '--silent', '--pack-destination', out], { cwd: pkg }).trim().split('\n').pop()
  const tarball = path.join(out, packed)
  fs.rmSync(work, { recursive: true, force: true })
  const result = { target, name, version: root.version, electron, tarball, bytes: fs.statSync(tarball).size, ms: Date.now() - t0 }
  log(`${tarball} ${(result.bytes / 1e6).toFixed(1)} MB`)
  console.log(JSON.stringify(result))
}

main().catch(error => { console.error(`build-platform: ${error.message}`); process.exit(1) })
