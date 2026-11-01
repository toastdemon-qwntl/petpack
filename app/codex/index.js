// petpack Codex core: the API main.js (S1) uses. Main-process Node only; no Electron imports.
//
//   import { createCodex } from './codex/index.js'
//   const codex = createCodex({ pet: argv.pet, cacheDir: path.join(app.getPath('userData'), 'pets') })
//
// createCodex(opts) -> {
//   home                         primary Codex home (installs go here); homes: every candidate home that is read
//   getPet()                     Promise<{ petName, displayName, spriteUrl /* data URL | null */, source, path, atlas }>
//                                never rejects; spriteUrl null means "draw Dot". atlas = { width, height, cols: 8,
//                                rows: 9|11, cellW, cellH, version } (renderers use the top 8x9 cells)
//   getMe(id)                    Promise<{ id, petName, displayName, spriteUrl, atlas, skills }> (bridge getMe shape)
//   listSkills()                 [{ id, name, description }] from <home>/skills/* and ~/.agents/skills/* (no dot dirs)
//   listSkillsDetailed()         same with { path, root, installedFrom? }
//   packSkill(id)                Promise<{ id, name, description, files: [{ path, b64 }], bytes, truncated }> (<= 512 KB)
//   installSkill(pkg, fromName, o?) Promise<{ installed, path?, reason? }> -> <home>/skills/petpack-<name>/, never
//                                overwrites (o: { dirName, prefix })
//   getStatus()                  Promise<{ status, at, session, cwd }>
//   onStatus(cb)                 cb({ status, at, session, cwd }) now and on each change; returns unsubscribe.
//                                One shared 1 s poller runs while anyone is subscribed.
//   dispose()                    stops the poller
// }
// opts: { pet?: '--pet <dir|name|file>', home?: pin one Codex home, env?, cacheDir?: where downloaded built-in pet
//         sheets are cached, fetchPets?: false to never download, intervalMs?: status poll (1000) }
//
// The single-purpose functions are re-exported for other lanes (L3b commons, tests).

import { codexHome, codexHomes, existingHomes, agentsSkillsDir } from './home.js'
import { getPet, listPets, imageInfo, atlasOf, loadBuiltin, selectedPetIds, BUILTIN_PETS, NO_PET } from './pets.js'
import { listSkills, findSkill, packSkill, parseFrontmatter, skillRoots, PACK_MAX_BYTES } from './skills.js'
import { installSkill, skillSlug } from './install.js'
import { readStatus, watchStatus, createStatusTracker } from './status.js'

export {
  codexHome, codexHomes, existingHomes, agentsSkillsDir,
  getPet, listPets, imageInfo, atlasOf, loadBuiltin, selectedPetIds, BUILTIN_PETS, NO_PET,
  listSkills, findSkill, packSkill, parseFrontmatter, skillRoots, PACK_MAX_BYTES,
  installSkill, skillSlug,
  readStatus, watchStatus, createStatusTracker
}

export function createCodex (opts = {}) {
  const base = { env: opts.env, home: opts.home }
  const homes = codexHomes(base)
  const home = opts.home || codexHome(base)
  const ctx = { ...base, homes }
  let petPromise = null
  const subs = new Set()
  let stop = null
  let last = null

  const api = {
    home,
    homes,
    getPet () {
      if (!petPromise) {
        petPromise = getPet({ ...ctx, pet: opts.pet, cacheDir: opts.cacheDir, fetch: opts.fetchPets !== false })
          .catch(() => ({ ...NO_PET }))
      }
      return petPromise
    },
    refreshPet () { petPromise = null; return api.getPet() },
    listSkills () {
      try { return listSkills(ctx).map(({ id, name, description }) => ({ id, name, description })) } catch { return [] }
    },
    listSkillsDetailed () {
      try { return listSkills(ctx) } catch { return [] }
    },
    packSkill (id) { return packSkill(id, ctx) },
    installSkill (pkg, fromName, o = {}) { return installSkill(pkg, fromName, { ...o, home }) },
    getStatus () { return readStatus(ctx) },
    async getMe (id) {
      const pet = await api.getPet()
      return {
        id,
        petName: pet.petName,
        displayName: pet.displayName,
        spriteUrl: pet.spriteUrl,
        atlas: pet.atlas,
        skills: api.listSkills()
      }
    },
    onStatus (cb) {
      subs.add(cb)
      if (last) { try { cb(last) } catch {} }
      if (!stop) {
        stop = watchStatus((s) => {
          last = s
          for (const fn of subs) { try { fn(s) } catch {} }
        }, { ...ctx, intervalMs: opts.intervalMs })
      }
      return () => {
        subs.delete(cb)
        if (!subs.size && stop) { stop(); stop = null; last = null }
      }
    },
    dispose () { subs.clear(); if (stop) { stop(); stop = null } }
  }
  return api
}

export default createCodex
