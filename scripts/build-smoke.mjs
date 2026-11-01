#!/usr/bin/env node
// Install the launcher tarball + one platform tarball into a fresh folder, the way npm does for a person, then run
// the pane's smoke through the installed bin. Proves the platform package's runtime is used and Electron is never
// downloaded. Same script on macOS, Windows and Linux.
//
//   node scripts/build-smoke.mjs --launcher <qwntllabs-petpack-x.tgz> --platform <qwntllabs-petpack-os-arch-x.tgz>
//                                --out <dir>                 -> <dir>/result.json, exit 0 only when every check passed
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WIN = process.platform === 'win32'
const MAC = process.platform === 'darwin'
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined }
const LAUNCHER = path.resolve(arg('launcher'))
const PLATFORM = path.resolve(arg('platform'))
const OUT = path.resolve(arg('out') || 'smoke-out')
fs.mkdirSync(OUT, { recursive: true })
const t0 = Date.now()
const result = { os: process.platform, arch: process.arch, node: process.version, checks: {}, timings: {} }
const check = (name, pass, detail) => {
  result.checks[name] = { pass: Boolean(pass), detail }
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const save = () => fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2))

function run(cmd, args, { cwd, timeoutMs = 300000, shell = false, log, env } = {}) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(cmd, args, { cwd, shell, env: env || process.env, windowsHide: false })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    const timer = setTimeout(() => {
      out += `\n[smoke] TIMEOUT after ${timeoutMs} ms\n`
      if (WIN) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
      else child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', e => { out += `\n[smoke] spawn error: ${e.message}\n` })
    child.on('close', code => {
      clearTimeout(timer)
      if (log) fs.writeFileSync(path.join(OUT, log), out)
      resolve({ code, out, ms: Date.now() - started })
    })
  })
}
// npm/npx are .cmd shims on Windows, which Node only runs through a shell.
const quote = a => (/[\s"&|<>^]/.test(a) ? `"${a}"` : a)
const npmRun = (tool, args, o) => WIN ? run([`${tool}.cmd`, ...args.map(quote)].join(' '), [], { ...o, shell: true }) : run(tool, args, o)

async function main() {
  const sizes = { launcher: fs.statSync(LAUNCHER).size, platform: fs.statSync(PLATFORM).size }
  result.tarballs = { launcher: path.basename(LAUNCHER), platform: path.basename(PLATFORM), bytes: sizes }
  check('launcher tarball <= 1 MB', sizes.launcher <= 1e6, `${(sizes.launcher / 1e6).toFixed(2)} MB`)

  const inst = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-pkg-'))
  fs.writeFileSync(path.join(inst, 'package.json'), JSON.stringify({ name: 'petpack-pkg-smoke', private: true }))
  const env = { ...process.env, PETPACK_USER_DATA: path.join(inst, 'user-data'), PETPACK_CACHE: path.join(inst, 'cache') }
  const install = await npmRun('npm', ['install', '--no-audit', '--no-fund', LAUNCHER, PLATFORM], { cwd: inst, log: 'npm-install.log', env })
  result.timings.npmInstallMs = install.ms
  check('npm install launcher + platform', install.code === 0, `exit ${install.code} in ${install.ms} ms`)
  if (install.code !== 0) return
  const nm = path.join(inst, 'node_modules')
  const installed = fs.readdirSync(nm).flatMap(n => n.startsWith('@') ? fs.readdirSync(path.join(nm, n)).map(s => `${n}/${s}`) : [n])
  result.installed = installed
  check('no electron package installed', !installed.includes('electron'), installed.join(', '))

  const bin = path.join(nm, '@qwntllabs', 'petpack', 'bin', 'petpack.js')
  const rt = await run(process.execPath, [bin, 'runtime'], { cwd: inst, log: 'runtime.log', env })
  const runtimePath = rt.out.trim().split(/\r?\n/).pop()
  result.timings.runtimeMs = rt.ms
  result.runtimePath = runtimePath
  const fromPackage = runtimePath.includes(`petpack-${process.platform}-${process.arch}`) || runtimePath.startsWith(env.PETPACK_CACHE)
  check('runtime resolves to the platform package', rt.code === 0 && fromPackage && fs.existsSync(runtimePath),
    `exit ${rt.code} in ${rt.ms} ms: ${runtimePath}`)

  try {
    if (MAC) {
      const app = runtimePath.replace(/\/Contents\/MacOS\/.*$/, '')
      const x = spawnSync('xattr', ['-lr', app], { encoding: 'utf8' })
      const q = (x.stdout || '').split('\n').filter(l => l.includes('com.apple.quarantine'))
      check('no quarantine xattr on Electron.app', q.length === 0, `${q.length} entries`)
      const v = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
      const d = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' })
      const s = spawnSync('spctl', ['-a', '-vv', '-t', 'exec', app], { encoding: 'utf8' })
      result.signature = { verifyExit: v.status, verify: (v.stderr || '').trim(), info: (d.stderr || '').trim().split('\n').filter(l => /Authority|TeamIdentifier|Identifier=/.test(l)), spctlExit: s.status, spctl: (s.stderr || '').trim() }
      // Electron's release is ad-hoc signed by the linker (no Developer ID, not notarized): recorded, not a gate.
      console.log(`info Electron.app signature: ${JSON.stringify(result.signature)}`)
    } else if (WIN) {
      const ps = c => spawnSync('powershell', ['-NoProfile', '-Command', c], { encoding: 'utf8' }).stdout || ''
      const streams = ps(`Get-Item -LiteralPath '${runtimePath}' -Stream * | Select-Object -ExpandProperty Stream`).split(/\r?\n/).filter(Boolean)
      check('no Mark-of-the-Web on electron.exe', !streams.includes('Zone.Identifier'), streams.join(','))
      result.signature = ps(`$s = Get-AuthenticodeSignature -LiteralPath '${runtimePath}'; "$($s.Status) | $($s.SignerCertificate.Subject)"`).trim()
      console.log(`info electron.exe Authenticode: ${result.signature}`)
    }
  } catch (e) { result.signatureError = e.message }
  save()

  const smokeDir = path.join(OUT, 'pane')
  const pane = await npmRun('npx', ['--no-install', 'petpack', '--demo', '--smoke', smokeDir, '--smoke-wait', '8'], { cwd: inst, log: 'pane.log', env, timeoutMs: 120000 })
  result.timings.paneMs = pane.ms
  let smoke = null
  try { smoke = JSON.parse(fs.readFileSync(path.join(smokeDir, 'smoke.json'), 'utf8')) } catch {}
  const used = (pane.out.match(/petpack: runtime (.+)/) || [])[1] || ''
  result.pane = { exit: pane.code, runtimeLine: used, ok: smoke?.ok, electron: smoke?.electron, drew: smoke?.drew }
  check('npx petpack --demo --smoke exits 0', pane.code === 0 && smoke?.ok === true, `exit ${pane.code} in ${pane.ms} ms, smoke.ok ${smoke?.ok}, Electron ${smoke?.electron}`)
  check('pane ran on the platform runtime', used.startsWith(`@qwntllabs/petpack-${process.platform}-${process.arch}`), used)
  check('still no electron download', !fs.existsSync(path.join(nm, 'electron')), fs.existsSync(path.join(nm, 'electron')) ? 'node_modules/electron appeared' : 'none')
}

main()
  .catch(e => check('driver', false, e.stack || e.message))
  .finally(() => {
    result.totalMs = Date.now() - t0
    result.ok = Object.values(result.checks).every(c => c.pass)
    save()
    console.log(`${result.ok ? 'OK' : 'FAILED'} in ${result.totalMs} ms -> ${path.join(OUT, 'result.json')}`)
    process.exit(result.ok ? 0 : 1)
  })
