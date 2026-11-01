// Menu-bar / system-tray icon (build B4): room code, Seat, Dock, Align, Codex registration, Quit.
import { Menu, Tray, nativeImage } from 'electron'
import zlib from 'node:zlib'

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

/**
 * state(): { room, seat (int|null), dock ('left'|'right'), align (DIP), codex ('registered'|'unregistered'|'missing'|null) }
 * actions: copyRoom(), setSeat(seat|null), setDock(side), nudge(dy | 'reset'), registerCodex(), quit()
 */
export function createTray({ state, actions }) {
  let tray
  try {
    tray = new Tray(trayImage())
  } catch (error) {
    console.error(`petpack: no tray icon (${error.message})`)
    return { refresh() {}, destroy() {} }
  }
  tray.setToolTip('petpack')
  function build() {
    const s = state()
    const codex = s.codex === 'registered'
      ? [{ label: 'Registered ✓', enabled: false }]
      : s.codex === 'missing'
        ? [{ label: 'Codex not found', enabled: false }]
        : [{ label: 'Register', click: () => actions.registerCodex() }]
    return Menu.buildFromTemplate([
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
      { label: 'Align', submenu: [
        { label: 'Up', click: () => actions.nudge(-8) },
        { label: 'Down', click: () => actions.nudge(8) },
        { label: s.align ? `Reset (${s.align > 0 ? '+' : ''}${s.align})` : 'Reset', enabled: Boolean(s.align),
          click: () => actions.nudge('reset') },
      ] },
      { label: 'Codex', submenu: codex },
      { type: 'separator' },
      { label: 'Quit petpack', click: () => actions.quit() },
    ])
  }
  const refresh = () => { if (!tray.isDestroyed()) tray.setContextMenu(build()) }
  refresh()
  return { refresh, destroy: () => tray.destroy() }
}
