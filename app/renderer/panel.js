// Tray popover page (TRAY lane). Talks only to window.panel (app/panel-preload.cjs).
const bridge = window.panel
const $ = id => document.getElementById(id)
if (location.hash === '#mac') document.documentElement.classList.add('mac')
window.__panelReady = { done: false }

let state = null
let pets = { current: null, list: [] }
let catalog = []
const call = (cmd, arg) => bridge.call(cmd, arg)

// ---------- pixel art ----------
function pixelUrl (rows, palette, scale = 2) {
  const c = document.createElement('canvas')
  c.width = rows[0].length * scale; c.height = rows.length * scale
  const g = c.getContext('2d')
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (!palette[ch]) return
    g.fillStyle = palette[ch]; g.fillRect(x * scale, y * scale, scale, scale)
  }))
  return c.toDataURL()
}
const ICONS = {
  sound: ['........', '...#..#.', '..##...#', '####.#.#', '####.#.#', '..##...#', '...#..#.', '........'],
  muted: ['........', '...#....', '..##.#.#', '####..#.', '####..#.', '..##.#.#', '...#....', '........'],
  party: ['.....#..', '..#....#', '....##..', '...###..', '..####..', '.#####..', '######..', '........'],
  collapse: ['........', '.######.', '.#....#.', '.#.##.#.', '.#.##.#.', '.#....#.', '.######.', '........'],
  quit: ['...##...', '.#.##.#.', '#..##..#', '#......#', '#......#', '.#....#.', '..####..', '........'],
  moon: ['..###...', '.##.....', '##......', '##......', '##.....#', '.##...##', '..####..', '........'],
  check: ['........', '......#.', '.....##.', '#...##..', '##.##...', '.###....', '..#.....', '........'],
  flip: ['..#.....', '.###....', '#.#.....', '..#..#..', '..#..#..', '.....#.#', '....###.', '.....#..'],
  skill: ['..##....', '.####...', '######..', '.####...', '..####..', '...####.', '....###.', '.....#..'],
  memory: ['.######.', '#......#', '#.####.#', '#......#', '#.###..#', '#......#', '.######.', '........'],
  technique: ['...##...', '..####..', '.##..##.', '##.##.##', '##.##.##', '.##..##.', '..####..', '...##...'],
  resource: ['.##..##.', '#..##..#', '#......#', '.#....#.', '..#..#..', '...##...', '...##...', '..####..'],
}
const KIND_COLOR = { skill: '#e2a33a', memory: '#3f86a8', technique: '#8a7ad1', resource: '#5bb97a' }
const icon = (name, color = '#5d6b70') => `url(${pixelUrl(ICONS[name], { '#': color })})`
function paintIcons () {
  const set = (sel, url) => document.querySelectorAll(sel).forEach(el => { el.style.backgroundImage = url })
  set('.ico-party', icon('party')); set('.ico-collapse', icon('collapse')); set('.ico-quit', icon('quit'))
  document.documentElement.style.setProperty('--moon', icon('moon', '#fff'))
  document.documentElement.style.setProperty('--check', icon('check', '#fff'))
  document.documentElement.style.setProperty('--flip', icon('flip', '#3f86a8'))
}

// The built-in pixel pet (no Codex pet found), drawn like the tray icon.
const DOT = ['................', '...###....###...', '...###....###...', '...##########...', '..############..', '..############..',
  '..##..####..##..', '..##..####..##..', '..############..', '..############..', '..#####..#####..', '...##########...',
  '...##......##...', '...##......##...', '................', '................']

// ---------- sprites: Codex atlases are 8 columns x 9 (or 11) rows; row 0 is idle ----------
const images = new Map()
function loadImage (url) {
  if (!url) return Promise.resolve(null)
  if (!images.has(url)) {
    images.set(url, new Promise(resolve => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = url }))
  }
  return images.get(url)
}
function gridOf (img, atlas) {
  const cols = atlas?.cols || 8
  const rows = atlas?.rows || (Math.abs(img.height / 11 - img.width / 8 * 52 / 48) < Math.abs(img.height / 9 - img.width / 8 * 52 / 48) ? 11 : 9)
  return { cellW: atlas?.cellW || Math.floor(img.width / cols), cellH: atlas?.cellH || Math.floor(img.height / rows) }
}
function idleFrames (img, grid) {
  // Frames of row 0 with any visible pixel (pets use 4-8 of the 8 cells).
  const probe = document.createElement('canvas')
  probe.width = grid.cellW; probe.height = grid.cellH
  const g = probe.getContext('2d', { willReadFrequently: true })
  const frames = []
  try {
    for (let col = 0; col < 8; col++) {
      g.clearRect(0, 0, grid.cellW, grid.cellH)
      g.drawImage(img, col * grid.cellW, 0, grid.cellW, grid.cellH, 0, 0, grid.cellW, grid.cellH)
      const data = g.getImageData(0, 0, grid.cellW, grid.cellH).data
      let seen = false
      for (let i = 3; i < data.length; i += 16) if (data[i] > 24) { seen = true; break }
      if (seen) frames.push(col)
    }
  } catch { return [0] } // a relay-hosted sheet can't be read back (cross-origin): first frame only
  return frames.length ? frames : [0]
}
function drawCell (canvas, img, grid, col) {
  const g = canvas.getContext('2d')
  g.imageSmoothingEnabled = false
  g.clearRect(0, 0, canvas.width, canvas.height)
  const s = Math.min(canvas.width / grid.cellW, canvas.height / grid.cellH)
  const w = grid.cellW * s; const h = grid.cellH * s
  g.drawImage(img, col * grid.cellW, 0, grid.cellW, grid.cellH, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
}
function drawDot (canvas, frame = 0) {
  const g = canvas.getContext('2d')
  g.clearRect(0, 0, canvas.width, canvas.height)
  const s = Math.floor(canvas.width / 16)
  const bob = frame % 2 ? s : 0
  DOT.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== '#') return
    g.fillStyle = (y === 6 || y === 7) && (x === 4 || x === 5 || x === 10 || x === 11) ? '#2c3a3f' : '#74a9c3'
    g.fillRect(x * s, y * s + bob, s, s)
  }))
}

let meAnim = { stop () {} }
async function animateMe (pet) {
  meAnim.stop()
  const canvas = $('me')
  canvas.width = 128; canvas.height = 128
  const img = await loadImage(pet?.spriteUrl)
  let frame = 0
  let timer
  if (!img) {
    drawDot(canvas, 0)
    timer = setInterval(() => drawDot(canvas, ++frame), 520)
  } else {
    const grid = gridOf(img, pet.atlas)
    const frames = idleFrames(img, grid)
    drawCell(canvas, img, grid, frames[0])
    timer = setInterval(() => drawCell(canvas, img, grid, frames[++frame % frames.length]), 170)
  }
  meAnim = { stop: () => clearInterval(timer) }
}

// ---------- header ----------
let replyTimer = null
function renderHeader () {
  const cur = pets.current
  $('pet-name').textContent = cur && cur.source !== 'none' ? cur.displayName : (cur?.displayName || 'Dot')
  if (!state) return
  const st = $('status-text').parentElement
  st.dataset.key = state.status.key
  $('status-text').textContent = state.status.text
  // What Codex is on right now (the pane reports `task` only while it works).
  $('task-line').hidden = !state.task
  $('task-line').textContent = state.task || ''
  $('task-line').title = state.task ? `working on: ${state.task}` : ''
  document.body.classList.toggle('dnd', Boolean(state.dnd))
}
function showReply (text) {
  const el = $('reply')
  el.textContent = text
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show')
  clearTimeout(replyTimer)
  replyTimer = setTimeout(() => el.classList.remove('show'), 6000)
}

// ---------- pet picker ----------
async function renderPets () {
  const grid = $('pet-grid')
  grid.textContent = ''
  const list = pets.list
  if (!list.length) { const p = document.createElement('div'); p.className = 'muted'; p.style.gridColumn = '1 / -1'; p.textContent = 'No Codex pets found yet: choose a folder.'; grid.append(p) }
  for (const pet of list) {
    const b = document.createElement('button')
    b.className = `pet-tile${pet.current ? ' current' : ''}`
    b.title = `${pet.displayName}${pet.source === 'custom' ? ' (your pet)' : ''}${pet.available === 'download' ? ' · downloads when chosen' : ''}`
    const c = document.createElement('canvas'); c.width = 80; c.height = 80
    b.append(c)
    if (pet.available === 'download') { const d = document.createElement('span'); d.className = 'dl'; d.textContent = '↓'; b.append(d) }
    b.addEventListener('click', async () => {
      b.disabled = true
      try { pets = await call('choosePet', pet.id || pet.key); renderAllPets() } catch (error) { showReply(`can't wear that one (${String(error.message || error).replace(/^Error invoking remote method[^:]*: (Error: )?/, '')})`) }
      b.disabled = false
    })
    grid.append(b)
    loadImage(pet.spriteUrl).then(img => { if (img) { const gr = gridOf(img, pet.atlas); drawCell(c, img, gr, idleFrames(img, gr)[0]) } else drawDot(c) })
  }
  $('follow-codex').checked = pets.current?.source !== 'chosen'
}
function renderAllPets () { renderHeader(); renderPets(); animateMe(pets.current); drawSprite($('nb-me'), pets.current?.spriteUrl, pets.current?.atlas) }

// ---------- sharing ----------
function renderMode () {
  const mode = state?.sharing?.mode || 'free'
  for (const b of $('mode').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode))
  document.body.classList.toggle('mode-off', mode === 'off')
  document.body.classList.toggle('mode-ask', mode === 'ask')
}
function renderCatalog () {
  const list = $('share-list')
  list.textContent = ''
  if (!catalog.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'Nothing to share yet: skills, memories and notes show up here.'; list.append(li); return }
  const hidden = new Set(state?.sharing?.hidden || [])
  const order = { skill: 0, memory: 1, technique: 2, resource: 3 }
  for (const item of [...catalog].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.title.localeCompare(b.title))) {
    const li = document.createElement('li')
    li.className = 'share-item'
    li.title = item.path ? `${item.title}\n${item.path}` : item.title
    const k = document.createElement('span'); k.className = 'kind'
    k.style.backgroundImage = icon(ICONS[item.kind] ? item.kind : 'memory', KIND_COLOR[item.kind] || '#5d6b70')
    const t = document.createElement('span'); t.className = 't'; t.textContent = item.title
    const kind = document.createElement('span'); kind.className = 'k'; kind.textContent = item.kind
    const sw = document.createElement('input'); sw.type = 'checkbox'; sw.className = 'switch mini'; sw.dataset.ref = item.ref
    sw.checked = !hidden.has(item.ref)
    sw.setAttribute('aria-label', `Share ${item.title}`)
    sw.addEventListener('change', async () => { state = await call('setShared', { ref: item.ref, on: sw.checked }) })
    li.append(k, t, kind, sw)
    list.append(li)
  }
}
$('mode').addEventListener('click', async e => {
  const b = e.target.closest('button[data-mode]')
  if (!b) return
  state = await call('setMode', b.dataset.mode)
  renderMode()
})

// ---------- co-working: sit next to… ----------
let people = []
let coworkTimer = null
function drawSprite (canvas, url, atlas) {
  loadImage(url).then(img => {
    if (!img) { drawDot(canvas); return }
    const gr = gridOf(img, atlas)
    drawCell(canvas, img, gr, idleFrames(img, gr)[0])
  })
}
const STATUS_WORD = { working: 'working', waiting: 'waiting for them', idle: 'idle', done: 'just finished', failed: 'stuck', away: 'away' }
function renderNeighbours () {
  for (const side of ['left', 'right']) {
    const p = people.find(x => x.side === side)
    const el = $(`nb-${side}`)
    el.classList.toggle('on', Boolean(p))
    el.querySelector('.nb-name').textContent = p ? p.name : 'nobody'
    el.title = p ? `${p.name} sits on your ${side}` : `Nobody on your ${side} yet`
  }
}
function renderPeople () {
  renderNeighbours()
  const list = $('people')
  list.textContent = ''
  if (!people.length) {
    const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'Nobody else is online in this room yet.'
    list.append(li); return
  }
  for (const p of people) {
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.className = 'person'
    b.dataset.id = p.id
    b.title = p.side ? `${p.name} already sits on your ${p.side}` : `Sit next to ${p.name} and co-work`
    const c = document.createElement('canvas'); c.width = 56; c.height = 56
    const pn = document.createElement('span'); pn.className = 'pn'
    const name = document.createElement('b'); name.textContent = p.name
    const st = document.createElement('i'); st.textContent = p.dnd ? 'do not disturb' : (STATUS_WORD[p.status] || p.status)
    pn.append(name, st)
    const tag = document.createElement('span')
    tag.className = `tag${p.side ? ' next' : ''}`
    tag.textContent = p.side === 'left' ? '← next to you' : p.side === 'right' ? 'next to you →' : 'Sit here'
    b.append(c, pn, tag)
    b.addEventListener('click', () => coworkWith(p, b))
    li.append(b)
    list.append(li)
    drawSprite(c, p.spriteUrl, p.atlas)
  }
}
function showCowork (text, ok = true, sticky = false) {
  const el = $('cowork-note')
  el.textContent = text
  el.classList.toggle('fail', !ok)
  el.hidden = false
  clearTimeout(coworkTimer)
  if (!sticky) coworkTimer = setTimeout(() => { el.hidden = true }, 8000)
}
async function coworkWith (p, button) {
  button.classList.add('pending')
  button.querySelector('.tag').textContent = 'asking…'
  try {
    const r = await call('cowork', p.id)
    if (r?.text) showCowork(r.text, true, !p.side)
  } catch (error) {
    showCowork(String(error.message || error).replace(/^Error invoking remote method[^:]*: (Error: )?/, ''), false)
    renderPeople()
  }
}

// ---------- room ----------
function renderRoom () {
  if (!state) return
  $('room-code').textContent = state.room
  $('online-n').textContent = state.online == null ? '–' : String(state.online)
  for (const b of $('dock').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.dock === state.dock))
  for (const b of $('sit').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.sit === (state.sit || 'side')))
}
$('sit').addEventListener('click', async e => {
  const b = e.target.closest('button[data-sit]')
  if (b) { state = await call('setSit', b.dataset.sit); renderRoom() }
})
$('room-copy').addEventListener('click', async () => { await call('copyRoom'); $('room-copy').textContent = 'Copied'; setTimeout(() => { $('room-copy').textContent = 'Copy' }, 1200) })
$('room-change').addEventListener('click', () => { $('room-form').hidden = false; $('room-input').value = state?.room || ''; $('room-input').focus(); $('room-input').select() })
$('room-cancel').addEventListener('click', () => { $('room-form').hidden = true })
$('room-form').addEventListener('submit', async e => {
  e.preventDefault()
  const code = $('room-input').value.trim()
  $('room-form').hidden = true
  if (code && code !== state?.room) { state = await call('setRoom', code); render() }
})
$('dock').addEventListener('click', async e => {
  const b = e.target.closest('button[data-dock]')
  if (b) { state = await call('setDock', b.dataset.dock); renderRoom() }
})
$('align-up').addEventListener('click', async () => { state = await call('nudge', -8) })
$('align-down').addEventListener('click', async () => { state = await call('nudge', 8) })

// ---------- DND ----------
$('dnd').addEventListener('change', async () => { state = await call('dnd', $('dnd').checked); render() })

// ---------- recall ----------
$('recall').addEventListener('click', async () => {
  state = await call('recall')
  if (state.reply) showReply(state.reply.text)
  render()
})

// ---------- ask to share ----------
let asking = null
function showAsk (ask) {
  asking = ask
  $('ask-text').textContent = ask.text ? `${ask.text}. Share it?` : `${ask.from}'s pet asks for your ${ask.kind} "${ask.title}". Share it?`
  $('ask').hidden = false
}
async function answerAsk (yes) {
  if (!asking) return
  const id = asking.id
  asking = null
  $('ask').hidden = true
  await call('answerAsk', { id, yes })
}
$('ask-yes').addEventListener('click', () => answerAsk(true))
$('ask-no').addEventListener('click', () => answerAsk(false))

// ---------- terminal ----------
const term = $('term')
const MAX_LINES = 200
const pad = n => String(n).padStart(2, '0')
function addTermLine (line) {
  const stick = term.scrollTop + term.clientHeight >= term.scrollHeight - 8
  const d = new Date(line.at || Date.now())
  const row = document.createElement('div')
  row.className = `tl ${line.source === 'codex' ? 'codex' : 'pet'} ${line.kind || ''}`
  const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} `
  const src = document.createElement('span'); src.className = 'src'; src.textContent = line.source === 'codex' ? 'codex ' : line.kind === 'you' ? 'you   ' : 'pet   '
  const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = line.text
  row.append(ts, src, tx)
  term.querySelector('.caret')?.remove()
  term.append(row)
  const caret = document.createElement('span'); caret.className = 'caret'; term.append(caret)
  while (term.querySelectorAll('.tl').length > MAX_LINES) term.querySelector('.tl').remove()
  if (stick) term.scrollTop = term.scrollHeight
}
$('term-toggle').addEventListener('click', () => {
  const wrap = $('term-wrap')
  wrap.hidden = !wrap.hidden
  $('term-toggle').textContent = wrap.hidden ? 'Show' : 'Hide'
  $('term-toggle').setAttribute('aria-expanded', String(!wrap.hidden))
  if (!wrap.hidden) term.scrollTop = term.scrollHeight
})

// ---------- footer ----------
function renderFooter () {
  const muted = Boolean(state?.muted)
  $('mute-label').textContent = muted ? 'Sound on' : 'Mute'
  $('mute').classList.toggle('on', muted)
  document.querySelector('.ico-sound').style.backgroundImage = icon(muted ? 'muted' : 'sound')
}
$('mute').addEventListener('click', async () => { state = await call('mute'); renderFooter() })
$('party').addEventListener('click', () => call('party'))
$('collapse').addEventListener('click', () => call('collapse'))
$('quit').addEventListener('click', () => call('quit'))
$('choose-folder').addEventListener('click', async () => { pets = await call('chooseFolder'); renderAllPets() })
$('follow-codex').addEventListener('change', async () => {
  if ($('follow-codex').checked) { pets = await call('followCodex'); renderAllPets() } else $('follow-codex').checked = true
})
addEventListener('keydown', e => { if (e.key === 'Escape') call('hide') })

function render () {
  renderHeader(); renderMode(); renderRoom(); renderFooter()
  $('dnd').checked = Boolean(state?.dnd)
}

async function loadCatalog () {
  try { catalog = await call('catalog') } catch { catalog = [] }
  renderCatalog()
}

bridge.on(msg => {
  if (msg.type === 'state') { state = msg.state; render() } else if (msg.type === 'line') addTermLine(msg.line)
  else if (msg.type === 'reply') showReply(msg.reply.text)
  else if (msg.type === 'people') { people = msg.people || []; renderPeople() }
  else if (msg.type === 'cowork') { showCowork(msg.cowork.text, msg.cowork.ok !== false, Boolean(msg.cowork.pending)); renderPeople() }
  else if (msg.type === 'ask') showAsk(msg.ask)
  else if (msg.type === 'ask-done') { if (asking?.id === msg.id) { asking = null; $('ask').hidden = true } }
  else if (msg.type === 'shown') { call('pets').then(p => { pets = p; renderAllPets() }).catch(() => {}); loadCatalog() }
})

async function start () {
  paintIcons()
  const init = await call('init')
  state = init.state
  pets = init.pets
  people = init.people || []
  renderPeople()
  for (const line of init.lines) addTermLine(line)
  if (!init.lines.length) addTermLine({ source: 'pet', kind: 'info', text: 'watching Codex and your pet…', at: Date.now() })
  render()
  renderAllPets()
  await loadCatalog()
  window.__panelReady.done = true
}
start().catch(error => console.error(`panel start: ${error.message}`))
