// Which Electron runs the pane, found without starting it (plain Node; `npx petpack mcp` never comes here).
//
//   1. The prebuilt runtime npm installed beside petpack: the optional dependency
//      @qwntllabs/petpack-<platform>-<arch> (the esbuild pattern: npm picks the one matching `os`/`cpu`).
//      Windows and Linux carry Electron's files directly. npm drops symlinks, which a macOS .app needs for its
//      frameworks, so the macOS packages carry Electron's own zip and it is unpacked once into petpack's cache.
//   2. A local `electron` package (a checkout of the repo, where it is a dev dependency).
//   3. Neither (an unsupported platform, or `--omit=optional`): Electron fetched once into petpack's cache with npm,
//      the way `npx electron` does it.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const WIN = process.platform === 'win32'

export const PLATFORM_PACKAGE = `@qwntllabs/petpack-${process.platform}-${process.arch}`

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** The Electron version petpack is built and tested against (package.json "petpack.electron"). */
export function pinnedElectron() {
  return readJson(path.join(ROOT, 'package.json'))?.petpack?.electron || '45.2.1'
}

/** petpack's own cache: macOS ~/Library/Caches/petpack, Windows %LOCALAPPDATA%\petpack\Cache, else ~/.cache/petpack. */
export function cacheDir() {
  if (process.env.PETPACK_CACHE) return path.resolve(process.env.PETPACK_CACHE)
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'petpack')
  if (WIN) return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'petpack', 'Cache')
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'petpack')
}

// ---------------------------------------------------------------------------------------------------------------
// 1. The platform package

function fromPlatformPackage() {
  let dir
  try { dir = path.dirname(require.resolve(`${PLATFORM_PACKAGE}/package.json`)) } catch { return null }
  const meta = readJson(path.join(dir, 'package.json'))?.petpack
  if (!meta?.executable) return null
  const runtime = { source: PLATFORM_PACKAGE, electron: meta.electron }
  if (!meta.archive) {
    const exe = path.join(dir, meta.executable)
    return fs.existsSync(exe) ? { ...runtime, path: exe } : null
  }
  const target = path.join(cacheDir(), 'runtime', `electron-v${meta.electron}-${process.platform}-${process.arch}`)
  const exe = path.join(target, meta.executable)
  if (!fs.existsSync(exe)) unpack(path.join(dir, meta.archive), target)
  return fs.existsSync(exe) ? { ...runtime, path: exe, unpacked: target } : null
}

/** Unpack into a temp sibling and rename, so a second launch racing this one never sees half a runtime. */
function unpack(zip, target) {
  const tmp = `${target}.${process.pid}.tmp`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  // ditto keeps the bundle's symlinks, modes and signatures; tar.exe (bsdtar) reads zips on Windows 10+.
  const [cmd, args] = process.platform === 'darwin' ? ['/usr/bin/ditto', ['-x', '-k', zip, tmp]]
    : WIN ? ['tar.exe', ['-xf', zip, '-C', tmp]] : ['unzip', ['-q', zip, '-d', tmp]]
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw new Error(`couldn't unpack ${zip}: ${(result.stderr || result.error?.message || '').trim()}`)
  }
  try {
    fs.renameSync(tmp, target)
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true })
    if (!fs.existsSync(target)) throw error
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 2 and 3. The `electron` npm package: local, or fetched into the cache

function electronFrom(requireFn, source, log) {
  const dir = path.dirname(requireFn.resolve('electron/package.json'))
  const electron = readJson(path.join(dir, 'package.json'))?.version
  if (!fs.existsSync(path.join(dir, 'path.txt'))) {
    log(`petpack: fetching Electron ${electron} for ${process.platform}-${process.arch} (once, about 120-160 MB)...`)
  }
  try {
    return { source, electron, path: requireFn('electron') }
  } catch (error) {
    const exe = WIN ? unzipWithTar(dir, electron) : null // Smart App Control can block the unzip binding (electron#52481)
    if (exe) return { source, electron, path: exe }
    throw error
  }
}

function fromLocalElectron(log) {
  try { require.resolve('electron/package.json') } catch { return null }
  return electronFrom(require, 'electron', log)
}

function npmCommand() {
  const bin = path.dirname(process.execPath)
  const candidates = [process.env.npm_execpath, path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  const cli = candidates.find(file => file && /npm-cli\.js$/.test(file) && fs.existsSync(file))
  return cli ? [process.execPath, [cli]] : [WIN ? 'npm.cmd' : 'npm', []]
}

function fromNpm(log) {
  const version = pinnedElectron()
  const prefix = path.join(cacheDir(), 'electron-npm', version)
  const anchor = createRequire(path.join(prefix, 'node_modules', '.petpack.js'))
  try { anchor.resolve('electron/package.json') } catch {
    log(`petpack: no prebuilt runtime for ${process.platform}-${process.arch}; getting Electron ${version} from npm (once)...`)
    fs.mkdirSync(prefix, { recursive: true })
    const [cmd, pre] = npmCommand()
    const result = spawnSync(cmd, [...pre, 'install', '--prefix', prefix, `electron@${version}`, '--no-save',
      '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error'],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: WIN && cmd === 'npm.cmd', windowsHide: true })
    if (result.status !== 0) throw new Error(`npm install electron@${version} failed (exit ${result.status})`)
  }
  return electronFrom(anchor, `electron@${version} (npm, cached)`, () => {})
}

/** Windows: unzip the cached Electron zip with tar.exe when the extract-zip binding is blocked. */
function unzipWithTar(dir, version) {
  const name = `electron-v${version}-win32-${process.arch}.zip`
  const roots = [process.env.electron_config_cache,
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache')].filter(Boolean)
  for (const root of roots) {
    let entries = []
    try { entries = fs.readdirSync(root) } catch { continue }
    for (const sub of ['', ...entries]) {
      const zip = path.join(root, sub, name)
      if (!fs.existsSync(zip)) continue
      const dist = path.join(dir, 'dist')
      fs.mkdirSync(dist, { recursive: true })
      const result = spawnSync('tar.exe', ['-xf', zip, '-C', dist], { stdio: 'inherit', windowsHide: true })
      if (result.status !== 0) return null
      fs.writeFileSync(path.join(dir, 'path.txt'), 'electron.exe')
      return path.join(dist, 'electron.exe')
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * { path, source, electron } of the Electron executable to run. `PETPACK_ELECTRON` (a path) overrides everything.
 * Throws with a readable message when no runtime can be found or fetched.
 */
export function resolveRuntime({ log = console.log } = {}) {
  if (process.env.PETPACK_ELECTRON) return { path: process.env.PETPACK_ELECTRON, source: 'PETPACK_ELECTRON' }
  let runtime = null
  try { runtime = fromPlatformPackage() } catch (error) { log(`petpack: ${error.message}; falling back to npm's Electron`) }
  return runtime || fromLocalElectron(log) || fromNpm(log)
}
