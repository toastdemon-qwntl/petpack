// The tray popover's bridge (TRAY lane): `window.panel`. Sandboxed, so CommonJS.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('panel', {
  call: (cmd, arg) => ipcRenderer.invoke('petpack:panel', cmd, arg),
  on (cb) {
    if (typeof cb !== 'function') return () => {}
    const h = (_event, msg) => cb(msg)
    ipcRenderer.on('petpack:panel-push', h)
    return () => ipcRenderer.removeListener('petpack:panel-push', h)
  },
})
