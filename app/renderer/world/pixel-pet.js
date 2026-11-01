import { createBuiltinAtlas, BUILTIN_KINDS } from './cast-creatures.js'
import { createAtlasCharacter, preparePetAtlas } from './sprite-pet.js'

const atlases = new Map()

/** Original pixel creatures use exactly the same frame/sampling path as Codex pets. */
export function createPixelPet({ color = '#80bba0', kind = 'blob' } = {}) {
  if (Number.isInteger(kind)) kind = BUILTIN_KINDS[((kind % BUILTIN_KINDS.length) + BUILTIN_KINDS.length) % BUILTIN_KINDS.length]
  if (!BUILTIN_KINDS.includes(kind)) kind = 'blob'
  const key = `${kind}:${color}`
  let entry = atlases.get(key)
  if (!entry) {
    entry = { atlas: preparePetAtlas(createBuiltinAtlas({ color, kind })), users: 0 }
    atlases.set(key, entry)
  }
  entry.users++
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (--entry.users === 0) {
      entry.atlas.texture.dispose()
      atlases.delete(key)
    }
  }
  try { return createAtlasCharacter({ ...entry.atlas, release }, { color, name: `${kind} pet` }) }
  catch (error) { release(); throw error }
}
