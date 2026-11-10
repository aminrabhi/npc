# Simulora

Simulora is a pixel village that keeps living when you stop touching it.

Ten residents wake up, follow their own routines, visit each other's homes, argue,
gossip and remember what was said. You can watch from above, spawn into the village as
Amin, talk to whoever is nearby, or open the tools and rewrite a personality, repaint
the map, or script a scene.

It is a browser-based simulation built with vanilla JavaScript and a canvas, with a
small server for optional model-written dialogue and persistence.

## What is in the village

- **A day that runs itself.** Each resident has a home and a daily plan. They move
  between rooms, use beds and furniture, react to the clock and weather, and make their
  own decisions about when to seek someone out.
- **Conversations with consequences.** Villagers approach each other, start with a
  person or an ordinary topic, and carry the result back into their relationships. A
  conversation can be friendly, awkward, curious or hostile without being scripted in
  advance.
- **Directional relationships.** Every resident has a private opinion of every other
  resident: 90 one-way relationships, not a single shared score. A can adore B while B
  merely tolerates A, and both views can drift in different directions.
- **Memory and gossip.** Residents remember personal history, disagreements, promises,
  secrets and things they only heard second-hand. A rumour can change what someone
  thinks about a person who was never in the room.
- **Ordinary life and the news.** The village reads BBC headlines, but only residents
  who care about the news bring it up, and they only know what the headline said.
- **A playable character.** Amin Rabhi can be summoned into the village, walked around,
  and used to join conversations as a participant rather than an observer.
- **Tools for changing the village.** A tile editor, an NPC studio, a conversation log,
  a relationship graph, simulation controls and a small scripting panel are all built
  in.

## Run it locally

Simulora needs Node.js 20 or newer. There is no build step and there are no npm
dependencies to install.

```bash
git clone https://github.com/aminrabhi/npc.git
cd npc
npm run dev
```

Open <http://localhost:3000>. The local server serves the site and mounts the API routes
from `api/`.

The village works without any credentials: conversations fall back to the procedural
writer, and memories and relationships stay in the browser. To enable model-written
dialogue or Supabase persistence, copy the example environment file and fill in the
services you want to use:

```bash
cp .env.example .env
```

`GROQ_API_KEY` enables model-written conversations. The Supabase settings enable
server-side persistence, with `supabase/schema.sql` containing the table definitions.
The browser never receives those keys. The real `.env` is ignored by git.

## Controls

The debug buttons start hidden so the village is unobstructed.

| Input | Action |
| --- | --- |
| `,` | Show or hide Console, Logs, Relations, Script, Edit tiles and NPC studio |
| `I` | Summon or dismiss Amin Rabhi |
| `WASD` or arrow keys | Walk while playing as Amin |
| `/` | Open the player chat while playing |
| `Enter` | Send a chat line |
| `Esc` | Close a chat, editor or studio panel |
| `.` | Replay the scene currently set up in the Script panel |
| `Ctrl/Cmd + Z` | Undo in the tile editor |

Clicking a villager punishes them; right-clicking pets them. The tile editor, NPC studio
and player chat pause the normal click interactions while open.

## How a conversation happens

1. A resident decides to talk. The candidate must be free, nearby, reachable and not
   already on cooldown with them.
2. They walk to a tile beside the other person, stop, and face each other.
3. `js/social_context.js` sometimes gives the conversation a social seed: an absent
   person, a claim, the source of that claim and the speaker's confidence in it. Other
   conversations begin with an ordinary topic.
4. `js/conversation.js` manages the turn-taking. With Groq configured, each line is
   requested by the server using the speaker's personality, voice, current motivation,
   relationship, relevant memories, news context and the last few turns.
5. The closing turn is generated as a goodbye. Relationships, opinions and memories are
   updated when the conversation lands, whether or not the transcript is ever saved.

The offline writer in `js/offline_dialogue.js` uses the same character profiles and
social context when no model is configured. Offline lines are labelled as such rather
than presented as generated dialogue.

## What gets saved

By default, browser storage holds the village's evolving state: relationships,
memories, personalities, homes, player character choices and local conversation logs.
Clearing site data resets that local history.

When Supabase is configured, memories and directional relationship changes persist on
the server automatically. Conversation transcripts are the deliberate exception: they
are written only when someone presses **Save to Supabase** in the Conversation Logs
panel. A saved transcript does not replay its relationship or memory changes.

## Project layout

| Path | What lives there |
| --- | --- |
| `index.html`, `css/`, `js/` | The no-build browser app: canvas rendering, simulation, UI and local state |
| `data/` | The village map, homes and resident roster |
| `assets/` | Tilemap, character sprites, furniture, UI images, fonts and icons |
| `server/` | Prompts, model client, relationship rules, news fetching and provider validation |
| `api/` | Thin HTTP route handlers used by the local server |
| `supabase/` | Database schema for optional persistence |
| `tools/` | Local server, syntax checks, test suites and the original map-building helpers |

The simulation code is deliberately split from the presentation code. `js/main.js`
boots the world and wires the systems together; `js/lifestyle.js` owns the daily plan;
`js/npc.js` draws and moves individual villagers; and the panels under `js/*_panel.js`,
`js/conv_logs.js` and `js/npc_studio.js` provide the tooling around it.

The Python map-building helpers under `tools/` expect the original asset download
unpacked in `assets_pack/`. That folder is local-only; the generated map data and runtime
sprites are already tracked.

## Tests

The Node test suites use local test doubles, so they do not spend model credits or need
a configured production service.

```bash
npm run check         # syntax-check every browser module and API route
npm run test:api      # API routes, validation, fallbacks and persistence
npm run test:offline  # the procedural writer and conversation seeding
npm run test:social   # fights, petting and scripted conversations
```

Additional Playwright checks for the editor, rooms, doors and the NPC studio live under
`tools/` and require a browser test environment.

## Notes and limits

- Dialogue quality depends on the configured model. When one is configured, the default
  is a small model chosen to keep replies short and conversational; the offline writer
  is the fallback, not a hidden second model.
- Sprites face left and right only, so villagers standing above or below each other
  mirror outward rather than literally looking up or down.
- Relationships do not begin from a clean slate. The cast already has old warmth,
  wariness and unfinished business.
- The village is a simulation to watch and prod, not a game with a win condition.

## Credits

The pixel art is the Sunnyside World asset pack by Daniel Diggle; no artwork is drawn by
Simulora itself. News headlines come from the BBC's public RSS feeds and link back to the
BBC. The interface uses Pixelify Sans.
