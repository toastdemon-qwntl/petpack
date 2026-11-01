// Open the Codex desktop app on a new thread with a prompt already typed in.
// Evidence (Codex app bundle, app.asar deep-link router): `codex://new` is the `newThread` route; its parser reads
// `prompt` (searchParams `prompt`), plus optional `path` (a project folder), `projectId` and `mode`.
//
//   codexPromptUrl(text, { path? }) -> 'codex://new?prompt=...'
//   openCodexWithPrompt(text, { path?, platform?, dryRun? }) -> Promise<{ ok, url, cmd, args }>

import { spawn } from 'node:child_process'

export function codexPromptUrl(text, { path } = {}) {
  const q = new URLSearchParams({ prompt: String(text || '').slice(0, 4000) })
  if (path) q.set('path', String(path))
  return `codex://new?${q.toString().replace(/\+/g, '%20')}`
}

function command(url, platform) {
  if (platform === 'darwin') return ['open', [url]]
  // rundll32 hands the URL to its protocol handler without cmd.exe parsing (& and % stay intact).
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
  return ['xdg-open', [url]]
}

export function openCodexWithPrompt(text, { path, platform = process.platform, dryRun = false } = {}) {
  const url = codexPromptUrl(text, { path })
  const [cmd, args] = command(url, platform)
  if (dryRun) return Promise.resolve({ ok: true, url, cmd, args })
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => { if (!done) { done = true; resolve({ ok, url, cmd, args }) } }
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: platform !== 'win32', windowsHide: true })
      child.on('error', () => finish(false))
      child.on('exit', (code) => finish(code === 0))
      setTimeout(() => { try { child.unref() } catch {} ; finish(true) }, 4000).unref?.()
    } catch { finish(false) }
  })
}
