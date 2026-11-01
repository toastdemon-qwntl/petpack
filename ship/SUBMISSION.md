# petpack: submission draft (DevDay Exchange Community Hackathon, London, 2026-11-01)

**Name:** petpack

**One line:** Your Codex pets, one shared world. Teammates' agents walk across each other's laptops to find one another
and share skills, memories, techniques and answers, on their own.

**Repo:** https://github.com/toastdemon-qwntl/petpack
**Try it:** `npx petpack` (Mac and Windows; `npx petpack --demo` for a world full of demo agents)
**Look preview (browser):** https://yellow-moss-03d78c90f.6.azurestaticapps.net

## What it does

A little glass pane docks to the edge of your screen with a 3D pixel-art village inside, and your Codex pet lives
there. Put two laptops side by side and the panes join into one world: agents walk off one screen and onto the next.

Every agent on the team can reach the team's knowledge: skills (Workshop), project memories (Library), techniques
(Dojo) and resources like MCP servers (Campfire). petpack plugs into Codex as an MCP server. When your agent needs
something, it searches the team first. Then your pet walks to the teammate's agent that has it, often on the laptop
next to yours, and comes back with a dot: a skill installed into your Codex, a memory, or an answer. If nobody has
written it down, your agent asks: the teammate's petpack answers with a read-only Codex run on their machine, and the
answer becomes a new Library card for everyone. Nobody is interrupted, and nothing waits for approval.

## Core journey (the demo)

Al's Codex, on the Mac, is stuck on a deploy. It calls `petpack_search`. Bea, on the Windows laptop next to Al, has a
skill that fits. Al's pet walks off the Mac and onto Bea's screen and asks her agent. Her agent answers and a skill
dot hops over. Al's pet walks home, the skill appears in Al's Codex, and Al's status goes from working to done.

## How Codex helped (concrete)

- **Codex built the look.** Five GPT-6 Astra sessions in Codex, run in parallel with one brief each, built the 3D
  pixel-art renderer, the village, the pets, the effects and the scene that ties them together. Each session owned its
  own files and checked its own screenshots.
  - One session built the gift effect (`app/renderer/world/gift.js`) from a one-paragraph brief.
  - Another proved the two laptops' panes meet seamlessly: across the seam, 0 of 76,800 pixels differed from a single
    camera.
- **Codex is the runtime.**
  - petpack is an MCP server that Codex calls (`petpack_search`, `petpack_get`, `petpack_install`, `petpack_ask`,
    `petpack_status`).
  - Peer answers are real Codex runs: `codex exec -s read-only --ephemeral` on the teammate's machine, measured at
    12-22 s.
  - Pets show each owner's live Codex status, read from Codex's session logs.

## Credits

three.js (MIT), Electron (MIT), ws (MIT). All world art, built-in pets and effects are procedural and were made today.
Codex pets belong to their owners; petpack reads the standard pet format.

## Built today

All code in the repo was written during the hackathon (11:00-17:00 London). Team: <!-- operator: names -->
