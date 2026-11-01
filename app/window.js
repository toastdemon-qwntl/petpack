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
function readSaved() {
  const file = stateFile()
  try { return (file && JSON.parse(fs.readFileSync(file, 'utf8'))) || {} } catch { return {} }
}
function save(patch) {
  const file = stateFile()
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ ...readSaved(), ...patch }, null, 2)}\n`)
  } catch (error) { console.error(`petpack: window state not saved (${error.message})`) }
}
const remember = collapsed => save({ collapsed })

// ---------------------------------------------------------------------------------------------------------------
// Placement: docked (left/right edge, saved vertical position + display) or floating (x/y + display), dragged by the
// pane's glass frame. Released within SNAP DIP of a screen's left/right edge it docks there; elsewhere it floats.
// The dock SIDE is main's setting (settings.dock, which the relay also hears): a drag onto the other edge asks main
// through onDockSide(fn). Placement persists in userData/window.json and is clamped onto a visible display.

export const PUCK = 56
const SNAP = 40
let dockSideHandler = null
/** main.js: onDockSide(side => trayActions().setDock(side)) so a drag onto the other edge updates settings.dock. */
export function onDockSide(fn) { dockSideHandler = typeof fn === 'function' ? fn : null }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
function displayFor(id, point) {
  const all = screen.getAllDisplays()
  return all.find(d => d.id === id) || (point && Number.isFinite(point.x) ? screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }) : null)
}
const sideOf = st => st.sideOverride || st.dock || 'right'
/** Where the full pane goes for a placement; `base` is main's default dock bounds (it carries the size). */
function placedBounds(st, base) {
  const p = st.placement || { mode: 'dock' }
  const { width, height } = base
  if (p.mode === 'float' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
    const wa = (displayFor(p.displayId, p) || screen.getPrimaryDisplay()).workArea
    return { x: Math.round(clamp(p.x, wa.x, wa.x + wa.width - width)), y: Math.round(clamp(p.y, wa.y, wa.y + wa.height - height)), width, height }
  }
  if (p.mode === 'dock' && Number.isFinite(p.y)) {
    const wa = (displayFor(p.displayId, { x: base.x, y: p.y }) || screen.getPrimaryDisplay()).workArea
    const x = sideOf(st) === 'left' ? wa.x - HANG : wa.x + wa.width - width + HANG
    return { x, y: Math.round(clamp(p.y, wa.y, wa.y + wa.height - height)), width, height }
  }
  if (st.sideOverride && st.sideOverride !== st.dock) {
    const wa = screen.getDisplayMatching(base).workArea
    return { ...base, x: st.sideOverride === 'left' ? wa.x - HANG : wa.x + wa.width - width + HANG }
  }
  return base
}
function collapsedBounds(st) {
  if (st.placement?.mode === 'float') {
    const f = st.full
    return { x: Math.round(f.x + (f.width - PUCK) / 2), y: Math.round(f.y + (f.height - PUCK) / 2), width: PUCK, height: PUCK }
  }
  return tabBounds(st.full, sideOf(st), st.scale)
}
function placementOf(st) {
  const p = st.placement || { mode: 'dock' }
  return { mode: p.mode === 'float' ? 'float' : 'dock', side: sideOf(st), displayId: p.displayId ?? null,
    ...(p.mode === 'float' ? { x: p.x, y: p.y } : { y: p.y ?? null }) }
}
function announce(win) {
  const st = stateOf(win)
  if (!st || win.isDestroyed()) return
  win.webContents.send('petpack:window-event', { type: 'placement', placement: placementOf(st) })
  for (const fn of placementListeners) { try { fn(placementOf(st)) } catch { /* listener */ } }
}
const placementListeners = new Set()
/** Tray: called with { mode: 'dock'|'float', side } whenever the placement changes. Returns an unsubscribe. */
export function onPlacementChange(fn) { placementListeners.add(fn); return () => placementListeners.delete(fn) }
const thePane = () => { for (const [id] of panes) { const w = BrowserWindow.getAllWindows().find(x => !x.isDestroyed() && x.webContents.id === id); if (w) return w } return null }
/** Tray: the pane's current placement. */
export function getPlacement(win = thePane()) { const st = stateOf(win); return st ? placementOf(st) : null }

function applyPlacement(win, st, ms = 140) {
  if (!st.base) st.base = win.getBounds()
  st.full = placedBounds(st, { ...st.base, width: st.base.width, height: st.base.height })
  const to = st.collapsed ? collapsedBounds(st) : st.full
  return animateBounds(win, st, to, ms).then(() => { raiseToTop(win); announce(win); return describe(win) })
}

/** Tray "Dock left" / "Dock right": docked on that edge at main's default height. */
export async function placeDock(side, win = thePane()) {
  const st = stateOf(win)
  if (!st || (side !== 'left' && side !== 'right')) return null
  st.placement = { mode: 'dock' }
  save({ placement: st.placement })
  if (side !== st.dock) return askSide(win, st, side)
  st.sideOverride = null
  if (st.baseOpts) st.base = dockBounds(st.baseOpts)
  return applyPlacement(win, st)
}
/** Tray "Float": the pane lifts off the edge where it is and floats there. */
export async function placeFloat(win = thePane()) {
  const st = stateOf(win)
  if (!st) return null
  if (st.placement?.mode === 'float') return describe(win)
  const b = st.full || win.getBounds()
  const display = screen.getDisplayMatching(b)
  const inward = sideOf(st) === 'left' ? SNAP + 24 : -(SNAP + 24)
  st.placement = { mode: 'float', displayId: display.id, x: b.x + inward, y: b.y }
  save({ placement: st.placement })
  return applyPlacement(win, st)
}
function askSide(win, st, side) {
  st.expectDock = side
  if (dockSideHandler) {
    try { dockSideHandler(side) } catch (error) { console.error(`petpack: dock side change failed (${error.message})`) }
    // main re-docks (placePane) and reloads the page; if it did nothing, fall back to a local override.
    setTimeout(() => { if (st.expectDock === side) { st.expectDock = null; st.sideOverride = side; applyPlacement(win, st) } }, 600)
    return describe(win)
  }
  st.expectDock = null
  st.sideOverride = side // shim until main wires onDockSide: the window docks there; the relay keeps the old side
  return applyPlacement(win, st)
}

// Dragging: the page reports where on the pane the pointer went down; main follows the cursor until the page says up.
function dragStart(win, { ox, oy } = {}) {
  const st = stateOf(win)
  if (!st || st.collapsed) return describe(win)
  clearInterval(st.timer); st.timer = null
  clearInterval(st.drag?.timer)
  const b = win.getBounds()
  const drag = { ox: clamp(Number(ox) || 0, 0, b.width), oy: clamp(Number(oy) || 0, 0, b.height), w: b.width, h: b.height, last: null, moved: Date.now() }
  st.drag = drag
  st.onChange?.()
  drag.timer = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(drag.timer); return }
    const p = screen.getCursorScreenPoint()
    if (drag.last && p.x === drag.last.x && p.y === drag.last.y) {
      if (Date.now() - drag.moved > 15000) dragEnd(win) // the page never said up
      return
    }
    drag.last = p; drag.moved = Date.now()
    win.setBounds({ x: p.x - drag.ox, y: p.y - drag.oy, width: drag.w, height: drag.h })
  }, 16)
  return describe(win)
}
function dragEnd(win) {
  const st = stateOf(win)
  if (!st?.drag) return describe(win)
  clearInterval(st.drag.timer)
  st.drag = null
  st.onChange?.()
  const b = win.getBounds()
  const p = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(p)
  const wa = display.workArea
  const y = clamp(b.y, wa.y, wa.y + wa.height - b.height)
  const side = b.x - wa.x <= SNAP ? 'left' : (wa.x + wa.width) - (b.x + b.width) <= SNAP ? 'right' : null
  st.placement = side ? { mode: 'dock', displayId: display.id, y } : { mode: 'float', displayId: display.id, x: clamp(b.x, wa.x, wa.x + wa.width - b.width), y }
  save({ placement: st.placement })
  st.base = { ...b }
  if (process.env.PETPACK_LOG_WINDOW) console.log(`[petpack window] ${new Date().toISOString()} dropped ${JSON.stringify(b)} -> ${JSON.stringify(st.placement)}${side ? ` dock ${side}` : ''}`)
  if (side && side !== sideOf(st)) return askSide(win, st, side)
  return applyPlacement(win, st)
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
  if (!st.dock) st.dock = dock === 'left' || dock === 'right' ? dock : inferDock(win)
  if (persist) { st.remembered = collapsed; remember(collapsed) }
  if (collapsed === st.collapsed) return describe(win)
  if (st.drag) dragEnd(win)
  if (collapsed) st.full = st.timer ? (st.full || win.getBounds()) : win.getBounds()
  st.collapsed = collapsed
  st.onChange?.()
  const to = collapsed ? collapsedBounds(st) : (st.full || win.getBounds())
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
  return { collapsed: st.collapsed, remembered: st.remembered, dock: sideOf(st), placement: placementOf(st), bounds: win.getBounds(), full: st.full }
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
  const saved = readSaved()
  const placement = saved.placement && typeof saved.placement === 'object' && ['dock', 'float'].includes(saved.placement.mode) ? saved.placement : { mode: 'dock' }
  const st = { collapsed: false, remembered: Boolean(saved.collapsed), dock: null, full: null, timer: null, scale: 1, onChange: null,
    placement, base: null, baseOpts: null, lastSig: null, expectDock: null, sideOverride: null, drag: null }
  panes.set(id, st)
  win.on('closed', () => { clearInterval(st.timer); clearInterval(st.drag?.timer); panes.delete(id) })
  win.webContents.on('did-start-loading', () => {
    // A reload starts with the full pane again; the page re-applies the remembered state once it is drawn.
    if (st.collapsed && !win.isDestroyed()) setCollapsed(win, false, { persist: false, animate: false })
  })
  if (ipcInstalled) return
  ipcInstalled = true
  ipcMain.handle('petpack:window', async (event, cmd, arg = {}) => {
    if (!String(event.senderFrame?.url || '').startsWith('petpack://local/')) throw new Error('not allowed')
    // From the pane itself, or from another petpack page (a tray panel): it always acts on the pane.
    const sender = BrowserWindow.fromWebContents(event.sender)
    const target = stateOf(sender) ? sender : thePane()
    if (!target || !stateOf(target)) return { collapsed: false }
    const opts = arg && typeof arg === 'object' ? arg : {}
    const s = stateOf(target)
    switch (cmd) {
      case 'collapse': return setCollapsed(target, true, opts)
      case 'expand': return setCollapsed(target, false, opts)
      case 'toggle': return setCollapsed(target, !s.collapsed, opts)
      case 'state': return describe(target)
      case 'placement': return placementOf(s)
      case 'drag-start': return dragStart(target, opts)
      case 'drag-end': return dragEnd(target)
      case 'dock': return placeDock(opts.side, target)
      case 'float': return placeFloat(target)
      // Another page (tray panel) folding/opening the pane: the pane's page swaps its DOM first, then resizes.
      case 'request': return requestCollapse(target, ['toggle', 'collapse', 'expand'].includes(opts.type) ? opts.type : 'toggle')
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
  let bounds = dockBounds(opts)
  const st = stateOf(win)
  if (st) {
    if (st.drag) return win.getBounds() // never yank the pane out from under the cursor
    const side = opts?.dock === 'left' ? 'left' : 'right'
    const sig = `${side}|${opts?.align ?? 0}|${opts?.top ?? 0.2}|${opts?.scale ?? 1}`
    const ours = st.expectDock === side
    // The tray / flags moved the dock (side or nudge): main's placement wins over a saved drag.
    if (st.lastSig !== null && sig !== st.lastSig && !ours) { st.placement = { mode: 'dock' }; save({ placement: st.placement }); st.sideOverride = null }
    if (ours) { st.expectDock = null; st.sideOverride = null }
    if (st.sideOverride === side) st.sideOverride = null
    st.lastSig = sig
    st.dock = side
    st.scale = opts?.scale || 1
    st.baseOpts = opts
    st.base = bounds
    bounds = placedBounds(st, bounds)
    st.full = bounds
    if (st.lastSig !== null) setImmediate(() => announce(win))
  }
  if (st?.collapsed) { // keep the tab on the (new) edge, or the puck where it floats; the full pane comes back on expand
    clearInterval(st.timer); st.timer = null
    const tab = collapsedBounds(st)
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
    if (interactive || stateOf(win)?.collapsed || stateOf(win)?.drag) win.setIgnoreMouseEvents(false)
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
