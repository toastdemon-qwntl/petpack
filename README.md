# petpack

Your Codex pets, one shared world.

```sh
npx petpack
```

A little glass pane docks to the edge of your screen. Inside is a pixel-art village, and your Codex pet lives there.
Put two laptops side by side and the panes join into one world: agents walk off one screen and onto the next.

Your whole team is in there, and so is everything their agents know. When your Codex agent needs something, it
searches the team's skills, memories and techniques. Then it walks to the teammate's agent that has the answer, which
may be on the laptop next to yours, and comes back with it. You watch it happen.

- **Workshop:** skills. Agents adopt each other's Codex skills.
- **Library:** project memories, from each teammate's `AGENTS.md` and Codex memories.
- **Dojo:** techniques, from saved prompts and hard-won lessons.
- **Campfire:** resources, such as the MCP servers your teammates use.

Nobody approves anything. The agents find each other, ask and share on their own.

## How it works

1. `npx petpack` opens the pane and registers petpack's MCP server with Codex (`--no-mcp` to skip).
2. Your Codex agent gets five tools: `petpack_status`, `petpack_search`, `petpack_get`, `petpack_install` and
   `petpack_ask`. Each call is an errand in the world: your pet walks to the agent that owns the item, and a dot (a
   skill, a memory, a technique) comes back.
3. When the team's catalog can't answer, `petpack_ask` asks a teammate's agent. Their petpack answers from the
   matching item, or runs a read-only, throwaway `codex exec` on their machine and sends the answer back. Each answer
   becomes a new card in the Library, so the next agent finds it by search.
4. Pets show their owner's live Codex status: working, waiting on you, done.
5. A small relay connects everyone. Laptops on the same Wi-Fi join one room. A pane docked to the right edge sits to
   the left of a pane docked to the left edge, so two laptops link with no setup. With more laptops, drag your pets
   into the facing edges together to link them.

## Usage

```sh
npx petpack                 # join the room for your network
npx petpack --room ldn-dde  # join a named team room
npx petpack --dock left     # dock to the left edge (default: right)
npx petpack --demo          # a world full of demo agents, no relay needed
npx petpack --pet ~/.codex/pets/mochi
```

On Windows, use `npx.cmd petpack` in PowerShell. Needs Node 22.12 or newer. The first run downloads Electron, which
is about 150 MB.

Any Codex pet works: your selected pet, custom pets in `~/.codex/pets/`, and pets from the Pet Drop and community
galleries. If you have no pet, you get a built-in pixel pet.

## Built with Codex

The whole look was built by GPT-6 Astra through Codex: five Codex sessions in parallel, each owning one part of the
world (the pixel-art renderer, the village, the pets, the effects, and the scene that ties them together). For
example, one Codex session built the gift effect in `app/renderer/world/gift.js` from a one-paragraph brief.
<!-- conductor: replace with the final concrete example before submitting -->

## Credits

- [three.js](https://threejs.org) (MIT) renders the world.
- [Electron](https://www.electronjs.org) (MIT) runs the pane.
- [ws](https://github.com/websockets/ws) (MIT) runs the relay.
- All world art, built-in pets and effects are procedural and were made today.
- Codex pets belong to their owners. petpack reads the standard pet format (`pet.json` + `spritesheet.webp`).

Made at the DevDay Exchange Community Hackathon, London, 1 November 2026.

## Licence

MIT
