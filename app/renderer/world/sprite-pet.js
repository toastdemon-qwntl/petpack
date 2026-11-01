import { createAtlasCharacter, preparePetAtlas } from './cast-atlas.js'
import { createPixelPet } from './pixel-pet.js'

// Preserve the original helper exports for existing callers.
export { createAtlasCharacter, preparePetAtlas } from './cast-atlas.js'

const atlases = new Map()
const LOAD_TIMEOUT_MS = 10000

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    // Set before src: relay-served HTTP(S) images must remain canvas-readable.
    image.crossOrigin = 'anonymous'
    const finish = error => {
      clearTimeout(timer)
      image.onload = image.onerror = null
      if (error) {
        image.removeAttribute('src')
        reject(error)
      } else resolve(image)
    }
    const timer = setTimeout(() => finish(new Error('Pet atlas load timed out')), LOAD_TIMEOUT_MS)
    image.onload = () => finish()
    image.onerror = () => finish(new Error('Pet atlas could not be loaded or decoded'))
    try { image.src = url }
    catch (error) { finish(error) }
  })
}

async function acquireAtlas(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('A spriteUrl is required for a sprite pet')
  // Keep relative/local app URLs working, and reject malformed URLs before an
  // image request. Do not echo URLs: they may contain a private relay token.
  const parsed = new URL(url, document.baseURI)
  if (!['data:', 'blob:', 'http:', 'https:', 'file:'].includes(parsed.protocol)) throw new Error('Unsupported pet atlas URL')
  let entry = atlases.get(url)
  if (!entry) {
    entry = { users: 0, ready: loadImage(url).then(preparePetAtlas) }
    atlases.set(url, entry)
  }
  entry.users++
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (--entry.users === 0) {
      if (atlases.get(url) === entry) atlases.delete(url)
      entry.ready.then(atlas => atlas.texture.dispose(), () => {})
    }
  }
  try { return { ...await entry.ready, release } }
  catch (error) { release(); throw error }
}

export async function createSpritePet({ spriteUrl, color = '#79b9dc' } = {}) {
  let atlas
  try {
    atlas = await acquireAtlas(spriteUrl)
    return createAtlasCharacter(atlas, { color })
  } catch {
    atlas?.release()
    console.warn('petpack: Could not load pet atlas; using a built-in pixel pet.')
    return createPixelPet({ color })
  }
}
