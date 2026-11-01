import * as THREE from 'three'

const icons = {
  waiting: '<circle cx="10" cy="10" r="7.5" fill="#fff0f0" stroke="#ef6468" stroke-width="1.7"/><path d="M10 5.5v4.8l3 1.8" fill="none" stroke="#ef6468" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  done: '<circle cx="10" cy="10" r="9" fill="#e6f8ee"/><path d="m5.8 10 2.8 2.8 5.6-5.7" fill="none" stroke="#2dbb79" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  failed: '<circle cx="10" cy="10" r="9" fill="#fff0f0"/><path d="m7 7 6 6m0-6-6 6" fill="none" stroke="#ed626a" stroke-width="2.1" stroke-linecap="round"/>',
}
const clamp = THREE.MathUtils.clamp

export function createBubbles(overlay, camera) {
  const root = document.createElement('div')
  root.className = 'petpack-fx'
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'
  stylesheet.href = new URL('./fx.css', import.meta.url).href
  root.append(stylesheet)
  overlay.append(root)
  const projected = new THREE.Vector3()
  let width = overlay.clientWidth || 600
  let height = overlay.clientHeight || 300

  function project(element, point, offsetY, scale = 1, bottom = false, alpha = 1) {
    projected.copy(point).project(camera)
    const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.15
      && Math.abs(projected.y) < 1.25 && scale > .015
    element.hidden = !visible
    // Author CSS uses display:flex for bubbles; explicitly hide clipped elements.
    element.style.visibility = visible ? 'visible' : 'hidden'
    if (!visible) return
    const x = (projected.x * .5 + .5) * width
    const y = (-projected.y * .5 + .5) * height + offsetY
    element.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) translate(-50%,${bottom ? '-100%' : '0'}) scale(${scale.toFixed(4)})`
    element.style.opacity = clamp(alpha, 0, 1).toFixed(3)
  }

  function paint(entry) {
    const key = entry.sayTime > 0 ? `say:${entry.text}` : entry.status
    if (key === entry.content || (key === 'idle' && entry.spring > .015)) return
    entry.content = key
    entry.dots = []
    entry.bubble.replaceChildren()
    if (entry.sayTime > 0) {
      entry.bubble.textContent = entry.text
      entry.bubble.setAttribute('aria-label', entry.text)
    } else if (entry.status === 'working') {
      const working = document.createElement('span')
      working.className = 'fx-working'
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement('i')
        working.append(dot); entry.dots.push(dot)
      }
      entry.bubble.append(working)
      entry.bubble.setAttribute('aria-label', 'Working')
    } else if (icons[entry.status]) {
      // Only fixed, local icon markup enters this branch. Names/text use textContent.
      entry.bubble.innerHTML = `<svg class="fx-status-icon" viewBox="0 0 20 20" aria-hidden="true">${icons[entry.status]}</svg>`
      entry.bubble.setAttribute('aria-label', entry.status)
    }
  }

  return {
    attach({ name, isMe, color }) {
      const label = document.createElement('div')
      label.className = 'fx-name'; label.textContent = name || ''
      label.dataset.me = String(Boolean(isMe))
      label.style.setProperty('--peer-color', `#${color.getHexString()}`)
      const bubble = document.createElement('div')
      bubble.className = 'fx-bubble'; bubble.setAttribute('role', 'status')
      bubble.style.visibility = label.style.visibility = 'hidden'
      root.append(label, bubble)
      return { label, bubble, status: 'idle', sayTime: 0, text: '', content: '', dots: [], spring: 0, velocity: 0 }
    },
    detach(entry) { entry.label.remove(); entry.bubble.remove() },
    status(entry, status) {
      entry.status = status === 'working' || icons[status] ? status : 'idle'
      paint(entry)
    },
    say(entry, text) {
      entry.text = String(text ?? '').slice(0, 200)
      entry.sayTime = entry.text ? 2.5 : 0
      entry.velocity = 2.5
      paint(entry)
    },
    update(entry, feet, head, dt, t) {
      entry.sayTime = Math.max(0, entry.sayTime - dt)
      paint(entry)
      const target = entry.sayTime > 0 || entry.status !== 'idle' ? 1 : 0
      let remaining = Math.min(dt, .1)
      while (remaining > 0) {
        const step = Math.min(remaining, 1 / 120)
        entry.velocity += ((target - entry.spring) * 330 - entry.velocity * 26) * step
        entry.spring += entry.velocity * step
        remaining -= step
      }
      const spring = Math.max(0, entry.spring)
      project(entry.label, feet, 7, 1, false, .78)
      project(entry.bubble, head, -7, spring, true, spring)
      for (let i = 0; i < entry.dots.length; i++) {
        const bounce = Math.max(0, Math.sin(t * 6 - i * .8))
        entry.dots[i].style.transform = `translateY(${-bounce * 3}px)`
        entry.dots[i].style.opacity = String(.55 + bounce * .45)
      }
    },
    createGiftLabel(text) {
      if (!text) return null
      const element = document.createElement('div')
      element.className = 'fx-gift-label'; element.textContent = String(text).slice(0, 80)
      element.style.visibility = 'hidden'; root.append(element)
      return element
    },
    projectGift(element, point, opacity) {
      if (element) project(element, point, -16, .85 + opacity * .15, true, opacity)
    },
    resize(w, h) { width = w; height = h },
    dispose() { root.remove() },
  }
}
