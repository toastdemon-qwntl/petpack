// A plain-browser stand-in for the Electron bridge (window.petpack). Query parameters:
//   ?demo                 demo bots plus a fake Codex agent that calls the MCP tools
//   &seat=0 &dock=right   seat and dock edge (dock defaults to right)
//   &relay=ws://host:port/ws   relay(s) to join, comma-separated (none: solo); &relay=local -> ws://<this host>:8787/ws;
//   &relay=live -> the built-in failover list (shared/protocol.js RELAYS)
//   &room=code &name=Pip &id=fixed-id &status=working
import { tier1Answer } from './brain.js'

const enc = text => btoa(unescape(encodeURIComponent(text)))
const MY_ITEMS = [
  { ref: 'skill:win-glass-pane', kind: 'skill', title: 'win-glass-pane', summary: 'Make an Electron overlay click-through on Windows: transparent frameless window, setIgnoreMouseEvents with forward, cursor polling.' },
  { ref: 'skill:release-notes', kind: 'skill', title: 'release-notes', summary: 'Draft release notes from merged commits grouped by area, with breaking changes first.' },
  { ref: 'memory:agents-md-testing', kind: 'memory', title: 'Testing', summary: 'Run node --test once on the final candidate; vitest maxWorkers 4.' },
  { ref: 'technique:pixel-seams', kind: 'technique', title: 'pixel seams', summary: 'Quantize both panes to the same even CSS size so the art grid matches across the bezel.' },
]

export function installMockBridge(target = window) {
  const params = new URLSearchParams(location.search)
  const demo = params.has('demo')
  let relayUrl = params.get('relay')
  if (relayUrl === 'local') relayUrl = `ws://${location.hostname || 'localhost'}:8787/ws`
  const seatParam = params.get('seat')
  const config = {
    relayUrl: relayUrl === 'live' ? undefined : relayUrl && !relayUrl.includes(',') ? relayUrl : null,
    relays: relayUrl && relayUrl.includes(',') ? relayUrl.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    room: params.get('room') || null,
    seat: seatParam != null && seatParam !== '' && Number.isFinite(Number(seatParam)) ? Math.trunc(Number(seatParam)) : null,
    demo,
    install: false,
    name: params.get('name') || null,
    dock: params.get('dock') === 'left' ? 'left' : 'right',
    mock: true,
  }
  let id = params.get('id')
  if (!id) {
    try { id = sessionStorage.getItem('petpack-mock-id') } catch { id = null }
    if (!id) {
      id = `mock-${Math.random().toString(36).slice(2, 10)}`
      try { sessionStorage.setItem('petpack-mock-id', id) } catch { /* private mode */ }
    }
  }
  const names = ['Pip', 'Rex', 'Mochi', 'Nova']
  const petName = config.name || names[(((config.seat ?? 0) % names.length) + names.length) % names.length]
  const statusListeners = new Set()
  const installed = []
  let agentHandler = null
  let status = params.get('status') || 'idle'
  const emitStatus = next => { status = next; for (const cb of statusListeners) cb({ status: next, at: Date.now() }) }

  const items = MY_ITEMS.map(item => ({ ...item, bytes: item.summary.length, sha: item.ref.length.toString(16), mtime: Date.now() - 7200e3 }))
  const skillOf = item => {
    const text = `---\nname: ${item.title}\ndescription: ${item.summary}\n---\n\n# ${item.title}\n\n${item.summary}\n`
    return { id: item.title, name: item.title, description: item.summary, files: [{ path: 'SKILL.md', b64: enc(text) }] }
  }
  const bridge = {
    config,
    async getMe() {
      const spriteUrl = params.get('sprite') || null
      let atlas = null
      if (spriteUrl) {
        // Like the shell: an 8-column grid of any cell size; real sheets are often 8x11 (top 9 rows standard).
        try {
          const image = new Image()
          image.src = spriteUrl
          await image.decode()
          const cellW = Math.floor(image.naturalWidth / 8)
          const rows = Math.max(9, Math.round(image.naturalHeight / (cellW * 208 / 192)))
          atlas = { cols: 8, rows, cellW, cellH: Math.floor(image.naturalHeight / rows) }
        } catch { atlas = null }
      }
      return { id, petName: petName.toLowerCase(), displayName: petName, spriteUrl, atlas,
        skills: items.filter(i => i.kind === 'skill').map(i => ({ id: i.title, name: i.title, description: i.summary })) }
    },
    onStatus(cb) { statusListeners.add(cb); queueMicrotask(() => cb({ status, at: Date.now() })); return () => statusListeners.delete(cb) },
    async packSkill(skillId) { const item = items.find(i => i.title === skillId); return item ? skillOf(item) : null },
    async installSkill(pkg, fromName) { return bridge.installItem({ kind: 'skill', ...pkg }, fromName) },
    async installItem(item, fromName) {
      const slug = String(item?.name || item?.title || item?.ref || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
      const owner = String(fromName || 'peer').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const path = item?.kind === 'skill' ? `~/.codex/skills/petpack-${owner}-${slug}/` : `~/.codex/skills/petpack-note-${slug}/`
      installed.push({ path, item, fromName })
      return { installed: true, path }
    },
    async getCatalog() { return items },
    async readItem(ref, as) {
      const item = items.find(i => i.ref === ref)
      if (!item) return { ok: false, reason: 'not found' }
      if (as === 'pkg' && item.kind === 'skill') return { ok: true, sha: item.sha, pkg: skillOf(item) }
      return { ok: true, sha: item.sha, text: `# ${item.title}\n\n${item.summary}\n` }
    },
    async answerAsk({ question, kind }) {
      await new Promise(r => setTimeout(r, 1500))
      return tier1Answer(question, kind, items, { strict: false }) || { ok: true, text: `${petName} has nothing on that yet.` }
    },
    setInteractive() {},
    onAgentCall(handler) { agentHandler = handler; return () => { if (agentHandler === handler) agentHandler = null } },
  }
  target.petpack = bridge
  document.documentElement.classList.add('petpack-mock')

  // Test hooks: drive MCP calls and Codex status from the page.
  const call = async (tool, args = {}) => {
    if (!agentHandler) throw new Error('no agent handler yet')
    return agentHandler({ id: `call-${Math.random().toString(36).slice(2, 8)}`, tool, args })
  }
  target.petpackMock = { call, setStatus: emitStatus, installed, get status() { return status } }

  if (demo) {
    // A fake Codex agent: works for a while, then searches and asks the team, then is done.
    const questions = [
      { query: 'pdf tables', question: 'how do I extract tables from a PDF?', kind: 'skill' },
      { query: 'websocket reconnect', question: 'websocket keeps dropping, how should we reconnect?', kind: 'memory' },
      { query: 'azure deploy', question: 'how do we ship this to Azure?', kind: 'skill' },
      { query: 'flaky tests', question: 'tests are flaky, where do I start?', kind: 'technique' },
    ]
    let n = 0
    const cycle = async () => {
      const q = questions[n++ % questions.length]
      try {
        emitStatus('working')
        await new Promise(r => setTimeout(r, 4000))
        const hits = await call('petpack_search', { query: q.query, kind: q.kind })
        if (hits?.length && n % 2 === 0) await call('petpack_get', { id: hits[0].id })
        else await call('petpack_ask', { question: q.question, kind: q.kind })
        emitStatus('done')
      } catch { emitStatus('idle') }
      setTimeout(cycle, 32000 + Math.random() * 8000)
    }
    setTimeout(cycle, Number(params.get('firstcall')) || 9000)
  }
  return bridge
}
