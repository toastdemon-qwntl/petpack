// petpack local IPC: the running overlay (Electron main) <-> `npx petpack mcp` processes.
//
// Transport: Node `net` over a Unix socket (macOS/Linux) or a named pipe (Windows). Frames are newline-delimited
// JSON. The overlay writes `<userData>/ipc.json` (mode 0600) = { endpoint, token, pid, version, startedAt }. A client
// must send { t:'hello', token } first; anything else, or a wrong token, gets { t:'denied' } and the socket closes.
//
//   C -> S  { t:'hello', token }                 S -> C  { t:'welcome', pid, version } | { t:'denied', error }
//   C -> S  { t:'call', id, tool, args }         S -> C  { t:'result', id, ok:true, result } | { t:'result', id, ok:false, error }
//   C -> S  { t:'ping', id }                     S -> C  { t:'pong', id }
//
// Main process (S1):   const ipc = await startIpcServer({ onCall: ({ id, tool, args }) => askRenderer(...), profile })
//                      ...on quit: await ipc.close()
// MCP process:         const c = await connectIpc({ profile }); await c.call('petpack_status', {})
//
// No dependencies. Plain Node >= 22.

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const IPC_VERSION = 1
const MAX_FRAME = 8 * 1024 * 1024

function cleanProfile(profile) {
  const p = String(profile || process.env.PETPACK_PROFILE || 'default')
  const safe = p.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 24)
  return safe || 'default'
}

/**
 * The overlay's Electron `userData` folder, computed without Electron.
 * Default profile: `app.getPath('userData')` for an app named `petpack`
 *   macOS `~/Library/Application Support/petpack`, Windows `%APPDATA%\petpack`, Linux `$XDG_CONFIG_HOME|~/.config/petpack`.
 * `--profile p` (p != default): the sibling folder `petpack-p`. S1 should `app.setPath('userData', userDataDir(p))`.
 * `PETPACK_USER_DATA` overrides everything (tests, CI).
 */
export function userDataDir(profile) {
  if (process.env.PETPACK_USER_DATA) return path.resolve(process.env.PETPACK_USER_DATA)
  const home = os.homedir()
  let appData
  if (process.platform === 'darwin') appData = path.join(home, 'Library', 'Application Support')
  else if (process.platform === 'win32') appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  else appData = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  const p = cleanProfile(profile)
  return path.join(appData, p === 'default' ? 'petpack' : `petpack-${p}`)
}

export function ipcInfoPath(userData) {
  return path.join(userData, 'ipc.json')
}

function userHash() {
  let name = ''
  try { name = os.userInfo().username } catch { name = process.env.USER || process.env.USERNAME || '' }
  return crypto.createHash('sha256').update(`${name}|${os.homedir()}`).digest('hex').slice(0, 8)
}

/** Socket path (macOS/Linux, per-user tmpdir, well under the 104-byte limit) or named pipe (Windows). */
export function endpointFor(profile) {
  const p = cleanProfile(profile)
  if (process.platform === 'win32') return `\\\\.\\pipe\\petpack-${userHash()}-${p}`
  return path.join(os.tmpdir(), `petpack-${userHash()}-${p}.sock`)
}

export function readIpcInfo(userData) {
  try {
    const info = JSON.parse(fs.readFileSync(ipcInfoPath(userData), 'utf8'))
    if (info && typeof info.endpoint === 'string' && typeof info.token === 'string') return info
  } catch {}
  return null
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function writeFileAtomic600(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  try { fs.chmodSync(tmp, 0o600) } catch {}
  fs.renameSync(tmp, file)
}

/** Line splitter for a socket: calls onFrame(obj) per JSON line; closes on oversize/garbage. */
function frames(sock, onFrame) {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    if (buf.length > MAX_FRAME) { sock.destroy(); return }
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { sock.destroy(); return }
      onFrame(msg)
    }
  })
}

function send(sock, obj) {
  if (!sock.destroyed && sock.writable) sock.write(JSON.stringify(obj) + '\n')
}

function tokenOk(given, token) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Connect once to an endpoint; resolves the socket, rejects with the net error (ENOENT/ECONNREFUSED/...). */
function dial(endpoint, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint)
    const t = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })) }, timeoutMs)
    sock.once('connect', () => { clearTimeout(t); resolve(sock) })
    sock.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

/** Is something live listening at this endpoint? */
async function endpointLive(endpoint) {
  try { const s = await dial(endpoint, 800); s.destroy(); return true } catch { return false }
}

/**
 * Overlay side. Listens on the per-user endpoint, writes ipc.json (0600), answers authenticated calls with onCall.
 * onCall({ id, tool, args }) -> result (or Promise). Throwing/rejecting sends { ok:false, error: message }.
 * A stale socket (left by a crashed overlay) is removed; a live one means another overlay owns it -> throws EADDRINUSE.
 */
export async function startIpcServer({ onCall, profile, userData, endpoint, version = '0', log = () => {} } = {}) {
  if (typeof onCall !== 'function') throw new TypeError('startIpcServer: onCall is required')
  userData = userData || userDataDir(profile)
  endpoint = endpoint || endpointFor(profile)
  const token = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(userData, { recursive: true })

  const sockets = new Set()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    let authed = false
    const authTimer = setTimeout(() => { if (!authed) { send(sock, { t: 'denied', error: 'hello required' }); sock.end() } }, 5000)
    authTimer.unref()
    sock.on('close', () => { sockets.delete(sock); clearTimeout(authTimer) })
    sock.on('error', () => {})
    frames(sock, async (msg) => {
      if (!authed) {
        if (msg && msg.t === 'hello' && tokenOk(msg.token, token)) {
          authed = true
          clearTimeout(authTimer)
          send(sock, { t: 'welcome', pid: process.pid, version })
        } else {
          clearTimeout(authTimer)
          send(sock, { t: 'denied', error: 'bad token' })
          sock.end()
          setTimeout(() => sock.destroy(), 200).unref()
        }
        return
      }
      if (msg.t === 'ping') { send(sock, { t: 'pong', id: msg.id }); return }
      if (msg.t !== 'call') return
      const { id, tool, args } = msg
      try {
        const result = await onCall({ id, tool: String(tool), args: args && typeof args === 'object' ? args : {} })
        send(sock, { t: 'result', id, ok: true, result: result === undefined ? null : result })
      } catch (e) {
        send(sock, { t: 'result', id, ok: false, error: String((e && e.message) || e) })
      }
    })
  })

  const listen = () => new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e) }
    const onOk = () => { server.off('error', onErr); resolve() }
    server.once('error', onErr)
    server.once('listening', onOk)
    server.listen(endpoint)
  })

  try {
    await listen()
  } catch (e) {
    if (e.code !== 'EADDRINUSE' || process.platform === 'win32') throw e
    if (await endpointLive(endpoint)) throw e // a live overlay owns it
    log(`petpack ipc: removing stale socket ${endpoint}`)
    try { fs.unlinkSync(endpoint) } catch {}
    await listen()
  }
  if (process.platform !== 'win32') { try { fs.chmodSync(endpoint, 0o600) } catch {} }

  const info = { endpoint, token, pid: process.pid, version, ipc: IPC_VERSION, startedAt: new Date().toISOString() }
  writeFileAtomic600(ipcInfoPath(userData), JSON.stringify(info, null, 2))
  log(`petpack ipc: listening on ${endpoint}`)

  let closed = false
  return {
    endpoint,
    token,
    userData,
    async close() {
      if (closed) return
      closed = true
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(() => r()))
      const cur = readIpcInfo(userData)
      if (cur && cur.token === token) { try { fs.unlinkSync(ipcInfoPath(userData)) } catch {} }
    },
  }
}

/**
 * MCP side. Reads ipc.json, connects and authenticates. Rejects with err.code:
 *   'ENOOVERLAY' no ipc.json / overlay not running (stale file or dead socket), 'EDENIED' token refused.
 * Returns { call(tool, args, { timeoutMs }), close(), onClose(cb), info }.
 */
export async function connectIpc({ profile, userData } = {}) {
  userData = userData || userDataDir(profile)
  const info = readIpcInfo(userData)
  if (!info) throw Object.assign(new Error('petpack is not running'), { code: 'ENOOVERLAY' })
  let sock
  try {
    sock = await dial(info.endpoint)
  } catch (e) {
    throw Object.assign(new Error(`petpack is not running (${e.code || e.message})`), { code: 'ENOOVERLAY', cause: e })
  }
  const pending = new Map()
  const closeCbs = []
  let seq = 0
  let isClosed = false
  let welcomed
  const welcome = new Promise((res, rej) => { welcomed = { res, rej } })

  const finish = (err) => {
    if (isClosed) return
    isClosed = true
    welcomed.rej(err)
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err) }
    pending.clear()
    for (const cb of closeCbs) { try { cb(err) } catch {} }
  }

  sock.on('error', (e) => finish(Object.assign(new Error(`petpack connection lost (${e.code || e.message})`), { code: 'ECLOSED' })))
  sock.on('close', () => finish(Object.assign(new Error('petpack connection closed'), { code: 'ECLOSED' })))
  frames(sock, (msg) => {
    if (msg.t === 'welcome') welcomed.res(msg)
    else if (msg.t === 'denied') { finish(Object.assign(new Error(`petpack refused the connection: ${msg.error}`), { code: 'EDENIED' })); sock.destroy() }
    else if (msg.t === 'result' || msg.t === 'pong') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.t === 'pong' || msg.ok) p.resolve(msg.result ?? null)
      else p.reject(Object.assign(new Error(msg.error || 'call failed'), { code: 'ECALL' }))
    }
  })
  send(sock, { t: 'hello', token: info.token })
  const helloTimer = setTimeout(() => finish(Object.assign(new Error('petpack did not answer hello'), { code: 'ENOOVERLAY' })), 3000)
  try { await welcome } finally { clearTimeout(helloTimer) }

  const request = (frame, timeoutMs) => new Promise((resolve, reject) => {
    if (isClosed) { reject(Object.assign(new Error('petpack connection closed'), { code: 'ECLOSED' })); return }
    const id = `${process.pid}-${++seq}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(Object.assign(new Error(`petpack did not answer within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    send(sock, { ...frame, id })
  })

  return {
    info,
    get closed() { return isClosed },
    call: (tool, args = {}, { timeoutMs = 20000 } = {}) => request({ t: 'call', tool, args }, timeoutMs),
    ping: (timeoutMs = 2000) => request({ t: 'ping' }, timeoutMs),
    onClose(cb) { closeCbs.push(cb) },
    close() { sock.end(); sock.destroy(); finish(Object.assign(new Error('closed'), { code: 'ECLOSED' })) },
  }
}
