// Menu-bar / system-tray icon (build B4): room code, Seat, Dock, Align, Pet, Codex registration, Quit.
import { BrowserWindow, Menu, Tray, dialog, nativeImage } from 'electron'
import path from 'node:path'
import zlib from 'node:zlib'
import { createPanel } from './panel.js'

// A 16x16 pixel pet head (two ears, two eyes), drawn as rows: '#' body, '.' clear.
const ART = [
  '................',
  '................',
  '...###....###...',
  '...###....###...',
  '...##########...',
  '..############..',
  '..############..',
  '..##..####..##..',
  '..##..####..##..',
  '..############..',
  '..############..',
  '..#####..#####..',
  '...##########...',
  '...##......##...',
  '...##......##...',
  '................',
]

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** Encode the art at `scale` as an RGBA PNG data URL. */
export function iconDataUrl(scale = 1, rgba = [0, 0, 0, 255]) {
  const size = 16 * scale
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1)
    for (let x = 0; x < size; x++) {
      if (ART[Math.floor(y / scale)][Math.floor(x / scale)] !== '#') continue
      raw.set(rgba, row + 1 + x * 4)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return `data:image/png;base64,${png.toString('base64')}`
}

function trayImage() {
  const mac = process.platform === 'darwin'
  const color = mac ? [0, 0, 0, 255] : [116, 169, 195, 255] // template black on macOS, petpack blue elsewhere
  const image = nativeImage.createFromDataURL(iconDataUrl(1, color))
  image.addRepresentation({ scaleFactor: 2, dataURL: iconDataUrl(2, color) })
  if (mac) image.setTemplateImage(true)
  return image
}

// ---- Pet ▸ picker (L3a): every pet app/codex finds, a check on the current one, and a folder chooser. ----
let codexModule = null
const loadCodexModule = async () => (codexModule ??= await import('./codex/index.js'))

function petMenu(pets, choose, chooseFolder) {
  const items = []
  const cur = pets.current
  if (!cur || cur.source === 'none') items.push({ label: 'No Codex pet found: choose one…', click: chooseFolder }, { type: 'separator' })
  const usable = pets.list.filter(p => p.available !== 'no')
  const custom = usable.filter(p => p.source === 'custom')
  const builtin = usable.filter(p => p.source === 'builtin')
  const item = p => ({ label: p.available === 'download' ? `${p.displayName} (downloads)` : p.displayName,
    type: 'checkbox', checked: Boolean(p.current), click: () => choose(p.id) })
  if (custom.length) items.push({ label: 'Your pets', enabled: false }, ...custom.map(item))
  if (builtin.length) items.push({ label: 'Codex pets', enabled: false }, ...builtin.map(item))
  if (usable.length) items.push({ type: 'separator' })
  items.push({ label: 'Use the pet selected in Codex', type: 'checkbox', checked: cur?.source !== 'chosen', click: () => choose(null) })
  items.push({ label: 'Choose a pet folder…', click: chooseFolder })
  return items
}

/**
 * state(): { room, seat (int|null), dock ('left'|'right'), align (DIP), codex ('registered'|'unregistered'|'missing'|null) }
 * actions: copyRoom(), setSeat(seat|null), setDock(side), nudge(dy | 'reset'), registerCodex(), quit(), setRoom?(code|null)
 * onPetChange(pet): optional; called after the person picks a pet. Without it the tray reloads petpack's windows,
 *   which re-runs getMe() and re-sends the sprite to the room.
 * pane(): optional, the docked pane BrowserWindow (the popover sends it recall/DND/mute/party); userData: optional.
 *
 * Clicking the icon opens the popover (app/panel.js); right-click opens this native menu. Linux trays mostly can't
 * tell clicks apart, so there the menu stays the click target and starts with "Open petpack…".
 */
export function createTray({ state, actions, onPetChange, pane, userData }) {
  let tray
  try {
    tray = new Tray(trayImage())
  } catch (error) {
    console.error(`petpack: no tray icon (${error.message})`)
    return { refresh() {}, destroy() {} }
  }
  tray.setToolTip('petpack')
  const nativeMenuOnClick = process.platform === 'linux'
  let panel = null
  try {
    panel = createPanel({ tray, state, actions, pane, userData, onPetChange: pet => { onPetChange?.(pet); loadPets() } })
  } catch (error) {
    console.error(`petpack: no tray popover (${error.message})`)
  }
  if (panel && !nativeMenuOnClick) {
    tray.on('click', () => panel.toggle())
    tray.on('right-click', () => { if (!tray.isDestroyed()) tray.popUpContextMenu(build()) })
  }
  if (panel && (process.argv.includes('--panel') || process.env.PETPACK_PANEL === 'open')) setTimeout(() => panel.show(), 1500)
  let pets = { list: [], current: null }
  let retries = 0
  async function loadPets() {
    try {
      const codex = await loadCodexModule()
      const [list, current] = await Promise.all([codex.listPets({ sprites: false }), codex.currentPet()])
      if (current === null && retries++ < 20) { setTimeout(loadPets, 1500); return } // Codex core not created yet
      pets = { list, current }
      tray.setToolTip(current && current.source !== 'none' ? `petpack · ${current.displayName}` : 'petpack · no Codex pet found')
    } catch (error) {
      console.error(`petpack: pet list failed (${error.message})`)
    }
    refresh()
  }
  async function choose(idOrPath) {
    try {
      const codex = await loadCodexModule()
      const pet = await codex.choosePet(idOrPath)
      if (typeof onPetChange === 'function') onPetChange(pet)
      else for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.reload()
    } catch (error) {
      dialog.showMessageBox({ type: 'warning', message: 'petpack could not use that pet',
        detail: `${error.message}\n\nA Codex pet is a folder with pet.json and an 8x9 (or 8x11) spritesheet.webp or .png.` }).catch(() => {})
    }
    loadPets()
  }
  async function chooseFolder() {
    const mac = process.platform === 'darwin'
    const result = await dialog.showOpenDialog({
      title: 'Choose a Codex pet',
      message: 'Pick a pet folder (pet.json + spritesheet) or its spritesheet file',
      properties: mac ? ['openDirectory', 'openFile'] : ['openFile'],
      filters: [{ name: 'Codex pet (pet.json, spritesheet)', extensions: ['json', 'webp', 'png'] }],
    }).catch(() => ({ canceled: true }))
    if (result.canceled || !result.filePaths?.[0]) return
    const picked = result.filePaths[0]
    choose(/\.json$/i.test(picked) ? path.dirname(picked) : picked)
  }
  function build() {
    const s = state()
    const codex = s.codex === 'registered'
      ? [{ label: 'Registered ✓', enabled: false }]
      : s.codex === 'missing'
        ? [{ label: 'Codex not found', enabled: false }]
        : [{ label: 'Register', click: () => actions.registerCodex() }]
    return Menu.buildFromTemplate([
      ...(actions.showMe ? [{ label: 'Show me', click: () => actions.showMe() }] : []),
      ...(panel ? [{ label: 'Open petpack…', click: () => panel.show() }, { type: 'separator' }] : []),
      { label: s.room ? `Room ${s.room} (copy)` : 'Room: everyone on this network', enabled: Boolean(s.room),
        click: () => actions.copyRoom() },
      { type: 'separator' },
      { label: 'Seat', submenu: [
        { label: 'Auto', type: 'radio', checked: s.seat == null, click: () => actions.setSeat(null) },
        ...[0, 1, 2, 3, 4, 5].map(i => ({ label: String(i + 1), type: 'radio', checked: s.seat === i,
          click: () => actions.setSeat(i) })),
      ] },
      { label: 'Dock', submenu: [
        { label: 'Left', type: 'radio', checked: s.dock === 'left', click: () => actions.setDock('left') },
        { label: 'Right', type: 'radio', checked: s.dock !== 'left', click: () => actions.setDock('right') },
      ] },
      ...(actions.setSit ? [{ label: 'Sitting', submenu: [
        { label: 'Side by side', type: 'radio', checked: s.sit !== 'across', click: () => actions.setSit('side') },
        { label: 'Across the table', type: 'radio', checked: s.sit === 'across', click: () => actions.setSit('across') },
      ] }] : []),
      { label: 'Align', submenu: [
        { label: 'Up', click: () => actions.nudge(-8) },
        { label: 'Down', click: () => actions.nudge(8) },
        { label: s.align ? `Reset (${s.align > 0 ? '+' : ''}${s.align})` : 'Reset', enabled: Boolean(s.align),
          click: () => actions.nudge('reset') },
      ] },
      { label: pets.current && pets.current.source !== 'none' ? `Pet: ${pets.current.displayName}` : 'Pet',
        submenu: petMenu(pets, choose, chooseFolder) },
      { label: 'Codex', submenu: [...codex,
        ...(actions.setAnswerInCodex ? [{ type: 'separator' }, { label: 'Answer teammates in Codex', type: 'checkbox',
          checked: s.answerInCodex !== false, click: item => actions.setAnswerInCodex(item.checked) }] : [])] },
      { type: 'separator' },
      { label: 'Quit petpack', click: () => actions.quit() },
    ])
  }
  // macOS/Windows: the click opens the popover, so the menu is only popped on right-click (setContextMenu would take
  // the left click too). Linux: the menu is the click target.
  const refresh = () => {
    if (tray.isDestroyed()) return
    if (!panel || nativeMenuOnClick) tray.setContextMenu(build())
    panel?.refresh()
  }
  refresh()
  loadPets()
  return { refresh, refreshPets: loadPets, panel, destroy: () => { panel?.destroy(); tray.destroy() } }
}
