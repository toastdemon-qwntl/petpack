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

/** One message slot per pet, then one collision layout for the whole pane. */
export function createBubbles(overlay, camera, stage) {
  const root = document.createElement('div')
  root.className = 'petpack-fx'
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./fx.css', import.meta.url).href
  root.append(stylesheet); overlay.append(root)
  const projected = new THREE.Vector3(), ink = document.createElement('canvas')
  const pixelScale = Math.max(1, Number(stage?.pixelScale) || 2)
  const entries = new Set(), reservations = new Set(), requests = [], silhouettes = []
  let width = overlay.clientWidth || 520, height = overlay.clientHeight || 340, time = 0
  const snap = n => Math.round(n / pixelScale) * pixelScale
  const margin = pixelScale * 3, gap = pixelScale * 2
  const hide = element => { element.hidden = true; element.style.visibility = 'hidden' }
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
  }
  function screen(point) {
    projected.copy(point).project(camera)
    const result = stage?.toScreen ? stage.toScreen(point) : {
      x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height,
    }
    return { ...result, inDepth: projected.z > -1 && projected.z < 1 }
  }
  function request(element, point, { content, alpha = 1, offset = 0, bottom = true, priority = 1, belowY } = {}) {
    hide(element)
    if (!element.isConnected || alpha <= .01) return
    const anchor = screen(point)
    // A neighbour's off-screen pet must not acquire a ghost bubble at this seam.
    if (!anchor.inDepth || anchor.x < 0 || anchor.x >= width || anchor.y < -height || anchor.y > height) return
    if (content) paint(element, content)
    requests.push({ element, anchor, content, alpha, priority, bottom, offset, belowY })
  }
  function contentOf(entry) {
    return entry.active?.type === 'message' ? entry.active
      : entry.active?.type === 'reservation' ? entry.active.content.get(entry) || { status: 'idle' }
        : { status: entry.status }
  }
  function release(token, result = true) {
    reservations.delete(token); token.cancelled = !result; token.ready = false
    for (const entry of token.entries) {
      if (entry.active === token) entry.active = null
      entry.queue = entry.queue.filter(item => item !== token)
    }
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
      for (const item of entry.queue) item.resolve?.(false)
      entry.label.remove(); entry.bubble.remove(); entries.delete(entry)
    },
    status(entry, status) { entry.status = statuses.has(status) ? status : 'idle' },
    say(entry, text) {
      text = String(text ?? '').slice(0, 180).trim()
      if (!text || !entries.has(entry)) return Promise.resolve(false)
      return new Promise(resolve => entry.queue.push({ type: 'message', text,
        remaining: Math.max(2.2, Math.min(7, text.length * .055)), resolve }))
    },
    reserve(participants) {
      const token = { type: 'reservation', entries: [...new Set(participants)], content: new Map(), ready: false, cancelled: false }
      reservations.add(token)
      for (const entry of token.entries) entry.queue.push(token)
      return token
    },
    present(token, entry, content) { if (token.ready) token.content.set(entry, content) },
    release,
    begin(dt, t) {
      time = t; requests.length = 0; silhouettes.length = 0
      for (const entry of entries) {
        let left = dt
        // Carry elapsed time across queued speech without depending on Promise microtasks.
        while (true) {
          if (!entry.active && entry.queue[0]?.type === 'message') entry.active = entry.queue.shift()
          if (entry.active?.type !== 'message') break
          const used = Math.min(left, entry.active.remaining)
          entry.active.remaining -= used; left -= used
          if (entry.active.remaining > .00001) break
          entry.active.resolve(true); entry.active = null
          if (left <= 0) break
        }
      }
      for (const token of reservations) {
        if (!token.ready && token.entries.every(entry => !entry.active && entry.queue[0] === token)) {
          token.ready = true
          for (const entry of token.entries) { entry.queue.shift(); entry.active = token }
        }
      }
    },
    update(entry, feet, head, dt, _t, visible = true) {
      const content = contentOf(entry), target = content.text || content.status !== 'idle' ? 1 : 0
      entry.sayTime = entry.active?.remaining || (content.text ? 1 : 0); entry.text = content.text || ''
      entry.spring += (target - entry.spring) * (1 - Math.exp(-dt * 18))
      hide(entry.bubble); hide(entry.label)
      if (!visible) return
      const footScreen = screen(feet), headScreen = screen(head)
      if (Math.max(footScreen.y, headScreen.y) < 0 || Math.min(footScreen.y, headScreen.y) > height) return
      if (footScreen.x >= 0 && footScreen.x < width) {
        const shoulder = head.clone(); shoulder.x += (head.y - feet.y) * .48
        const halfWidth = Math.abs(screen(shoulder).x - headScreen.x)
        silhouettes.push({ x: footScreen.x - halfWidth, y: headScreen.y - pixelScale * 2,
          w: halfWidth * 2, h: Math.max(0, footScreen.y - headScreen.y) + pixelScale * 3 })
      }
      if (target) request(entry.bubble, head, { content, alpha: entry.spring,
        offset: -pixelScale * 3, belowY: footScreen.y + pixelScale * 5,
        priority: entry.active ? 0 : 2 })
      if (entry.name) request(entry.label, feet, { offset: pixelScale * 3, bottom: false, priority: 3, alpha: .96 })
    },
    createGiftLabel(text) {
      if (!text) return null
      const element = canvas('fx-gift-label', String(text))
      element._content = { text: String(text).slice(0, 64) }
      return element
    },
    projectGift(element, point, opacity, lift = 0) {
      if (element) request(element, point, { content: element._content, alpha: opacity,
        offset: -pixelScale * (5 + lift), priority: 1 })
    },
    layout() {
      const occupied = [...silhouettes]
      requests.sort((a, b) => a.priority - b.priority)
      for (const item of requests) {
        const { element, anchor, content } = item
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
          xs.add(fitX(box.x - w - gap)); xs.add(fitX(box.x + box.w + gap))
          ys.add(fitY(box.y - h - gap)); ys.add(fitY(box.y + box.h + gap))
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
        if (content) paint(element, content, (anchor.x - best.x) / pixelScale, best.y >= anchor.y)
        element.hidden = false; element.style.visibility = 'visible'
        element.style.transform = `translate3d(${best.x}px,${best.y}px,0)`
        element.style.opacity = String(clamp(item.alpha, 0, 1))
      }
    },
    resize(w, h) { width = w; height = h },
    dispose() {
      for (const entry of [...entries]) this.detach(entry)
      root.remove()
    },
  }
}
