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
//   onCodexEvent(cb)             cb({ type: 'started'|'waiting'|'done'|'failed', title, session, threadId, cwd, at,
//                                message: { title: 'Codex finished'|'Codex needs you'|..., body: <task title> } })
//                                on each live session's transition (not for what was already true at start-up)
//   currentTask()                Promise<{ title (<= 48 chars: thread name, else the latest prompt), status, since,
//                                sessions (live count), approvalPending, session, threadId, cwd }>
//   openCodex({ session|threadId }) Promise<{ ok, url, method }>: opens codex://threads/<id> (or the app)
//   takeOverPet({ enabled })     switch Codex's own pet off (desktop [desktop] avatar-overlay-pet-visible = false +
//                                .codex-global-state.json electron-avatar-overlay-open = false; CLI [tui] pet =
//                                "disabled" when set), remembering the originals in <userData>/codex-takeover.json.
//                                Selected pet ids stay, so petpack shows the same pet. enabled:false (--no-takeover)
//                                only restores a takeover left by a crash. Idempotent.
//   releasePet()                 restore exactly what was there; idempotent
//   takeoverActive()             bool
//   dispose()                    stops the poller
// }
// Module-level listPets(), choosePet(), onPetChange(), currentPet(), onCodexEvent(), currentCodexTask() act on the
// latest createCodex() instance (the tray imports them). codexEventMessage(e), openCodex(o), codexThreadUrl(s) are
// plain functions. petChoiceFile(cacheDir) / readPetChoice(file) expose where the pick is kept.
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
import { readStatus, watchStatus, createStatusTracker, currentTask, compressTitle } from './status.js'
import { openCodex, codexThreadUrl } from './open.js'
import { takeOverPet as takeOver, releasePet as release, takeoverState } from './takeover.js'

// The words the Codex app's pet uses, for an OS notification: { title, body }.
export function codexEventMessage (e = {}) {
  const t = e.title || 'Codex task'
  switch (e.type) {
    case 'done': return { title: 'Codex finished', body: t }
    case 'waiting': return { title: 'Codex needs you', body: t }
    case 'failed': return { title: 'Codex hit an error', body: t }
    case 'started': return { title: 'Codex is working', body: t }
    default: return { title: 'Codex', body: t }
  }
}

export {
  codexHome, codexHomes, existingHomes, agentsSkillsDir,
  getPet, listPetFolders, listPetCandidates, checkedPaths, imageInfo, atlasOf, loadBuiltin, selectedPetIds, BUILTIN_PETS, NO_PET,
  listSkills, findSkill, packSkill, parseFrontmatter, skillRoots, PACK_MAX_BYTES,
  installSkill, skillSlug,
  readStatus, watchStatus, createStatusTracker, currentTask, compressTitle,
  openCodex, codexThreadUrl
}

export function takeoverFile (cacheDir) {
  return cacheDir ? path.join(path.dirname(path.resolve(cacheDir)), 'codex-takeover.json') : null
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
  const markerFile = opts.takeoverFile || takeoverFile(opts.cacheDir)
  let flagPet = opts.pet || null
  let chosen = choiceFile ? readPetChoice(choiceFile) : null
  let petPromise = null
  const subs = new Set()
  const petSubs = new Set()
  let stop = null
  let last = null
  const eventSubs = new Set()
  function ensureWatcher () {
    if (stop) return
    stop = watchStatus((s) => {
      last = s
      for (const fn of subs) { try { fn(s) } catch {} }
    }, {
      ...ctx,
      intervalMs: opts.intervalMs,
      onEvent: (e) => {
        const ev = { ...e, message: codexEventMessage(e) }
        for (const fn of eventSubs) { try { fn(ev) } catch {} }
      }
    })
  }
  function maybeStop () {
    if (!subs.size && !eventSubs.size && stop) { stop(); stop = null; last = null }
  }
  const petOpts = (extra = {}) => ({ ...ctx, pet: flagPet, choice: chosen,
    cacheDir: opts.cacheDir, fetch: opts.fetchPets !== false, appAsars: opts.appAsars, takeoverFile: markerFile, ...extra })

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
      ensureWatcher()
      return () => { subs.delete(cb); maybeStop() }
    },
    // cb({ type: 'started'|'waiting'|'done'|'failed', title, session, threadId, cwd, at, message }) on each Codex
    // session's transition; message = { title, body } for an OS notification. Shares the status poller.
    onCodexEvent (cb) {
      eventSubs.add(cb)
      ensureWatcher()
      return () => { eventSubs.delete(cb); maybeStop() }
    },
    // { title (<= 48 chars), status, since, sessions, approvalPending, session, threadId, cwd }
    async currentTask () {
      if (stop && stop.tracker) { if (!last) await stop.tracker.poll(); return stop.tracker.task() }
      return currentTask(ctx)
    },
    openCodex (o = {}) { return openCodex(o) },
    // One pet on screen: switch Codex's own pet off while petpack shows it (o.enabled === false, i.e. --no-takeover,
    // only restores a takeover a crash left behind). releasePet() restores exactly what was there.
    takeOverPet (o = {}) {
      if (!markerFile) return { ok: false, changed: [], reason: 'no cacheDir/takeoverFile' }
      if (o.enabled === false) return { ok: true, changed: [], released: release({ markerFile }) }
      const r = takeOver({ homes, markerFile })
      petPromise = null
      return r
    },
    releasePet () { return markerFile ? release({ markerFile }) : { ok: true, restored: [] } },
    takeoverActive () { return Boolean(markerFile && takeoverState(markerFile)) },
    dispose () { subs.clear(); petSubs.clear(); eventSubs.clear(); if (stop) { stop(); stop = null } }
  }
  current = api
  return api
}

// Module-level picker for the tray (it imports this module; main.js made the instance). No instance yet: inert.
export function listPets (o) { return current ? current.listPets(o) : Promise.resolve([]) }
export function choosePet (idOrPath) { return current ? current.choosePet(idOrPath) : Promise.reject(new Error('petpack is starting')) }
export function onPetChange (cb) { return current ? current.onPetChange(cb) : () => {} }
export function takeOverPet (o) { return current ? current.takeOverPet(o) : { ok: false, changed: [], reason: 'petpack is starting' } }
// releasePet({ userData | markerFile | cacheDir }) works without an instance too (uninstall, a later launch).
export function releasePet (o = {}) {
  const markerFile = o.markerFile || (o.userData && path.join(o.userData, 'codex-takeover.json')) || (o.cacheDir && takeoverFile(o.cacheDir))
  if (markerFile) return release({ markerFile })
  return current ? current.releasePet() : { ok: true, restored: [] }
}
export function onCodexEvent (cb) { return current ? current.onCodexEvent(cb) : () => {} }
export function currentCodexTask () { return current ? current.currentTask() : currentTask({}) }
export function currentPet () { return current ? current.getPet() : Promise.resolve(null) } // null: not started yet

export default createCodex
