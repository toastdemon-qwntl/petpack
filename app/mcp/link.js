// The overlay's view of its Codex link: registered in Codex's config, and which Codex sessions are connected now.
//
// Main process (S1):
//   const link = createCodexLink({ userData: USER_DATA, onEvent: (ev) => agentCall('codex_link', ev).catch(() => {}) })
//   startIpcServer({ onCall, onClient: link.onClient, ... })
//   link.state() -> { status: 'unregistered'|'registered'|'connected', sessions, lastSeen, client, configs }
//
// Events for the brain (once per launch each):
//   { type: 'hint', text: 'restart Codex to connect me' }  no Codex session has connected `hintAfterMs` after start
//   { type: 'connected', text: 'Codex connected', client }  the first Codex session connects (dismisses the hint)
// `codex-link.json` in userData keeps the last connection for `petpack doctor`.

import fs from 'node:fs'
import path from 'node:path'
import { registrationStatus } from './register.js'

export const LINK_FILE = 'codex-link.json'
export const HINT_TEXT = 'restart Codex to connect me'
export const CONNECTED_TEXT = 'Codex connected'

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

const isCodex = (c) => c && c.kind === 'codex-mcp'
const summary = (c) => ({ app: c.app || 'codex', name: c.name || null, version: c.version || null, pid: c.pid || null })

export function createCodexLink({ userData, onEvent = () => {}, onChange = () => {}, hintAfterMs = 12000, targets } = {}) {
  const file = userData ? path.join(userData, LINK_FILE) : null
  const saved = (file && readJson(file)) || {}
  const sessions = new Map()
  let lastSeen = saved.lastSeen || null
  let lastClient = saved.client || null
  let connectedOnce = false
  let hinted = false
  let saveTimer = null

  const emit = (ev) => { try { onEvent(ev) } catch {} }
  const save = () => {
    if (!file || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try { fs.writeFileSync(file, JSON.stringify({ lastSeen, client: lastClient }, null, 2)) } catch {}
    }, 200)
    saveTimer.unref?.()
  }

  const hintTimer = setTimeout(() => {
    if (connectedOnce || sessions.size) return
    hinted = true
    emit({ type: 'hint', text: HINT_TEXT })
  }, hintAfterMs)
  hintTimer.unref?.()

  function state() {
    const configs = registrationStatus({ userData, targets })
    const registered = configs.some((c) => c.status === 'registered')
    return {
      status: sessions.size ? 'connected' : registered ? 'registered' : 'unregistered',
      sessions: sessions.size,
      lastSeen,
      client: lastClient,
      configs,
    }
  }

  function onClient(event, client) {
    if (!isCodex(client)) return
    lastSeen = new Date().toISOString()
    if (event === 'connect') {
      sessions.set(client.conn, client)
      lastClient = summary(client)
      if (!connectedOnce) {
        connectedOnce = true
        clearTimeout(hintTimer)
        emit({ type: 'connected', text: CONNECTED_TEXT, client: lastClient, dismissHint: hinted })
      }
    } else if (event === 'disconnect') {
      sessions.delete(client.conn)
    }
    save()
    if (event !== 'call') { try { onChange(state()) } catch {} }
  }

  return {
    onClient,
    state,
    close() { clearTimeout(hintTimer); clearTimeout(saveTimer) },
  }
}

/** The last connection petpack's overlay recorded (for doctor), or null. */
export function lastCodexConnection(userData) {
  return readJson(path.join(userData, LINK_FILE))
}
