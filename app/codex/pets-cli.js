// `petpack pets`: what pet petpack would show, every candidate it found, and every place it looked. Plain Node.
//
// runPetsCommand(argv) -> Promise<exit code>
//   argv: [--pet <dir|name|file>] [--profile <p>] [--choose <id|path> | --clear] [--json] [--no-fetch]
//   --choose saves a pet the same way the tray's Pet menu does (petpack picks it up on its next start or reload);
//   --clear goes back to the pet selected in Codex.

import fs from 'node:fs'
import path from 'node:path'
import { createCodex, getPet, checkedPaths, selectedPetIds, codexHomes, readPetChoice } from './index.js'

function parse (argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/)
    if (!m) continue
    const key = m[1]
    if (['json', 'clear', 'no-fetch'].includes(key)) o[key] = true
    else o[key] = m[2] ?? argv[++i]
  }
  return o
}

async function userData (profile) {
  try {
    const { userDataDir } = await import(new URL('../mcp/ipc.js', import.meta.url).href)
    return userDataDir(profile || '')
  } catch { return null }
}

const size = (a) => (a ? `${a.width}x${a.height} (${a.cols}x${a.rows} of ${a.cellW}x${a.cellH})` : '-')

export async function runPetsCommand (argv = []) {
  const o = parse(argv)
  const ud = await userData(typeof o.profile === 'string' ? o.profile : '')
  const cacheDir = ud ? path.join(ud, 'pets') : undefined
  const codex = createCodex({ pet: o.pet, cacheDir, fetchPets: !o['no-fetch'] })
  if (o.clear || o.choose) {
    try {
      const pet = await codex.choosePet(o.clear ? null : o.choose)
      console.log(o.clear ? `petpack: back to the pet selected in Codex: ${pet.displayName}` : `petpack: chose ${pet.displayName} (${pet.path})`)
      return 0
    } catch (error) {
      console.error(`petpack: ${error.message}`)
      return 1
    }
  }
  const homes = codexHomes()
  const trace = []
  const pet = await getPet({ homes, pet: o.pet, choice: codex.choiceFile ? readPetChoice(codex.choiceFile) : null,
    cacheDir, fetch: !o['no-fetch'], trace })
  const candidates = await codex.listPets({ sprites: false })
  const checked = checkedPaths({ homes, cacheDir })
  if (codex.choiceFile) checked.push({ path: codex.choiceFile, what: 'petpack choice (tray Pet menu, --choose)', exists: fs.existsSync(codex.choiceFile) })
  const report = {
    using: { name: pet.displayName, id: pet.petName, source: pet.source, path: pet.path, atlas: pet.atlas },
    why: trace,
    selections: selectedPetIds({ homes }),
    candidates: candidates.map(({ id, displayName, source, path: p, atlas, available, why, current }) => ({ id, displayName, source, path: p, atlas, available, why, current })),
    checked
  }
  if (o.json) { console.log(JSON.stringify(report, null, 2)); return 0 }

  console.log(pet.source === 'none'
    ? 'petpack would show: the built-in pixel pet (no Codex pet found)'
    : `petpack would show: ${pet.displayName} [${pet.source}] ${size(pet.atlas)}\n  ${pet.path}`)
  console.log('\nWhy (lookup order, first usable wins):')
  for (const t of trace) console.log(`  ${t.step}${t.value ? ` = ${t.value}` : ''}: ${t.result}`)
  console.log('\nPets found:')
  if (!candidates.length) console.log('  none')
  for (const c of candidates) {
    console.log(`  ${c.current ? '*' : ' '} ${c.displayName.padEnd(22)} ${c.source.padEnd(8)} ${c.available === 'yes' ? size(c.atlas) : c.available === 'download' ? 'downloads when chosen' : 'unusable: ' + c.why}`)
    console.log(`      ${c.path}`)
  }
  console.log('\nChecked:')
  for (const c of checked) console.log(`  ${c.exists ? 'found  ' : 'missing'} ${c.path}  (${c.what})`)
  console.log('\nPick one: the tray icon > Pet, or `petpack pets --choose <folder|name>` (--clear to follow Codex again).')
  return 0
}
