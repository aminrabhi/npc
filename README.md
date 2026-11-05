# Sunnyside Village

A pixel village where ten villagers live out a day: walking, watching clouds, chilling
in their own rooms, sleeping in their own beds, and talking to each other. Part 1 built
the village, the tile editor and the lifestyle simulation. Part 2 makes those villagers
into people: distinct editable personalities, real conversations through Groq Cloud,
directional relationships that evolve, memories that persist, and the occasional BBC
headline.

The art is the supplied asset pack only. Nothing here draws artwork.

## What runs where

| Layer | Files | Notes |
| --- | --- | --- |
| The village | `index.html`, `js/*.js`, `css/style.css`, `assets/`, `data/` | Static, no build step |
| Serverless API | `api/*.js` | Vercel Node functions |
| Server logic | `server/*.js` | Groq client, prompts, Supabase REST, news, validation |
| Database | `supabase/schema.sql` | Run once in the Supabase SQL editor |
| Local dev server | `tools/api_server.js` | Static files **and** the same `api/*` handlers |

The browser never sees a key. It talks to `/api/chat`, `/api/memories`,
`/api/relationships`, `/api/conversations`, `/api/news` and `/api/status`, and those
functions hold the Groq and service-role credentials.

## Setup

### 1. Groq

1. Create a key at <https://console.groq.com/keys>.
2. Set `GROQ_API_KEY` in Vercel (or in a local `.env`).
3. Leave `GROQ_MODEL` unset, or set it to `allam-2-7b`.

`allam-2-7b` is the default conversation model and lives in exactly one place:
`server/env.js` (`DEFAULT_MODEL`), overridable with `GROQ_MODEL`. If the model is
unavailable the API returns the actual Groq error, with the configuration point named;
it is never silently swapped for another model.

### 2. Supabase

1. Create a project and copy the URL, anon key and service-role key.
2. Run `supabase/schema.sql` in the SQL editor. It creates the village tables, indexes,
   and turns on RLS with no policies for `anon`/`authenticated`, so only the service
   role (and therefore only the server) can read or write.
3. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.

Until this is done the village still runs: dialogue falls back to clearly-labelled
offline lines, and relationships and memories are kept in the browser only. The
Conversation Logs panel says `persistence off: no Supabase` rather than failing quietly.

### 3. Vercel

Import the repository as an "Other" project. Zero config is enough: `api/` becomes
functions, everything else is served statically. `vercel.json` only raises the function
duration to 30 s and marks the API as no-store. Set the environment variables above for
Production (and Preview if you want previews to talk).

#### Environment variables

```
GROQ_API_KEY=
GROQ_MODEL=allam-2-7b
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

`.env.example` has the same names with placeholders. `.env` is git-ignored.

### 4. Local development

```bash
cp .env.example .env      # fill in what you have
npm run dev               # http://localhost:3000
```

`tools/api_server.js` serves the static village and mounts the real API routes, reading
`.env` itself. There are no npm dependencies.

## The important distinction

**Automatic**, during ordinary simulation, with no user interaction:

* NPC memories (shared, personal, milestones, disagreements, news)
* Relationship scores, trust, familiarity, categories, best-friend status

**Manual**, and only this:

* Conversation transcripts. They are logged locally for the panel, and written to
  Supabase only when someone presses **Save to Supabase** in Conversation Logs.

Saving a transcript does not create duplicate memories or move a relationship again, and
not saving one does not cost the villagers anything: memory and relationship persistence
never waits on transcript persistence.

## Conversation flow

`js/conversation.js` owns a conversation; `js/lifestyle.js` still owns the body.

1. A villager decides to talk. Candidates must be free, close enough, reachable, off a
   doorstep, and not on cooldown with the initiator.
2. They walk to a tile beside the partner, stop, and the two face each other.
3. A session is created with a random target of 5-10 total messages.
4. Each turn asks `/api/chat` for one line for the current speaker, with that speaker's
   personality, the relationship, relevant memories, at most two headlines and the last
   eight turns. allam-2-7b has a 4k context, so the prompt is deliberately small.
5. The final message is generated in `closing` mode, so conversations end on a goodbye.
6. Both villagers are handed back and resume the day. Cooldowns depend on category,
   sociability and a little randomness.

If Groq fails three times in a row the chat ends, and every line that came from a
fallback is badged `offline` in the logs. A failed request is never disguised as a
generated line.

## Relationships

Directional: `npc_id` + `other_id` is the key, so A can adore B while B merely tolerates
A. Changes per conversation are small on purpose (single digits), asymmetric (weighted
by the viewer's sociability and trust), and categories are derived from the numbers by
one formula (`server/relationships.js`, mirrored in `js/relationships.js`). Villagers can
reach `friend`, `close friend` and `best friend`, and friendships make them seek each
other out through the partner-appeal score used when choosing who to talk to.

## News

Headlines come from the BBC's own RSS feeds (`feeds.bbci.co.uk/news/rss.xml` and category
feeds), cached for 15 minutes, mirrored to `village_news`, with the cached copy used when
a refresh fails. Only headline, summary and link are stored; article bodies are never
fetched or sent to the model. The panel credits BBC News with a link, which is what the
BBC's terms require for displaying the feeds. There is no scraping and no BBC API is
assumed.

A villager only raises the news if their `newsInterest` says so, headlines are not
repeated until the recent list rotates, and the prompt tells them they only know what the
headline said.

## Debug interface

One debug surface, as before: the tile editor panel. It now has two extra buttons.

* **Sim**: time and weather overrides, villager states (Part 1).
* **Logs**: live conversations, recent conversations, complete transcripts, participants
  and ids, timestamps and duration, message count and status, relationship context,
  memories produced, news context, errors, NPC filter and text search, **Save to
  Supabase**, and the list of already-saved transcripts.

## Tests

```bash
npm run check        # syntax-check every module and route
npm run test:api     # API routes against local Groq/Supabase/BBC test doubles
```

`tools/test_api.js` starts its own doubles (`tools/mock_backends.js`) and two servers,
one configured and one deliberately empty, and covers validation, the message cap, model
misconfiguration, duplicate prevention, directional relationships, transcript save and
retrieval, news caching and the "no keys yet" errors.

Browser verification is `tools/verify_part2.py` (Playwright, needs the screenshot venv),
run against a configured server on `:3001` and an unconfigured one on `:3000`. The Part 1
suites (`tools/test_editor.py`, `test_rooms.py`, `test_doors.py`, `npc_check.py`) still
apply and still pass.

## Notes and limits

* Dialogue quality depends on the configured model; `allam-2-7b` is small and the prompt
  is tuned to keep it to one short, in-character sentence.
* Sprites only face left and right, so a pair that has to stand one above the other
  mirrors outward instead of literally looking up or down.
* Relationships start with a couple of long-standing neighbours so day one is not ten
  strangers.
* There is no fighting or hostility system in this part, only warm, neutral and cool
  relationships.
