// The bridge: exactly `window.petpack` (CONTRACT + build B6 + backend bridge additions). Sandboxed, so CommonJS.
const { contextBridge, ipcRenderer } = require('electron')

const config = Object.freeze(ipcRenderer.sendSync('petpack:config') || {})
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

// Agent calls (MCP -> main -> here -> the page's handler -> back). Calls that arrive before the page registers wait.
let agentHandler = null
const queued = []
async function runAgentCall({ id, tool, args }) {
  try {
    const result = await agentHandler({ id, tool, args })
    ipcRenderer.send('petpack:agent-result', { id, ok: true, result })
  } catch (error) {
    ipcRenderer.send('petpack:agent-result', { id, ok: false, error: String(error?.message || error) })
  }
}
ipcRenderer.on('petpack:agent-call', (_event, request) => {
  if (agentHandler) runAgentCall(request)
  else queued.push(request)
})

// Cursor-poll fallback for flaky mouse forwarding (build B3): main tells us where the cursor is over the pane.
let hovering = false
ipcRenderer.on('petpack:cursor', (_event, c) => {
  if (!c.inside) {
    if (!hovering) return
    hovering = false
    const leave = { bubbles: false, clientX: -1, clientY: -1 }
    document.documentElement.dispatchEvent(new MouseEvent('mouseleave', leave))
    document.dispatchEvent(new MouseEvent('mousemove', { ...leave, bubbles: true }))
    return
  }
  hovering = true
  const target = document.elementFromPoint(c.x, c.y) || document.documentElement
  const init = { bubbles: true, cancelable: true, composed: true, clientX: c.x, clientY: c.y,
    screenX: c.screenX, screenY: c.screenY }
  target.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerType: 'mouse', isPrimary: true }))
  target.dispatchEvent(new MouseEvent('mousemove', init))
})

contextBridge.exposeInMainWorld('petpack', {
  config,
  getMe: () => call('petpack:getMe'),
  listPets: () => call('petpack:listPets'),
  onMeChanged(cb) {
    if (typeof cb !== 'function') return () => {}
    const h = () => cb()
    ipcRenderer.on('petpack:me-changed', h)
    return () => ipcRenderer.removeListener('petpack:me-changed', h)
  },
  onStatus(cb) {
    if (typeof cb !== 'function') return () => {}
    const listener = (_event, status) => cb(status)
    ipcRenderer.on('petpack:status', listener)
    call('petpack:status').then(status => { if (status) cb(status) }).catch(() => {})
    return () => ipcRenderer.removeListener('petpack:status', listener)
  },
  packSkill: id => call('petpack:packSkill', id),
  installSkill: (pkg, fromName) => call('petpack:installSkill', pkg, fromName),
  installItem: (item, fromName) => call('petpack:installItem', item, fromName),
  getCatalog: () => call('petpack:getCatalog'),
  catalog: () => call('petpack:getCatalog'),
  readItem: (ref, as) => call('petpack:readItem', ref, as),
  answerAsk: request => call('petpack:answerAsk', request),
  savePhoto: dataUrl => call('petpack:savePhoto', dataUrl),
  // L3b: our stuck Codex session's need (or null), the sharing list and settings.json `share`.
  currentNeed: () => call('petpack:currentNeed'),
  // L3a: Codex's live task ({ title, status, ... } | null) and its transitions ({ type, title, at }).
  currentTask: () => call('petpack:currentTask'),
  setFace: pngDataUrl => ipcRenderer.send('petpack:face', String(pngDataUrl || '')),
  // L3b: a lesson from the Codex session that last finished (or the one given).
  lessonFromSession: session => call('petpack:lessonFromSession', session),
  // Live in Codex: a share request asked in the Codex app; a teammate's question opened as a new Codex thread.
  elicitShare: request => call('petpack:elicitShare', request),
  askInCodex: request => call('petpack:askInCodex', request),
  // S5 live progress: the brain's step ({ callId, text }) back to the MCP call that asked.
  agentStep: step => ipcRenderer.send('petpack:agent-step', step && typeof step === 'object' ? step : {}),
  onCodexEvent(cb) {
    if (typeof cb !== 'function') return () => {}
    const h = (_e, ev) => cb(ev)
    ipcRenderer.on('petpack:codex-event', h)
    return () => ipcRenderer.removeListener('petpack:codex-event', h)
  },
  listShareable: () => call('petpack:listShareable'),
  shareSettings: () => call('petpack:shareSettings'),
  setShare: patch => call('petpack:setShare', patch),
  // CHAT lane (app/chat-main.js): ask your pet in text (codex exec) or out loud (OpenAI Realtime, main does the SDP).
  chat: {
    ask: request => call('petpack:chat-ask', request),
    reset: () => call('petpack:chat-reset'),
    onEvent(cb) {
      if (typeof cb !== 'function') return () => {}
      const h = (_e, ev) => cb(ev)
      ipcRenderer.on('petpack:chat-event', h)
      return () => ipcRenderer.removeListener('petpack:chat-event', h)
    },
  },
  voice: {
    prepare: () => call('petpack:voice-prepare'),
    connect: (sdp, opts) => call('petpack:voice-connect', sdp, opts),
  },
  // TRAY popover (app/panel.js): the page reports state and activity lines; the popover sends commands.
  panelReport: report => ipcRenderer.send('petpack:panel-report', report),
  activity: line => ipcRenderer.send('petpack:activity', line),
  askShare: request => call('petpack:ask-share', request),
  onPanelCommand(cb) {
    if (typeof cb !== 'function') return () => {}
    const h = (_e, msg) => cb(msg)
    ipcRenderer.on('petpack:panel-command', h)
    return () => ipcRenderer.removeListener('petpack:panel-command', h)
  },
  // Window collapse (COLLAPSE lane, app/window.js): commands in, window events out.
  window: (cmd, arg) => ipcRenderer.invoke('petpack:window', cmd, arg),
  onWindow: cb => {
    if (typeof cb !== 'function') return () => {}
    const h = (_e, ev) => cb(ev)
    ipcRenderer.on('petpack:window-event', h)
    return () => ipcRenderer.removeListener('petpack:window-event', h)
  },
  onAgentCall(handler) {
    agentHandler = typeof handler === 'function' ? handler : null
    if (agentHandler) {
      ipcRenderer.send('petpack:agent-ready', true)
      for (const request of queued.splice(0)) runAgentCall(request)
    }
    return () => {
      if (agentHandler === handler) { agentHandler = null; ipcRenderer.send('petpack:agent-ready', false) }
    }
  },
  setInteractive: on => ipcRenderer.send('petpack:interactive', Boolean(on)),
  // Right-click menu: [{ id, label, checked?, enabled? } | { type: 'separator' } | { label, submenu }] -> { id, handled } | null
  contextMenu: items => ipcRenderer.invoke('petpack:context-menu', items),
})
