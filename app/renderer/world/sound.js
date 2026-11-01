/**
 * attachSound(world, { volume = .16, muted = false, ambience = true }) -> world
 * Additive, procedural WebAudio; no assets, DOM controls or extra render loop.
 *
 * world.setMuted(bool) / world.setSoundVolume(0..1)
 * world.unlockAudio() -> Promise<boolean> (also automatic on the first gesture)
 * world.playSound('gift'|'learn'|'knock'|'handshake'|'firework', petId|{x,y?,z})
 * world.soundSnapshot() -> read-only audio state; world.disposeSound() detaches.
 *
 * Direct gifts/giftFx, skill-count increases, map.bloom contacts (including ask
 * handovers), footsteps and the MOMENTS methods are decorated automatically.
 * Directors with private/queued FX can call playSound at their actual launch;
 * ask's private launch has no public event, so we never guess its queue timing.
 * A later FX adapter can use scene.userData.petpackSound(type, source, options).
 * Footsteps use the cast's 1.25-unit stride. Time/positions belong to this world;
 * offscreen one-shots become a faint cue within 1.4 units of a side edge only.
 * Optional context (caller-owned), onEvent and ambience:false support capture.
 */
import { Vector3 } from 'three'

const attached = new WeakMap()
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n))
const finite = Number.isFinite
const midi = note => 440 * 2 ** ((note - 69) / 12)
const valid = p => p && finite(p.x) && finite(p.z)
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const successful = value => value !== false && !value?.cancelled
const cues = new Set(['step', 'gift', 'learn', 'knock', 'handshake', 'firework'])

export function attachSound(world, options = {}) {
  if (attached.has(world)) return world
  const stage = world.stage, canvas = stage.renderer.domElement
  const doc = canvas.ownerDocument, win = doc.defaultView
  const point = new Vector3()
  const undo = [], voices = new Set(), footsteps = new Map(), skills = new Map()
  const learned = new Map(), knocks = new Map(), meetings = new Set(), fireworks = new Set()
  const counts = Object.create(null), recent = new Map()
  let disposed = false, context = options.context || null, ownsContext = !options.context
  let master, compressor, noiseBuffer, wind, windFilter, windGain, windPan
  let volume = finite(options.volume) ? clamp(options.volume) : .16
  let muted = !!options.muted, available = true, lastTime, time = 0, simulation = 0
  let nextBird = 2.7, nextCricket = .8, lastEdge = -Infinity, epoch = 0
  let silenceReplay = false
  const pending = new Set()

  function install(object, name, fn) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name)
    object[name] = fn
    undo.push(() => {
      if (object[name] !== fn) return
      if (descriptor) Object.defineProperty(object, name, descriptor)
      else delete object[name]
    })
  }
  function wrap(object, name, decorate) {
    const original = object?.[name]
    if (typeof original === 'function') install(object, name, function (...args) {
      if (disposed) return original.apply(this, args)
      return decorate(() => original.apply(this, args), args)
    })
  }
  function samples() { return world.snapshot?.() || [] }
  function pet(id) { return samples().find(p => p.id === id) }
  function location(source) {
    const p = valid(source) ? source : pet(source)
    if (!valid(p)) return null
    return { x: p.x, z: p.z, y: finite(p.y) ? p.y : (world.map.ground(p.x, p.z) || 0) + 1 }
  }
  function spatial(source) {
    const p = location(source)
    const width = canvas.clientWidth, height = canvas.clientHeight
    if (!p || width <= 0 || height <= 0) return null
    const screen = stage.toScreen(point.set(p.x, p.y, p.z))
    if (!finite(screen.x) || !finite(screen.y) || screen.y < 0 || screen.y >= height) return null
    const pan = clamp(screen.x / width * 2 - 1, -.96, .96)
    if (screen.x >= 0 && screen.x < width) return { pan, gain: 1, edge: false, ...p }
    const outside = Math.max(-screen.x, screen.x - width) / width * (world.map.chunkWidth || 14)
    if (outside >= 1.4) return null
    return { pan, gain: .09 * (1 - outside / 1.4) ** 2, edge: true, ...p }
  }
  function active() {
    return !disposed && !muted && volume > 0 && !doc.hidden && !silenceReplay && context?.state === 'running'
  }
  function report(type, position) {
    counts[type] = (counts[type] || 0) + 1
    // Diagnostics are optional and cannot break the world's animation loop.
    try { options.onEvent?.({ type, ...position, at: context.currentTime, simulation }) } catch { /* observer only */ }
  }
  function gainTarget(node, value, seconds = .025) {
    if (!node || !context || context.state === 'closed') return
    const at = context.currentTime
    node.gain.cancelScheduledValues(at)
    node.gain.setTargetAtTime(value, at, seconds)
  }
  function stopVoices() {
    for (const voice of [...voices]) {
      try { voice.source.stop() } catch { /* already ended */ }
      voice.cleanup()
    }
  }
  function syncGain() {
    gainTarget(master, muted || doc.hidden || disposed ? 0 : volume)
    if (muted || doc.hidden) stopVoices()
  }
  function boot() {
    if (disposed || !available) return false
    try {
      if (!context) {
        const AudioContext = win.AudioContext || win.webkitAudioContext
        if (!AudioContext) { available = false; return false }
        context = new AudioContext({ latencyHint: 'interactive' })
      }
      if (master) return context.state !== 'closed'
      master = context.createGain(); master.gain.value = 0
      compressor = context.createDynamicsCompressor()
      compressor.threshold.value = -18; compressor.knee.value = 15
      compressor.ratio.value = 3; compressor.attack.value = .006; compressor.release.value = .18
      compressor.connect(master); master.connect(context.destination)
      // A seeded buffer avoids asset fetches, harsh white-noise transients, and
      // repeated allocations. Synthesis alone owns these disposable audio nodes.
      noiseBuffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate)
      const data = noiseBuffer.getChannelData(0)
      let seed = 91273, low = 0
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        low = .985 * low + .015 * (seed / 2147483648 - 1)
        data[i] = low * 4
      }
      if (options.ambience !== false) {
        wind = context.createBufferSource(); wind.buffer = noiseBuffer; wind.loop = true
        windFilter = context.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 700
        windGain = context.createGain(); windGain.gain.value = 0
        windPan = context.createStereoPanner(); windPan.pan.value = 0
        wind.connect(windFilter); windFilter.connect(windGain); windGain.connect(windPan); windPan.connect(compressor)
        wind.start()
      }
      syncGain()
      return true
    } catch {
      available = false
      return false
    }
  }
  function unlockAudio() {
    if (!boot()) return Promise.resolve(false)
    if (context.state === 'running') { syncGain(); return Promise.resolve(true) }
    try {
      // A browser may leave a pre-gesture resume pending. Always retry from the
      // actual gesture instead of returning that blocked promise indefinitely.
      return Promise.resolve(context.resume()).then(() => {
        if (disposed) return false
        syncGain()
        return context.state === 'running'
      }, () => false)
    } catch { return Promise.resolve(false) }
  }
  function gesture(event) {
    if (event.type === 'keydown' && (event.repeat || event.metaKey || event.ctrlKey || event.altKey)) return
    if (!muted && !doc.hidden) void unlockAudio()
  }

  function voice({ frequency = 440, end = frequency, duration = .2, delay = 0,
    amplitude = .15, pan = 0, wave = 'sine', filter = 3200, attack = .006, noise = false } = {}) {
    if (!active() || voices.size >= 48) return
    const at = context.currentTime + .003 + delay
    const source = noise ? context.createBufferSource() : context.createOscillator()
    const envelope = context.createGain(), lowpass = context.createBiquadFilter(), panner = context.createStereoPanner()
    if (noise) source.buffer = noiseBuffer
    else {
      source.type = wave
      source.frequency.setValueAtTime(frequency, at)
      source.frequency.exponentialRampToValueAtTime(Math.max(20, end), at + duration * .8)
    }
    lowpass.type = 'lowpass'; lowpass.frequency.value = filter; lowpass.Q.value = .6
    panner.pan.value = clamp(pan, -1, 1)
    envelope.gain.setValueAtTime(0, at)
    envelope.gain.linearRampToValueAtTime(amplitude, at + Math.min(attack, duration * .2))
    envelope.gain.exponentialRampToValueAtTime(.00001, at + duration)
    source.connect(lowpass); lowpass.connect(envelope); envelope.connect(panner); panner.connect(compressor)
    const record = { source, cleanup() {
      if (!voices.delete(record)) return
      source.disconnect(); lowpass.disconnect(); envelope.disconnect(); panner.disconnect()
      source.onended = null
    } }
    voices.add(record); source.onended = record.cleanup
    source.start(at, ...(noise ? [(simulation * .137) % 2] : []))
    source.stop(at + duration + .02)
  }
  function playSound(type, source, extra = {}) {
    if (!active() || !cues.has(type)) return false
    const position = spatial(source)
    if (!position) return false
    // The adjacent seat suggests life beyond the bezel, without replaying a full
    // fanfare, footsteps or ambience from a pet that belongs to another pane.
    if (position.edge) {
      if (type === 'step' || context.currentTime - lastEdge < .65) return false
      lastEdge = context.currentTime
      voice({ frequency: midi(81), end: midi(76), duration: .10, amplitude: position.gain, pan: position.pan })
      report('edge', position); return true
    }
    const key = `${type}:${typeof source === 'object' ? `${source.x}:${source.z}` : source}`
    if (context.currentTime - (recent.get(key) ?? -Infinity) < (type === 'step' ? .09 : .07)) return false
    recent.set(key, context.currentTime)
    if (recent.size > 128) recent.delete(recent.keys().next().value)
    const tone = (config) => voice({ pan: position.pan, ...config })
    if (type === 'step') {
      tone({ frequency: extra.foot ? 165 : 145, end: 85, wave: 'triangle', duration: .065, amplitude: .095, filter: 650 })
      tone({ noise: true, duration: .035, amplitude: .11, filter: 1100 })
    } else if (type === 'gift') {
      tone({ frequency: midi(88), end: midi(88) * 1.006, duration: .29, amplitude: .18, wave: 'triangle', filter: 4500 })
      tone({ frequency: midi(100), duration: .14, amplitude: .045, delay: .013 })
    } else if (type === 'learn') {
      for (const [i, note] of [76, 80, 83].entries()) tone({ frequency: midi(note), duration: i === 2 ? .48 : .22,
        delay: i * .10, amplitude: .13, wave: 'square', filter: 2200, attack: .009 })
    } else if (type === 'knock') {
      for (const delay of [0, .27]) {
        tone({ frequency: 640, end: 330, duration: .075, delay, amplitude: .22, wave: 'triangle', filter: 1650, attack: .002 })
        tone({ noise: true, duration: .032, delay, amplitude: .12, filter: 2100, attack: .002 })
      }
    } else if (type === 'handshake') {
      for (const [i, note] of [57, 64, 69, 73, 76].entries()) tone({ frequency: midi(note), duration: .95,
        delay: i * .018, amplitude: .075, wave: 'triangle', filter: 1650, attack: .05 })
    } else if (type === 'firework') {
      tone({ frequency: 185, end: 55, duration: .17, amplitude: .18, wave: 'triangle', filter: 1200, attack: .002 })
      tone({ noise: true, duration: .20, amplitude: .38, filter: 2300, attack: .002 })
      for (let i = 0; i < 6; i++) tone({ noise: true, duration: .025 + i * .004, delay: .08 + i * .065,
        amplitude: .18 * (1 - i / 8), filter: 2700 + i * 180, attack: .002,
        pan: clamp(position.pan + Math.sin(i * 2.4) * .11, -.96, .96) })
    } else return false
    report(type, position)
    return true
  }
  function learn(id) {
    // Counts can update just before the visible dot touches, or immediately after.
    // Coalesce both notifications into one reward without suppressing later gifts.
    if (simulation - (learned.get(id) ?? -Infinity) < 1.2) return
    learned.set(id, simulation)
    playSound('learn', id)
  }
  function settle(result, done) {
    const token = { epoch }; pending.add(token)
    Promise.resolve(result).then(value => {
      if (!disposed && token.epoch === epoch && pending.delete(token)) done(value)
    }, () => { pending.delete(token) })
    return result
  }
  function reset() {
    epoch++; pending.clear(); footsteps.clear(); learned.clear(); knocks.clear(); meetings.clear(); fireworks.clear()
    stopVoices()
  }
  function update(dt, t) {
    const delta = finite(t) && finite(lastTime) ? t - lastTime : 0
    const stale = delta < 0 || delta > .75
    lastTime = t; time = t
    const step = stale ? 0 : clamp(delta, 0, .1)
    if (stale) reset()
    simulation += step
    const state = samples(), ids = new Set(state.map(p => p.id))
    for (const id of footsteps.keys()) if (!ids.has(id)) footsteps.delete(id)
    for (const p of state) {
      const old = footsteps.get(p.id)
      const moving = p.moving > .07
      const travel = old ? distance(old, p) : 0
      const walk = { x: p.x, z: p.z, moving, phase: old?.moving && moving ? old.phase : 0 }
      if (old && moving && step > 0 && travel > .00001 && travel <= Math.max(.4, step * 8.1)) {
        walk.phase += Math.min(travel, step * 8) / .625
        if (Math.floor(walk.phase + 1e-8) > Math.floor((old.moving ? old.phase : 0) + 1e-8)) playSound('step', p, { foot: Math.floor(walk.phase + 1e-8) % 2 })
        walk.phase %= 2
      }
      footsteps.set(p.id, walk)
    }
    for (const [id, knock] of knocks) {
      const p = state.find(p => p.id === id)
      if (!p) { knocks.delete(id); continue }
      if (distance(p, knock.target) >= .07) continue
      if (simulation >= knock.next && step > 0) {
        playSound('knock', p); knock.next = simulation + 8
      }
    }
    for (const meeting of meetings) {
      // The director can skip a busy pet. Observe the real seam arrivals rather
      // than trying to reproduce its private choice of available participants.
      const a = state.find(p => distance(p, { x: meeting.x - .72, z: 1.5 }) < .09)
      const b = state.find(p => distance(p, { x: meeting.x + .72, z: 1.5 }) < .09)
      if (a && b) {
        // The seam itself is outside the left pane's half-open viewport. Put
        // the chord at its visible participant so both laptops hear the hello.
        const local = spatial(a)?.edge === false ? a : spatial(b)?.edge === false ? b : { x: meeting.x, z: 1.5 }
        playSound('handshake', local); meetings.delete(meeting)
      }
    }
    for (const firework of fireworks) {
      if (simulation - firework.start >= .55 + firework.burst * .48) {
        const i = firework.burst++
        playSound('firework', { x: firework.x + [0, -1.15, 1.2][i], z: firework.z,
          y: firework.y + [1.9, 1.45, 1.65][i] })
        if (firework.burst === 3) fireworks.delete(firework)
      }
    }
    if (!active() || options.ambience === false || !step) return
    const night = clamp(stage.scene.userData.petpackDaylight?.night ?? ((stage.timeOfDay < 6 || stage.timeOfDay >= 20) ? 1 : 0))
    if (windGain) {
      gainTarget(windGain, (.034 - night * .017) * (.8 + .2 * Math.sin(simulation * .19)), .6)
      windPan.pan.setTargetAtTime(Math.sin(simulation * .073) * .45, context.currentTime, .6)
    }
    if (simulation >= nextBird) {
      nextBird = simulation + 6.5 + (Math.sin(simulation * 1.7) * .5 + .5) * 7
      if (night < .8) {
        const pan = Math.sin(simulation * .67) * .75
        for (const [i, note] of [88, 92, 90].entries()) voice({ frequency: midi(note), end: midi(note + 3),
          duration: .10, delay: i * .16, amplitude: .026 * (1 - night), pan, filter: 3400, attack: .02 })
        report('bird', { pan, gain: .026 * (1 - night) })
      }
    }
    if (simulation >= nextCricket) {
      nextCricket = simulation + 1.5 + (Math.sin(simulation * 2.3) * .5 + .5) * 1.8
      if (night > .15) {
        const pan = Math.sin(simulation * .33) * .85
        for (let i = 0; i < 3; i++) voice({ frequency: 3700, end: 3530, duration: .045,
          delay: i * .085, amplitude: .015 * night, pan, filter: 4300 })
        report('cricket', { pan, gain: .015 * night })
      }
    }
  }

  // stage.update is called by the real automatic loop as well as renderFrame.
  // Wrapping only world.renderFrame would miss the default closure-owned loop.
  wrap(stage, 'update', (call, [dt, t]) => { const result = call(); update(dt, t); return result })
  wrap(world, 'renderFrame', (call, [, , renderOptions]) => {
    const old = silenceReplay; silenceReplay ||= renderOptions?.render === false
    try { return call() } finally { silenceReplay = old }
  })
  wrap(world, 'upsertPet', (call, [id, info = {}]) => {
    const previous = skills.get(id), result = call()
    if (finite(info.skillCount)) {
      skills.set(id, info.skillCount)
      if (finite(previous) && info.skillCount > previous) learn(id)
    }
    return result
  })
  wrap(world.map, 'bloom', (call, [item]) => {
    const result = call()
    if (item?.toId !== undefined && item.kind === 'skill') learn(item.toId)
    return result
  })
  for (const method of ['gift', 'giftFx']) wrap(world, method, (call, [from, to, settings = {}]) => {
    const result = call()
    if (from !== to && pet(from) && pet(to)) playSound('gift', from)
    return settle(result, value => {
      if (successful(value) && (settings.kind ?? 'skill') === 'skill' && pet(to)) learn(to)
    })
  })
  wrap(world, 'ask', (call, [from, , settings = {}]) => settle(call(), value => {
    if (successful(value) && settings.kind === 'skill' && pet(from)) learn(from)
  }))
  wrap(world, 'handshake', (call, [settings = {}]) => {
    const source = settings.seat ?? world.seat, side = settings.side || 'right', width = world.map.chunkWidth || 14
    const left = Math.trunc(source) - (side === 'left' ? 1 : 0), x = (left + .5) * width
    const result = call()
    if (!finite(source) || !['left', 'right'].includes(side)) return result
    const meeting = { x }
    meetings.add(meeting)
    return settle(result, () => meetings.delete(meeting))
  })
  wrap(world, 'knock', (call, [id, enabled = true]) => {
    const result = call(), p = pet(id)
    if (!enabled) knocks.delete(id)
    else if (result && p && !knocks.has(id)) knocks.set(id, {
      target: { x: Math.round(p.x / (world.map.chunkWidth || 14)) * (world.map.chunkWidth || 14), z: 4.25 }, next: simulation,
    })
    return result
  })
  wrap(world, 'celebrate', (call, [id]) => {
    const p = pet(id), result = call()
    if (!p) return result
    const site = world.map.landmark(Math.round(p.x / (world.map.chunkWidth || 14)))
    const effect = { x: site.x, z: site.z - 3.7, y: world.map.ground(site.x, site.z) + 2.9, start: simulation, burst: 0 }
    fireworks.add(effect)
    return settle(result, () => fireworks.delete(effect))
  })
  wrap(world, 'removePet', (call, [id]) => {
    footsteps.delete(id); skills.delete(id); learned.delete(id); knocks.delete(id)
    return call()
  })
  wrap(world, 'resetEffects', call => { reset(); return call() })
  function disposeSound() {
    if (disposed) return
    disposed = true; reset()
    for (const event of ['pointerdown', 'keydown', 'touchend']) doc.removeEventListener(event, gesture, true)
    doc.removeEventListener('visibilitychange', visibility)
    try { wind?.stop() } catch { /* already stopped */ }
    for (const node of [wind, windFilter, windGain, windPan, compressor, master]) node?.disconnect()
    if (ownsContext && context && context.state !== 'closed') void context.close().catch(() => {})
    for (const restore of undo.reverse()) restore()
    attached.delete(world)
  }
  function visibility() {
    reset(); syncGain()
    if (ownsContext && context?.state === 'running' && doc.hidden) void context.suspend().catch(() => {})
    else if (!doc.hidden && context && !muted) void unlockAudio()
  }
  wrap(world, 'dispose', call => { disposeSound(); return call() })
  const canStart = () => /Electron\//.test(win.navigator.userAgent) || win.navigator.userActivation?.hasBeenActive
  install(world, 'setMuted', value => {
    muted = !!value; syncGain()
    if (!muted && (context || canStart())) void unlockAudio()
    return muted
  })
  install(world, 'setSoundVolume', value => { if (finite(value)) volume = clamp(value); syncGain(); return volume })
  install(world, 'unlockAudio', unlockAudio)
  install(world, 'playSound', playSound)
  install(stage.scene.userData, 'petpackSound', playSound)
  install(world, 'disposeSound', disposeSound)
  install(world, 'soundSnapshot', () => ({ available, state: disposed ? 'disposed' : context?.state || 'locked', muted,
    volume, voices: voices.size, counts: { ...counts }, time, night: stage.scene.userData.petpackDaylight?.night ?? 0 }))
  for (const event of ['pointerdown', 'keydown', 'touchend']) doc.addEventListener(event, gesture, { capture: true, passive: true })
  doc.addEventListener('visibilitychange', visibility)
  attached.set(world, true)
  // Creating an AudioContext before activation produces browser console warnings.
  // Only Electron or an already activated document attempts early startup.
  if (context?.state === 'running' || canStart()) {
    if (!muted) void unlockAudio()
  }
  return world
}
