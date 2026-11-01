// Ask your pet: click your pet (or press Enter) and a little pixel chat field slides up inside the glass pane. Your pet
// thinks (working dots) and answers in its speech bubble; a tiny transcript keeps the conversation. Hold Space (or the
// mic pip) to talk out loud when an OpenAI key is set: a Realtime voice session over WebRTC, the pet waving as it talks.
// app.js: import('./chat.js').then(m => m.attachChat({ world, brain, bridge: window.petpack, root: pane })).catch(() => {})

const BUBBLE_MAX = 170
const NO_KEY_SEEN = 'petpack.voice.noKeyShown'

export function attachChat({ world, brain, bridge = window.petpack, root } = {}) {
  if (!world || !brain) return null
  if (window.petpackChat) return window.petpackChat // one chat per page, however many times it is attached
  const pane = root?.classList?.contains('petpack-pane') ? root : (root?.querySelector?.('.petpack-pane') || document.querySelector('.petpack-pane'))
  if (!pane) return null
  const viewport = pane.querySelector('.world-viewport') || pane

  if (!document.querySelector('link[data-petpack-chat]')) {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('./chat.css', import.meta.url).href })
    link.dataset.petpackChat = ''
    document.head.append(link)
  }

  // ---- DOM ----
  const box = el('div', 'pp-chat')
  const log = el('div', 'pp-chat-log')
  const form = el('form', 'pp-chat-form')
  const input = Object.assign(el('input', 'pp-chat-input'), { type: 'text', placeholder: 'ask your pet…', autocomplete: 'off', spellcheck: false, maxLength: 2000 })
  const send = Object.assign(el('button', 'pp-chat-send'), { type: 'submit', title: 'Send', textContent: '↵' })
  form.append(input, send)
  box.append(log, form)
  const mic = Object.assign(el('button', 'pp-mic'), { type: 'button', title: 'Hold to talk (or hold Space)' })
  mic.append(el('span', 'pp-mic-icon'))
  const tip = el('div', 'pp-mic-tip')
  viewport.append(box, mic, tip)
  // A focused field must never scroll the world inside its overflow-hidden frame.
  for (const node of new Set([viewport, pane])) {
    node.addEventListener('scroll', () => { if (node.scrollTop || node.scrollLeft) { node.scrollTop = 0; node.scrollLeft = 0 } })
  }


  const myId = () => brain.me?.id
  // The pet's own name (Codex pet), not the person's display name the room shows.
  let ownPet = null
  Promise.resolve(bridge?.getMe?.()).then(m => {
    const name = String(m?.petName || '').trim()
    if (name) ownPet = /^[a-z0-9-]+$/.test(name) ? name.replace(/(^|-)([a-z])/g, (_, d, c) => (d ? ' ' : '') + c.toUpperCase()) : name
  }).catch(() => {})
  const petName = () => ownPet || brain.me?.name || 'Pip'
  const userName = () => bridge?.config?.name || (ownPet ? brain.me?.name : '') || ''
  const setInteractive = on => { try { bridge?.setInteractive?.(on) } catch { /* bridge gone */ } }

  // ---- open / close ----
  let open = false
  function openChat() {
    if (!open) { open = true; box.classList.add('on'); pane.classList.add('pp-chatting') }
    setInteractive(true)
    setTimeout(() => input.focus({ preventScroll: true }), 30)
  }
  function closeChat() {
    if (!open) return
    open = false
    box.classList.remove('on')
    pane.classList.remove('pp-chatting')
    input.blur()
  }

  // Our own pet: a click (not a throw) opens the chat. Capture phase, so the seat hint doesn't talk over it.
  let down = null
  window.addEventListener('pointerdown', e => {
    // Picked at press time too: a walking pet may have moved off the cursor by the click.
    let id = null
    try { id = e.target?.closest?.('[data-pet-id]')?.dataset.petId ?? world.pick(e.clientX, e.clientY) } catch { /* no world */ }
    down = { x: e.clientX, y: e.clientY, at: performance.now(), id }
  }, true)
  window.addEventListener('click', e => {
    if (box.contains(e.target) || mic.contains(e.target)) return
    const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0
    if (moved > 6 || (down && performance.now() - down.at > 600)) return
    // The play layer's hit button (a tap giggles), else the world's own picker.
    const mine = String(myId())
    const ids = [down?.id, e.target?.closest?.('[data-pet-id]')?.dataset.petId, world.pick(e.clientX, e.clientY)]
    if (ids.some(id => id != null && String(id) === mine)) { e.stopPropagation(); openChat() }
  }, true)

  // Keys: Enter opens, Escape closes, Space (outside the field) is push-to-talk. Typing never reaches the pane's hotkeys.
  input.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); closeChat() }
  })
  input.addEventListener('keyup', e => e.stopPropagation())
  const typing = t => t === input || t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || '')
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
    if (e.key === 'Enter' && !open) { e.preventDefault(); openChat() }
    else if (e.key === 'Escape' && open) closeChat()
    else if (e.code === 'Space' && !e.repeat) { e.preventDefault(); e.stopPropagation(); talkStart() }
  }, true)
  window.addEventListener('keyup', e => {
    if (typing(e.target)) return
    if (e.code === 'Space') { e.preventDefault(); talkStop() }
  }, true)
  window.addEventListener('blur', () => { talkStop(); if (open && !input.value.trim() && !busy) closeChat() })

  // The pane is click-through except over pets: app.js's cursor rule takes .pp-chat and .pp-mic too.

  // ---- transcript ----
  function line(who, text, cls = '') {
    const row = el('div', `pp-line pp-${who} ${cls}`.trim())
    if (who !== 'note') row.append(Object.assign(el('b', 'pp-who'), { textContent: who === 'you' ? 'you' : petName() }))
    const span = Object.assign(el('span', 'pp-text'), { textContent: text })
    row.append(span)
    log.append(row)
    while (log.children.length > 60) log.firstChild.remove()
    log.scrollTop = log.scrollHeight
    log.classList.add('has')
    return { row, set(text) { span.textContent = text; log.scrollTop = log.scrollHeight }, remove() { row.remove() } }
  }
  const sayBubble = text => {
    const id = myId()
    if (!id || !text) return
    // The bubbles' pixel font has no "…" or curly quotes.
    const t = String(text).replace(/\s+/g, ' ').replace(/…/g, '...').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim()
    try { world.say(id, t.length > BUBBLE_MAX ? `${t.slice(0, BUBBLE_MAX - 3).trimEnd()}...` : t) } catch { /* pet not shown */ }
  }

  // Working dots while Codex thinks (the pet's status bubble, which the room sees too), then back.
  let restoreStatus = null
  function thinking(on) {
    const mine = brain.me
    if (!mine) return
    if (on) {
      if (restoreStatus === null) restoreStatus = mine.status || 'idle'
      brain.setStatus?.('working')
    } else if (restoreStatus !== null) {
      const back = restoreStatus === 'working' || restoreStatus === 'done' ? 'idle' : restoreStatus
      restoreStatus = null
      if (mine.status === 'working') brain.setStatus?.(back)
    }
  }
  function bounce(seconds = 1.6, anim = 'wave') {
    const mine = brain.me
    if (!mine) return
    mine.anim = anim
    mine.animUntil = (brain.time || 0) + seconds
  }

  // ---- text: Codex ----
  let busy = false
  const pending = new Map() // ask id -> transcript handle for the thinking line
  bridge?.chat?.onEvent?.(ev => {
    const thinkingLine = pending.get(ev?.id)
    if (!thinkingLine) return
    if (ev.type === 'tool') {
      const label = /search|find/.test(ev.tool) ? 'looking through the team…' : /ask/.test(ev.tool) ? 'asking a teammate…'
        : /get/.test(ev.tool) ? 'reading it…' : /status/.test(ev.tool) ? 'seeing who\'s around…' : 'working…'
      thinkingLine.set(label)
      sayBubble(label)
    } else if (ev.type === 'partial' && ev.text) thinkingLine.set(ev.text)
  })

  form.addEventListener('submit', async e => {
    e.preventDefault()
    const question = input.value.trim()
    if (!question || busy) return
    input.value = ''
    await ask(question)
  })

  async function ask(question) {
    busy = true
    box.classList.add('busy')
    line('you', question)
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const think = line('pet', '…', 'pp-thinking')
    pending.set(id, think)
    thinking(true)
    let result
    try {
      result = bridge?.chat?.ask
        ? await bridge.chat.ask({ id, question, petName: petName(), userName: userName() })
        : { ok: false, error: 'offline', text: '' }
    } catch (error) { result = { ok: false, error: String(error?.message || error) } }
    pending.delete(id)
    thinking(false)
    think.row.classList.remove('pp-thinking')
    busy = false
    box.classList.remove('busy')
    if (result?.ok && result.text) {
      think.set(result.text)
      sayBubble(result.text)
      bounce(Math.min(4, 1 + result.text.length / 60))
    } else {
      const why = result?.error === 'offline' ? 'I can only talk inside the petpack app.'
        : result?.error === 'timeout' ? 'I got lost in thought. Ask me again?'
        : /not found|ENOENT|not started/i.test(result?.error || '') ? 'I need Codex on this computer to think. Install it and sign in, then ask me again.'
        : /login|auth|401|sign in/i.test(result?.error || '') ? 'Sign in to Codex and I can answer.'
        : 'Hmm, my head is fuzzy. Ask me again?'
      think.set(why)
      think.row.classList.add('pp-err')
      sayBubble(why)
      if (result?.error) console.warn('petpack chat:', result.error)
    }
    if (open) input.focus({ preventScroll: true })
    return result
  }

  // ---- voice: OpenAI Realtime over WebRTC ----
  const voice = { pc: null, dc: null, track: null, audio: null, connecting: null, talking: false, speaking: false, model: null,
    transcript: '', youLine: null, petLine: null, tick: 0 }

  function showTip(text, ms = 5200) {
    tip.textContent = text
    tip.classList.add('on')
    clearTimeout(showTip.timer)
    showTip.timer = setTimeout(() => tip.classList.remove('on'), ms)
  }

  async function connectVoice() {
    if (voice.pc) return true
    if (voice.connecting) return voice.connecting
    voice.connecting = (async () => {
      let stream = null
      let pc = null
      try {
        const ready = bridge?.voice?.prepare ? await bridge.voice.prepare().catch(() => null) : null
        if (!ready?.available) {
          let seen = false
          try { seen = localStorage.getItem(NO_KEY_SEEN) === '1'; localStorage.setItem(NO_KEY_SEEN, '1') } catch { /* no storage */ }
          if (!seen) showTip('add an OpenAI API key for voice')
          mic.classList.add('nokey')
          return false
        }
        mic.classList.remove('nokey')
        mic.classList.add('connecting')
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        pc = new RTCPeerConnection()
        const audio = new Audio()
        audio.autoplay = true
        pc.ontrack = e => { audio.srcObject = e.streams[0]; watchLevel(e.streams[0]) }
        const [track] = stream.getAudioTracks()
        track.enabled = false
        pc.addTrack(track, stream)
        const dc = pc.createDataChannel('oai-events')
        dc.addEventListener('message', e => { try { onVoiceEvent(JSON.parse(e.data)) } catch { /* not JSON */ } })
        const opened = new Promise(resolve => dc.addEventListener('open', resolve, { once: true }))
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        const answer = await bridge.voice.connect(offer.sdp, { petName: petName(), userName: userName() })
        if (!answer?.ok) throw new Error(answer?.error || answer?.reason || 'voice unavailable')
        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
        await Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error('voice channel did not open')), 10000))])
        Object.assign(voice, { pc, dc, track, audio, model: answer.model })
        pc.addEventListener('connectionstatechange', () => {
          if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) hangUp()
        })
        mic.classList.add('live')
        return true
      } catch (error) {
        console.warn('petpack voice:', error?.message || error)
        showTip(/permission|denied|NotAllowed/i.test(String(error?.name || error?.message)) ? 'petpack needs the microphone for voice' : 'voice is unavailable right now')
        try { stream?.getTracks().forEach(t => t.stop()) } catch {}
        try { pc?.close() } catch {}
        hangUp()
        return false
      } finally {
        mic.classList.remove('connecting')
        voice.connecting = null
      }
    })()
    return voice.connecting
  }
  function hangUp() {
    try { voice.track?.stop() } catch {}
    try { voice.dc?.close() } catch {}
    try { voice.pc?.close() } catch {}
    if (voice.audio) voice.audio.srcObject = null
    Object.assign(voice, { pc: null, dc: null, track: null, audio: null, talking: false, speaking: false })
    mic.classList.remove('live', 'talking')
  }
  const sendVoice = msg => { try { if (voice.dc?.readyState === 'open') voice.dc.send(JSON.stringify(msg)) } catch { /* closed */ } }

  let pressed = false
  async function talkStart() {
    if (pressed) return
    pressed = true
    mic.classList.add('talking')
    const ok = await connectVoice()
    if (!ok || !pressed) { if (!ok) mic.classList.remove('talking'); return }
    if (voice.speaking) { sendVoice({ type: 'response.cancel' }); sendVoice({ type: 'output_audio_buffer.clear' }) }
    sendVoice({ type: 'input_audio_buffer.clear' })
    voice.track.enabled = true
    voice.talking = true
    bounce(0.6, 'review')
  }
  function talkStop() {
    if (!pressed) return
    pressed = false
    mic.classList.remove('talking')
    if (!voice.talking) return
    voice.talking = false
    // Let the last syllable reach the server before committing the turn.
    setTimeout(() => {
      if (voice.track) voice.track.enabled = false
      sendVoice({ type: 'input_audio_buffer.commit' })
      sendVoice({ type: 'response.create' })
      if (!voice.youLine) voice.youLine = line('you', '(said something)', 'pp-voice')
      voice.petLine = line('pet', '…', 'pp-thinking')
      thinking(true)
    }, 220)
  }

  async function onVoiceEvent(ev) {
    switch (ev.type) {
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript && voice.youLine) voice.youLine.set(ev.transcript.trim())
        break
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
        voice.transcript += ev.delta || ''
        if (voice.petLine) voice.petLine.set(voice.transcript)
        break
      case 'response.output_audio_transcript.done':
      case 'response.output_text.done': {
        const text = (ev.transcript || ev.text || voice.transcript).trim()
        voice.transcript = ''
        if (text) {
          if (voice.petLine) { voice.petLine.set(text); voice.petLine.row.classList.remove('pp-thinking') } else line('pet', text)
          voice.petLine = null
          sayBubble(text)
        }
        break
      }
      case 'output_audio_buffer.started': voice.speaking = true; thinking(false); break
      case 'output_audio_buffer.stopped': case 'output_audio_buffer.cleared': voice.speaking = false; break
      case 'response.done': {
        voice.youLine = null
        const calls = (ev.response?.output || []).filter(o => o?.type === 'function_call')
        if (!calls.length) { thinking(false); break }
        for (const call of calls) {
          let args = {}
          try { args = JSON.parse(call.arguments || '{}') } catch { /* keep {} */ }
          if (voice.petLine) voice.petLine.set(/search/.test(call.name) ? 'looking through the team…' : /ask/.test(call.name) ? 'asking a teammate…' : 'working…')
          let output
          try { output = await brain.call(call.name, args) } catch (error) { output = { error: String(error?.message || error) } }
          sendVoice({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output ?? null).slice(0, 12000) } })
        }
        sendVoice({ type: 'response.create' })
        break
      }
      case 'error':
        console.warn('petpack voice error:', ev.error?.message || ev)
        if (voice.petLine) { voice.petLine.set('I lost my voice for a second. Try again?'); voice.petLine.row.classList.add('pp-err'); voice.petLine = null }
        thinking(false)
        break
      default: break
    }
  }

  // The pet waves while its voice is playing (level from the remote audio, so it follows the actual speech).
  function watchLevel(stream) {
    try {
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      clearInterval(voice.tick)
      voice.tick = setInterval(() => {
        if (!voice.pc) { clearInterval(voice.tick); ctx.close().catch(() => {}); return }
        analyser.getByteTimeDomainData(data)
        let peak = 0
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
        const loud = peak > 10
        mic.classList.toggle('speaking', loud)
        if (loud) bounce(0.35, 'wave')
      }, 120)
    } catch { /* no audio graph: no wave */ }
  }

  mic.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); mic.setPointerCapture?.(e.pointerId); talkStart() })
  mic.addEventListener('pointerup', e => { e.stopPropagation(); talkStop() })
  mic.addEventListener('pointercancel', () => talkStop())
  mic.addEventListener('click', e => e.stopPropagation())

  const api = { open: openChat, close: closeChat, ask, talkStart, talkStop, hangUp, get isOpen() { return open }, get busy() { return busy }, el: box }
  window.petpackChat = api
  return api
}

function el(tag, className) { return Object.assign(document.createElement(tag), { className }) }
