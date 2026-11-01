// The pane is the window (build R3-1/R3-2): a fixed 416x312 DIP frameless, transparent window docked flush to the
// left or right edge of the primary display's work area, 20 % down, always on top, click-through over empty glass.
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export const PANE = Object.freeze({ width: 416, height: 312 })
const HANG = 2 // DIP past the screen edge, so fractional scaling never leaves a 1 px gap
const IS_MAC = process.platform === 'darwin'
const IS_WIN = process.platform === 'win32'

export function paneSize(scale = 1) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  return { width: Math.round(PANE.width * s), height: Math.round(PANE.height * s) }
}

/** Where the pane goes on `display` (defaults to the primary display). */
export function dockBounds({ display = screen.getPrimaryDisplay(), dock = 'right', align = 0, top = 0.2, scale = 1 } = {}) {
  const { width, height } = paneSize(scale)
  const wa = display.workArea
  const b = display.bounds
  const x = dock === 'left' ? wa.x - HANG : wa.x + wa.width - width + HANG
  const want = Math.round(b.y + b.height * top + (Number(align) || 0))
  const y = Math.max(wa.y, Math.min(want, wa.y + wa.height - height))
  return { x, y, width, height }
}

/** ≤ 0 means flush (or hanging past) on the docked side. */
export function edgeGap(bounds, workArea, dock) {
  return dock === 'left' ? bounds.x - workArea.x : (workArea.x + workArea.width) - (bounds.x + bounds.width)
}

export function createPaneWindow({ preload, scale = 1, vibrancy = false, debug = false } = {}) {
  const { width, height } = paneSize(scale)
  const options = {
    width, height, useContentSize: true,
    show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: true, acceptFirstMouse: true,
    roundedCorners: false, thickFrame: false, hiddenInMissionControl: true,
    title: 'petpack',
    webPreferences: {
      preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      backgroundThrottling: false, spellcheck: false, devTools: debug,
    },
  }
  if (IS_MAC) {
    options.type = 'panel' // non-activating, floats over full-screen apps, on every Space
    if (vibrancy) Object.assign(options, { vibrancy: 'hud', visualEffectState: 'active' })
  } else if (IS_WIN) {
    options.type = 'toolbar' // out of Alt+Tab
  }
  const win = new BrowserWindow(options)
  raiseToTop(win)
  installCollapse(win)
  return win
}

// ---------------------------------------------------------------------------------------------------------------
// Collapse: the pane folds into a slim glass tab flush on the docked edge, same vertical centre. The page drives it
// over `petpack:window` (collapse | expand | toggle | state); main-side requests (tray) go to the page as
// `petpack:window-event` {type:'toggle'|'collapse'|'expand'} so the page can swap its DOM before the window shrinks.
// The person's choice (not auto-opens) is remembered per profile in userData/window.json.

export const TAB = Object.freeze({ width: 36, height: 120 })
const ANIM_MS = 250
const panes = new Map() // webContents.id -> collapse state
const stateOf = win => (win && !win.isDestroyed() ? panes.get(win.webContents.id) : null)
let ipcInstalled = false

function stateFile() {
  try { return path.join(app.getPath('userData'), 'window.json') } catch { return null }
}
function readRemembered() {
  const file = stateFile()
  try { return Boolean(file && JSON.parse(fs.readFileSync(file, 'utf8')).collapsed) } catch { return false }
}
function remember(collapsed) {
  const file = stateFile()
  if (!file) return
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ collapsed }, null, 2)}\n`) } catch (error) {
    console.error(`petpack: collapse state not saved (${error.message})`)
  }
}

/** The tab's bounds for a pane at `full` docked on `dock`: flush on that edge, same vertical centre. */
export function tabBounds(full, dock = 'right', scale = 1) {
  const s = Number.isFinite(scale) && scale > 0 ? Math.min(scale, 1.5) : 1
  const width = Math.round(TAB.width * s)
  const height = Math.round(TAB.height * s)
  const x = dock === 'left' ? full.x : full.x + full.width - width
  const y = Math.round(full.y + (full.height - height) / 2)
  return { x, y, width, height }
}

function inferDock(win) {
  const b = win.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  return b.x + b.width / 2 < wa.x + wa.width / 2 ? 'left' : 'right'
}

// Linux locks a non-resizable window's size via min = max constraints; unlock it around our own size changes.
function setBoundsFree(win, bounds) {
  if (win.isDestroyed()) return
  const lock = process.platform === 'linux' && !win.isResizable()
  if (lock) win.setResizable(true)
  win.setBounds(bounds)
  if (lock) win.setResizable(false)
}

const easeOut = t => 1 - (1 - t) ** 3
function animateBounds(win, st, to, ms = ANIM_MS) {
  clearInterval(st.timer)
  const from = win.getBounds()
  if (ms <= 0 || process.env.PETPACK_NO_ANIM) { setBoundsFree(win, to); return Promise.resolve(to) }
  const lock = process.platform === 'linux' && !win.isResizable()
  if (lock) win.setResizable(true)
  const start = Date.now()
  return new Promise(resolve => {
    const step = () => {
      if (win.isDestroyed()) { clearInterval(st.timer); resolve(to); return }
      const t = Math.min(1, (Date.now() - start) / ms)
      const k = easeOut(t)
      const lerp = (a, b) => Math.round(a + (b - a) * k)
      // Hold the docked edge still: grow/shrink from the inner side.
      win.setBounds({ x: lerp(from.x, to.x), y: lerp(from.y, to.y), width: lerp(from.width, to.width), height: lerp(from.height, to.height) })
      if (t >= 1) {
        clearInterval(st.timer); st.timer = null
        win.setBounds(to)
        if (lock) win.setResizable(false)
        resolve(to)
      }
    }
    st.timer = setInterval(step, 16)
    step()
  })
}

async function setCollapsed(win, collapsed, { dock, persist = true, animate = true } = {}) {
  const st = stateOf(win)
  if (!st) return { collapsed: false }
  if (dock === 'left' || dock === 'right') st.dock = dock
  if (!st.dock) st.dock = inferDock(win)
  if (persist) { st.remembered = collapsed; remember(collapsed) }
  if (collapsed === st.collapsed) return describe(win)
  if (collapsed) st.full = st.timer ? (st.full || win.getBounds()) : win.getBounds()
  st.collapsed = collapsed
  st.onChange?.()
  const to = collapsed ? tabBounds(st.full, st.dock, st.scale) : (st.full || win.getBounds())
  await animateBounds(win, st, to, animate ? ANIM_MS : 0)
  raiseToTop(win)
  if (process.env.PETPACK_LOG_WINDOW && !win.isDestroyed()) {
    console.log(`[petpack window] ${new Date().toISOString()} ${collapsed ? 'collapsed' : 'expanded'} ${JSON.stringify(win.getBounds())}`)
  }
  return describe(win)
}

function describe(win) {
  const st = stateOf(win)
  if (!st) return { collapsed: false }
  return { collapsed: st.collapsed, remembered: st.remembered, dock: st.dock, bounds: win.getBounds(), full: st.full }
}

/** Main-side request (tray item, second launch): the page swaps its DOM, then calls back over petpack:window. */
export function requestCollapse(win, type = 'toggle') {
  if (!win || win.isDestroyed() || !stateOf(win)) return false
  win.webContents.send('petpack:window-event', { type })
  return true
}
export function isCollapsed(win) { return Boolean(stateOf(win)?.collapsed) }

function installCollapse(win) {
  const id = win.webContents.id
  const st = { collapsed: false, remembered: readRemembered(), dock: null, full: null, timer: null, scale: 1, onChange: null }
  panes.set(id, st)
  win.on('closed', () => { clearInterval(st.timer); panes.delete(id) })
  win.webContents.on('did-start-loading', () => {
    // A reload starts with the full pane again; the page re-applies the remembered state once it is drawn.
    if (st.collapsed && !win.isDestroyed()) setCollapsed(win, false, { persist: false, animate: false })
  })
  if (ipcInstalled) return
  ipcInstalled = true
  ipcMain.handle('petpack:window', async (event, cmd, arg = {}) => {
    if (!String(event.senderFrame?.url || '').startsWith('petpack://local/')) throw new Error('not allowed')
    const target = BrowserWindow.fromWebContents(event.sender)
    if (!target || !stateOf(target)) return { collapsed: false }
    const opts = arg && typeof arg === 'object' ? arg : {}
    const s = stateOf(target)
    switch (cmd) {
      case 'collapse': return setCollapsed(target, true, opts)
      case 'expand': return setCollapsed(target, false, opts)
      case 'toggle': return setCollapsed(target, !s.collapsed, opts)
      case 'state': return describe(target)
      default: throw new Error(`unknown window command ${cmd}`)
    }
  })
}

export function raiseToTop(win) {
  if (win.isDestroyed()) return
  if (IS_MAC) win.setAlwaysOnTop(true, 'status')
  else if (IS_WIN) win.setAlwaysOnTop(true, 'screen-saver')
  else win.setAlwaysOnTop(true)
}

export function placePane(win, opts) {
  if (win.isDestroyed()) return null
  const bounds = dockBounds(opts)
  const st = stateOf(win)
  if (st) { st.full = bounds; st.dock = opts?.dock === 'left' ? 'left' : 'right'; st.scale = opts?.scale || 1 }
  if (st?.collapsed) { // keep the tab on the (new) docked edge; the full pane comes back on expand
    clearInterval(st.timer); st.timer = null
    const tab = tabBounds(bounds, st.dock, st.scale)
    setBoundsFree(win, tab)
    raiseToTop(win)
    return tab
  }
  if (st?.timer) { clearInterval(st.timer); st.timer = null }
  setBoundsFree(win, bounds)
  // Windows at 125/150 % can round the size; insist on the exact DIP size.
  const now = win.getBounds()
  if (now.width !== bounds.width || now.height !== bounds.height) win.setSize(bounds.width, bounds.height)
  raiseToTop(win)
  return bounds
}

/**
 * Click-through (build B3). Empty glass passes clicks to the desktop; the page calls setInteractive(true) over a pet.
 * Forwarding is flaky on Windows, so main also polls the cursor at 30 Hz: while it is over the pane the page gets a
 * synthetic mousemove, and once it leaves, ignore is forced back on.
 */
export function createClickThrough(win, { send }) {
  let interactive = false
  let inside = false
  let last = { x: NaN, y: NaN }
  const cursorOver = () => {
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
  }
  const apply = () => {
    if (win.isDestroyed()) return
    // The collapsed tab is all glass and always takes the click.
    if (interactive || stateOf(win)?.collapsed) win.setIgnoreMouseEvents(false)
    else win.setIgnoreMouseEvents(true, { forward: true })
  }
  const st = stateOf(win)
  if (st) st.onChange = apply
  const timer = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) return
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    const over = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
    if (over) {
      if (!interactive && (p.x !== last.x || p.y !== last.y || !inside)) {
        send({ inside: true, x: p.x - b.x, y: p.y - b.y, screenX: p.x, screenY: p.y })
      }
      last = p
    } else if (inside) {
      send({ inside: false })
      if (interactive) { interactive = false; apply() }
    }
    inside = over
  }, 33)
  apply()
  return {
    get interactive() { return interactive },
    set(on) {
      const next = Boolean(on)
      if (win.isDestroyed() || (next && !cursorOver())) return // never hold the mouse while the cursor is elsewhere
      if (next) inside = true
      if (next === interactive) return
      interactive = next
      apply()
    },
    reset() { interactive = false; inside = false; last = { x: NaN, y: NaN }; apply() },
    dispose() { clearInterval(timer) },
  }
}
