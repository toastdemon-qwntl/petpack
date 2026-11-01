// Original procedural pixel companions. One art pixel becomes a 4×4 atlas block.
// Unused cells are transparent, so imported and built-in pets use identical scanning.
export const BUILTIN_KINDS = Object.freeze(['blob', 'cat', 'robot', 'sprout'])
export const BUILTIN_ATLAS_FRAMES = Object.freeze([6, 6, 6, 6, 6, 4, 6, 6, 6])
const defaults = { blob: '#67a8c6', cat: '#dca567', robot: '#86aaa4', sprout: '#96b96b' }

function mix(a, b, amount) {
  const aa = a.match(/\w\w/g).map(n => parseInt(n, 16))
  const bb = b.match(/\w\w/g).map(n => parseInt(n, 16))
  return `#${aa.map((n, i) => Math.round(n + (bb[i] - n) * amount).toString(16).padStart(2, '0')).join('')}`
}
function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
}
function polygon(ctx, points, color) {
  const minY = Math.floor(Math.min(...points.map(p => p[1])))
  const maxY = Math.ceil(Math.max(...points.map(p => p[1])))
  for (let y = minY; y < maxY; y++) {
    const intersections = []
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length]
      if ((a[1] <= y + .5 && b[1] > y + .5) || (b[1] <= y + .5 && a[1] > y + .5)) {
        intersections.push(a[0] + (y + .5 - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
      }
    }
    intersections.sort((a, b) => a - b)
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const start = Math.ceil(intersections[i] - .5)
      const end = Math.ceil(intersections[i + 1] - .5)
      rect(ctx, start, y, end - start, 1, color)
    }
  }
}
function poly(ctx, points, fill, outline) {
  if (outline) {
    for (const [x, y] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) polygon(ctx, points.map(p => [p[0] + x, p[1] + y]), outline)
  }
  polygon(ctx, points, fill)
}
function oval(ctx, x, y, w, h, color, outline) {
  if (outline) oval(ctx, x - 1, y - 1, w + 2, h + 2, outline)
  for (let row = 0; row < h; row++) {
    const reach = Math.sqrt(Math.max(0, 1 - ((row + .5 - h / 2) / (h / 2)) ** 2)) * w / 2
    const left = Math.ceil(w / 2 - reach - .5)
    const right = Math.ceil(w / 2 + reach - .5)
    rect(ctx, x + left, y + row, right - left, 1, color)
  }
}
function box(ctx, x, y, w, h, fill, edge) {
  if (edge) {
    rect(ctx, x, y - 1, w, h + 2, edge)
    rect(ctx, x - 1, y, w + 2, h, edge)
  }
  rect(ctx, x, y, w, h, fill)
}
function palette(kind, color) {
  const key = mix(color, '#e9dfbd', .25)
  return {
    key, edge: mix(key, '#283e49', .68), shade: mix(key, '#546a73', .4),
    light: mix(key, '#fff5d9', .7), cream: '#fff0ce', white: '#fff9e6',
    ink: '#384957', cheek: '#dc987f', gold: '#e7bc6b',
    fur: '#daa575', furLight: '#f2c68c', furDark: '#a46d54',
    leaf: kind === 'sprout' ? '#86ab67' : key, leafDark: '#55795f', leafLight: '#c3d787',
  }
}
function pose(row, frame) {
  const run = row === 1 || row === 2 || row === 7
  const jumping = row === 4
  return {
    run, jump: jumping, wave: row === 3, failed: row === 5, waiting: row === 6, review: row === 8,
    bob: run ? [0, -1, -2, -1, 0, -1][frame] : row === 0 ? [0, 0, -1, -1, 0, 0][frame] : 0,
    lift: jumping ? [0, 4, 9, 9, 4, 0][frame] : 0,
    stride: run ? [-2, 0, 2, 2, 0, -2][frame] : 0,
    footL: run ? [0, 1, 2, 0, 0, 0][frame] : 0,
    footR: run ? [0, 0, 0, 0, 1, 2][frame] : row === 6 ? [0, 0, 0, 1, 0, 0][frame] : 0,
    slump: row === 5 ? frame : 0,
    blink: row === 0 && frame === 4,
    glance: run ? 1 : row === 6 ? [0, 0, 1, 1, 0, -1][frame] : 0,
    hand: [0, -1, 0, 1, 0, -1][frame] ?? 0,
    frame,
  }
}
function face(ctx, p, colors, x, y, separation = 10, robot = false) {
  const ink = robot ? '#f5e1a0' : colors.ink
  for (const side of [-1, 1]) {
    const px = x + side * separation / 2 + p.glance
    if (p.blink || p.review || p.failed) {
      rect(ctx, px - 1, y + (p.failed ? 2 : 1), 4, p.review ? 2 : 1, ink)
      if (p.failed) rect(ctx, px + (side < 0 ? -1 : 2), y, 1, 1, colors.shade)
    } else if ((p.wave || p.jump) && p.frame > 2) {
      rect(ctx, px, y, 2, 1, ink)
      rect(ctx, px - 1, y + 1, 1, 2, ink)
      rect(ctx, px + 2, y + 1, 1, 2, ink)
    } else {
      rect(ctx, px - 1, y, 4, 5, ink)
      rect(ctx, px - 1, y, 1, 1, robot ? '#fffbed' : colors.white)
    }
  }
  if (robot) {
    rect(ctx, x - 2, y + 8, 5, 1, p.failed ? '#dfa086' : '#9ac3ad')
  } else if (p.failed) {
    rect(ctx, x - 1, y + 7, 3, 1, colors.ink)
    rect(ctx, x - 2, y + 8, 1, 1, colors.ink)
    rect(ctx, x + 2, y + 8, 1, 1, colors.ink)
  } else {
    rect(ctx, x - 1, y + 8, 3, 1, colors.ink)
    rect(ctx, x - 2, y + 7, 1, 1, colors.ink)
    rect(ctx, x + 2, y + 7, 1, 1, colors.ink)
  }
}
function feet(ctx, p, c, left = 17, right = 27, color = c.shade) {
  box(ctx, left + p.stride, 45 - p.footL, 6, 3, color, c.edge)
  box(ctx, right - p.stride, 45 - p.footR, 6, 3, color, c.edge)
  rect(ctx, left + p.stride, 45 - p.footL, 4, 1, c.light)
  rect(ctx, right - p.stride, 45 - p.footR, 4, 1, c.light)
}
function hand(ctx, p, c, x, y, color) {
  const handY = p.wave ? y - 15 + p.hand : p.jump ? y - 10 : p.review ? y - 5 : y + (p.failed ? 2 : 0)
  const handX = p.review ? x - 5 : p.wave ? 41 : x
  if (p.wave || p.jump) {
    poly(ctx, [[x,y+5],[x+4,y+5],[handX+4,handY+5],[handX+1,handY+3],[x+1,y]], color, c.edge)
  }
  oval(ctx, handX, handY, 5, 7, color, c.edge)
  if (p.wave) rect(ctx, handX, handY - 2, 2, 3, color)
}
function blob(ctx, p, c) {
  feet(ctx, p, c, 15, 28)
  const y = 14 + p.bob + p.slump
  oval(ctx, 7, y + 20, 7, 9, c.shade, c.edge)
  hand(ctx, p, c, 34, y + 19, c.key)
  poly(ctx, [[13,y+5],[18,y+1],[29,y],[34,y+5],[37,y+14],[38,41],[34,45],[16,45],[10,41],[10,y+14]], c.key, c.edge)
  poly(ctx, [[12,y+14],[14,y+7],[20,y+3],[27,y+3],[30,y+6],[19,y+6],[16,y+13]], c.light)
  poly(ctx, [[35,y+15],[35,39],[31,43],[17,43],[14,41],[28,41],[32,38]], c.shade)
  oval(ctx, 16, 34 + Math.min(1, p.bob), 17, 8, c.light)
  rect(ctx, 13, y + 20, 4, 2, c.cheek)
  rect(ctx, 32, y + 20, 4, 2, c.cheek)
  face(ctx, p, c, 24, y + 13, 11)
  // One off-centre cowlick keeps the silhouette recognisable at a glance.
  poly(ctx, [[18,y+2],[19,y-3],[24,y-4],[27,y-2],[25,y+2]], c.key, c.edge)
  rect(ctx, 20, y - 2, 4, 1, c.light)
}
function cat(ctx, p, c) {
  // Curl behind the feet: stepped silhouette, no smooth vector stroke.
  poly(ctx, [[14,43],[7,43],[5,40],[5,34],[8,31],[10,32],[10,35],[8,36],[8,39],[15,39]], c.fur, c.furDark)
  rect(ctx, 5, 35, 3, 3, c.furDark)
  feet(ctx, p, c, 17, 27, c.furLight)
  oval(ctx, 14, 31, 21, 15, c.fur, c.furDark)
  oval(ctx, 18, 35, 12, 10, c.cream)
  oval(ctx, 11, 34 + p.bob, 6, 10, c.fur, c.furDark)
  hand(ctx, p, { ...c, edge: c.furDark }, 33, 34 + p.bob, c.furLight)
  const y = 14 + p.bob + p.slump
  poly(ctx, [[10,y+7],[10,y-6+(p.failed?4:0)],[14,y-6+(p.failed?4:0)],[21,y+2]], c.fur, c.furDark)
  poly(ctx, [[29,y+2],[36,y-6+(p.failed?4:0)],[39,y-5+(p.failed?4:0)],[37,y+9]], c.fur, c.furDark)
  poly(ctx, [[12,y-3],[17,y+1],[12,y+3]], c.cheek)
  poly(ctx, [[35,y-3],[36,y+4],[31,y+2]], c.cheek)
  oval(ctx, 10, y, 29, 23, c.furLight, c.furDark)
  poly(ctx, [[13,y+14],[15,y+18],[20,y+21],[32,y+20],[37,y+15],[35,y+20],[30,y+23],[17,y+22],[11,y+18]], c.fur)
  rect(ctx, 19, y + 1, 2, 4, c.furDark)
  rect(ctx, 24, y, 2, 6, c.furDark)
  rect(ctx, 29, y + 1, 2, 4, c.furDark)
  oval(ctx, 18, y + 13, 14, 8, c.cream)
  face(ctx, p, c, 24, y + 9, 13)
  rect(ctx, 23, y + 15, 3, 2, c.furDark)
  rect(ctx, 10, y + 13, 5, 1, c.furDark)
  rect(ctx, 35, y + 13, 5, 1, c.furDark)
  rect(ctx, 11, y + 17, 4, 1, c.furDark)
  rect(ctx, 35, y + 17, 4, 1, c.furDark)
  box(ctx, 16, 34 + p.bob, 18, 3, c.key, c.edge)
  rect(ctx, 18, 34 + p.bob, 11, 1, c.light)
  box(ctx, 29, 37 + p.bob, 4, 7, c.key, c.edge)
  rect(ctx, 29, 42 + p.bob, 4, 1, c.gold)
}
function robot(ctx, p, c) {
  feet(ctx, p, c, 15, 29)
  box(ctx, 17, 32, 16, 13, c.key, c.edge)
  rect(ctx, 18, 33, 3, 10, c.light)
  box(ctx, 22, 37, 7, 5, c.shade, c.edge)
  rect(ctx, 24, 38, 3, 2, c.gold)
  box(ctx, 11, 33 + p.bob, 4, 9, c.shade, c.edge)
  hand(ctx, p, c, 35, 33 + p.bob, c.light)
  const y = 13 + p.bob + p.slump
  box(ctx, 23, y - 6, 2, 5, c.shade, c.edge)
  box(ctx, 22, y - 9, 4, 3, p.failed ? '#c98474' : c.gold, c.edge)
  rect(ctx, 22, y - 9, 2, 1, c.cream)
  box(ctx, 6, y + 7, 4, 8, c.shade, c.edge)
  box(ctx, 38, y + 7, 4, 8, c.shade, c.edge)
  box(ctx, 10, y, 28, 21, c.light, c.edge)
  rect(ctx, 10, y, 25, 2, c.cream)
  rect(ctx, 36, y + 2, 2, 19, c.shade)
  box(ctx, 13, y + 4, 22, 13, '#426268', c.edge)
  rect(ctx, 14, y + 5, 20, 1, '#61817c')
  face(ctx, p, c, 23, y + 6, 10, true)
  rect(ctx, 12, y + 18, 2, 1, c.edge)
  rect(ctx, 32, y + 18, 3, 1, c.edge)
  rect(ctx, 7, y + 8, 1, 5, c.light)
}
function sprout(ctx, p, c) {
  feet(ctx, p, c, 17, 27, '#bbac77')
  const y = 25 + p.bob + p.slump
  oval(ctx, 11, y + 9, 6, 9, c.cream, '#938b64')
  hand(ctx, p, { ...c, edge: '#938b64' }, 33, y + 9, c.cream)
  poly(ctx, [[22,y-3],[28,y-3],[34,y+3],[36,y+11],[32,44],[25,47],[16,43],[14,y+8],[17,y+2]], '#e6d5a0', '#938b64')
  poly(ctx, [[18,y+3],[22,y],[28,y],[25,y+4],[22,y+16],[19,y+17],[17,y+11]], c.cream)
  poly(ctx, [[32,y+8],[34,y+12],[31,43],[26,45],[29,40]], '#c1bd8a')
  rect(ctx, 15, y + 12, 4, 2, c.cheek)
  rect(ctx, 31, y + 12, 4, 2, c.cheek)
  face(ctx, p, c, 24, y + 5, 10)
  const droop = p.failed ? 4 : 0
  poly(ctx, [[23,y],[22,y-11],[24,y-16],[26,y-15],[25,y]], c.leafDark, '#466650')
  poly(ctx, [[24,y-8],[19,y-17+droop],[10,y-18+droop],[10,y-12+droop],[14,y-7+droop],[22,y-5]], c.leaf, c.leafDark)
  poly(ctx, [[24,y-10],[29,y-21+droop],[36,y-22+droop],[39,y-20+droop],[37,y-12+droop],[30,y-7],[25,y-6]], c.leaf, c.leafDark)
  poly(ctx, [[13,y-16+droop],[19,y-15+droop],[23,y-9],[18,y-11]], c.leafLight)
  poly(ctx, [[28,y-12],[31,y-19+droop],[36,y-20+droop],[33,y-16+droop]], c.leafLight)
  rect(ctx, 17, 42, 5, 2, c.key)
  rect(ctx, 18, 41, 2, 4, c.key)
  rect(ctx, 19, 42, 1, 1, c.gold)
}
const drawers = { blob, cat, robot, sprout }

export function createBuiltinAtlas({ color, kind = 'blob' } = {}) {
  if (typeof kind === 'number') kind = BUILTIN_KINDS[((kind % 4) + 4) % 4]
  if (!drawers[kind]) kind = 'blob'
  const normalizer = document.createElement('canvas').getContext('2d')
  normalizer.fillStyle = defaults[kind]
  if (color != null) normalizer.fillStyle = typeof color === 'number' ? `#${color.toString(16).padStart(6, '0')}` : color
  const normalized = normalizer.fillStyle
  color = /^#[\da-f]{6}$/i.test(normalized) ? normalized : defaults[kind]
  const art = document.createElement('canvas')
  art.width = 48 * 8
  art.height = 52 * 9
  const ctx = art.getContext('2d')
  const colors = palette(kind, color)
  for (let row = 0; row < 9; row++) {
    for (let frame = 0; frame < BUILTIN_ATLAS_FRAMES[row]; frame++) {
      const p = pose(row, frame)
      // Preserve the complete silhouette inside the pinned 52-pixel cell.
      p.lift = Math.min(p.lift, { blob: 8, cat: 6, robot: 3, sprout: 2 }[kind])
      ctx.save()
      ctx.beginPath()
      ctx.rect(frame * 48, row * 52, 48, 52)
      ctx.clip()
      ctx.translate(frame * 48 + (row === 2 ? 48 : 0), row * 52 - p.lift)
      if (row === 2) ctx.scale(-1, 1)
      drawers[kind](ctx, p, colors)
      ctx.restore()
    }
  }
  const atlas = document.createElement('canvas')
  atlas.width = 1536
  atlas.height = 1872
  const out = atlas.getContext('2d')
  out.imageSmoothingEnabled = false
  out.drawImage(art, 0, 0, atlas.width, atlas.height)
  // The renderer owns its prepared atlas cache; release this large source after sampling.
  return atlas
}
