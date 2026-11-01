/**
 * PLAY postcard companion. attachPhoto(world, { date? }) returns the same world
 * and adds world.photo(): a synchronous PNG data URL (null after disposal).
 * date can be a Date, an ISO date string, or a function returning either; omitted
 * means the viewer's current local date. The live scene is captured at its art
 * resolution, framed, then enlarged exactly 4× with nearest-neighbour sampling.
 * drawPixelIcon(ctx, kind, x, y, { pixel = 1, color }) draws a 9×9 pixel icon.
 */

const attached = new WeakMap()

const icons = {
  skill: [
    '000111000', '010111010', '111111111', '011000110', '111010111',
    '011000110', '111111111', '010111010', '000111000',
  ],
  memory: [
    '000000000', '011101110', '111111111', '100010001', '101010101',
    '101010101', '100010001', '111111111', '000010000',
  ],
  technique: [
    '001111000', '011111110', '011111110', '011111110', '111111110',
    '111111110', '011111100', '001111000', '001111000',
  ],
  resource: [
    '000010000', '000110000', '001110000', '001111000', '011111010',
    '111111110', '111011110', '011001100', '001111000',
  ],
  heart: [
    '000000000', '011001100', '111111110', '111111110', '111111110',
    '011111100', '001111000', '000110000', '000000000',
  ],
  star: [
    '000010000', '000111000', '000111000', '111111111', '011111110',
    '001111100', '011101110', '011000110', '010000010',
  ],
  idle: [
    '000000000', '000000000', '001111100', '011000110', '010000010',
    '011000110', '001111100', '000000000', '000000000',
  ],
  working: [
    '000010000', '000110000', '001110000', '011111110', '000111100',
    '000111000', '001110000', '001100000', '001000000',
  ],
  waiting: [
    '011111110', '001000100', '001101100', '000111000', '000010000',
    '000111000', '001101100', '001111100', '011111110',
  ],
  done: [
    '000000000', '000000010', '000000110', '000001100', '010011000',
    '011110000', '001100000', '000000000', '000000000',
  ],
  failed: [
    '000000000', '011000110', '011101110', '001111100', '000111000',
    '001111100', '011101110', '011000110', '000000000',
  ],
}

const iconColors = {
  skill: '#b47c49', memory: '#538d9b', technique: '#a76e71', resource: '#c47b4c',
  heart: '#df7c91', star: '#efc871', idle: '#819391', working: '#d3a653',
  waiting: '#9991ab', done: '#679c83', failed: '#c77f75',
}

export function drawPixelIcon(ctx, kind, x, y, { pixel = 1, color } = {}) {
  const mask = icons[kind] || icons.star
  const scale = Math.max(1, Math.round(pixel))
  ctx.save()
  ctx.fillStyle = color || iconColors[kind] || iconColors.star
  for (let row = 0; row < mask.length; row++) {
    for (let col = 0; col < mask[row].length; col++) {
      if (mask[row][col] === '1') ctx.fillRect(Math.round(x) + col * scale, Math.round(y) + row * scale, scale, scale)
    }
  }
  ctx.restore()
}

// Original 5×7 bitmap lettering: no downloaded font and no antialiased text.
const glyphs = {
  p: ['00000', '00000', '11110', '10001', '11110', '10000', '10000'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01111'],
  t: ['00100', '00100', '11110', '00100', '00100', '00101', '00010'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  c: ['00000', '00000', '01111', '10000', '10000', '10000', '01111'],
  k: ['10000', '10000', '10010', '10100', '11000', '10100', '10010'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
}

function lettering(ctx, text, x, y, color) {
  ctx.fillStyle = color
  for (const letter of text) {
    const mask = glyphs[letter]
    if (mask) for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) if (mask[row][col] === '1') ctx.fillRect(x + col, y + row, 1, 1)
    }
    x += 6
  }
}

function dateLabel(value) {
  if (typeof value === 'function') value = value()
  // An explicit date-only label must not shift a day when parsed in another zone.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = value === undefined ? new Date() : new Date(value)
  const valid = Number.isNaN(date.getTime()) ? new Date() : date
  return `${valid.getFullYear()}-${String(valid.getMonth() + 1).padStart(2, '0')}-${String(valid.getDate()).padStart(2, '0')}`
}

export function attachPhoto(world, { date } = {}) {
  if (attached.has(world)) return world
  const stage = world.stage
  const source = stage?.renderer?.domElement
  if (!source || typeof stage.render !== 'function') throw new TypeError('attachPhoto needs a live petpack world')
  const doc = source.ownerDocument
  let disposed = false
  const previousDispose = world.dispose

  function photo() {
    if (disposed) return null
    const pixelScale = Math.max(1, stage.pixelScale || 2)
    const ratio = stage.renderer.getPixelRatio?.() || 1
    const width = Math.max(1, Math.round((source.clientWidth || source.width / ratio) / pixelScale))
    const height = Math.max(1, Math.round((source.clientHeight || source.height / ratio) / pixelScale))
    const art = doc.createElement('canvas')
    art.width = width; art.height = height
    const artContext = art.getContext('2d')
    artContext.imageSmoothingEnabled = false
    // The WebGL buffer is deliberately not preserved during normal animation.
    // Re-render and copy in this same task before the browser can discard it.
    stage.render()
    artContext.drawImage(source, 0, 0, width, height)

    const border = 10
    const footer = 36
    const card = doc.createElement('canvas')
    card.width = width + border * 2; card.height = height + border + footer
    const ctx = card.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#f7efdb'
    ctx.fillRect(0, 0, card.width, card.height)
    ctx.fillStyle = '#ece1c8'
    // A few restrained paper fibres, deterministic and confined to the frame.
    for (let y = 3; y < card.height; y += 7) for (let x = 3; x < card.width; x += 11) {
      if ((x * 7 + y * 3) % 13 < 2 && (x < border || x > width + border || y < border || y > height + border)) ctx.fillRect(x, y, 1, 1)
    }
    ctx.fillStyle = '#e4d8bd'
    ctx.fillRect(border - 1, border - 1, width + 2, height + 2)
    ctx.drawImage(art, border, border)

    const bottom = border + height
    lettering(ctx, 'petpack', border + 1, bottom + 8, '#54766b')
    lettering(ctx, dateLabel(date), border + 1, bottom + 20, '#a39c84')

    // A perforated little village stamp; the room's landmark supplies the seal.
    const stampX = card.width - border - 22
    const stampY = bottom + 6
    ctx.fillStyle = '#d9d1b5'
    ctx.fillRect(stampX, stampY, 22, 24)
    ctx.fillStyle = '#fff9e9'
    ctx.fillRect(stampX + 1, stampY + 1, 20, 22)
    ctx.fillStyle = '#f7efdb'
    for (let offset = 2; offset < 22; offset += 4) {
      ctx.fillRect(stampX + offset, stampY, 2, 1)
      ctx.fillRect(stampX + offset, stampY + 23, 2, 1)
      ctx.fillRect(stampX, stampY + offset, 1, 2)
      ctx.fillRect(stampX + 21, stampY + offset, 1, 2)
    }
    ctx.fillStyle = '#e1e5cb'
    ctx.fillRect(stampX + 4, stampY + 4, 14, 16)
    const kind = world.map?.landmark?.(world.seat || 0)?.kind || 'skill'
    drawPixelIcon(ctx, kind, stampX + 7, stampY + 7)
    // Three short cancellation bars read as postage without competing with art.
    ctx.fillStyle = '#c4bda2'
    for (let y = 0; y < 3; y++) ctx.fillRect(stampX - 14 + y * 2, stampY + 6 + y * 3, 16 - y * 2, 1)

    const output = doc.createElement('canvas')
    output.width = card.width * 4; output.height = card.height * 4
    const outputContext = output.getContext('2d')
    outputContext.imageSmoothingEnabled = false
    outputContext.drawImage(card, 0, 0, output.width, output.height)
    return output.toDataURL('image/png')
  }

  function dispose(...args) {
    if (disposed) return
    disposed = true
    return previousDispose?.apply(world, args)
  }
  world.photo = photo
  world.dispose = dispose
  attached.set(world, { photo })
  return world
}
