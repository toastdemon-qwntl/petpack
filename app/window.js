// The pane is the window (build R3-1/R3-2): a fixed 416x312 DIP frameless, transparent window docked flush to the
// left or right edge of the primary display's work area, 20 % down, always on top, click-through over empty glass.
import { BrowserWindow, screen } from 'electron'

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
  return win
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
  win.setBounds(bounds)
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
    if (interactive) win.setIgnoreMouseEvents(false)
    else win.setIgnoreMouseEvents(true, { forward: true })
  }
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
