// In-pane zoom (WIDE lane): scroll / pinch over a seat's pane pulls the camera out over the strip, drag pans,
// double-click or the home pip returns to the seat's exact framing (the same stage.focus call setSeat makes,
// and the critically damped spring lands exactly on it, so the edge-to-edge seams are restored exactly).
// Pets stay on the same art-pixel grid (pixelScale never changes); name labels hide once pets get small.
//
//   const zoom = attachZoom({ world, root, seat })   // seat: number | () => number; default world.seat
//   zoom.home(); zoom.zoomTo(level); zoom.level; zoom.zoomed; zoom.wantsPointer(x, y); zoom.dispose()
//
// stage.focus clamps span to 80 world units, so the widest view is 80 / 14 = 5.7 chunks.

const MAX_SPAN = 80
const LABELS_HIDE_AT = 2.25 // level (chunks across) above which name labels hide
const sheet = typeof CSSStyleSheet === 'function' ? new CSSStyleSheet() : null
sheet?.replaceSync(`
.pp-zoom-far .fx-name { visibility: hidden !important; }
.pp-zoom-pip { position: absolute; z-index: 9; right: 10px; bottom: 10px; width: 22px; height: 22px; padding: 0; border: 0;
  border-radius: 7px; background: #fff7dfe6; box-shadow: 0 0 0 2px #24323d22, 0 2px 6px #0c1d3326; cursor: pointer;
  opacity: 0; transform: scale(.85); transition: opacity .2s, transform .2s; pointer-events: none; image-rendering: pixelated; }
.pp-zoom-pip.on { opacity: .95; transform: scale(1); pointer-events: auto; }
.pp-zoom-pip svg { display: block; width: 14px; height: 14px; margin: 4px; shape-rendering: crispEdges; }
.pp-zoom-pip:hover { background: #fffaf0; }
.pp-zoom-pan { cursor: grab; } .pp-zoom-pan.pp-zoom-dragging { cursor: grabbing; }
`)
let sheetAdopted = false
// Pixel icons on a 7x7 grid: a house (home) and a minus lens (zoom out).
const HOME_ICON = '<svg viewBox="0 0 7 7" aria-hidden="true"><path fill="#24323d" d="M3 0h1v1h1v1h1v1h1v1H6v3H4V5H3v2H1V4H0V3h1V2h1V1h1z"/></svg>'
const OUT_ICON = '<svg viewBox="0 0 7 7" aria-hidden="true"><path fill="#24323d" d="M1 0h3v1h1v1h1v2H5v1h1v1h1v1H6V6H5V5H4v1H1V5H0V1h1zm0 2v2h4V2z"/><path fill="#24323d" d="M1 2h4v1H1z"/></svg>'

/**
 * Keep the map streaming every chunk the camera can see. The world streams seat-1..seat+1 around the camera
 * centre; a wider view needs more. Wraps map.ensure so the world's own calls are widened, never narrowed.
 * Returns { update(lo, hi), dispose() }.
 */
export function widenEnsure(world) {
  const map = world?.map
  if (!map || typeof map.ensure !== 'function') return { update() {}, dispose() {} }
  const original = map.ensure
  let want = null
  let applied = ''
  const widened = function (a, b) {
    if (!want) return original.call(map, a, b)
    return original.call(map, Math.min(a, want[0]), Math.max(b, want[1]))
  }
  map.ensure = widened
  return {
    update(lo, hi) {
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return
      lo = Math.floor(lo); hi = Math.ceil(hi)
      const key = `${lo}|${hi}`
      if (key === applied) return
      applied = key
      want = [lo, hi]
      const c = Math.round((world.stage?.camera?.position?.x || 0) / (map.chunkWidth || 14))
      original.call(map, Math.min(c - 1, lo), Math.max(c + 1, hi))
    },
    dispose() { if (map.ensure === widened) map.ensure = original; want = null },
  }
}

/** The chunk range [lo, hi] an orthographic stage camera shows (x extent), plus the chunk under its centre. */
export function visibleChunks(stage, chunkWidth = 14) {
  const cam = stage?.camera
  if (!cam) return null
  const half = Math.abs(cam.right - cam.left) / 2
  const x = cam.position.x
  return { lo: Math.floor((x - half) / chunkWidth + .5), hi: Math.ceil((x + half) / chunkWidth - .5), center: x, half }
}

export function attachZoom({ world, root, seat } = {}) {
  if (!world?.stage || !root) return null
  if (sheet && !sheetAdopted) { document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; sheetAdopted = true }
  const stage = world.stage
  const map = world.map
  const chunkWidth = map?.chunkWidth || 14
  const maxLevel = MAX_SPAN / chunkWidth
  const seatOf = () => {
    const s = typeof seat === 'function' ? seat() : seat
    return Number.isFinite(s) ? Math.trunc(s) : Number.isFinite(world.seat) ? world.seat : 0
  }
  const stream = widenEnsure(world)
  let level = 1 // chunks across
  let pan = 0 // world x offset from the seat centre
  let lastSeat = world.seat
  let disposed = false
  let drag = null
  let hovering = false
  let raf = 0

  const pip = document.createElement('button')
  pip.type = 'button'
  pip.className = 'pp-zoom-pip'
  pip.setAttribute('aria-label', 'Back to this seat')
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative'
  root.append(pip)

  function centre() {
    const s = seatOf()
    return map?.chunkCenter?.(s) || { x: s * chunkWidth, z: 0 }
  }
  function apply() {
    const c = centre()
    if (level <= 1) {
      level = 1; pan = 0
      stage.focus(c.x, c.z, { span: chunkWidth }) // exactly setSeat's framing
    } else stage.focus(c.x + pan, c.z, { span: Math.min(MAX_SPAN, chunkWidth * level) })
    root.classList.toggle('pp-zoom-far', level > LABELS_HIDE_AT)
    root.classList.toggle('pp-zoom-pan', level > 1)
    paintPip()
    want()
  }
  function maxPan() { return (level - 1) * chunkWidth * 1.5 }
  function want() {
    // Chunks the goal view will show (the camera glides there), unioned with what the camera shows now.
    const s = seatOf()
    const half = level / 2
    const goalLo = s + pan / chunkWidth - half, goalHi = s + pan / chunkWidth + half
    const now = visibleChunks(stage, chunkWidth)
    const lo = Math.min(goalLo, now ? now.lo : s) - .5, hi = Math.max(goalHi, now ? now.hi : s) + .5
    stream.update(Math.round(lo), Math.round(hi))
  }
  function paintPip() {
    const zoomed = level > 1
    pip.innerHTML = zoomed ? HOME_ICON : OUT_ICON
    pip.setAttribute('aria-label', zoomed ? 'Back to this seat' : 'Zoom out')
    pip.title = zoomed ? 'Back to this seat (double-click)' : 'See the wider world (scroll)'
    pip.classList.toggle('on', zoomed || hovering)
  }
  function zoomTo(next, { anchorX = null } = {}) {
    if (disposed) return
    const before = level
    next = Math.min(maxLevel, Math.max(1, Number(next) || 1))
    if (next < 1.04) next = 1
    // Zoom about the cursor's world x when there is one, so the place under it stays put.
    if (anchorX != null && next > 1) {
      const rect = root.getBoundingClientRect()
      const f = rect.width ? (anchorX - rect.left) / rect.width - .5 : 0
      pan += f * chunkWidth * (before - next)
    }
    level = next
    pan = Math.max(-maxPan(), Math.min(maxPan(), pan))
    apply()
  }
  function home() { if (disposed) return; level = 1; pan = 0; apply() }

  function inside(x, y) {
    const r = root.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }
  // The pane's own controls (pip, chat, permission card, mic) keep their clicks.
  const control = event => event.target !== root && !!event.target?.closest?.('button, input, textarea, select, a, .pp-chat, .pp-perm, .pp-mic, .pp-grip, .pp-tab, .pp-zoom-pip')
  function onWheel(event) {
    if (disposed || !inside(event.clientX, event.clientY) || control(event)) return
    event.preventDefault()
    // Trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel as larger steps.
    let dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1)
    const k = event.ctrlKey ? 0.008 : 0.0022
    dy = Math.max(-240, Math.min(240, dy))
    if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY) && level > 1) {
      // Two-finger sideways scroll pans when zoomed out.
      const rect = root.getBoundingClientRect()
      pan = Math.max(-maxPan(), Math.min(maxPan(), pan + event.deltaX * chunkWidth * level / Math.max(1, rect.width)))
      apply()
      return
    }
    zoomTo(level * Math.exp(dy * k), { anchorX: event.clientX })
  }
  function onDown(event) {
    if (disposed || level <= 1 || event.button !== 0 || !inside(event.clientX, event.clientY) || control(event)) return
    if (world.pick?.(event.clientX, event.clientY)) return // pets keep their own clicks and throws
    drag = { x: event.clientX, pan, id: event.pointerId }
    root.classList.add('pp-zoom-dragging')
    // Capture-phase window listeners: play.js sets the viewport to pointer-events: none, so empty glass targets the
    // pane, whose frame-drag (collapse.js) would move the window. Zoomed out, a drag on the glass pans instead.
    event.stopPropagation()
  }
  function onMove(event) {
    if (!drag || event.pointerId !== drag.id) return
    const rect = root.getBoundingClientRect()
    const perPx = chunkWidth * level / Math.max(1, rect.width)
    pan = Math.max(-maxPan(), Math.min(maxPan(), drag.pan - (event.clientX - drag.x) * perPx))
    apply()
  }
  function onUp(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return
    drag = null
    root.classList.remove('pp-zoom-dragging')
  }
  function onDouble(event) {
    if (disposed || level <= 1 || !inside(event.clientX, event.clientY) || control(event)) return
    if (world.pick?.(event.clientX, event.clientY)) return
    home()
  }
  function onHover(event) {
    const over = inside(event.clientX, event.clientY)
    if (over !== hovering) { hovering = over; paintPip() }
  }
  function onPip(event) {
    event.stopPropagation()
    if (level > 1) home()
    else zoomTo(3)
  }
  function onKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === '-' || event.key === '_') zoomTo(level * 1.5)
    else if (event.key === '=' || event.key === '+') zoomTo(level / 1.5)
    else if (event.key === '0' || (event.key === 'Escape' && level > 1)) home()
  }
  function tick() {
    if (disposed) return
    // A seat change (setSeat) already refocused the camera at home framing: follow it.
    if (world.seat !== lastSeat) { lastSeat = world.seat; level = 1; pan = 0; root.classList.remove('pp-zoom-far', 'pp-zoom-pan'); paintPip() }
    if (level > 1 || stream) want()
    raf = requestAnimationFrame(tick)
  }

  window.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('pointerdown', onDown, true)
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onUp, true)
  window.addEventListener('dblclick', onDouble, true)
  document.addEventListener('mousemove', onHover)
  pip.addEventListener('click', onPip)
  pip.addEventListener('dblclick', e => e.stopPropagation())
  window.addEventListener('keydown', onKey)
  paintPip()
  raf = requestAnimationFrame(tick)

  return {
    zoomTo, home,
    get level() { return level },
    get pan() { return pan },
    get zoomed() { return level > 1 },
    /** True where the pane should take the mouse in a click-through window: zoomed out, or over the pip. */
    wantsPointer(x, y) {
      if (disposed) return false
      if (level > 1 && inside(x, y)) return true
      const r = pip.getBoundingClientRect()
      return hovering && x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6
    },
    dispose() {
      if (disposed) return
      home()
      disposed = true
      cancelAnimationFrame(raf)
      stream.dispose()
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('dblclick', onDouble, true)
      document.removeEventListener('mousemove', onHover)
      window.removeEventListener('keydown', onKey)
      pip.remove()
      root.classList.remove('pp-zoom-far', 'pp-zoom-pan', 'pp-zoom-dragging')
    },
  }
}
