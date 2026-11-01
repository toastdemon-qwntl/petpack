import * as THREE from 'three'
import { createGlowField, seedFor } from './fx-sprites.js'

const TAU = Math.PI * 2
const cream = new THREE.Color('#fff3cc')
const blue = new THREE.Color('#9ccbea')
const gold = new THREE.Color('#ffd77b')
const coral = new THREE.Color('#e89883')
const clamp = value => Math.max(0, Math.min(1, value))
const settle = value => 1 - (1 + value * 7) * Math.exp(-value * 7)
const valid = point => [point?.x, point?.y ?? 0, point?.z].every(Number.isFinite)

/** Small shared-world celebrations; only the glass tap belongs to the DOM. */
export function createMoments({ scene, camera, overlay, stage }) {
  const root = new THREE.Group()
  root.name = 'petpack-moments'
  scene.add(root)
  const pixelScale = Math.max(1, Number(stage?.pixelScale) || 2)
  const field = createGlowField(root, camera, 2048, { pixelScale })
  const glass = document.createElement('div')
  glass.className = 'petpack-glass-taps'
  glass.setAttribute('aria-hidden', 'true')
  Object.assign(glass.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none', zIndex: '4' })
  overlay.append(glass)
  const effects = new Set(), taps = new Set()
  const projected = new THREE.Vector3()
  let disposed = false, width = overlay.clientWidth || 520, height = overlay.clientHeight || 340

  function remove(effect, result = false) {
    if (!effects.delete(effect)) return
    effect.resolve?.(result)
  }
  function add(effect) {
    // In a very busy world old completed moments yield to current life.
    while (effects.size >= 24) remove(effects.values().next().value)
    effects.add(effect)
    return effect
  }
  function burst(point) {
    if (disposed || !valid(point)) return
    add({ ...point, y: point.y ?? 0, color: new THREE.Color(point.color || cream), type: 'burst', age: 0 })
  }
  function drawBurst(effect, age, radius = 1.05, count = 18) {
    const progress = clamp(age / .85)
    const spread = settle(progress) * radius
    for (let i = 0; i < count; i++) {
      const angle = i / count * TAU
      const length = spread * (i % 3 ? 1 : .66)
      field.add(effect.x + Math.cos(angle) * length, effect.y + Math.sin(angle) * length * .9 - progress * progress * .18,
        effect.z + .06, i % 3 ? effect.color : cream, i % 3 ? .14 : .26, (1 - progress) * .95, i % 3 ? 'dot' : 'sparkle')
    }
    field.add(effect.x, effect.y, effect.z + .1, cream, .72 * (1 - progress), clamp(1 - progress * 3), 'sparkle')
  }
  function bridge({ x, y = 0, z } = {}) {
    const inert = { touch() {}, finish() {}, cancel() {} }
    if (disposed || !valid({ x, y, z })) return inert
    const effect = add({ type: 'bridge', x, y, z, age: 0, finished: null, touched: false, phase: seedFor(`${x}:${z}`) * TAU })
    return {
      touch(point = {}) {
        if (!effects.has(effect) || effect.touched) return
        effect.touched = true
        burst({ x, y: y + 1.7, z: z + .12, color: gold, ...point })
      },
      finish() { if (effects.has(effect) && effect.finished === null) effect.finished = 0 },
      cancel() { remove(effect) },
    }
  }
  function celebrate({ x, y = 0, z, color = gold } = {}) {
    if (disposed || !valid({ x, y, z })) return Promise.resolve(false)
    let effect
    const promise = new Promise(resolve => { effect = add({ type: 'celebrate', x, y, z, age: 0, resolve,
      color: new THREE.Color(color), phase: seedFor(`${x}:${z}`) * TAU }) })
    promise.cancel = () => remove(effect)
    return promise
  }
  function tap({ x, y = 0, z } = {}) {
    if (disposed || !valid({ x, y, z })) return
    while (taps.size >= 8) {
      const old = taps.values().next().value
      old.canvas.remove(); taps.delete(old)
    }
    const canvas = document.createElement('canvas')
    canvas.className = 'petpack-tap-ripple'
    canvas.width = 56; canvas.height = 56
    Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: `${56 * pixelScale}px`,
      height: `${56 * pixelScale}px`, imageRendering: 'pixelated', pointerEvents: 'none' })
    glass.append(canvas)
    taps.add({ x, y, z, age: 0, canvas, context: canvas.getContext('2d') })
  }
  function drawBridge(effect, dt) {
    if (effect.finished !== null) effect.finished += dt
    if (effect.finished >= 5 || effect.age >= 18) { remove(effect); return }
    const growth = settle(clamp(effect.age / 1.05)) / settle(1)
    const resting = effect.finished !== null
    const fade = resting ? clamp((5 - effect.finished) / 1.2) : 1
    const quiet = resting ? .26 : 1
    for (let i = 0; i < 57; i++) {
      const ratio = i / 56, dx = (ratio * 2 - 1) * 2.35
      if (Math.abs(dx) > growth * 2.35) continue
      const arch = Math.sin(ratio * Math.PI)
      const shimmer = .62 + .38 * Math.sin(effect.age * 3.5 - i * .67 + effect.phase) ** 2
      for (const side of [-1, 1]) {
        field.add(effect.x + dx, effect.y + .17 + arch * .32,
          effect.z + side * .37, i % 5 ? cream : blue, i % 5 ? .1 : .19, shimmer * fade * quiet, i % 5 ? 'dot' : 'sparkle')
      }
      if (!resting && i % 4 === 0) {
        const drift = (effect.age * .6 + i * .137) % 1
        field.add(effect.x + dx, effect.y + .3 + drift * .65, effect.z + Math.sin(i * 1.7) * .35,
          gold, .13, (1 - drift) * fade * .7, 'sparkle')
      }
    }
  }
  function drawCelebration(effect) {
    if (effect.age >= 3.25) { remove(effect, true); return }
    const colors = [effect.color, gold, blue]
    for (let flower = 0; flower < 3; flower++) {
      const age = effect.age - flower * .48
      if (age < 0) continue
      const x = effect.x + [0, -1.15, 1.2][flower]
      const peak = effect.y + [1.9, 1.45, 1.65][flower]
      const z = effect.z + flower * .12
      if (age < .55) {
        const rise = clamp(age / .55)
        for (let trail = 0; trail < 5; trail++) {
          const p = Math.max(0, rise - trail * .065)
          field.add(x, effect.y + (peak - effect.y) * p, z, trail ? colors[flower] : cream,
            trail ? .09 : .21, 1 - trail / 6, trail ? 'dot' : 'sparkle')
        }
        continue
      }
      const burstAge = age - .55, p = clamp(burstAge / 1.35)
      if (p >= 1) continue
      const spread = settle(p * 1.4) * [1.35, 1.1, 1.2][flower]
      for (let i = 0; i < 20; i++) {
        const angle = i * TAU / 20 + flower * .28 + effect.phase
        const vx = Math.cos(angle), vy = Math.sin(angle)
        for (let tail = 0; tail < 2; tail++) {
          const radius = spread * (1 - tail * .12) * (i % 2 ? .75 : 1)
          field.add(x + vx * radius, peak + vy * radius - p * p * .55, z + .1,
            tail ? colors[flower] : i % 4 ? colors[flower] : cream,
            i % 4 ? .17 : .30, Math.sqrt(1 - p) * (tail ? .45 : 1), i % 4 ? 'dot' : 'sparkle')
        }
      }
      field.add(x, peak, z + .15, cream, .58 * (1 - p), clamp(1 - p * 5), 'sparkle')
    }
  }
  function drawTap(effect) {
    const { canvas, context: ctx } = effect
    ctx.clearRect(0, 0, 56, 56)
    projected.set(effect.x, effect.y, effect.z)
    const point = stage?.toScreen ? stage.toScreen(projected) : (() => {
      projected.project(camera)
      return { x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height }
    })()
    canvas.hidden = point.x < 0 || point.x >= width || point.y < 0 || point.y > height
    const snap = value => Math.round(value / pixelScale) * pixelScale
    canvas.style.transform = `translate3d(${snap(point.x) - 28 * pixelScale}px,${snap(point.y) - 28 * pixelScale}px,0)`
    for (let ring = 0; ring < 2; ring++) {
      const age = effect.age - ring * .16
      if (age < 0 || age > .8) continue
      const p = age / .8, radius = Math.round(3 + settle(p) * 19)
      ctx.globalAlpha = (1 - p) * (ring ? .6 : .9)
      // One art-pixel contours. Drawing individual pixels avoids antialiasing.
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(Math.hypot(dx, dy) - radius) > .53) continue
        ctx.fillStyle = '#779ca9'; ctx.fillRect(28 + dx, 29 + dy, 1, 1)
        ctx.fillStyle = '#fff9df'; ctx.fillRect(28 + dx, 28 + dy, 1, 1)
      }
    }
    if (effect.age < .2) {
      ctx.globalAlpha = 1 - effect.age / .2
      ctx.fillStyle = '#fff9df'
      ctx.fillRect(27, 25, 2, 6); ctx.fillRect(25, 27, 6, 2)
    }
    ctx.globalAlpha = 1
  }
  function reset() {
    for (const effect of effects) remove(effect)
    for (const effect of taps) effect.canvas.remove()
    taps.clear()
    field.begin(); field.end()
  }
  return {
    bridge, burst, celebrate, tap,
    update(dt) {
      if (disposed) return
      dt = Number.isFinite(dt) ? Math.max(0, dt) : 0
      field.begin()
      for (const effect of effects) {
        effect.age += dt
        if (effect.type === 'bridge') drawBridge(effect, dt)
        else if (effect.type === 'celebrate') drawCelebration(effect)
        else if (effect.age >= .85) remove(effect)
        else drawBurst(effect, effect.age)
      }
      field.end()
      for (const effect of taps) {
        effect.age += dt
        if (effect.age >= .96) { effect.canvas.remove(); taps.delete(effect) }
        else drawTap(effect)
      }
    },
    resize(w, h) {
      width = Math.max(1, Number(w) || 1); height = Math.max(1, Number(h) || 1)
      field.resize(width, height)
    },
    reset,
    dispose() {
      if (disposed) return
      disposed = true; reset(); field.dispose(); root.removeFromParent(); glass.remove()
    },
  }
}
