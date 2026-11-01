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
function frame(ctx, w, h, tail = true) {
  const body = h - (tail ? 4 : 1)
  stepRect(ctx, 0, 1, w, body, '#766f5d')
  stepRect(ctx, 0, 0, w, body - 1, '#8c866e')
  stepRect(ctx, 1, 1, w - 2, body - 3, '#fff9e9')
  ctx.fillStyle = '#ffffff'; ctx.fillRect(3, 1, w - 6, 1)
  if (tail) {
    const x = Math.floor(w / 2) - 2
    ctx.fillStyle = '#8c866e'; ctx.fillRect(x, body - 1, 5, 2); ctx.fillRect(x + 1, body + 1, 3, 1)
    ctx.fillStyle = '#fff9e9'; ctx.fillRect(x + 1, body - 2, 3, 2); ctx.fillRect(x + 2, body, 1, 1)
  }
}

/** Canvas contents and DOM origins are both on the world's art-pixel grid. */
export function createBubbles(overlay, camera, stage) {
  const root = document.createElement('div')
  root.className = 'petpack-fx'
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./fx.css', import.meta.url).href
  root.append(stylesheet); overlay.append(root)
  const projected = new THREE.Vector3()
  const pixelScale = Math.max(1, Number(stage?.pixelScale) || 2)
  let width = overlay.clientWidth || 520, height = overlay.clientHeight || 340
  const snap = n => Math.round(n / pixelScale) * pixelScale
  const ink = document.createElement('canvas')
  function canvas(className, text = '') {
    const element = document.createElement('canvas')
    element.className = className
    element.setAttribute('role', className === 'fx-bubble' ? 'status' : 'img')
    element.setAttribute('aria-label', text)
    element.style.visibility = 'hidden'
    root.append(element)
    return element
  }
  function size(element, w, h) {
    if (element.width !== w) element.width = w
    if (element.height !== h) element.height = h
    element.style.width = `${w * pixelScale}px`
    element.style.height = `${h * pixelScale}px`
    const ctx = element.getContext('2d')
    ctx.clearRect(0, 0, w, h); ctx.imageSmoothingEnabled = false
    return ctx
  }
  function textBubble(element, text) {
    const { width: w, height: h } = paintPixelText(ink, text, { color: '#405348', maxWidth: 87 })
    const ctx = size(element, Math.max(19, w + 12), h + 14)
    frame(ctx, element.width, element.height)
    ctx.drawImage(ink, Math.floor((element.width - w) / 2), 4)
    element.setAttribute('aria-label', text)
  }
  function paint(entry, t = 0) {
    const key = entry.sayTime > 0 ? `say:${entry.text}` : entry.status === 'working' ? `work:${Math.floor(t * 8)}` : entry.status
    if (key === entry.content) return
    entry.content = key
    if (entry.sayTime > 0) { textBubble(entry.bubble, entry.text); return }
    const ctx = size(entry.bubble, entry.status === 'working' ? 25 : 21, 23)
    if (entry.status === 'idle') return
    frame(ctx, entry.bubble.width, entry.bubble.height)
    if (entry.status === 'working') {
      for (let i = 0; i < 3; i++) {
        const bounce = Math.round(Math.max(0, Math.sin(t * 6 - i * .85)) * 2)
        ctx.fillStyle = '#788574'; ctx.fillRect(5 + i * 6, 8 - bounce, 3, 3)
        ctx.fillStyle = '#bac4a3'; ctx.fillRect(5 + i * 6, 8 - bounce, 1, 1)
      }
    } else {
      const pattern = icons[entry.status]
      if (pattern) for (let y = 0; y < pattern.length; y++) for (let x = 0; x < pattern[y].length; x++) {
        if (pattern[y][x] === '.') continue
        ctx.fillStyle = pattern[y][x] === 'g' ? '#469365' : '#c9655b'
        ctx.fillRect(6 + x, 4 + y, 1, 1)
      }
    }
    entry.bubble.setAttribute('aria-label', entry.status)
  }
  function project(element, point, offset, bottom, alpha = 1) {
    projected.copy(point).project(camera)
    const screen = stage?.toScreen ? stage.toScreen(point) : {
      x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height,
    }
    const w = element.width * pixelScale, h = element.height * pixelScale
    const visible = alpha > .01 && projected.z > -1 && projected.z < 1
      && screen.x > -w && screen.x < width + w && screen.y > -h && screen.y < height + h
    element.hidden = !visible
    element.style.visibility = visible ? 'visible' : 'hidden'
    if (!visible) return
    // No percentage translation or fractional scale: neither can split art pixels.
    const x = snap(screen.x - w / 2)
    const y = snap(screen.y + offset - (bottom ? h : 0))
    element.style.transform = `translate3d(${x}px,${y}px,0)`
    element.style.opacity = String(clamp(alpha, 0, 1))
  }
  return {
    attach({ name, isMe, color }) {
      const safeName = String(name || '').slice(0, 28)
      const label = canvas('fx-name', safeName), bubble = canvas('fx-bubble')
      const { width: w, height: h } = paintPixelText(ink, safeName, { color: '#405348', maxWidth: 90 })
      const ctx = size(label, w + (isMe ? 10 : 6), h + 5)
      if (safeName) {
        stepRect(ctx, 0, 0, label.width, label.height, '#fff7dfeb')
        if (isMe) {
          ctx.fillStyle = `#${color.getHexString()}`; ctx.fillRect(3, 3, 2, 2)
          ctx.fillStyle = '#fffef2'; ctx.fillRect(3, 3, 1, 1)
        }
        ctx.drawImage(ink, isMe ? 7 : 3, 2)
      }
      return { label, bubble, status: 'idle', sayTime: 0, text: '', content: '', spring: 0 }
    },
    detach(entry) { entry.label.remove(); entry.bubble.remove() },
    status(entry, status) { entry.status = statuses.has(status) ? status : 'idle'; paint(entry) },
    say(entry, text) {
      entry.text = String(text ?? '').slice(0, 180)
      entry.sayTime = entry.text ? Math.max(3, Math.min(7, entry.text.length * .045)) : 0
      paint(entry)
    },
    update(entry, feet, head, dt, t, visible = true) {
      entry.sayTime = Math.max(0, entry.sayTime - dt)
      paint(entry, t)
      const target = entry.sayTime > 0 || entry.status !== 'idle' ? 1 : 0
      entry.spring += (target - entry.spring) * (1 - Math.exp(-dt * 18))
      project(entry.label, feet, pixelScale * 3, false, visible ? .96 : 0)
      project(entry.bubble, head, -pixelScale * (2 + Math.round((1 - entry.spring) * 3)), true,
        visible ? entry.spring : 0)
    },
    createGiftLabel(text) {
      if (!text) return null
      const element = canvas('fx-gift-label', String(text))
      textBubble(element, String(text).slice(0, 64))
      return element
    },
    projectGift(element, point, opacity) { if (element) project(element, point, -pixelScale * 5, true, opacity) },
    resize(w, h) { width = w; height = h },
    dispose() { root.remove() },
  }
}
