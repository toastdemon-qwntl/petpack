// Relay client (Protocol v2, shared/protocol.js): one WebSocket, JSON text frames, reconnect with
// 1-2-4-8-15 s backoff plus jitter, and a silent solo fallback when no welcome arrives within 3 s.
export const DEFAULT_RELAY = 'wss://petpack-relay.azurewebsites.net/ws'
const BACKOFF = [1, 2, 4, 8, 15]

export function createNet({
  url = DEFAULT_RELAY,
  hello, // () => hello frame, rebuilt on every (re)connect so it carries the last seat
  onMessage = () => {},
  onStatus = () => {}, // 'connecting' | 'online' | 'solo' | 'offline'
  WebSocketImpl = globalThis.WebSocket,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
  random = Math.random,
  soloAfterMs = 3000,
} = {}) {
  let socket = null
  let attempt = 0
  let retryTimer = null
  let soloTimer = null
  let closed = false
  let welcomed = false
  let status = 'idle'
  const setStatus = next => { if (next !== status) { status = next; try { onStatus(next) } catch (error) { console.warn('petpack net status', error) } } }

  function connect() {
    if (closed || !url || typeof WebSocketImpl !== 'function') { setStatus('solo'); return }
    clearTimer(retryTimer); retryTimer = null
    welcomed = false
    setStatus(status === 'idle' ? 'connecting' : status)
    if (soloTimer == null && status !== 'online') soloTimer = setTimer(() => { soloTimer = null; if (!welcomed) setStatus('solo') }, soloAfterMs)
    let ws
    try { ws = new WebSocketImpl(url) } catch { scheduleRetry(); return }
    socket = ws
    ws.onopen = () => {
      if (socket !== ws) return
      try { ws.send(JSON.stringify(hello ? hello() : { t: 'hello', v: 2 })) } catch { /* the close handler retries */ }
    }
    ws.onmessage = event => {
      if (socket !== ws) return
      let msg
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
      if (msg?.t === 'welcome') {
        welcomed = true
        attempt = 0
        if (soloTimer != null) { clearTimer(soloTimer); soloTimer = null }
        setStatus('online')
      }
      try { onMessage(msg) } catch (error) { console.warn('petpack net message', msg?.t, error) }
    }
    ws.onerror = () => { /* onclose follows; stay quiet (no error UI) */ }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      if (closed) return
      if (status === 'online') setStatus('offline')
      scheduleRetry()
    }
  }
  function scheduleRetry() {
    if (closed || retryTimer) return
    const base = BACKOFF[Math.min(attempt, BACKOFF.length - 1)]
    attempt++
    const delay = base * 1000 * (0.75 + random() * 0.5)
    if (soloTimer == null && status !== 'solo') soloTimer = setTimer(() => { soloTimer = null; if (!welcomed) setStatus('solo') }, soloAfterMs)
    retryTimer = setTimer(() => { retryTimer = null; connect() }, delay)
  }
  function send(msg) {
    if (!socket || socket.readyState !== 1 || !welcomed) return false
    try { socket.send(JSON.stringify(msg)); return true } catch { return false }
  }
  function close() {
    closed = true
    clearTimer(retryTimer); clearTimer(soloTimer)
    const ws = socket
    socket = null
    try { ws?.close() } catch { /* already closed */ }
  }
  return {
    connect, send, close,
    get status() { return status },
    get connected() { return welcomed && socket?.readyState === 1 },
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
