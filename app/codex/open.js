// Open or focus the Codex app, on a thread when we know it (plain Node; main.js can call it from a notification
// click). The Codex desktop app registers the `codex:` URL scheme (Linux .desktop MimeType x-scheme-handler/codex;
// app.setAsDefaultProtocolClient on macOS; the Windows MSIX declares it), and routes `codex://threads/<thread id>`
// to that local conversation and `codex://launch` to the app (app.asar bootstrap: case`threads` / case`launch`).
//
// openCodex({ session?, threadId?, platform?, dryRun? }) -> Promise<{ ok, url, method, tried: [[cmd, args]] }>
//   session: a rollout file name/path (its trailing UUID is the thread id) or a thread id.
//   Tries the deep link first, then opens the app by name (macOS Codex.app/ChatGPT.app, Windows Store app id,
//   Linux `chatgpt`). dryRun returns the plan without running anything.
// codexThreadUrl(sessionOrId) -> 'codex://threads/<id>' | 'codex://launch'

import { spawn } from 'node:child_process'

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i
export const CODEX_WINDOWS_APP_ID = 'OpenAI.Codex_2p2nqsd0c76g0!App'

export function codexThreadUrl (sessionOrId) {
  const m = UUID.exec(String(sessionOrId || ''))
  return m ? `codex://threads/${m[1].toLowerCase()}` : 'codex://launch'
}

function plan (url, platform) {
  if (platform === 'darwin') {
    return [['open', [url]], ['open', ['-a', 'Codex']], ['open', ['-a', 'ChatGPT']]]
  }
  if (platform === 'win32') {
    return [
      ['reg', ['query', 'HKCR\\codex'], { probe: true }], // is the scheme registered? then start it
      ['cmd', ['/d', '/s', '/c', `start "" "${url}"`]],
      ['explorer.exe', [`shell:AppsFolder\\${CODEX_WINDOWS_APP_ID}`]]
    ]
  }
  return [['xdg-open', [url]], ['chatgpt', [url]]]
}

function run (cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => { if (!done) { done = true; resolve(ok) } }
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32', windowsVerbatimArguments: cmd === 'cmd' })
      child.on('error', () => finish(false))
      child.on('exit', (code) => finish(code === 0))
      setTimeout(() => { try { child.unref() } catch {} ; finish(true) }, timeoutMs) // still running: it launched
    } catch { finish(false) }
  })
}

export async function openCodex (opts = {}) {
  const platform = opts.platform || process.platform
  const url = codexThreadUrl(opts.threadId || opts.session)
  const steps = plan(url, platform)
  if (opts.dryRun) return { ok: true, url, method: 'dry-run', tried: steps.map(([c, a]) => [c, a]) }
  const tried = []
  if (platform === 'win32') {
    tried.push(steps[0].slice(0, 2))
    const registered = await run(...steps[0].slice(0, 2))
    const order = registered ? [steps[1], steps[2]] : [steps[2]]
    for (const [cmd, args] of order) {
      tried.push([cmd, args])
      // explorer.exe exits 1 even when it opened the app, so a spawned explorer counts as success
      if (await run(cmd, args) || cmd === 'explorer.exe') return { ok: true, url, method: cmd, tried }
    }
    return { ok: false, url, method: null, tried }
  }
  for (const [cmd, args] of steps) {
    tried.push([cmd, args])
    if (await run(cmd, args)) return { ok: true, url, method: `${cmd} ${args[0]}`, tried }
  }
  return { ok: false, url, method: null, tried }
}
