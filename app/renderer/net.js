// Owner L2. Same code as L1's server/net-failover.js (tested there by relay.test.js and failover-smoke.js).
// Relay client (Protocol v2, shared/protocol.js): one WebSocket, JSON text frames, relay failover in RELAYS order,
// reconnect with 1-2-4-8-15 s backoff plus jitter, and a silent solo fallback when no welcome arrives within 3 s.
// Failover rule (same on every laptop, so they land on the same relay; rooms are per relay):
//   each round starts at urls[0]; a connect that doesn't reach welcome within openTimeoutMs, or closes first, moves
//   straight on to the next relay; after the last one the round backs off and starts again at urls[0]. While on a
//   later relay, urls[0]/healthz is probed every probeMs and the client moves back as soon as it answers 200.
import { RELAYS, OPEN_TIMEOUT_MS, PRIMARY_PROBE_MS, CLOSE, healthUrl } from '../../shared/protocol.js'

export const DEFAULT_RELAY = RELAYS[0]
const BACKOFF = [1, 2, 4, 8, 15]

export function createNet({
  url = null, // a single relay (PETPACK_RELAY / --relay); otherwise `urls`
  urls = url ? [url] : RELAYS,
  hello, // () => hello frame, rebuilt on every (re)connect so it carries the last seat
  onMessage = () => {},
  onStatus = () => {}, // 'connecting' | 'online' | 'solo' | 'offline' | 'replaced' (another pane took this id over; stopped)
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
  random = Math.random,
  soloAfterMs = 3000,
  openTimeoutMs = OPEN_TIMEOUT_MS,
  probeMs = PRIMARY_PROBE_MS,
} = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean)
  let socket = null
  let index = 0 // relay being tried / used
  let attempt = 0 // failed rounds in a row
  let retryTimer = null
  let soloTimer = null
  let openTimer = null
  let probeTimer = null
  let closed = false
  let welcomed = false
  let status = 'idle'
  const setStatus = next => { if (next !== status) { status = next; try { onStatus(next) } catch (error) { console.warn('petpack net status', error) } } }
  const armSolo = () => { if (soloTimer == null && status !== 'solo' && status !== 'online') soloTimer = setTimer(() => { soloTimer = null; if (!welcomed) setStatus('solo') }, soloAfterMs) }

  function connect() {
    if (closed || !list.length || typeof WebSocketImpl !== 'function') { setStatus('solo'); return }
    clearTimer(retryTimer); retryTimer = null
    welcomed = false
    setStatus(status === 'idle' ? 'connecting' : status)
    armSolo()
    let ws
    try { ws = new WebSocketImpl(list[index]) } catch { failed(null); return }
    socket = ws
    clearTimer(openTimer)
    openTimer = setTimer(() => { openTimer = null; if (socket === ws && !welcomed) { socket = null; try { ws.close() } catch {} ; failed(ws) } }, openTimeoutMs)
    ws.onopen = () => {
      if (socket !== ws) return
      try { ws.send(JSON.stringify(hello ? hello() : { t: 'hello', v: 2 })) } catch { /* the close handler moves on */ }
    }
    ws.onmessage = event => {
      if (socket !== ws) return
      let msg
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
      if (msg?.t === 'welcome') {
        welcomed = true
        attempt = 0
        clearTimer(openTimer); openTimer = null
        if (soloTimer != null) { clearTimer(soloTimer); soloTimer = null }
        setStatus('online')
        if (index > 0) startProbe()
      }
      try { onMessage(msg) } catch (error) { console.warn('petpack net message', msg?.t, error) }
    }
    ws.onerror = () => { /* onclose follows; stay quiet (no error UI) */ }
    ws.onclose = (event) => {
      if (socket !== ws) return
      socket = null
      clearTimer(openTimer); openTimer = null
      stopProbe()
      if (event?.code === CLOSE.replaced) {
        // another pane or overlay with this id took the agent over: this one stops for good (no reconnect fight)
        closed = true; welcomed = false
        clearTimer(retryTimer); clearTimer(soloTimer)
        setStatus('replaced')
        return
      }
      if (closed) return
      if (welcomed) {
        // an established connection dropped: start a new round at the primary after a short pause
        welcomed = false
        if (status === 'online') setStatus('offline')
        index = 0
        schedule(BACKOFF[0])
      } else failed(ws)
    }
  }

  function failed() {
    if (closed) return
    if (index + 1 < list.length) { index++; connect(); return } // next relay right away
    index = 0
    schedule(BACKOFF[Math.min(attempt, BACKOFF.length - 1)])
    attempt++
  }

  function schedule(seconds) {
    if (closed || retryTimer) return
    armSolo()
    retryTimer = setTimer(() => { retryTimer = null; connect() }, seconds * 1000 * (0.75 + random() * 0.5))
  }

  function startProbe() {
    stopProbe()
    const target = healthUrl(list[0])
    if (!target || typeof fetchImpl !== 'function') return
    probeTimer = setTimer(async function probe() {
      probeTimer = null
      if (closed || index === 0 || !welcomed) return
      let ok = false
      try { ok = (await fetchImpl(target, { cache: 'no-store' })).ok } catch { ok = false }
      if (closed || index === 0 || !welcomed) return
      if (!ok) { probeTimer = setTimer(probe, probeMs); return }
      // primary is back: everyone moves home on the same rule
      const ws = socket
      socket = null
      welcomed = false
      index = 0
      try { ws?.close(1000, 'primary back') } catch {}
      setStatus('offline')
      connect()
    }, probeMs)
  }
  function stopProbe() { if (probeTimer != null) { clearTimer(probeTimer); probeTimer = null } }

  function send(msg) {
    if (!socket || socket.readyState !== 1 || !welcomed) return false
    try { socket.send(JSON.stringify(msg)); return true } catch { return false }
  }
  function close() {
    closed = true
    clearTimer(retryTimer); clearTimer(soloTimer); clearTimer(openTimer); stopProbe()
    const ws = socket
    socket = null
    try { ws?.close() } catch { /* already closed */ }
  }
  return {
    connect, send, close,
    get status() { return status },
    get connected() { return welcomed && socket?.readyState === 1 },
    get url() { return list[index] },
    get index() { return index },
  }
}

/** Relay-hosted sprite paths come back relative; resolve them against the relay origin. */
export function relayAsset(relayUrl, path) {
  if (!path || typeof path !== 'string') return null
  if (/^(https?:|data:|blob:)/.test(path)) return path
  try {
    const base = new URL(relayUrl)
    base.protocol = base.protocol === 'wss:' ? 'https:' : 'http:'
    return new URL(path, base).href
  } catch { return null }
}
