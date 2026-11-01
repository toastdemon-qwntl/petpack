import * as THREE from 'three'
import { paintPixelText } from './fx-art.js'

const clamp = THREE.MathUtils.clamp
const statuses = new Set(['idle', 'working', 'waiting', 'done', 'failed'])
const icons = {
  waiting: ['..rrrrr..', '.r.....r.', 'r...r...r', 'r...r...r', 'r...rrr.r', 'r.......r', 'r.......r', '.r.....r.', '..rrrrr..'],
  done: ['........g', '.......gg', '......gg.', '.....gg..', 'g...gg...', 'gg.gg....', '.ggg.....', '..g......', '.........'],
  failed: ['rr.....rr', '.rr...rr.', '..rr.rr..', '...rrr...', '....r....', '...rrr...', '..rr.rr..', '.rr...rr.', 'rr.....rr'],
}
function stepRect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color
  ctx.fillRect(x + 2, y, w - 4, h)
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2)
  ctx.fillRect(x, y + 2, w, h - 4)
}
function frame(ctx, w, h, tailX, below) {
  const y = below ? 4 : 0, body = h - 4
  stepRect(ctx, 0, y + 1, w, body, '#766f5d')
  stepRect(ctx, 0, y, w, body - 1, '#8c866e')
  stepRect(ctx, 1, y + 1, w - 2, body - 3, '#fff9e9')
  ctx.fillStyle = '#ffffff'; ctx.fillRect(3, y + 1, w - 6, 1)
  const x = clamp(Math.round(tailX), 4, w - 5)
  ctx.fillStyle = '#8c866e'
  ctx.fillRect(x - 2, below ? 3 : body - 1, 5, 2)
  ctx.fillRect(x - 1, below ? 2 : body + 1, 3, 1)
  ctx.fillRect(x, below ? 1 : body + 2, 1, 1)
  ctx.fillStyle = '#fff9e9'
  ctx.fillRect(x - 1, below ? 4 : body - 2, 3, 2)
  ctx.fillRect(x, below ? 3 : body, 1, 1)
}
const overlaps = (a, b, gap) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x
  && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y

// Exact critically damped spring for a moving target, with target-velocity
// feed-forward. A conventional stationary-target spring would add a second
// timeline of lag behind the already interpolated pet. This still damps starts,
// stops and corrections, but has no steady-state error during a uniform walk.
function follow(state, goal, travel, dt) {
  if (dt <= 0) { state.value = goal; state.velocity = 0; return }
  const frequency = 90, targetVelocity = travel / dt
  const displacement = state.value - (goal - travel)
  const relativeVelocity = state.velocity - targetVelocity
  const impulse = relativeVelocity + frequency * displacement
  const decay = Math.exp(-frequency * dt)
  const next = goal + (displacement + impulse * dt) * decay
  const crossed = (next - goal) * (state.value - goal) <= 0
  state.velocity = targetVelocity + (relativeVelocity - frequency * impulse * dt) * decay
  state.value = next
  if (crossed || Math.abs(next - goal) < .001) {
    state.value = goal; state.velocity = targetVelocity
  }
}

/** Per-pet FIFO speech, one speaking slot per pane, event-driven placement. */
export function createBubbles(overlay, camera, stage) {
  const root = document.createElement('div')
  root.className = 'petpack-fx'
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./fx.css', import.meta.url).href
  root.append(stylesheet); overlay.append(root)
  const projected = new THREE.Vector3(), right = new THREE.Vector3(), ink = document.createElement('canvas')
  const pixelScale = Math.max(1, Number(stage?.pixelScale) || 2)
  const entries = new Set(), reservations = new Set(), requests = [], silhouettes = []
  let width = overlay.clientWidth || 520, height = overlay.clientHeight || 340, time = 0
  let frameDt = 0, dirty = true, speaker = null, turn = null, order = 0
  let placed = new Map()
  const snap = n => Math.round(n / pixelScale) * pixelScale
  const margin = pixelScale * 3, gap = pixelScale * 2
  const hide = element => { if (!element.hidden) element.hidden = true }
  function canvas(className, text = '') {
    const element = document.createElement('canvas')
    element.className = className
    element.setAttribute('role', className === 'fx-bubble' ? 'status' : 'img')
    element.setAttribute('aria-label', text)
    hide(element); root.append(element)
    return element
  }
  function size(element, w, h) {
    if (element.width !== w) element.width = w
    if (element.height !== h) element.height = h
    element.style.width = `${w * pixelScale}px`; element.style.height = `${h * pixelScale}px`
    const ctx = element.getContext('2d')
    ctx.clearRect(0, 0, w, h); ctx.imageSmoothingEnabled = false
    return ctx
  }
  function paint(element, content, tailX = element.width / 2, below = false) {
    const text = content?.text || '', status = content?.status || 'idle'
    const limit = Math.max(5, Math.min(96, Math.floor((width - 2 * margin) / pixelScale) - 12))
    const key = `${text}|${status}|${status === 'working' ? Math.floor(time * 8) : ''}|${limit}|${Math.round(tailX)}|${below}`
    if (element._paint === key) return
    element._paint = key
    let w, h
    if (text) ({ width: w, height: h } = paintPixelText(ink, text, { color: '#405348', maxWidth: limit }))
    const ctx = size(element, text ? Math.max(21, w + 12) : status === 'working' ? 25 : 21, text ? h + 14 : 23)
    frame(ctx, element.width, element.height, tailX, below)
    const top = below ? 4 : 0
    if (text) ctx.drawImage(ink, Math.floor((element.width - w) / 2), 4 + top)
    else if (status === 'working') {
      for (let i = 0; i < 3; i++) {
        const bounce = Math.round(Math.max(0, Math.sin(time * 6 - i * .85)) * 2)
        ctx.fillStyle = '#788574'; ctx.fillRect(5 + i * 6, 8 + top - bounce, 3, 3)
        ctx.fillStyle = '#bac4a3'; ctx.fillRect(5 + i * 6, 8 + top - bounce, 1, 1)
      }
    } else {
      const pattern = icons[status]
      if (pattern) for (let y = 0; y < pattern.length; y++) for (let x = 0; x < pattern[y].length; x++) {
        if (pattern[y][x] === '.') continue
        ctx.fillStyle = pattern[y][x] === 'g' ? '#469365' : '#c9655b'
        ctx.fillRect(6 + x, 4 + top + y, 1, 1)
      }
    }
    element.setAttribute('aria-label', text || status)
  }
  function rename(entry, { name, isMe, color }) {
    const safeName = String(name || '').slice(0, 28)
    entry.name = safeName
    const { width: w, height: h } = paintPixelText(ink, safeName, { color: '#405348', maxWidth: 90 })
    const ctx = size(entry.label, w + (isMe ? 10 : 6), h + 5)
    if (safeName) {
      stepRect(ctx, 0, 0, entry.label.width, entry.label.height, '#fff7dfeb')
      if (isMe) {
        ctx.fillStyle = `#${color.getHexString()}`; ctx.fillRect(3, 3, 2, 2)
        ctx.fillStyle = '#fffef2'; ctx.fillRect(3, 3, 1, 1)
      }
      ctx.drawImage(ink, isMe ? 7 : 3, 2)
    }
    entry.label.setAttribute('aria-label', safeName)
    dirty = true
  }
  function screen(point) {
    projected.copy(point).project(camera)
    const result = stage?.toScreen ? stage.toScreen(point) : {
      x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height,
    }
    return { ...result, inDepth: projected.z > -1 && projected.z < 1 }
  }
  function request(element, anchor, { content, alpha = 1, offset = 0, bottom = true, priority = 1, belowY, motion } = {}) {
    if (!element.isConnected || alpha <= .01) return
    // A neighbour's off-screen pet must not acquire a ghost bubble at this seam.
    if (!anchor.inDepth || anchor.x < 0 || anchor.x >= width || anchor.y < -height || anchor.y > height) return
    const identity = content ? `${content.text || ''}|${content.status || 'idle'}` : element.getAttribute('aria-label')
    if (content) paint(element, content, element._placement?.tail, element._placement?.below)
    requests.push({ element, anchor, content, alpha, priority, bottom, offset, belowY, identity, motion })
  }
  function track(entry, feet, head, dt) {
    const foot = screen(feet), top = screen(head)
    const previous = entry.motion
    // Derive the art viewport from the camera and final-image scale. This is
    // the cast-atlas feet snap, BEFORE the stage's overscan crop/blit. Do not
    // round stage.toScreen to the art grid: its origin includes the blit offset.
    let rasterX = 0, rasterY = 0
    if (stage?.toScreen && camera.isOrthographicCamera) {
      right.setFromMatrixColumn(camera.matrixWorld, 0).add(feet)
      const scale = Math.abs(stage.toScreen(right).x - foot.x) / pixelScale
      const artW = (camera.right - camera.left) * scale / camera.zoom
      const artH = (camera.top - camera.bottom) * scale / camera.zoom
      projected.copy(feet).project(camera)
      const x = (projected.x + 1) * artW / 2, y = (projected.y + 1) * artH / 2
      rasterX = (Math.floor(x + .5) - x) * pixelScale
      rasterY = -(Math.floor(y + .5) - y) * pixelScale
    }
    const dx = previous ? foot.x - previous.x : 0, dy = previous ? foot.y - previous.y : 0
    const still = previous && Math.hypot(dx, dy) < .001 ? previous.still + dt : 0
    // Debounce rest so a repeated network sample cannot toggle the art snap.
    const motion = { x: foot.x, y: foot.y, dx, dy, still, resting: still >= .12, rasterX, rasterY }
    entry.motion = motion
    return { foot, top, motion }
  }
  function contentOf(entry) {
    return entry.active?.type === 'message' ? entry.active
      : entry.active?.type === 'reservation' ? entry.active.content.get(entry) || { status: 'idle' }
        : { status: entry.status }
  }
  function release(token, result = true) {
    reservations.delete(token); token.cancelled = !result; token.ready = false
    if (turn === token) turn = null
    for (const entry of token.entries) {
      if (entry.active === token) entry.active = null
      entry.queue = entry.queue.filter(item => item !== token)
    }
  }
  function claimTurn() {
    if (turn) return
    // Queue order is independent of which chunk this pane can see. Adjacent
    // panes must advance an ask/gift on the same clock, even across the seam.
    const candidates = [...new Set([...entries].map(entry => entry.queue[0]).filter(Boolean))]
      .filter(item => item.type === 'message' || item.entries.every(entry => !entry.active && entry.queue[0] === item))
    turn = candidates.reduce((first, item) => !first || item.order < first.order ? item : first, null)
    if (!turn) return
    const participants = turn.type === 'message' ? [turn.entry] : turn.entries
    for (const entry of participants) { entry.queue.shift(); entry.active = turn }
    if (turn.type === 'reservation') turn.ready = true
  }
  return {
    attach(metadata) {
      const entry = { label: canvas('fx-name'), bubble: canvas('fx-bubble'), status: 'idle',
        active: null, queue: [], spring: 0, name: '', sayTime: 0, text: '' }
      entries.add(entry); rename(entry, metadata)
      return entry
    },
    rename,
    detach(entry) {
      for (const token of reservations) if (token.entries.includes(entry)) release(token, false)
      entry.active?.resolve?.(false)
      if (turn?.entry === entry) turn = null
      for (const item of entry.queue) item.resolve?.(false)
      entry.label.remove(); entry.bubble.remove(); entries.delete(entry)
      dirty = true
    },
    status(entry, status) { entry.status = statuses.has(status) ? status : 'idle' },
    say(entry, text) {
      text = String(text ?? '').slice(0, 180).trim()
      if (!text || !entries.has(entry)) return Promise.resolve(false)
      return new Promise(resolve => entry.queue.push({ type: 'message', text, entry, order: order++,
        remaining: Math.max(2.2, Math.min(7, text.length * .055)), resolve }))
    },
    reserve(participants) {
      const token = { type: 'reservation', entries: [...new Set(participants)], content: new Map(), ready: false, cancelled: false, order: order++ }
      reservations.add(token)
      for (const entry of token.entries) entry.queue.push(token)
      return token
    },
    present(token, entry, content) { if (token.ready) token.content.set(entry, content) },
    release,
    begin(dt, t) {
      time = t; frameDt = Number.isFinite(dt) ? clamp(dt, 0, .25) : 0
      requests.length = 0; silhouettes.length = 0
      let left = Number.isFinite(dt) ? Math.max(0, dt) : 0
      claimTurn()
      // Carry elapsed time across ordinary speech without Promise microtasks.
      while (turn?.type === 'message') {
        const used = Math.min(left, turn.remaining)
        turn.remaining -= used; left -= used
        if (turn.remaining > .00001) break
        turn.resolve(true); turn.entry.active = null; turn = null
        claimTurn()
        if (left <= 0) break
      }
    },
    update(entry, feet, head, dt, _t, visible = true) {
      const content = contentOf(entry), target = content.text || content.status !== 'idle' ? 1 : 0
      entry.sayTime = entry.active?.remaining || (content.text ? 1 : 0); entry.text = content.text || ''
      entry.spring += (target - entry.spring) * (1 - Math.exp(-dt * 18))
      entry.inPane = false
      if (!visible) { entry.motion = null; return }
      const { foot: footScreen, top: headScreen, motion } = track(entry, feet, head, frameDt)
      if (Math.max(footScreen.y, headScreen.y) < 0 || Math.min(footScreen.y, headScreen.y) > height) return
      if (footScreen.x >= 0 && footScreen.x < width) {
        entry.inPane = true
        const shoulder = head.clone(); shoulder.x += (head.y - feet.y) * .48
        const halfWidth = Math.abs(screen(shoulder).x - headScreen.x)
        silhouettes.push({ x: footScreen.x - halfWidth, y: headScreen.y - pixelScale * 2,
          w: halfWidth * 2, h: Math.max(0, footScreen.y - headScreen.y) + pixelScale * 3 })
      }
      if (target) request(entry.bubble, headScreen, { content, alpha: entry.spring, motion,
        offset: -pixelScale * 3, belowY: footScreen.y + pixelScale * 5,
        priority: entry.active ? 0 : 2 })
      if (entry.name) request(entry.label, footScreen, { offset: pixelScale * 3, bottom: false, priority: 3, alpha: .96, motion })
    },
    createGiftLabel(text) {
      if (!text) return null
      const element = canvas('fx-gift-label', String(text))
      element._content = { text: String(text).slice(0, 64) }
      return element
    },
    projectGift(element, point, opacity, lift = 0) {
      if (element) request(element, screen(point), { content: element._content, alpha: opacity,
        offset: -pixelScale * (5 + lift), priority: 1 })
    },
    layout() {
      // Arbitration is stable while a speaker remains eligible. Names do not
      // occupy the speech slot; gift/collaboration captions do.
      const candidates = requests.filter(item => item.element.className !== 'fx-name')
      const priority = Math.min(...candidates.map(item => item.priority))
      const chosen = candidates.find(item => item.element === speaker && item.priority === priority)
        || candidates.find(item => item.priority === priority)
      speaker = chosen?.element || null
      const visible = requests.filter(item => item.element.className === 'fx-name' || item === chosen)
      const next = new Map(visible.map(item => [item.element, item.identity]))
      if (next.size !== placed.size || [...next].some(([el, key]) => placed.get(el) !== key)) dirty = true
      for (const [element, identity] of next) if (placed.get(element) !== identity) element._follow = null
      for (const element of placed.keys()) if (!next.has(element)) { hide(element); element._follow = null }
      for (const item of requests) if (!next.has(item.element)) hide(item.element)
      if (dirty) restack(visible)
      placed = next; dirty = false
      for (const item of visible) position(item)
    },
    resize(w, h) { if (width !== w || height !== h) { width = w; height = h; dirty = true } },
    dispose() {
      for (const entry of [...entries]) this.detach(entry)
      root.remove(); placed.clear()
    },
  }

  function restack(items) {
      const occupied = [...silhouettes]
      items.sort((a, b) => a.priority - b.priority)
      for (const item of items) {
        const { element, anchor, content } = item
        element._placement = null
        const w = element.width * pixelScale, h = element.height * pixelScale
        const maxX = Math.floor((width - margin - w) / pixelScale) * pixelScale
        const maxY = Math.floor((height - margin - h) / pixelScale) * pixelScale
        if (maxX < margin || maxY < margin) continue
        const fitX = x => clamp(snap(x), margin, maxX), fitY = y => clamp(snap(y), margin, maxY)
        const idealX = anchor.x - w / 2
        let idealY = anchor.y + item.offset - (item.bottom ? h : 0)
        if (idealY < margin && item.belowY !== undefined) idealY = item.belowY
        const xs = new Set([fitX(idealX), margin, maxX])
        const ys = new Set([fitY(idealY), margin, maxY])
        if (item.belowY !== undefined) ys.add(fitY(item.belowY))
        for (const box of occupied) {
          // Round away from occupied bounds, never into the forbidden gap.
          xs.add(fitX(Math.floor((box.x - w - gap) / pixelScale) * pixelScale))
          xs.add(fitX(Math.ceil((box.x + box.w + gap) / pixelScale) * pixelScale))
          ys.add(fitY(Math.floor((box.y - h - gap) / pixelScale) * pixelScale))
          ys.add(fitY(Math.ceil((box.y + box.h + gap) / pixelScale) * pixelScale))
        }
        let best = null, cost = Infinity
        for (const x of xs) for (const y of ys) {
          const box = { x, y, w, h }
          if (occupied.some(other => overlaps(box, other, gap))) continue
          const distance = (x - idealX) ** 2 + (y - idealY) ** 2 * 1.3
          if (distance < cost) { best = box; cost = distance }
        }
        // A full pane yields lower-priority labels; it never paints intersecting rectangles.
        if (!best) continue
        occupied.push(best)
        const tail = (anchor.x - best.x) / pixelScale, below = best.y >= anchor.y
        element._placement = { x: best.x - anchor.x, y: best.y - anchor.y, tail, below }
        if (content) paint(element, content, tail, below)
      }
  }

  function position({ element, anchor, motion, alpha }) {
    const placement = element._placement
    if (!placement) { hide(element); return }
    let x = anchor.x + placement.x, y = anchor.y + placement.y
    const old = element._follow
    const travelX = old ? anchor.x - old.anchorX : 0, travelY = old ? anchor.y - old.anchorY : 0
    // Snap only after rest. Keep the cast's raster correction separate from
    // the continuous spring so art-pixel steps do not excite the spring.
    if (motion?.resting) { x = snap(x); y = snap(y) }
    const state = old || { x: { value: x, velocity: 0 }, y: { value: y, velocity: 0 } }
    follow(state.x, x, travelX, frameDt); follow(state.y, y, travelY, frameDt)
    state.anchorX = anchor.x; state.anchorY = anchor.y
    element._follow = state
    const finalX = Math.round(state.x.value + (motion?.rasterX || 0))
    const finalY = Math.round(state.y.value + (motion?.rasterY || 0))
    const transform = `translate3d(${finalX}px,${finalY}px,0)`
    if (element.style.transform !== transform) element.style.transform = transform
    element.style.opacity = String(clamp(alpha, 0, 1))
    element.hidden = false
  }
}
