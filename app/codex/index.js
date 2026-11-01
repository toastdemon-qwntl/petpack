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
//   listPets()                   Promise<[{ id, displayName, source: 'custom'|'builtin', path, atlas,
//                                available: 'yes'|'download'|'no', why, current }]> custom pets + built-ins
//   choosePet(idOrPath | null)   Promise<pet>; saves the pick in <userData>/pet-choice.json (beside cacheDir), which
//                                beats Codex's selection from then on; null follows Codex again. Rejects if unusable.
//   onPetChange(cb)              cb(pet) after choosePet; returns unsubscribe
//   dispose()                    stops the poller
// }
// Module-level listPets(), choosePet(), onPetChange(), currentPet() act on the latest createCodex() instance (the tray
// imports them). petChoiceFile(cacheDir) / readPetChoice(file) expose where the pick is kept.
// opts: { pet?: '--pet <dir|name|file>', home?: pin one Codex home, env?, cacheDir?: where downloaded built-in pet
//         sheets are cached, fetchPets?: false to never download, intervalMs?: status poll (1000) }
//
// The single-purpose functions are re-exported for other lanes (L3b commons, tests).

import fs from 'node:fs'
import path from 'node:path'
import { codexHome, codexHomes, existingHomes, agentsSkillsDir } from './home.js'
import { getPet, listPets as listPetFolders, listPetCandidates, checkedPaths, imageInfo, atlasOf, loadBuiltin, selectedPetIds, BUILTIN_PETS, NO_PET } from './pets.js'
import { listSkills, findSkill, packSkill, parseFrontmatter, skillRoots, PACK_MAX_BYTES } from './skills.js'
import { installSkill, skillSlug } from './install.js'
import { readStatus, watchStatus, createStatusTracker } from './status.js'

export {
  codexHome, codexHomes, existingHomes, agentsSkillsDir,
  getPet, listPetFolders, listPetCandidates, checkedPaths, imageInfo, atlasOf, loadBuiltin, selectedPetIds, BUILTIN_PETS, NO_PET,
  listSkills, findSkill, packSkill, parseFrontmatter, skillRoots, PACK_MAX_BYTES,
  installSkill, skillSlug,
  readStatus, watchStatus, createStatusTracker
}

export function petChoiceFile (cacheDir) {
  return cacheDir ? path.join(path.dirname(path.resolve(cacheDir)), 'pet-choice.json') : null
}
export function readPetChoice (file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return typeof v?.pet === 'string' && v.pet ? v.pet : null } catch { return null }
}

let current = null // the most recent createCodex() instance, for the module-level picker functions

export function createCodex (opts = {}) {
  const base = { env: opts.env, home: opts.home }
  const homes = codexHomes(base)
  const home = opts.home || codexHome(base)
  const ctx = { ...base, homes }
  const choiceFile = opts.choiceFile || petChoiceFile(opts.cacheDir)
  let flagPet = opts.pet || null
  let chosen = choiceFile ? readPetChoice(choiceFile) : null
  let petPromise = null
  const subs = new Set()
  const petSubs = new Set()
  let stop = null
  let last = null
  const petOpts = (extra = {}) => ({ ...ctx, pet: flagPet, choice: chosen,
    cacheDir: opts.cacheDir, fetch: opts.fetchPets !== false, appAsars: opts.appAsars, ...extra })

  const api = {
    home,
    homes,
    choiceFile,
    getPet () {
      if (!petPromise) petPromise = getPet(petOpts()).catch(() => ({ ...NO_PET }))
      return petPromise
    },
    refreshPet () { petPromise = null; return api.getPet() },
    // Every pet the picker can offer: [{ id, displayName, source, path, atlas, available, why, current }]
    async listPets (o = {}) {
      const [list, pet] = await Promise.all([listPetCandidates(petOpts({ sprites: o.sprites !== false })), api.getPet()])
      const isCustom = list.some((c) => c.source === 'custom' && c.path === pet.path)
      return list.map((c) => ({ ...c, current: Boolean(pet.path) && (c.source === 'custom' ? c.path === pet.path : !isCustom && c.id === pet.petName) }))
    },
    // Pick a pet (a custom pet folder, a sheet file, a pet name or a built-in id); null goes back to Codex's choice.
    // Saved in petpack's settings (pet-choice.json beside cacheDir); wins over Codex's selection from now on.
    // -> Promise<pet> (the new getPet() result); rejects when the choice doesn't resolve to a usable pet.
    async choosePet (idOrPath) {
      const choice = idOrPath == null || idOrPath === '' ? null : String(idOrPath)
      if (choice) {
        const probe = await getPet({ ...petOpts(), pet: null, choice })
        if (probe.source !== 'chosen') throw new Error(`no usable pet at ${choice}`)
      }
      if (choiceFile) {
        try {
          fs.mkdirSync(path.dirname(choiceFile), { recursive: true })
          if (choice) fs.writeFileSync(choiceFile, JSON.stringify({ pet: choice, at: new Date().toISOString() }, null, 2) + '\n')
          else fs.rmSync(choiceFile, { force: true })
        } catch {}
      }
      flagPet = null // the tray choice now beats this launch's --pet
      chosen = choice
      petPromise = null
      const pet = await api.getPet()
      for (const fn of petSubs) { try { fn(pet) } catch {} }
      return pet
    },
    onPetChange (cb) { petSubs.add(cb); return () => petSubs.delete(cb) },
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
    dispose () { subs.clear(); petSubs.clear(); if (stop) { stop(); stop = null } }
  }
  current = api
  return api
}

// Module-level picker for the tray (it imports this module; main.js made the instance). No instance yet: inert.
export function listPets (o) { return current ? current.listPets(o) : Promise.resolve([]) }
export function choosePet (idOrPath) { return current ? current.choosePet(idOrPath) : Promise.reject(new Error('petpack is starting')) }
export function onPetChange (cb) { return current ? current.onPetChange(cb) : () => {} }
export function currentPet () { return current ? current.getPet() : Promise.resolve(null) } // null: not started yet

export default createCodex
