import * as THREE from 'three'

// Original, hand-pixelled art. Dots remain light enough to take each pet's tint;
// larger storytelling icons have their own small, warm palette.
const PALETTE = {
  '.': null,
  o: '#665948', d: '#46564f', b: '#867055', c: '#c79659', g: '#e6b955',
  y: '#ffe89c', w: '#fff8dd', p: '#d6d3b1', t: '#699488', s: '#a7cfbd',
  r: '#b75b43', a: '#e9884b', f: '#ffd176', n: '#5a737b', l: '#a4bdbe',
}

const ART = {
  dot: [
    '................', '.......oo.......', '......oggo......', '.....ogywgo.....',
    '....ogywwwgo....', '...ogywwwwwgo...', '..ogywwwwwwwgo..', '.ogywwwwwwwwwgo.',
    '.ogywwwwwwwwwgo.', '..ogywwwwwwwgo..', '...ogywwwwwgo...', '....ogyyywgo....',
    '.....oggggo.....', '......occo......', '.......oo.......', '................',
  ],
  sparkle: [
    '................', '.......g........', '.......y........', '......gyg.......',
    '......gwg.......', '.....gywyg......', '...ggywwwygg....', '.gyywwwwwwwyyg..',
    '...ggywwwygg....', '.....gywyg......', '......gwg.......', '......gyg.......',
    '.......y........', '.......g........', '................', '................',
  ],
  book: [
    '................', '................', '..oooo....oooo..', '.owwwwooowwwwwo.',
    '.owwppwoowppwwo.', '.owwwwwopwwwwwo.', '.owpppwopwpppwo.', '.owwwwwopwwwwwo.',
    '.owpppwopwpppwo.', '.owwwwwopwwwwwo.', '.opppppoppppppo.', '.obbbbbobbcccco.',
    '..orrrooorrrro..', '...ooo..oooo....', '................', '................',
  ],
  page: [
    '................', '.....ooooo......', '....owwwwoo.....', '....owwwwppo....',
    '....owppwwwo....', '...owwwwwwwo....', '...owppppwo.....', '...owwwwwwo.....',
    '...owppppwo.....', '..owwwwwwwo.....', '..owppwwwo......', '..owwwwwwo......',
    '..oppppppo......', '...oooooo.......', '................', '................',
  ],
  hammer: [
    '................', '........ddd.....', '.......dssnd....', '......dslssnd...',
    '.....dslllsnd...', '......dnllnd....', '.......dnnd.....', '......ocdd......',
    '.....ocbo.......', '....ocbo........', '...ocbo.........', '..ocbo..........',
    '..obo...........', '...o............', '................', '................',
  ],
  item: [
    '................', '......yyyy......', '....yywwwwyy....', '...ywggwwggwy...',
    '..oggggwgggggo..', '..oggccwgccggo..', '..oggggwgggggo..', '..oooowwwooooo..',
    '..obbbbwbbbbbo..', '..obbbbwbbbbbo..', '..obccbwbbbcbo..', '..obbbbwbbbcbo..',
    '...obbbwbcbbo...', '....oooowooo....', '................', '................',
  ],
  slash: [
    '................', '...........ww...', '..........wy....', '........wwy.....',
    '.......ww.......', '.....wwy.....y..', '....ww......wy..', '..wwy......wy...',
    '.wy......wwy....', '........ww......', '......wwy.......', '.....wy.........',
    '...wwy..........', '...y............', '................', '................',
  ],
  flame: [
    '................', '........a.......', '.......aa.......', '.......afa......',
    '......affa......', '.....afffaa.....', '....afffffaa....', '...afffyfffa....',
    '...affyyyffa....', '..affyyyyyffa...', '..affyywyyffa...', '...afyywyyfa....',
    '...aaaffaaa.....', '....rrrrrr......', '................', '................',
  ],
  anvil: [
    '................', '................', '................', '....dddddddddd..',
    '...dlllllllllnd.', '.ddllllllllllnd.', '..dnnnnnnnnnnd..', '...ddddnnnddd...',
    '......dnnd......', '......dnnd......', '.....dnlnnd.....', '....dnllllnd....',
    '...dddddddddd...', '...obbbbbbbbo...', '....oooooooo....', '................',
  ],
  fist: [
    '................', '................', '....oooo........', '...owyyyooo.....',
    '..owyyoyyyyoo...', '..owyyoyoyyyyo..', '..oyyyoyoyoyyo..', '...oyyyyyyoyyo..',
    '...oyyyoooyyyo..', '....oycyyyyyco..', '....oycccccco...', '.....ottssso....',
    '.....otsssso....', '......ooooo.....', '................', '................',
  ],
}

/** A single strip; tile indices are zero-based, sampled in left-to-right order. */
export function createFxAtlas() {
  const tileSize = 16
  const names = Object.keys(ART)
  const columns = names.length
  const canvas = document.createElement('canvas')
  canvas.width = columns * tileSize
  canvas.height = tileSize
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = false
  const tiles = {}
  names.forEach((name, index) => {
    tiles[name] = index
    ART[name].forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const color = PALETTE[row[x]]
        if (!color) continue
        context.fillStyle = color
        context.fillRect(index * tileSize + x, y, 1, 1)
      }
    })
  })
  const texture = new THREE.CanvasTexture(canvas)
  texture.name = 'petpack-procedural-fx-atlas'
  texture.magFilter = texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace
  return { texture, tiles, columns, tileSize }
}

// Tiny original 3×5 face. M/W and a few symbols gain a column for readability.
// Lowercase maps to uppercase; unsupported Unicode gets a visible question mark.
const FONT = {
  ' ': ['00','00','00','00','00'],
  A: ['010','101','111','101','101'], B: ['110','101','110','101','110'],
  C: ['011','100','100','100','011'], D: ['110','101','101','101','110'],
  E: ['111','100','110','100','111'], F: ['111','100','110','100','100'],
  G: ['011','100','101','101','011'], H: ['101','101','111','101','101'],
  I: ['111','010','010','010','111'], J: ['001','001','001','101','010'],
  K: ['101','101','110','101','101'], L: ['100','100','100','100','111'],
  M: ['10001','11011','10101','10001','10001'], N: ['1001','1101','1011','1001','1001'],
  O: ['010','101','101','101','010'], P: ['110','101','110','100','100'],
  Q: ['0100','1010','1010','1010','0111'], R: ['110','101','110','101','101'],
  S: ['011','100','010','001','110'], T: ['111','010','010','010','010'],
  U: ['101','101','101','101','111'], V: ['101','101','101','101','010'],
  W: ['10001','10001','10101','11011','10001'], X: ['101','101','010','101','101'],
  Y: ['101','101','010','010','010'], Z: ['111','001','010','100','111'],
  0: ['111','101','101','101','111'], 1: ['010','110','010','010','111'],
  2: ['110','001','010','100','111'], 3: ['110','001','010','001','110'],
  4: ['101','101','111','001','001'], 5: ['111','100','110','001','110'],
  6: ['011','100','111','101','111'], 7: ['111','001','010','010','010'],
  8: ['111','101','111','101','111'], 9: ['111','101','111','001','110'],
  '!': ['1','1','1','0','1'], '"': ['101','101','000','000','000'],
  '#': ['01010','11111','01010','11111','01010'], '$': ['0111','1010','0110','0101','1110'],
  '%': ['1001','0010','0100','1000','1001'], '&': ['0110','1000','0111','1010','0101'],
  "'": ['1','1','0','0','0'], '(': ['01','10','10','10','01'],
  ')': ['10','01','01','01','10'], '*': ['101','010','111','010','101'],
  '+': ['000','010','111','010','000'], ',': ['00','00','00','01','10'],
  '-': ['000','000','111','000','000'], '.': ['0','0','0','0','1'],
  '/': ['001','001','010','100','100'], ':': ['0','1','0','1','0'],
  ';': ['00','01','00','01','10'], '<': ['001','010','100','010','001'],
  '=': ['000','111','000','111','000'], '>': ['100','010','001','010','100'],
  '?': ['110','001','010','000','010'], '@': ['01110','10001','10111','10101','01110'],
  '[': ['11','10','10','10','11'], '\\': ['100','100','010','001','001'],
  ']': ['11','01','01','01','11'], '^': ['010','101','000','000','000'],
  _: ['000','000','000','000','111'], '`': ['10','01','00','00','00'],
  '{': ['011','010','100','010','011'], '|': ['1','1','1','1','1'],
  '}': ['110','010','001','010','110'], '~': ['0000','0101','1010','0000','0000'],
}
const glyph = (letter) => FONT[letter.toUpperCase()] || FONT['?']
const measure = (text) => Math.max(0, [...text].reduce((n, letter) => n + glyph(letter)[0].length + 1, 0) - 1)

/** Paint at art resolution; the caller sizes CSS to width/height × pixelScale. */
export function paintPixelText(canvas, text, { color = '#374c45', maxWidth = 100, align = 'center' } = {}) {
  // Bounded input protects DOM overlays from an accidentally unbounded message.
  const input = String(text ?? '').slice(0, 2000).replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  const limit = Number.isFinite(maxWidth) ? Math.max(5, Math.floor(maxWidth)) : 100
  const lines = []
  for (const paragraph of input.split('\n')) {
    let line = ''
    for (const word of paragraph.trim().split(/ +/)) {
      if (!word) continue
      if (line && measure(`${line} ${word}`) <= limit) { line += ` ${word}`; continue }
      if (line) { lines.push(line); line = '' }
      for (const letter of word) {
        if (line && measure(line + letter) > limit) { lines.push(line); line = '' }
        line += letter
      }
    }
    lines.push(line)
  }
  const width = Math.max(1, ...lines.map(measure))
  const height = Math.max(1, lines.length * 7 - 2)
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = false
  context.fillStyle = color
  lines.forEach((line, index) => {
    let x = align === 'left' ? 0 : align === 'right' ? width - measure(line) : Math.floor((width - measure(line)) / 2)
    for (const letter of line) {
      const rows = glyph(letter)
      rows.forEach((row, y) => {
        for (let column = 0; column < row.length; column++) {
          if (row[column] === '1') context.fillRect(x + column, index * 7 + y, 1, 1)
        }
      })
      x += rows[0].length + 1
    }
  })
  return { width, height }
}
