// Tray popover (TRAY lane): placement, recall replies, the rollout terminal feed and sharing settings.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PANEL, anchorBounds, recallReply, rolloutEntries, statusLine, tailRollouts } from './panel-core.js'
import { mayShare, readSharing, shareable, writeSharing } from './sharing.js'

const workArea = { x: 0, y: 25, width: 1440, height: 875 }
const screenBounds = { x: 0, y: 0, width: 1440, height: 900 }

test('popover opens under a macOS menu-bar icon and stays on screen', () => {
  const b = anchorBounds({ tray: { x: 1200, y: 0, width: 22, height: 24 }, workArea, bounds: screenBounds })
  assert.equal(b.width, PANEL.width); assert.equal(b.height, PANEL.height)
  assert.ok(b.y >= 24 && b.y <= 40, `under the bar: ${b.y}`)
  assert.equal(b.x, Math.round(1211 - PANEL.width / 2))
  const edge = anchorBounds({ tray: { x: 1420, y: 0, width: 20, height: 24 }, workArea, bounds: screenBounds })
  assert.ok(edge.x + edge.width <= workArea.x + workArea.width, 'clamped to the right edge')
})

test('popover opens over a bottom Windows taskbar icon, and top-right when the tray has no bounds', () => {
  const win = { x: 0, y: 0, width: 1920, height: 1040 }
  const b = anchorBounds({ tray: { x: 1700, y: 1044, width: 24, height: 32 }, workArea: win, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })
  assert.ok(b.y + b.height <= 1040, 'above the taskbar')
  const linux = anchorBounds({ tray: { x: 0, y: 0, width: 0, height: 0 }, workArea, bounds: screenBounds })
  assert.equal(linux.x, workArea.width - PANEL.width - 6)
  assert.equal(linux.y, workArea.y + 6)
})

test('recall: a busy pet says who it is helping; a free one comes home', () => {
  assert.equal(recallReply({ errand: { kind: 'skill', with: 'Bea' } }, 'Mochi'), 'busy helping Bea, back soon')
  assert.equal(recallReply({ errand: { label: 'deploy notes', with: 'Bea' } }), 'busy helping Bea with deploy notes, back soon')
  assert.equal(recallReply({}, 'Mochi'), 'Mochi is on the way home')
  assert.equal(recallReply({ home: true }), 'already home')
  assert.equal(statusLine({ errand: { with: 'Bea' } }, 'working').text, 'away on an errand · helping Bea')
  assert.equal(statusLine({ dnd: true }, 'working').key, 'dnd')
  assert.equal(statusLine({}, 'waiting').key, 'waiting')
})

const rl = (type, payload) => JSON.stringify({ timestamp: '2026-11-01T15:00:00.000Z', type, payload })

test('rollout lines become terminal lines (shell, code-mode exec scripts, thinking, replies)', () => {
  assert.deepEqual(rolloutEntries(rl('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) })),
    [{ kind: 'cmd', text: 'npm test' }])
  const script = 'const r = await Promise.allSettled([\n  tools.exec_command({cmd:"git status --short",workdir:"/x"}),\n  tools.view_image({path:"/tmp/a.png"})\n])'
  assert.deepEqual(rolloutEntries(rl('response_item', { type: 'custom_tool_call', name: 'exec', input: script })),
    [{ kind: 'cmd', text: 'git status --short' }, { kind: 'tool', text: 'view_image /tmp/a.png' }])
  assert.deepEqual(rolloutEntries(rl('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Checking the sprite grid**\n\nmore' }] })),
    [{ kind: 'think', text: 'Checking the sprite grid' }])
  assert.deepEqual(rolloutEntries(rl('event_msg', { type: 'task_started' })), [{ kind: 'task', text: 'started a task' }])
  assert.deepEqual(rolloutEntries(rl('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done: tests pass.' }] })),
    [{ kind: 'say', text: 'Done: tests pass.' }])
  assert.deepEqual(rolloutEntries(rl('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'secret prompt' }] })), [])
  assert.deepEqual(rolloutEntries('not json'), [])
})

test('tailRollouts reads the live session read-only: backlog first, then appended lines', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-tail-'))
  const d = new Date()
  const dir = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'rollout-2026-11-01T15-00-00-abcdef.jsonl')
  fs.writeFileSync(file, rl('event_msg', { type: 'task_started' }) + '\n')
  const got = []
  const stop = tailRollouts(l => got.push(l), { homes: [home], intervalMs: 30 })
  try {
    assert.equal(got.length, 1)
    assert.equal(got[0].source, 'codex')
    fs.appendFileSync(file, rl('response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","ls -la"]}' }) + '\n')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.deepEqual(got.map(l => l.text), ['started a task', 'ls -la'])
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 3, 'file untouched')
  } finally { stop(); fs.rmSync(home, { recursive: true, force: true }) }
})

test('sharing settings persist and filter what the room sees', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petpack-share-'))
  try {
    assert.deepEqual(readSharing(dir), { mode: 'free', hidden: [], dnd: false })
    writeSharing(dir, { mode: 'ask' })
    writeSharing(dir, { hidden: ['skill:secret'], dnd: true })
    const s = readSharing(dir)
    assert.deepEqual(s, { mode: 'ask', hidden: ['skill:secret'], dnd: true })
    const items = [{ ref: 'skill:secret' }, { ref: 'memory:a' }]
    assert.deepEqual(shareable(items, s).map(i => i.ref), ['memory:a'])
    assert.equal(mayShare('memory:a', s), 'ask')
    assert.equal(mayShare('skill:secret', s), 'no')
    assert.deepEqual(shareable(items, { ...s, mode: 'off' }), [])
    assert.equal(mayShare('memory:a', { mode: 'free' }), 'yes')
    fs.writeFileSync(path.join(dir, 'sharing.json'), '{broken')
    assert.equal(readSharing(dir).mode, 'free')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
