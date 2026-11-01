# petpack contract (pinned 13:05Z, integration owner: conductor)

`npx petpack`: your Codex pet joins one shared map that sits top right on your screen. Laptops side by side show
neighbouring parts of the map, so pets walk off one laptop and onto the next. Pets share their Codex skills with each
other on their own (no prompts, no approve buttons). Every skill is a glowing **dot**: dots orbit the pet that knows
them and fly from pet to pet when shared.

Event: DevDay Exchange Community Hackathon, London, submissions close 17:00Z today. Mac + Windows. No build step:
plain ES modules, `three` loaded from `node_modules` through an import map.

## Layout and owners (each file has exactly one owner lane; never edit another lane's files)

| Path | Owner |
|---|---|
| `package.json`, `bin/petpack.js`, `app/main.js`, `app/preload.js`, `app/codex/*` | **shell** |
| `app/renderer/world/*` (incl. `world/demo.html`) | **world** |
| `app/renderer/index.html`, `app/renderer/app.js`, `app/renderer/net.js`, `app/renderer/brain.js`, `app/renderer/mock-bridge.js`, `server/*`, `shared/protocol.js` | **pack** |
| `CONTRACT.md`, `README.md` | conductor |

If you need a change in another lane's file or in this contract, write it in your final report; don't make it.

## World coordinates

- The map is one horizontal strip. Seat `s` owns world x in `[s * SEAT_W, (s + 1) * SEAT_W)`, `SEAT_W = 16`.
- A pet's state is only `x` (float), `facing` (`1` right, `-1` left), `anim`, `status`. The world decides ground
  height and depth placement itself.
- Each client's camera frames its own seat's segment. A pet outside it is on a neighbour's screen.

## Bridge: `window.petpack` (shell implements in preload; pack's `mock-bridge.js` fakes it in a plain browser)

```js
petpack.config            // { relayUrl, room, seat /* int|null */, demo /* bool */, install /* bool */, name }
petpack.getMe()           // Promise<{ id, petName, displayName, spriteUrl /* data:image/webp;base64,... | null */,
                          //           skills: [{ id, name, description }] }>
petpack.onStatus(cb)      // cb({ status: 'idle'|'working'|'waiting'|'done'|'failed', at }); returns unsubscribe
petpack.packSkill(id)     // Promise<{ id, name, description, files: [{ path /* posix, relative */, b64 }] }> (<= 512 KB)
petpack.installSkill(pkg, fromName) // Promise<{ installed: bool, path?, reason? }>
petpack.setInteractive(on) // true: window takes the mouse; false: clicks pass through to the desktop
```

- `id` is stable per machine (random, saved under the petpack config dir), never a username or email.
- `spriteUrl` is the user's Codex pet spritesheet (`${CODEX_HOME:-~/.codex}/pets/<pet>/spritesheet.webp`, with
  `pet.json` beside it) as a data URL, or `null` when they have no pet: the world then draws the built-in Dot.
- Status comes from the newest Codex session rollout under `${CODEX_HOME:-~/.codex}/sessions/`.

## Codex pet spritesheet (the world renders it)

1536x1872 atlas, 192x208 cells, 8 columns x 9 rows, transparent. Rows: 0 idle, 1 running-right, 2 running-left,
3 waving, 4 jumping, 5 failed, 6 waiting, 7 running, 8 review. Each row fills frames from the left; the rest of the
row is fully transparent (count frames per row by scanning cell alpha at load). Reference:
`openai/skills` → `skills/.curated/hatch-pet` (`SKILL.md`, `references/animation-rows.md`).

## World API: `app/renderer/world/index.js` (world implements, pack calls)

```js
import { createWorld } from './world/index.js'
const world = createWorld(canvas, { seat, seatWidth: 16 })
world.setSeat(seat)
world.upsertPet(id, { displayName, color /* '#rrggbb' */, spriteUrl /* or null */, skillCount, isMe })
world.updatePet(id, { x, facing, anim, status })  // ~10 Hz; world interpolates and animates between updates
world.removePet(id)
world.giftFx(fromId, toId, { label, color })      // a dot arcs from pet to pet (works across seats); Promise on arrival
world.say(id, text)                               // short bubble over a pet, e.g. "learned pdf"
world.pick(clientX, clientY)                      // pet id under the pointer, or null
world.dispose()
```

`anim`: `idle | run | wave | jump | failed | waiting | review` (`run` + `facing` picks the row).
`status` drives the Codex-style thought bubble: `working` (three bouncing dots), `waiting` (red clock),
`done` (green check), `failed` (red cross), `idle` (none).

## Relay protocol: `shared/protocol.js` (pack implements server and client)

JSON text frames over one WebSocket per client, rooms by name. Client → server: `hello`, `state`, `gift`, `fx`,
`seat`. Server → client: `welcome`, `join`, `leave`, `state`, `gift`, `fx`, `seat`. Pack defines the fields in
`shared/protocol.js` and documents them there. Gifts go only to their target; `fx` and `state` go to the room.

## Behaviour (pack's `brain.js`)

- Own pet only: wander its home segment, `anim` from Codex status (working: `run` laps; waiting: `waiting`;
  done: `jump` then `wave`; failed: `failed`).
- The pack shares on its own: when a peer lacks a skill this pet has, this pet walks to it (across seats if needed),
  waves, `giftFx` plays on every screen, the receiver installs it (`installSkill`), jumps, and says "learned <name>".
  Each skill goes to each peer once; at most one delivery in flight per pet; a new peer gets a welcome gift soon
  after joining.
- `--demo` (or `?demo` in a browser) adds bot peers with Dot characters so one laptop shows the whole story.

## Done means

- `npx petpack` (or `npm start`) on macOS and Windows opens a transparent, always-on-top, click-through overlay at the
  top right of the main display showing the shared map, the user's pet and peers in the same room.
- Two clients in the same room see each other; a skill gift moves a dot across screens and lands a real skill folder.
- Runs with no relay reachable (solo map, demo bots still work).
- Beautiful: it competes with the slickest product you know. 60 fps on a MacBook Air.
