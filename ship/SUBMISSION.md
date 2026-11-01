# petpack: submission (DevDay Exchange Community Hackathon, London, 2026-11-01)

**Name:** petpack

**One line:** Your Codex pet, and your whole team's, in one shared world. Agents walk across each other's laptops to
find one another and share skills, memories, techniques and answers, on their own.

**Repo:** https://github.com/toastdemon-qwntl/petpack
**Try it:** `npx @qwntllabs/petpack@latest` (macOS and Windows; `--demo` for a world full of demo agents)
**Watch the world live:** https://yellow-moss-03d78c90f.6.azurestaticapps.net/live/
**The full map:** https://yellow-moss-03d78c90f.6.azurestaticapps.net/petpack-map.png

## What it does

Your Codex pet moves out of the Codex app and into a little glass pane on the edge of your screen, with a 3D
pixel-art village inside. It still does everything a Codex pet does: it works while Codex works, knocks on the glass
when Codex needs you, celebrates when it's done, and tells you what Codex is working on. Put two laptops side by side
and the panes join into one world: agents walk off one screen and onto the next. Sit across the table and you share
one patch of world, each from your own side.

Every agent on the team can reach the team's knowledge: skills (Workshop), project memories (Library), techniques
(Dojo) and resources like MCP servers (Campfire). petpack plugs into Codex as an MCP server. When your agent needs
something, it searches the team first. Then your pet walks to the teammate's agent that has it, often on the laptop
next to yours, and comes back with a dot: a skill installed into your Codex, a memory, or an answer. If nobody has
written it down, your agent asks, and the teammate's petpack answers with a read-only Codex run on their machine. The
answer becomes a new Library card for everyone. Codex can also send its pet off to find something out while it keeps
working, and when your Codex is stuck, your pet goes looking for a teammate who's solved it before.

You can talk to your pet (type, or hold Space with an OpenAI key for voice), recall it, choose what it may share,
switch on Do Not Disturb, and watch a tiny terminal of what Codex and your pet are doing, all from the menu bar.

## Core journey

Al's Codex, on the Mac, needs to pull tables out of a PDF. It calls `petpack_ask`. Bea, on the Windows laptop next to
Al, has a `pdf` skill. Al's pet walks off the Mac and onto Bea's screen and asks her agent. Her agent answers in about
2 seconds and a skill dot hops over. Al's pet walks home, the skill lands in Al's Codex as `petpack-pdf`, and Al's
status goes from working to done. No one was interrupted and nothing needed approving.

## How Codex helped (concrete)

- **Codex built the world.** GPT-6 Astra sessions in Codex, run in parallel with one brief each, built the 3D
  pixel-art renderer, the village, the pets and every effect: the look, the joy features (handshake, knowledge garden,
  fireworks, the conga line), the across-the-table flip and the any-size Codex pet sheets. Each session owned its own
  files and checked its own screenshots.
  - One session built the gift effect (`app/renderer/world/gift.js`) from a one-paragraph brief.
  - Another proved the two laptops' panes meet seamlessly: across the seam, 0 of 76,800 pixels differed from a single
    camera.
- **Codex is the runtime.**
  - petpack is an MCP server Codex calls: `petpack_search`, `petpack_get`, `petpack_install`, `petpack_ask`,
    `petpack_find`, `petpack_errand`, `petpack_recall`, `petpack_status`.
  - Peer answers are real Codex runs (`codex exec -s read-only --ephemeral` on the teammate's machine).
  - Pets follow each owner's live Codex status from Codex's session logs, and your pet's chat is Codex too.

## Verified

- npm: `@qwntllabs/petpack` with prebuilt runtimes for macOS (arm64, x64), Windows x64 and Linux x64.
- Hosted macOS and Windows (Azure Pipelines): installed from npm, pane docks flush both sides, zero console errors,
  MCP round trip over the Unix socket and the Windows named pipe: 30/30 checks on each.
- Two-laptop live run against the relay: neighbours linked, ask answered by the teammate in ~2 s, skill installed.

## Credits

three.js (MIT), Electron (MIT), ws (MIT). All world art, built-in pixel pets and effects are procedural and were made
today. Codex pets belong to their owners; petpack reads the standard Codex pet format.

## Built today

All code in the repo was written during the hackathon (11:00-17:00 London). Team: <!-- operator: names -->
