// `petpack doctor`: one PASS/FIX line per thing petpack needs, with what to do for each FIX. Exit code 1 if any FIX.
//
//   runDoctor(argv)  argv: [--profile p] [--no-network]; returns { ok, items }

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { userDataDir, readIpcInfo, connectIpc } from './ipc.js'
import { codexConfigTargets, registrationStatus, codexOnPath } from './register.js'
import { lastCodexConnection } from './link.js'

const ROOT = new URL('../../', import.meta.url)
const PKG = (() => { try { return JSON.parse(fs.readFileSync(new URL('package.json', ROOT), 'utf8')) } catch { return {} } })()
const NPX = `npx ${PKG.name || '@qwntllabs/petpack'}`

function ago(iso) {
  const t = Date.parse(iso)
  if (!t) return '?'
  const s = Math.round((Date.now() - t) / 1000)
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`
}

async function relayCheck(wsUrl, timeoutMs = 5000) {
  const http = wsUrl.replace(/^ws/, 'http').replace(/\/ws\/?$/, '') + '/healthz'
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const r = await fetch(http, { signal: ctl.signal })
    return { ok: r.ok, detail: `${r.status} in ${Date.now() - t0} ms` }
  } catch (e) {
    return { ok: false, detail: e.name === 'AbortError' ? `no answer in ${timeoutMs / 1000} s` : e.cause?.code || e.message }
  } finally { clearTimeout(timer) }
}

function parseArgs(argv) {
  const opts = { profile: undefined, network: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile') opts.profile = argv[++i]
    else if (a.startsWith('--profile=')) opts.profile = a.slice(10)
    else if (a === '--no-network') opts.network = false
  }
  return opts
}

export async function runDoctor(argv = [], { print = (l) => console.log(l), relays } = {}) {
  const opts = Array.isArray(argv) ? parseArgs(argv.filter((a) => a !== 'doctor')) : { network: true, ...argv }
  const items = []
  const add = (ok, name, detail, fix) => items.push({ ok, name, detail, fix })
  const userData = userDataDir(opts.profile)

  // Node, Electron, platform
  const [maj, min] = process.versions.node.split('.').map(Number)
  add(maj > 22 || (maj === 22 && min >= 12), 'Node', `v${process.versions.node}`, 'install Node 22.12 or newer (https://nodejs.org)')
  let electron = { ok: false, detail: `Electron ${PKG.petpack?.electron || '?'} not fetched yet` }
  try {
    const rt = await import(new URL('bin/runtime.js', ROOT).href)
    const req = createRequire(new URL('package.json', ROOT))
    let where = null
    try { where = path.dirname(req.resolve(`${rt.PLATFORM_PACKAGE}/package.json`)) } catch {}
    if (!where && fs.existsSync(rt.cacheDir()) && fs.readdirSync(rt.cacheDir()).length) where = rt.cacheDir()
    if (!where) { try { where = path.dirname(req.resolve('electron/package.json')) } catch {} }
    electron = where ? { ok: true, detail: `Electron ${rt.pinnedElectron()} (${where})` } : { ok: false, detail: `Electron ${rt.pinnedElectron()} not fetched yet` }
  } catch {}
  add(electron.ok, 'Electron', electron.detail, `run \`${NPX}\` once; it fetches Electron (~120 MB)`)
  add(true, 'Platform', `${process.platform} ${process.arch} (${os.release()})`)

  // Codex homes and registration
  const targets = codexConfigTargets()
  const reg = registrationStatus({ userData, targets })
  const cli = codexOnPath()
  add(true, 'Codex CLI', cli ? cli : 'not on PATH (fine: petpack writes Codex\'s config.toml itself)')
  for (const r of reg) {
    const label = 'Codex config'
    if (r.status === 'registered') add(true, label, `${r.file}: petpack is registered`)
    else if (r.status === 'removed-by-user') add(false, label, `${r.file}: you removed petpack from it`, `\`${NPX} mcp install\` adds it back`)
    else if (r.status === 'missing') add(false, label, `${r.file}: petpack is not registered`, `run \`${NPX}\` (or \`${NPX} mcp install\`)`)
    else if (targets[0] && r.home === targets[0].home) add(false, label, `${r.file}: no Codex home yet`, `open Codex once, then run \`${NPX}\``)
  }

  // Overlay and last MCP connection
  const info = readIpcInfo(userData)
  let running = false
  if (info) {
    try { const c = await connectIpc({ userData, client: { kind: 'probe', name: 'doctor' } }); await c.ping(); c.close(); running = true } catch {}
  }
  add(true, 'petpack', running ? `running (pid ${info.pid})` : 'not running (Codex starts it on its first petpack call)')
  const last = lastCodexConnection(userData)
  if (last && last.lastSeen) {
    const who = last.client ? ` from Codex ${last.client.app === 'app' ? 'app' : last.client.app === 'cli' ? 'CLI' : ''}${last.client.version ? ' ' + last.client.version : ''}` : ''
    add(true, 'Codex link', `last MCP connection ${ago(last.lastSeen)}${who}`)
  } else {
    add(false, 'Codex link', 'no Codex session has connected yet', 'restart Codex (sessions opened before petpack was registered don\'t load it)')
  }

  // Relays
  if (opts.network) {
    let list = relays
    if (!list) { try { list = (await import(new URL('shared/protocol.js', ROOT).href)).RELAYS } catch { list = [] } }
    const checks = await Promise.all(list.map((u) => relayCheck(u)))
    list.forEach((u, i) => add(checks[i].ok, `Relay ${i ? 'backup' : 'primary'}`, `${u} ${checks[i].detail}`,
      'check the network (a venue Wi-Fi may block it; try a hotspot)'))
    if (list.length > 1 && checks.some((c) => c.ok)) items.filter((it) => it.name.startsWith('Relay') && !it.ok).forEach((it) => { it.ok = true; it.detail += ' (the other relay is up)' })
  }

  // Pet
  try {
    const pets = await import(new URL('app/codex/pets.js', ROOT).href)
    const list = pets.listPets ? pets.listPets() : []
    const selected = pets.selectedPetIds ? pets.selectedPetIds() : []
    const names = list.map((p) => p.displayName || p.petName || p.id).filter(Boolean)
    const sel = selected[0]?.id
    if (names.length || sel) add(true, 'Pet', `${names.length} custom pet${names.length === 1 ? '' : 's'}${names.length ? ` (${names.slice(0, 4).join(', ')})` : ''}${sel ? `; selected in Codex: ${sel}` : ''}`)
    else add(false, 'Pet', 'no Codex pet found (petpack uses its built-in pixel pet)', 'pick or hatch a pet in Codex; petpack picks it up on the next launch')
  } catch (e) {
    add(true, 'Pet', `pet check unavailable (${e.message})`)
  }

  const width = Math.max(...items.map((i) => i.name.length))
  for (const it of items) {
    print(`${it.ok ? 'PASS' : 'FIX '}  ${it.name.padEnd(width)}  ${it.detail}${it.ok || !it.fix ? '' : `\n${' '.repeat(width + 8)}-> ${it.fix}`}`)
  }
  const ok = items.every((i) => i.ok)
  print(ok ? 'petpack doctor: all good.' : `petpack doctor: ${items.filter((i) => !i.ok).length} to fix.`)
  return { ok, items }
}
