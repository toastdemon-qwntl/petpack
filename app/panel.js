// The tray popover (TRAY lane): a small glass window under the menu-bar icon (over it on a bottom taskbar) with your
// pet, recall, the pet picker, sharing, room, Do Not Disturb, a live activity terminal and the footer actions.
//
//   import { createPanel } from './panel.js'
//   const panel = createPanel({ tray, state, actions, pane: () => win, userData })
//   tray.on('click', () => panel.toggle())
//
// Main <-> popover: 'petpack:panel' (invoke cmd, arg) and 'petpack:panel-push' (state / line / ask).
// Pane page <-> main (preload one-liners, see the TRAY report): the page reports 'petpack:panel-report'
//   { status?, errand?: { kind, label, with } | null, home?, dnd?, muted?, online?, name? } and activity lines
//   'petpack:activity' { text, kind? }; main sends it 'petpack:panel-command' { cmd: 'recall'|'dnd'|'mute'|'party', on? }
//   and 'petpack:window-event' { type: 'collapse'|'expand' } (the COLLAPSE lane's channel).
//   'petpack:ask-share' (invoke { title, kind, ref, from }) -> boolean: the popover asks the person first.

import { BrowserWindow, app, clipboard, dialog, ipcMain, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PANEL, anchorBounds, recallReply, ringBuffer, statusLine, tailRollouts } from './panel-core.js'
import { MODES, readSharing, sharingFile, writeSharing } from './sharing.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ORIGIN = 'petpack://local'
const URL_PANEL = `${ORIGIN}/app/renderer/panel.html`
const IS_MAC = process.platform === 'darwin'
const DEFAULT_ROOM = 'dde-ldn'

let codexModule = null
const loadCodex = async () => (codexModule ??= await import('./codex/index.js'))
let catalogModule = null
const loadCatalog = async () => (catalogModule ??= await import('./codex/catalog.js'))

export function createPanel ({ tray, state = () => ({}), actions = {}, pane, userData = app.getPath('userData'), onPetChange, log = () => {} } = {}) {
  let win = null
  let ready = false
  let pinned = Boolean(process.env.PETPACK_PANEL_SHOTS)
  const lines = ringBuffer(200)
  let report = {} // the pane's last report
  let codexStatus = 'idle'
  let reply = null // { text, at } the pet's last answer to recall
  let muted = false
  let petName = null
  let blurredAt = 0
  let dialogOpen = false
  let pending = new Map() // ask-share id -> resolve
  let askSeq = 0
  const consoleErrors = []

  const paneWin = () => {
    const w = typeof pane === 'function' ? pane() : null
    if (w && !w.isDestroyed()) return w
    return BrowserWindow.getAllWindows().find(x => !x.isDestroyed() && x !== win && x.webContents.getURL().includes('/app/renderer/index.html')) || null
  }
  const toPane = (channel, payload) => { const w = paneWin(); if (w) w.webContents.send(channel, payload); return Boolean(w) }
  const push = msg => { if (win && !win.isDestroyed() && ready) win.webContents.send('petpack:panel-push', msg) }
  function addLine (line) {
    const entry = lines.push({ source: line.source || 'pet', kind: line.kind || 'info', text: String(line.text || '').slice(0, 160), at: line.at || Date.now() })
    push({ type: 'line', line: entry })
  }

  // Codex: status (header) and the live session (terminal), both read-only.
  let stopStatus = () => {}
  import('./codex/status.js').then(m => {
    stopStatus = m.watchStatus(s => {
      if (!s?.status || s.status === codexStatus) return
      codexStatus = s.status
      addLine({ source: 'codex', kind: 'status', text: `status: ${s.status}` })
      push({ type: 'state', state: snapshot() })
    }, { intervalMs: 1500 })
  }).catch(error => log(`panel status: ${error.message}`))
  const stopTail = tailRollouts(addLine, { intervalMs: 1000 })

  function sharing () { return readSharing(userData) }
  // First run with a settings.json `share` block (L3b's) but no sharing.json yet: start from it.
  if (!fs.existsSync(sharingFile(userData))) {
    try {
      const share = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))?.share
      if (share && typeof share === 'object') writeSharing(userData, { mode: share.mode === 'never' ? 'off' : share.mode, hidden: share.off })
    } catch {}
  }
  function snapshot () {
    const s = state() || {}
    const sh = sharing()
    return {
      room: s.room || DEFAULT_ROOM, seat: s.seat ?? null, dock: s.dock || 'right', align: s.align || 0, codex: s.codex ?? null,
      sharing: sh, dnd: sh.dnd, muted: report.muted ?? muted, online: Number.isFinite(report.online) ? report.online : null,
      status: statusLine({ ...report, dnd: sh.dnd }, codexStatus), codexStatus, errand: report.errand || null,
      reply, platform: process.platform, canSetRoom: true,
    }
  }
  const refresh = () => push({ type: 'state', state: snapshot() })

  // The pane page's reports (any petpack:// page that isn't the popover).
  const fromPane = event => String(event.senderFrame?.url || '').startsWith(`${ORIGIN}/`) && (!win || event.sender !== win.webContents)
  const onReport = (event, r) => {
    if (!fromPane(event) || !r || typeof r !== 'object') return
    const before = report.errand
    const { recall, ...rest } = r
    report = { ...report, ...rest }
    if (typeof r.muted === 'boolean') muted = r.muted
    if (!report.errand && before && reply) reply = null
    // brain.recall()'s own answer ({ busy, message }) replaces the popover's guess.
    if (recall && typeof recall.message === 'string') {
      reply = { text: recall.message, busy: Boolean(recall.busy), at: Date.now() }
      push({ type: 'reply', reply })
    }
    refresh()
  }
  const onActivity = (event, line) => {
    if (!fromPane(event) || !line) return
    const entry = typeof line === 'string' ? { source: 'pet', text: line } : { source: 'pet', ...line }
    addLine(entry)
    // brain.recall()'s answer arrives as a 'recall' activity line: it is the pet's reply in the header too.
    if (entry.kind === 'recall' && entry.text) {
      reply = { text: String(entry.text).slice(0, 120), busy: /busy/i.test(entry.text), at: Date.now() }
      push({ type: 'reply', reply })
    }
  }
  ipcMain.on('petpack:panel-report', onReport)
  ipcMain.on('petpack:activity', onActivity)
  ipcMain.removeHandler('petpack:ask-share')
  ipcMain.handle('petpack:ask-share', async (event, req = {}) => {
    if (!fromPane(event)) throw new Error('not allowed')
    // The brain already applied the rules (askPermission); this only asks the person.
    const id = ++askSeq
    const from = String(req.fromName || req.from || 'a teammate').slice(0, 60)
    const ask = { id, title: String(req.title || 'something').slice(0, 120), kind: req.kind || 'item', from,
      text: typeof req.text === 'string' && req.text ? req.text.slice(0, 160) : null }
    addLine({ source: 'pet', kind: 'ask', text: ask.text || `${from} asks for ${ask.kind} "${ask.title}"` })
    show()
    push({ type: 'ask', ask })
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); push({ type: 'ask-done', id }); resolve(false) }, Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : 30000)
      pending.set(id, yes => { clearTimeout(timer); push({ type: 'ask-done', id }); resolve(Boolean(yes)) })
    })
  })

  // Replays DND / mute into every (re)loaded pane page.
  const hooked = new WeakSet()
  function hookPane () {
    const w = paneWin()
    if (!w || hooked.has(w.webContents)) return
    hooked.add(w.webContents)
    w.webContents.on('did-finish-load', () => setTimeout(() => {
      const sh = sharing()
      if (sh.dnd) { toPane('petpack:panel-command', { cmd: 'dnd', on: true }); toPane('petpack:window-event', { type: 'collapse' }) }
      if (muted || sh.dnd) toPane('petpack:panel-command', { cmd: 'mute', on: true })
    }, 1500))
    w.webContents.on('console-message', e => { if (e.level === 'error') consoleErrors.push({ where: 'pane', message: e.message }) })
  }
  hookPane()

  // ---- commands from the popover ----
  async function petsPayload () {
    const codex = await loadCodex()
    const [list, current] = await Promise.all([codex.listPets({ sprites: true }), codex.currentPet()])
    if (current?.displayName) petName = current.displayName
    return {
      current: current ? { id: current.petName, displayName: current.displayName, spriteUrl: current.spriteUrl, atlas: current.atlas, source: current.source, path: current.path } : null,
      list: list.filter(p => p.available !== 'no').map(p => ({ id: p.source === 'custom' ? p.path && path.dirname(p.path) : p.id, key: p.id,
        displayName: p.displayName, source: p.source, spriteUrl: p.spriteUrl || null, atlas: p.atlas || null, current: Boolean(p.current),
        available: p.available })),
    }
  }
  async function choose (idOrPath) {
    const codex = await loadCodex()
    const pet = await codex.choosePet(idOrPath)
    addLine({ source: 'pet', kind: 'pet', text: idOrPath == null ? `following Codex's pet: ${pet.displayName}` : `now wearing ${pet.displayName}` })
    if (typeof onPetChange === 'function') onPetChange(pet)
    else toPane('petpack:me-changed')
    return petsPayload()
  }
  // Every item the pet could share (before the share filter), with its source file for the hover.
  async function catalogPayload () {
    const cat = await loadCatalog()
    const opts = { userData, answersDir: path.join(userData, 'answers') }
    const sh = sharing()
    if (typeof cat.listShareable === 'function') {
      return (await cat.listShareable(opts)).map(i => ({ ref: i.id, kind: i.kind, title: i.title,
        path: i.kind === 'skill' && i.sourcePath && !/\.md$/i.test(i.sourcePath) ? path.join(i.sourcePath, 'SKILL.md') : i.sourcePath || null,
        on: !sh.hidden.includes(i.id) }))
    }
    const built = await cat.buildCatalog(opts)
    return (built.all || built.items).map(item => {
      const src = built.index?.get?.(item.ref)?.src || {}
      const file = src.dir ? path.join(src.dir, 'SKILL.md') : (src.file || null)
      return { ref: item.ref, kind: item.kind, title: item.title, path: file, on: !sh.hidden.includes(item.ref) }
    })
  }
  // One sharing change, everywhere: sharing.json (the popover), settings.json `share` through main (L3b's catalog
  // filter reads it), and the live brain (brain.setSharing shape: mode free|ask|never, items { ref: false }).
  function applySharing (patch) {
    const sh = writeSharing(userData, patch)
    try { actions.setShare?.({ mode: sh.mode === 'off' ? 'never' : sh.mode, off: sh.hidden }) } catch (error) { log(`setShare: ${error.message}`) }
    // { mode: free|ask|off, hidden } as wired in app.js, plus brain.setSharing's own { items } for direct use.
    toPane('petpack:panel-command', { cmd: 'sharing', sharing: { mode: sh.mode, hidden: sh.hidden,
      items: Object.fromEntries(sh.hidden.map(ref => [ref, false])) } })
    return sh
  }
  function setDnd (on) {
    const sh = writeSharing(userData, { dnd: Boolean(on) })
    toPane('petpack:panel-command', { cmd: 'dnd', on: sh.dnd })
    toPane('petpack:window-event', { type: sh.dnd ? 'collapse' : 'expand' })
    toPane('petpack:panel-command', { cmd: 'mute', on: sh.dnd || muted })
    addLine({ source: 'pet', kind: 'dnd', text: sh.dnd ? 'do not disturb: tucked in at home, zzz' : 'back to work, asks welcome' })
    refresh()
    return snapshot()
  }
  async function setRoom (code) {
    const room = String(code || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48) || null
    addLine({ source: 'pet', kind: 'room', text: `moving to room ${room || DEFAULT_ROOM}` })
    if (typeof actions.setRoom === 'function') { await actions.setRoom(room); refresh(); return snapshot() }
    // Until main has setRoom: save it where main reads it and start again (a reconnect).
    const file = path.join(userData, 'settings.json')
    let s = {}
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    fs.writeFileSync(file, JSON.stringify({ ...s, room }, null, 2) + '\n')
    setTimeout(() => { app.relaunch(); app.exit(0) }, 300)
    return snapshot()
  }

  const commands = {
    init: async () => ({ state: snapshot(), lines: lines.all(), pets: await petsPayload().catch(() => ({ current: null, list: [] })) }),
    state: () => snapshot(),
    pets: () => petsPayload(),
    choosePet: id => choose(id),
    followCodex: () => choose(null),
    chooseFolder: async () => {
      dialogOpen = true // the open panel takes focus; the popover stays put meanwhile
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose a Codex pet', message: 'Pick a pet folder (pet.json + spritesheet) or its spritesheet file',
        properties: IS_MAC ? ['openDirectory', 'openFile'] : ['openFile'],
        filters: [{ name: 'Codex pet (pet.json, spritesheet)', extensions: ['json', 'webp', 'png'] }],
      }).catch(() => ({ canceled: true })).finally(() => { dialogOpen = false; if (win && !win.isDestroyed()) win.focus() })
      if (result.canceled || !result.filePaths?.[0]) return petsPayload()
      const picked = result.filePaths[0]
      return choose(/\.json$/i.test(picked) ? path.dirname(picked) : picked)
    },
    catalog: () => catalogPayload(),
    setMode: mode => {
      if (!MODES.includes(mode)) throw new Error('unknown sharing mode')
      applySharing({ mode })
      addLine({ source: 'pet', kind: 'share', text: mode === 'free' ? 'sharing freely' : mode === 'ask' ? 'will ask you before sharing' : 'not sharing anything' })
      return snapshot()
    },
    setShared: ({ ref, on } = {}) => {
      if (typeof ref !== 'string' || !ref) throw new Error('no item')
      const hidden = new Set(sharing().hidden)
      if (on) hidden.delete(ref); else hidden.add(ref)
      applySharing({ hidden: [...hidden] })
      return snapshot()
    },
    answerAsk: ({ id, yes } = {}) => { const done = pending.get(id); pending.delete(id); done?.(yes); return true },
    recall: () => {
      const s = snapshot()
      const name = report.petName || petName || 'your pet'
      reply = { text: recallReply({ ...report, dnd: s.dnd }, name), at: Date.now() }
      toPane('petpack:panel-command', { cmd: 'recall' })
      addLine({ source: 'pet', kind: 'you', text: 'you: come home!' })
      refresh()
      return snapshot()
    },
    copyRoom: () => { clipboard.writeText(snapshot().room); return true },
    setRoom: code => setRoom(code),
    setDock: side => { actions.setDock?.(side === 'left' ? 'left' : 'right'); return snapshot() },
    nudge: dy => { actions.nudge?.(dy === 'reset' ? 'reset' : Number(dy) || 0); return snapshot() },
    dnd: on => setDnd(on),
    mute: () => {
      muted = !(report.muted ?? muted)
      report.muted = muted
      toPane('petpack:panel-command', { cmd: 'mute', on: muted })
      return snapshot()
    },
    party: () => { toPane('petpack:panel-command', { cmd: 'party' }); addLine({ source: 'pet', kind: 'party', text: 'party! everyone into the conga line' }); return true },
    collapse: () => { toPane('petpack:window-event', { type: 'toggle' }); hide(); return true },
    registerCodex: async () => { await actions.registerCodex?.(); return snapshot() },
    quit: () => { (actions.quit || (() => app.quit()))(); return true },
    hide: () => { hide(); return true },
    pin: on => { pinned = Boolean(on); return true },
  }
  ipcMain.removeHandler('petpack:panel')
  ipcMain.handle('petpack:panel', async (event, cmd, arg) => {
    if (!win || event.sender !== win.webContents) throw new Error('not allowed')
    const fn = commands[cmd]
    if (!fn) throw new Error(`unknown panel command ${cmd}`)
    return fn(arg)
  })

  // ---- the window ----
  function create () {
    win = new BrowserWindow({
      width: PANEL.width, height: PANEL.height, show: false, frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      transparent: true, backgroundColor: '#00000000', hasShadow: true, roundedCorners: true,
      ...(IS_MAC ? { type: 'panel', vibrancy: 'popover', visualEffectState: 'active' } : {}),
      title: 'petpack',
      webPreferences: { preload: path.join(HERE, 'panel-preload.cjs'), contextIsolation: true, sandbox: true,
        nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    })
    win.setAlwaysOnTop(true, IS_MAC ? 'pop-up-menu' : 'screen-saver')
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    const wc = win.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', e => e.preventDefault())
    wc.on('console-message', e => {
      if (e.level === 'error') { consoleErrors.push({ where: 'panel', message: e.message, source: e.sourceId, line: e.lineNumber }); console.error(`[panel] ${e.message}`) }
    })
    wc.on('did-finish-load', () => { ready = true })
    wc.on('did-start-loading', () => { ready = false })
    // Clicking the tray icon while open blurs first; remember when, so that click doesn't open it again (toggle).
    win.on('blur', () => { if (!pinned && !dialogOpen) { blurredAt = Date.now(); hide() } })
    win.on('closed', () => { win = null; ready = false })
    wc.loadURL(URL_PANEL + (IS_MAC ? '#mac' : '')).catch(error => consoleErrors.push({ where: 'panel', message: `loadURL: ${error.message}` }))
  }
  function place () {
    if (!win) return
    let trayBounds = null
    try { trayBounds = tray && !tray.isDestroyed() ? tray.getBounds() : null } catch {}
    const point = trayBounds && trayBounds.width ? { x: trayBounds.x, y: trayBounds.y } : screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    win.setBounds(anchorBounds({ tray: trayBounds, workArea: display.workArea, bounds: display.bounds }))
  }
  function show () {
    if (!win || win.isDestroyed()) create()
    hookPane()
    place()
    win.show()
    win.focus()
    refresh()
    push({ type: 'shown' })
  }
  function hide () { if (win && !win.isDestroyed() && win.isVisible()) win.hide() }
  function toggle () {
    if (win && !win.isDestroyed() && win.isVisible()) hide()
    else if (Date.now() - blurredAt > 300) show()
  }
  create()

  const api = {
    show, hide, toggle, refresh, addLine, commands,
    get window () { return win },
    isVisible: () => Boolean(win && !win.isDestroyed() && win.isVisible()),
    errors: () => consoleErrors.slice(),
    destroy () {
      stopTail(); stopStatus()
      ipcMain.removeListener('petpack:panel-report', onReport)
      ipcMain.removeListener('petpack:activity', onActivity)
      ipcMain.removeHandler('petpack:panel'); ipcMain.removeHandler('petpack:ask-share')
      for (const done of pending.values()) done(false)
      pending = new Map()
      if (win && !win.isDestroyed()) win.destroy()
    },
  }
  if (process.env.PETPACK_PANEL_SHOTS) selfTest(api, { dir: path.resolve(process.env.PETPACK_PANEL_SHOTS), userData }).catch(error => {
    console.error(`panel self-test: ${error.stack || error.message}`); app.exit(1)
  })
  return api
}

// ---------------------------------------------------------------------------------------------------------------
// PETPACK_PANEL_SHOTS=<dir>: open the popover, screenshot each section, toggle DND and sharing, check they persist.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function selfTest (panel, { dir, userData }) {
  fs.mkdirSync(dir, { recursive: true })
  await wait(Number(process.env.PETPACK_PANEL_SHOTS_WAIT || 6) * 1000)
  panel.show()
  const win = panel.window
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve))
  const js = code => win.webContents.executeJavaScript(code)
  await js('window.__panelReady')
  for (let i = 0; i < 40 && !(await js('Boolean(window.__panelReady && window.__panelReady.done)')); i++) await wait(250)
  await wait(1500)
  const shot = async name => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG()) }
  const checks = {}
  const sections = ['header', 'pets', 'sharing', 'room', 'dnd', 'activity', 'footer']
  await shot('00-open')
  for (const [i, id] of sections.entries()) {
    await js(`document.getElementById('sec-${id}')?.scrollIntoView({ block: 'start' }); true`)
    await wait(350)
    await shot(`${String(i + 1).padStart(2, '0')}-${id}`)
  }
  checks.sectionsPresent = await js(`${JSON.stringify(sections)}.every(id => document.getElementById('sec-' + id))`)
  checks.petCount = await js('document.querySelectorAll(".pet-tile").length')
  checks.catalogCount = await js('document.querySelectorAll(".share-item").length')
  // Recall.
  await js(`document.getElementById('sec-header').scrollIntoView(); document.getElementById('recall').click(); true`)
  await wait(1500)
  checks.recallReply = await js(`document.getElementById('reply').textContent`)
  await shot('08-recall')
  // Sharing mode: Ask me first, then one item off.
  await js(`document.getElementById('sec-sharing').scrollIntoView(); document.querySelector('[data-mode="ask"]').click(); true`)
  await wait(400)
  const firstRef = await js(`(() => { const t = document.querySelector('.share-item input'); if (!t) return null; t.click(); return t.dataset.ref })()`)
  await wait(500)
  await shot('09-sharing-ask')
  let saved = readSharing(userData)
  checks.sharingMode = saved.mode
  checks.hiddenSaved = firstRef ? saved.hidden.includes(firstRef) : 'no catalog items'
  // DND on.
  await js(`document.getElementById('sec-dnd').scrollIntoView(); document.getElementById('dnd').click(); true`)
  await wait(700)
  await shot('10-dnd-on')
  saved = readSharing(userData)
  checks.dndSaved = saved.dnd
  checks.dndUi = await js(`document.body.classList.contains('dnd')`)
  // Activity terminal.
  panel.addLine({ source: 'pet', kind: 'errand', text: 'walking to Bea to fetch "deploy checklist"' })
  await js(`document.getElementById('sec-activity').scrollIntoView(); true`)
  await wait(400)
  checks.terminalLines = await js(`document.querySelectorAll('#term .tl').length`)
  await shot('11-activity')
  // Back to the defaults (DND off, Share freely, item back on), then check that persisted too.
  await js(`document.getElementById('dnd').click(); document.querySelector('[data-mode="free"]').click(); true`)
  await wait(400)
  if (firstRef) await js(`(() => { const t = document.querySelector('.share-item input[data-ref="${firstRef.replace(/"/g, '\\"')}"]'); t && t.click(); return true })()`)
  await wait(500)
  saved = readSharing(userData)
  checks.restored = saved.dnd === false && saved.mode === 'free' && (!firstRef || !saved.hidden.includes(firstRef))
  await shot('12-restored')
  const errors = panel.errors()
  const ok = checks.sectionsPresent && checks.sharingMode === 'ask' && checks.dndSaved === true && checks.dndUi === true &&
    checks.restored && checks.hiddenSaved !== false && checks.terminalLines > 0 && errors.length === 0
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ok, checks, errors, at: new Date().toISOString() }, null, 2))
  console.log(`panel self-test: ${ok ? 'ok' : 'FAILED'} ${JSON.stringify(checks)} errors=${errors.length} -> ${dir}`)
  if (process.env.PETPACK_PANEL_SHOTS_EXIT !== '0') app.exit(ok ? 0 : 1)
}
