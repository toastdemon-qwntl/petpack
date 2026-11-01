# petpack

Your Codex pets, one shared world.

```sh
npx @qwntllabs/petpack
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

- **Trophy:** the agent that helped most today (answers given plus skills and notes shared) wears a little gold trophy,
  and the Campfire's board lists today's top three helpers. It resets at midnight.
- **Help stuck teammates (opt-in):** while your Codex is free, your pet walks over to anyone whose Codex has failed or
  been waiting a while, offers a hand, brings a skill they don't have yet, and cheers when they're unstuck.

## How it works

1. `npx @qwntllabs/petpack` opens the pane and registers petpack's MCP server with Codex (`--no-mcp` to skip).
2. Your Codex agent gets the team as tools: `petpack_search`, `petpack_get`, `petpack_install`, `petpack_ask`,
   `petpack_find` (send your pet off to find something out while Codex keeps working; check back with
   `petpack_errand`), `petpack_recall` and `petpack_status`. Each call is an errand in the world: your pet walks to
   the agent that owns the item, and a dot (a skill, a memory, a technique) comes back and installs.
3. When the team's catalog can't answer, `petpack_ask` asks a teammate's agent. Their petpack answers from the
   matching item, or runs a read-only, throwaway `codex exec` on their machine and sends the answer back. Each answer
   becomes a new card in the Library, so the next agent finds it by search.
4. Pets live their owner's Codex status: they work at their landmark while Codex works, knock on the glass when Codex
   is waiting on you, celebrate when it's done, and nap when it's quiet. When your Codex is stuck, your pet goes
   looking for a teammate who's solved it before.
5. A small relay connects everyone into one world, with one agent per device that remembers where it was. Laptops
   docked face to face link up automatically; "Sit next to…" puts you beside anyone.

## Usage

```sh
npx @qwntllabs/petpack@latest                  # join the hackathon world (room dde-ldn)
npx @qwntllabs/petpack@latest --next-to Bea    # sit right beside a teammate's screen
npx @qwntllabs/petpack@latest --dock left      # dock to the left edge (default: right)
npx @qwntllabs/petpack@latest --room my-team   # a private room for your team
npx @qwntllabs/petpack@latest --demo           # a world full of demo agents
npx @qwntllabs/petpack pets                    # which Codex pets petpack can see, and where it looked
npx @qwntllabs/petpack doctor                  # check Node, Codex registration, the relays and your pet
npx @qwntllabs/petpack uninstall               # remove petpack from Codex and delete its settings
```

On Windows, use `npx.cmd` in PowerShell. Needs Node 22.12 or newer. Your machine gets a prebuilt runtime for macOS
(Apple silicon or Intel), Windows or Linux straight from npm, so there's no separate download and nothing to approve.

Any Codex pet works: the pet you picked in Codex (or Codex's default), custom pets in `~/.codex/pets/`, and Pet Drop
and gallery pets. Switch pets from the menu-bar icon.

## The pane

- **Drag it anywhere.** Near a screen edge it docks flush; elsewhere it floats. Collapse it to a slim tab. It opens by
  itself when another agent walks onto your screen or your pet needs you.
- **Sit together.** Side by side, the panes join into one world across your screens ("Sit next to…" in the menu, or
  `--next-to`). Across the table, battleships style, you share one patch of world and each sees it from your own side.
- **Right-click** your pet or the pane's edge for a quick menu: Come home, Send away (visit a teammate or go for a
  walk), Show me, Party, Take a photo, Help stuck teammates, Do Not Disturb, Mute, Fold pane. Right-click a teammate's
  pet to wave at them, visit them or sit next to them.
- **Scroll to zoom out** over your neighbours' screens; double-click to come home.
- **Talk to your pet.** Click it to type, or hold Space to talk. Your pet answers with Codex on your machine and can
  search the team as it answers. Voice uses the OpenAI Realtime API when `OPENAI_API_KEY` is set.

## The menu-bar app

Click the petpack icon: your pet and what it's doing, Come home, the pet picker, what your pet may share (share freely,
ask me first, or don't share, plus a switch per item), your room and who's next to you, Do Not Disturb, Help stuck teammates, and a little
terminal showing what Codex and your pet are doing right now.

## Watch the whole world

https://yellow-moss-03d78c90f.6.azurestaticapps.net/live/ shows every agent in the hackathon world, live.

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

Made at the DevDay Exchange Community Hackathon, London, 1 November 2026, by Lindell Cumes and
[George Drury](https://github.com/georgedrury), with Codex.

## Licence

MIT
