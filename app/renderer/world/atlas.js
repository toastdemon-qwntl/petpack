import { createBuiltinAtlas, BUILTIN_ATLAS_FRAMES } from './cast-creatures.js'

// A completely original Codex-format atlas, including intentionally empty cells.
export const TEST_ATLAS_FRAMES = BUILTIN_ATLAS_FRAMES
let atlasPromise

export async function makeTestAtlas() {
  if (!atlasPromise) {
    atlasPromise = Promise.resolve().then(() => createBuiltinAtlas({ kind: 'cat', color: '#69b8ae' }).toDataURL('image/png')).catch(error => {
      atlasPromise = undefined
      throw error
    })
  }
  return atlasPromise
}

// Consumer fixtures: every supported scale has the same original pixel artwork.
// Different row lengths deliberately exercise all 1–8 frame counts and a missing row.
export const VARIABLE_ATLAS_FRAMES = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 0])

export function makeSyntheticAtlas({ width = 1536, height = 1872, frames = VARIABLE_ATLAS_FRAMES } = {}) {
  const source = createBuiltinAtlas({ kind: 'cat', color: '#69b8ae' })
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  const cellWidth = Math.floor(width / 8), cellHeight = Math.floor(height / 9)
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < frames[row]; col++) {
      ctx.drawImage(source, (col % BUILTIN_ATLAS_FRAMES[row]) * 192, row * 208, 192, 208,
        col * cellWidth, row * cellHeight, cellWidth, cellHeight)
    }
  }
  // Padding is intentionally loud: floor-sized cells must never sample these pixels.
  ctx.fillStyle = '#ff00ff'
  ctx.fillRect(cellWidth * 8, 0, width - cellWidth * 8, height)
  ctx.fillRect(0, cellHeight * 9, width, height - cellHeight * 9)
  source.width = source.height = 1
  return canvas
}

/** Opt-in dev page fixtures; caller owns blob URL lifetime through dispose(). */
export async function makeAtlasFixtures() {
  const fixtures = [], urls = []
  const cases = [
    { id: 'half', label: '0.5× WebP', width: 768, height: 936, mime: 'image/webp', urlKind: 'data' },
    { id: 'normal', label: '1× WebP', width: 1536, height: 1872, mime: 'image/webp', urlKind: 'blob' },
    { id: 'double', label: '2× WebP', width: 3072, height: 3744, mime: 'image/webp', urlKind: 'data' },
    { id: 'off-size', label: 'Off-size PNG', width: 1547, height: 1885, mime: 'image/png', urlKind: 'blob' },
    { id: 'png', label: '1× PNG', width: 1536, height: 1872, mime: 'image/png', urlKind: 'data' },
    { id: 'broken', label: 'Broken URL → local', spriteUrl: 'http://[', expectedFallback: true },
    { id: 'non-grid', label: 'Non-grid → local', width: 128, height: 128, mime: 'image/png', urlKind: 'data', expectedFallback: true },
    { id: 'sparse', label: 'One row, one frame', width: 768, height: 936, mime: 'image/png', urlKind: 'data', frames: [0, 0, 1, 0, 0, 0, 0, 0, 0] },
  ]
  try {
    for (const spec of cases) {
      const fixture = { color: '#69b8ae', frames: VARIABLE_ATLAS_FRAMES, expectedFallback: false, ...spec }
      if (!fixture.spriteUrl) {
        const canvas = makeSyntheticAtlas(fixture)
        if (fixture.id === 'non-grid') {
          const ctx = canvas.getContext('2d')
          ctx.fillStyle = '#dba579'; ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
        if (fixture.urlKind === 'blob') {
          const blob = await new Promise(resolve => canvas.toBlob(resolve, fixture.mime, 1))
          if (!blob) throw new Error(`Could not encode fixture ${fixture.id}`)
          fixture.spriteUrl = URL.createObjectURL(blob)
          urls.push(fixture.spriteUrl)
        } else fixture.spriteUrl = canvas.toDataURL(fixture.mime, 1)
        canvas.width = canvas.height = 1
      }
      fixtures.push(fixture)
    }
  } catch (error) {
    urls.forEach(url => URL.revokeObjectURL(url))
    throw error
  }
  return { fixtures, dispose() { urls.splice(0).forEach(url => URL.revokeObjectURL(url)) } }
}
