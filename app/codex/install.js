// Install a received skill into Codex (main-process Node only; no Electron imports).
//
// installSkill(pkg, fromName, opts) -> Promise<{ installed: bool, path?, reason? }>   never throws
//   pkg: { id?, name, description?, files: [{ path (posix, relative), b64 }] } as made by packSkill (or a peer).
//   Writes <codex home>/skills/petpack-<name>/ (opts.dirName overrides the folder name; opts.prefix overrides
//   'petpack-'). Never overwrites: if the folder exists, returns { installed:false, path, reason:'exists' }.
//   Adds frontmatter to SKILL.md when it has none (Codex skips skills without name + description), and writes
//   .petpack.json { from, id, name, description, installedAt, files }. Codex picks new skills up without a restart.
// skillSlug(s) -> hyphen-case, <= 64 chars (Codex's skill-name rule).
//
// opts: { home?, homes?, env?, dirName?, prefix? }

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { codexHome } from './home.js'
import { parseFrontmatter } from './skills.js'

export function skillSlug (s) {
  const v = String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
  return v || 'skill'
}

function yamlString (s) {
  return JSON.stringify(String(s || '').replace(/\s+/g, ' ').trim())
}

export async function installSkill (pkg, fromName, opts = {}) {
  try {
    if (!pkg || typeof pkg !== 'object') return { installed: false, reason: 'no package' }
    const files = Array.isArray(pkg.files) ? pkg.files : []
    const name = skillSlug(pkg.name || pkg.id)
    const home = opts.home || codexHome(opts)
    const prefix = opts.prefix ?? 'petpack-'
    const dirName = opts.dirName ? skillSlug(opts.dirName) : (name.startsWith(prefix) ? name : skillSlug(prefix + name))
    const root = path.join(home, 'skills')
    const dir = path.join(root, dirName)
    if (fs.existsSync(dir)) return { installed: false, path: dir, reason: 'exists' }

    // Write into a temp folder, then rename, so Codex never sees half a skill.
    await fsp.mkdir(root, { recursive: true })
    const tmp = path.join(root, `.${dirName}.petpack-tmp-${process.pid}-${Date.now()}`)
    await fsp.mkdir(tmp, { recursive: true })
    let wrote = 0
    let hasSkillMd = false
    try {
      for (const f of files) {
        if (!f || typeof f.path !== 'string' || typeof f.b64 !== 'string') continue
        const rel = path.posix.normalize(f.path.replace(/\\/g, '/')).replace(/^\/+/, '')
        if (!rel || rel === '.' || rel.startsWith('..') || rel.split('/').includes('..') || rel === '.petpack.json') continue
        const abs = path.join(tmp, ...rel.split('/'))
        await fsp.mkdir(path.dirname(abs), { recursive: true })
        let buf = Buffer.from(f.b64, 'base64')
        if (rel === 'SKILL.md') {
          hasSkillMd = true
          const text = buf.toString('utf8')
          const fm = parseFrontmatter(text)
          if (!fm.name || !fm.description) {
            const body = text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '')
            const head = `---\nname: ${yamlString(fm.name || name)}\ndescription: ${yamlString(fm.description || pkg.description || `Skill shared by ${fromName || 'a teammate'} through petpack.`)}\n---\n`
            buf = Buffer.from(head + body, 'utf8')
          }
        }
        await fsp.writeFile(abs, buf)
        wrote++
      }
      if (!hasSkillMd) {
        const md = `---\nname: ${yamlString(name)}\ndescription: ${yamlString(pkg.description || `Skill shared by ${fromName || 'a teammate'} through petpack.`)}\n---\n\n# ${pkg.name || name}\n\n${pkg.description || ''}\n`
        await fsp.writeFile(path.join(tmp, 'SKILL.md'), md)
        wrote++
      }
      const meta = {
        from: fromName || null,
        id: pkg.id || null,
        name: pkg.name || name,
        description: pkg.description || '',
        installedAt: new Date().toISOString(),
        files: wrote
      }
      await fsp.writeFile(path.join(tmp, '.petpack.json'), JSON.stringify(meta, null, 2) + '\n')
      if (fs.existsSync(dir)) {
        await fsp.rm(tmp, { recursive: true, force: true })
        return { installed: false, path: dir, reason: 'exists' }
      }
      await fsp.rename(tmp, dir)
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    return { installed: true, path: dir }
  } catch (err) {
    return { installed: false, reason: String(err && err.message ? err.message : err) }
  }
}
