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
})
