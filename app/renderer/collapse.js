// Collapse: the pane folds into a slim glass tab on its docked edge (the owner's pet face, a visitor count) and opens
// itself when someone walks on. app.js calls attachCollapse({ world, brain, bridge, root }) once the world is up.
// Main (app/window.js) owns the window bounds over `petpack:window`; this page owns the DOM, the rules and the timing.
import { chunkOf } from './brain.js'

const QUIET_MS = 6000 // re-fold this long after the last visitor leaves (only if the person had folded it)
const SLOW_FRAME_MS = 250 // world update cadence while folded (no GPU draw)
const POLL_MS = 200

export function attachCollapse({ world, brain, bridge = window.petpack, root } = {}) {
  if (!world || !brain) return null
  const pane = root?.classList?.contains('petpack-pane') ? root : (root?.querySelector?.('.petpack-pane') || document.querySelector('.petpack-pane'))
  if (!pane) return null
  let dock = (pane.dataset.dock || bridge?.config?.dock) === 'left' ? 'left' : 'right'
  const win = (cmd, arg) => {
    try { return Promise.resolve(bridge?.window?.(cmd, arg)).catch(error => { console.warn('petpack window', error?.message || error); return null }) } catch { return Promise.resolve(null) }
  }
  const setInteractive = on => { try { bridge?.setInteractive?.(on) } catch { /* bridge gone */ } }

  if (!document.querySelector('link[data-petpack-collapse]')) {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('./collapse.css', import.meta.url).href })
    link.dataset.petpackCollapse = ''
    document.head.append(link)
  }

  // ---- DOM: the tab (body level, fixed on the docked edge) and the fold chevron (inner edge of the open pane) ----
  const tab = Object.assign(document.createElement('button'), { type: 'button', className: 'pp-tab', title: 'Open petpack' })
  tab.dataset.dock = dock
  const face = Object.assign(document.createElement('span'), { className: 'pp-tab-face' })
  const count = Object.assign(document.createElement('span'), { className: 'pp-tab-count' })
  const hint = Object.assign(document.createElement('span'), { className: 'pp-tab-hint', textContent: dock === 'left' ? '›' : '‹' })
  tab.append(face, count, hint)
  document.body.append(tab)
  const fold = Object.assign(document.createElement('button'), { type: 'button', className: 'pp-fold', title: 'Fold petpack (Ctrl/Cmd+Shift+P)',
    textContent: dock === 'left' ? '‹' : '›' })
  fold.dataset.dock = dock
  // The grip (top of the glass frame, on hover) and the frame itself drag the pane; the world never does.
  const grip = Object.assign(document.createElement('div'), { className: 'pp-grip', title: 'Drag petpack' })
  pane.append(fold, grip)

  /** Docked (flush on an edge, data-dock shape) or floating (fully rounded; folds to a round puck). */
  let placement = { mode: 'dock', side: dock }
  function applyPlacement(p) {
    if (!p || (p.mode !== 'dock' && p.mode !== 'float')) return
    placement = p
    document.body.classList.toggle('pp-floating', p.mode === 'float')
    if (p.side === 'left' || p.side === 'right') {
      dock = p.side
      pane.dataset.dock = dock
      tab.dataset.dock = dock
      fold.dataset.dock = dock
      fold.textContent = dock === 'left' ? '‹' : '›'
      hint.textContent = dock === 'left' ? '›' : '‹'
    }
  }

  function paintFace() {
    const me = brain.me || {}
    const url = typeof me.spriteUrl === 'string' && me.spriteUrl ? me.spriteUrl : null
    face.style.setProperty('--pp-owner', me.color || '#7aa6c8')
    if (!url) { face.classList.add('dot'); face.style.backgroundImage = ''; return }
    const image = new Image()
    image.onload = () => {
      const cols = Number(me.atlas?.cols) || 8
      const rows = Number(me.atlas?.rows) || Math.max(9, Math.round(image.naturalHeight / (image.naturalWidth / cols / 192 * 208)))
      // The idle frame is cell (0, 0): scale the sheet so one cell fills the face box.
      face.classList.remove('dot')
      face.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`
      face.style.backgroundSize = `${cols * 100}% ${rows * 100}%`
      face.style.backgroundPosition = '0 0'
    }
    image.onerror = () => { face.classList.add('dot'); face.style.backgroundImage = '' }
    image.src = url
  }
  face.classList.add('dot')
  paintFace()

  // ---- state ----
  const state = { collapsed: false, userCollapsed: false, autoOpened: false, paused: false }
  let present = new Set()
  const recentLeave = new Map() // id -> when it left this chunk
  let quietSince = performance.now()
  let involvedUntil = 0
  let knocking = false
  let pulse = false
  let hovering = false
  let queue = Promise.resolve()
  const serial = fn => (queue = queue.then(fn, fn))

  function hold(on) {
    if (on) {
      const r = pane.getBoundingClientRect()
      if (r.width > 60 && r.height > 60) {
        document.body.style.setProperty('--pp-pane-w', `${Math.round(r.width)}px`)
        document.body.style.setProperty('--pp-pane-h', `${Math.round(r.height)}px`)
      }
      document.body.classList.add('pp-hold')
    } else document.body.classList.remove('pp-hold')
  }

  // The motion is CSS (250 ms ease-out, the pane scales into / out of the tab's spot); the window itself changes size
  // once, while what is on screen already matches the new size, so a renderer lagging a resize never shows a jump.
  const ANIM_MS = 250
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))
  const collapse = ({ user = false } = {}) => serial(async () => {
    if (user) { state.userCollapsed = true; state.autoOpened = false; heldFor = new Set(present) }
    if (state.collapsed) { if (user) await win('collapse', { dock, persist: true }); return }
    state.collapsed = true
    fold.classList.remove('on')
    hold(true)
    document.body.classList.add('pp-collapsed')
    setInteractive(false)
    await wait(ANIM_MS + 10)
    if (!state.collapsed) return
    const result = await win('collapse', { dock, persist: user, animate: false })
    if (state.collapsed) state.paused = true
    log('collapsed', result)
  })
  const expand = ({ user = false } = {}) => serial(async () => {
    if (user) { state.userCollapsed = false; state.autoOpened = false; heldFor = new Set() }
    if (!state.collapsed) { if (user) await win('expand', { dock, persist: true }); return }
    state.collapsed = false
    state.paused = false
    quietSince = performance.now()
    document.body.classList.add('pp-unfolding') // the tab goes first, so the resize never shows it out of place
    await frame()
    const result = await win('expand', { dock, persist: user, animate: false })
    await frame()
    document.body.classList.remove('pp-collapsed')
    await wait(ANIM_MS + 10)
    document.body.classList.remove('pp-unfolding')
    if (!state.collapsed) hold(false)
    log('expanded', result)
  })
  const toggle = ({ user = true } = {}) => (state.collapsed ? expand({ user }) : collapse({ user }))
  function log(what, result) {
    const b = result?.bounds
    console.info(`[petpack collapse] ${what}${state.autoOpened ? ' (auto)' : ''}${b ? ` bounds ${b.x},${b.y} ${b.width}x${b.height}` : ''}`)
  }

  // ---- rendering drops to a slow, draw-free world update while folded ----
  const renderFrame = world.renderFrame
  let slowDt = 0
  let slowAt = 0
  world.renderFrame = (dt = 0, time = 0, opts) => {
    if (!state.paused) return renderFrame(dt, time, opts)
    slowDt += Number.isFinite(dt) ? dt : 0
    const now = performance.now()
    if (now - slowAt < SLOW_FRAME_MS) return undefined
    slowAt = now
    const d = slowDt
    slowDt = 0
    return renderFrame(d, time, { ...(opts || {}), render: false })
  }

  // ---- involvement: our pet knocks (Codex waiting), or a gift / ask / collab touches our pet ----
  const myId = () => brain.me?.id
  // Folded by hand while visitors were here: those visitors (and their asks/gifts) don't reopen it; a new arrival does.
  let heldFor = new Set()
  function involve(withId) {
    involvedUntil = performance.now() + 4000
    if (state.collapsed && state.userCollapsed && withId && heldFor.has(withId)) return
    pulse = true
  }
  const onKnock = (id, on) => { if (id !== myId()) return false; knocking = on !== false; return knocking }
  // The brain's events when it has them (visitor-enter/leave, knock, involved); else watch positions and the world calls.
  const events = typeof brain.on === 'function'
  const offs = []
  const entered = new Map() // id -> true, from visitor-enter / visitor-leave
  if (events) {
    offs.push(brain.on('visitor-enter', v => { if (v?.id && v.id !== myId()) entered.set(v.id, true) }))
    offs.push(brain.on('visitor-leave', v => { if (v?.id) entered.delete(v.id) }))
    offs.push(brain.on('knock', (id, on) => { if (onKnock(id, on)) involve() }))
    offs.push(brain.on('involved', e => involve(e?.with)))
  } else {
    const wrap = (name, test) => {
      const fn = world[name]
      if (typeof fn !== 'function') return
      world[name] = (...args) => {
        try { if (test(...args)) involve() } catch { /* never block the world */ }
        return fn(...args)
      }
    }
    wrap('knock', onKnock)
    for (const name of ['gift', 'ask', 'collab']) {
      const fn = world[name]
      if (typeof fn !== 'function') continue
      world[name] = (a, b, ...rest) => {
        try { if (a === myId() || b === myId()) involve(a === myId() ? b : a) } catch { /* never block the world */ }
        return fn(a, b, ...rest)
      }
    }
  }

  // ---- visitors on this pane's chunk ----
  function visitors() {
    if (events) return new Set(entered.keys())
    const ids = new Set()
    let seat = 0
    try { seat = brain.seat } catch { seat = 0 }
    try { for (const p of brain.pets()) if (!p.isMe && Number.isFinite(p.x) && chunkOf(p.x) === seat) ids.add(p.id) } catch { /* brain mid-update */ }
    return ids
  }
  let paintedFor = null
  function poll() {
    const now = performance.now()
    const ids = visitors()
    let arrived = false
    // A pet hovering on the chunk edge (out and back within 2.5 s) is not a new arrival.
    for (const id of present) if (!ids.has(id)) recentLeave.set(id, now)
    for (const id of ids) if (!present.has(id) && !(now - (recentLeave.get(id) ?? -1e9) < 2500)) arrived = true
    if (recentLeave.size > 64) for (const [id, at] of recentLeave) if (now - at > 2500) recentLeave.delete(id)
    if (arrived) heldFor = new Set()
    present = ids
    count.textContent = ids.size ? String(ids.size) : ''
    tab.classList.toggle('busy', ids.size > 0)
    const involved = knocking || now < involvedUntil
    if (ids.size || involved || (hovering && !state.collapsed)) quietSince = now
    const me = brain.me
    const key = me ? `${me.spriteUrl || ''}|${me.color || ''}` : null
    if (key && key !== paintedFor) { paintedFor = key; paintFace() }
    if (state.collapsed && (arrived || pulse)) {
      state.autoOpened = true
      expand()
    } else if (!state.collapsed && state.userCollapsed && state.autoOpened && now - quietSince >= QUIET_MS) {
      state.autoOpened = false
      collapse()
    }
    pulse = false
  }
  const timer = setInterval(poll, POLL_MS)

  // ---- input: tab click opens, chevron folds, Ctrl/Cmd+Shift+P toggles, main-side requests (tray) ----
  tab.addEventListener('click', event => { event.stopPropagation(); expand({ user: true }) })
  fold.addEventListener('click', event => { event.stopPropagation(); collapse({ user: true }) })
  const onKey = event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyP') {
      event.preventDefault()
      toggle({ user: true })
    }
  }
  window.addEventListener('keydown', onKey)
  const offWindow = bridge?.onWindow?.(event => {
    const type = typeof event === 'string' ? event : event?.type
    if (type === 'toggle') toggle({ user: true })
    else if (type === 'collapse') collapse({ user: true })
    else if (type === 'expand') expand({ user: true })
    else if (type === 'placement') applyPlacement(event.placement)
  })
  // The chevron and the grip show while the cursor is over the open pane; over them (or the glass frame) the pane
  // holds the mouse so they can be clicked and dragged.
  let overChrome = false
  let hideTimer = 0
  const near = (el, x, y, pad = 4) => { const r = el.getBoundingClientRect(); return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad }
  // The world runs edge to edge, so the frame is the outline plus a thin band just inside it (not on the docked edge).
  const FRAME_BAND = 5
  function onFrame(x, y) {
    const p = pane.getBoundingClientRect()
    if (x < p.left || x > p.right || y < p.top || y > p.bottom) return false
    const floating = document.body.classList.contains('pp-floating')
    const band = side => (!floating && side === dock ? 0 : FRAME_BAND)
    return x < p.left + band('left') || x > p.right - band('right') || y < p.top + FRAME_BAND || y > p.bottom - FRAME_BAND
  }
  const onMove = event => {
    if (state.collapsed || dragging) return
    const x = event.clientX, y = event.clientY
    const inside = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight
    hovering = inside
    fold.classList.toggle('on', inside)
    grip.classList.toggle('on', inside)
    clearTimeout(hideTimer)
    if (inside) hideTimer = setTimeout(() => { fold.classList.remove('on'); grip.classList.remove('on'); hovering = false }, 2500)
    const over = inside && (near(fold, x, y) || near(grip, x, y, 3) || onFrame(x, y))
    if (over !== overChrome) {
      overChrome = over
      let pet = false
      try { pet = !over && Boolean(world.pick?.(x, y)) } catch { pet = false }
      setInteractive(over || pet)
    }
  }
  const onLeave = () => { if (dragging) return; hovering = false; fold.classList.remove('on'); grip.classList.remove('on'); overChrome = false }
  window.addEventListener('mousemove', onMove)
  document.documentElement.addEventListener('mouseleave', onLeave)

  // ---- drag by the frame / grip: main follows the cursor; on release it docks (near an edge) or floats ----
  let dragging = false
  const onDown = event => {
    if (event.button !== 0 || state.collapsed || dragging) return
    if (event.target !== grip && event.target !== pane && !onFrame(event.clientX, event.clientY)) return // the world (pets, throws) keeps its own pointer
    event.preventDefault()
    event.stopPropagation()
    dragging = true
    try { pane.setPointerCapture(event.pointerId) } catch { /* not capturable */ }
    setInteractive(true)
    document.body.classList.add('pp-dragging')
    win('drag-start', { ox: event.clientX, oy: event.clientY })
  }
  const onUp = async () => {
    if (!dragging) return
    dragging = false
    const result = await win('drag-end')
    document.body.classList.remove('pp-dragging')
    applyPlacement(result?.placement)
    overChrome = false
  }
  pane.addEventListener('pointerdown', onDown, true)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  pane.addEventListener('lostpointercapture', onUp)

  // The remembered choice comes back once the first frames are drawn.
  win('state').then(s => {
    applyPlacement(s?.placement)
    if (s?.remembered && !state.collapsed) setTimeout(() => { if (!state.collapsed && !state.userCollapsed) collapse({ user: true }) }, 1500)
  })

  const api = {
    collapse: () => collapse({ user: true }), expand: () => expand({ user: true }), toggle: () => toggle({ user: true }),
    get collapsed() { return state.collapsed },
    get state() { return { ...state, visitors: [...present], placement, dragging } },
    dispose() {
      clearInterval(timer)
      clearTimeout(hideTimer)
      world.renderFrame = renderFrame
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      try { offWindow?.() } catch { /* ignore */ }
      for (const off of offs) { try { off?.() } catch { /* ignore */ } }
      pane.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      pane.removeEventListener('lostpointercapture', onUp)
      tab.remove(); fold.remove(); grip.remove()
      document.body.classList.remove('pp-collapsed', 'pp-hold', 'pp-floating', 'pp-dragging')
    },
  }
  window.petpackCollapse = api
  return api
}
