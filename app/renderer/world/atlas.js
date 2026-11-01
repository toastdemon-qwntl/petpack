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
