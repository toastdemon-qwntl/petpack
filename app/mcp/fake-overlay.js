#!/usr/bin/env node
// A stand-in for the running overlay, for tests, CI round trips and `codex exec` checks without Electron.
// It listens on the real IPC endpoint (same ipc.json) and answers every petpack_* tool with canned demo data.
//
//   PETPACK_USER_DATA=/tmp/pp node app/mcp/fake-overlay.js [--profile p]
//
// Prints `ready <endpoint>` on stdout once listening; logs each call on stderr. Exits on SIGINT/SIGTERM.

import { startIpcServer } from './ipc.js'

const now = Date.now()
const errands = new Map()
let errandSeq = 0
const ITEMS = [
  { id: 'rex-7f3a/skill:azure-app-service-deploy', kind: 'skill', title: 'azure-app-service-deploy',
    summary: 'Zip-deploy a Node app to Azure App Service Linux with WebSockets on; health check at /healthz.', owner: 'Rex', online: true, age: '2h' },
  { id: 'mia-19c2/memory:agents-md-testing', kind: 'memory', title: 'Testing: run node --test, never the whole desktop suite',
    summary: 'From Mia\'s AGENTS.md: tests are node --test files named *.test.js; keep vitest under 4 workers.', owner: 'Mia', online: true, age: '1d' },
  { id: 'rex-7f3a/technique:pixel-sprites', kind: 'technique', title: 'Slice an 8x9 pet atlas',
    summary: 'Count frames per row by scanning cell alpha; cells are atlas width / 8 by height / 9.', owner: 'Rex', online: true, age: '40m' },
  { id: 'kai-55e0/resource:github-mcp', kind: 'resource', title: 'github MCP server',
    summary: 'npx -y @modelcontextprotocol/server-github, env GITHUB_TOKEN.', owner: 'Kai', online: false, age: '3h' },
]

function score(item, q) {
  const words = String(q || '').toLowerCase().split(/\W+/).filter(Boolean)
  const hay = `${item.title} ${item.summary}`.toLowerCase()
  return words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0)
}

export function fakeOnCall({ tool, args }) {
  switch (tool) {
    case 'petpack_status':
      return {
        room: 'demo', me: { name: 'You', pet: 'Dot', seat: 0, status: 'working', online: true },
        peers: [
          { name: 'Rex', pet: 'Rex', seat: 1, where: 'right', status: 'idle', counts: { skill: 3, memory: 2, technique: 1, resource: 0 } },
          { name: 'Mia', pet: 'Mia', seat: 3, where: 'far', status: 'working', counts: { skill: 1, memory: 4, technique: 0, resource: 1 } },
          { name: 'Kai', pet: 'Kai', seat: null, where: 'away', status: 'idle', counts: { skill: 0, memory: 0, technique: 0, resource: 1 } },
        ],
      }
    case 'petpack_search': {
      const limit = Math.max(1, Math.min(10, Number(args.limit) || 3))
      return ITEMS.filter((i) => !args.kind || i.kind === args.kind)
        .map((i) => [score(i, args.query), i]).sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, i]) => i)
    }
    case 'petpack_get': {
      const it = ITEMS.find((i) => i.id === args.id)
      if (!it) throw new Error(`No item ${args.id}`)
      return { kind: it.kind, title: it.title, owner: it.owner, text: `# ${it.title}\n\n${it.summary}\n`, installed: it.kind === 'skill' }
    }
    case 'petpack_install': {
      const it = ITEMS.find((i) => i.id === args.id)
      if (!it) throw new Error(`No item ${args.id}`)
      return { installed: true, path: `~/.codex/skills/petpack-note-${it.title.replace(/\W+/g, '-').toLowerCase()}` }
    }
    case 'petpack_ask':
      return { answered_by: args.to || 'Rex', answer: `Rex's agent: for "${args.question}", zip-deploy and turn WebSockets on first.`, dot: ITEMS[0].id }
    case 'petpack_inbox':
      return [{ id: 'q1', from: 'Mia', question: 'How do you slice the pet atlas?' }]
    case 'petpack_answer':
      return { ok: true, id: args.id, first: true }
    case 'petpack_find': {
      const id = `e${++errandSeq}`
      errands.set(id, { question: args.question, startedAt: Date.now() })
      return { errand_id: id, message: `Dot is off to find out: ${args.question}` }
    }
    case 'petpack_errand': {
      const e = errands.get(args.errand_id)
      if (!e) throw new Error(`No errand ${args.errand_id}`)
      const done = Date.now() - e.startedAt > 300
      return done
        ? { errand_id: args.errand_id, status: 'done', where: 'home', findings: [{ from: 'Rex', answer: 'Zip-deploy, then turn WebSockets on.' }], installed: [ITEMS[0].id] }
        : { errand_id: args.errand_id, status: 'walking', where: 'right', findings: [], installed: [] }
    }
    case 'petpack_recall':
      return { coming_home: true, message: 'Dot is coming home.' }
    default:
      throw new Error(`Unknown tool ${tool}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fake-overlay.js')) {
  const pi = process.argv.indexOf('--profile')
  const profile = pi >= 0 ? process.argv[pi + 1] : undefined
  const ipc = await startIpcServer({
    profile,
    version: 'fake',
    onClient: (ev, client) => process.stderr.write(`fake-overlay client ${ev} ${JSON.stringify(client)}\n`),
    onCall: async (call) => {
      process.stderr.write(`fake-overlay call ${call.tool} ${JSON.stringify(call.args)}\n`)
      if (call.tool === 'petpack_ask' && call.progress) { call.progress('Dot is walking to Rex\'s screen'); await new Promise((r) => setTimeout(r, 300)); call.progress('Rex is thinking'); await new Promise((r) => setTimeout(r, 300)) }
      return fakeOnCall(call)
    },
  })
  process.stdout.write(`ready ${ipc.endpoint}\n`)
  const stop = async () => { await ipc.close(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
