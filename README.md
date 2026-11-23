# Next Read

A bespoke bookshop built from your Goodreads library. Import your export, get a taste profile you can edit, then browse shelves of recommendations as cover tiles. Click a book for *why* it was picked (which of your books it connects to, and where it may not land). Pin, dismiss and steer to refine.

Recommendations link on underlying ideas and narrative voice rather than genre or popularity. Every pick is checked against Open Library / Google Books, and anything that can't be found is dropped, which guards against invented titles. Covers come from the same lookup.

Runs on Cloudflare Workers (static assets + a small API).

## Layout

```
public/          static front end (no build step)
worker/index.js  Worker entry: routes POST /api/profile, /api/shelf and /api/explain, serves public/ for everything else
wrangler.jsonc   Worker config (name must match the Worker in the Cloudflare dashboard)
local/server.mjs  local server that uses your Claude plan via `claude -p`
server/          the logic the Worker and local server call
  anthropic.js   Claude Messages API client (plain fetch)
  prompt.js      the prompts: iterate here
  covers.js      catalogue verification + covers (Open Library, Google Books)
  handlers.js    pipeline: ask Claude, verify, attach covers
  http.js        auth (passcode), size limit, JSON in/out
test/            node:test unit tests (no network)
```

Your Goodreads CSV is parsed in the browser and kept in that browser's localStorage. It is never committed (`data/` and `*.csv` are git-ignored).

## Deploy (Cloudflare Workers)

Connected to GitHub through the Cloudflare dashboard (Workers Builds): every push to `main` deploys. The Worker is `next-read`.

Set two **secrets** on the Worker (dashboard: Settings -> Variables and Secrets, type Secret; or `npx wrangler secret put NAME`):

- `ANTHROPIC_API_KEY`: from the Claude Console (platform.claude.com/settings/keys)
- `APP_PASSCODE`: anything you like; you type it into the site once

**The API refuses to run until `APP_PASSCODE` is set.** Without that, anyone who found the URL could spend your Anthropic credits. To make the site private as well, put it behind Cloudflare Access; the passcode still applies on top.

Manual deploy: `npm install && npm run deploy`. The model defaults to `claude-sonnet-5-5`; set a `CLAUDE_MODEL` variable to change it.

## Run locally on your Claude plan (no API bill)

`local/server.mjs` serves the site and answers `/api/*` by running your signed-in Claude Code (`claude -p`), so usage is drawn from your Claude subscription instead of API billing. It listens on `127.0.0.1` only, so no passcode is needed. Covers and catalogue checks still work because they run from your own machine.

Needs Node 20+ and Claude Code installed and signed in (run `claude` once to log in).

```bash
git pull
npm run local        # http://localhost:8787
```

Notes: one request at a time; each call runs with tools disabled in an empty temp folder; set `CLAUDE_MODEL` (for example `sonnet`) to choose a model, `PORT` to change the port, `CLAUDE_BIN` if `claude` isn't on your PATH. Anthropic's rules for subscription use by scripts can change, so check them if this stops working.

## Run locally with the Cloudflare Worker (uses API credits)

Create `.dev.vars` (git-ignored):

```
ANTHROPIC_API_KEY=sk-ant-...
APP_PASSCODE=anything
```

then `npm run dev` and open the printed URL.

## How the site flows

1. **Import** your Goodreads CSV (parsed in the browser).
2. **Your taste**: the shop writes 8-12 statements describing your taste from your ratings, reviews and private notes. Edit, delete or add any of them.
3. **Your brief**: on the same screen, say which topics interest you and what you want your next read to be, plus optional quick nudges. This brief is sent with every shelf and question.
4. **Your shop**: themed shelves you scroll across. Reaching the end of a row stocks more books on it (up to 120 per shelf), and shelves further down the page are stocked as you reach them.
5. **Dive into a book**: click a cover for why it fits you, then ask follow-up questions about that book in the sheet.
6. **Refine**: write feedback ("less bleak") and press Restock; your pins, "not for me" reasons, chips and filters all count. "Edit my taste and brief" goes back to step 2 without losing the shop.

## How a run works (and how to tune it)

1. `/api/profile`: one call writes your taste profile as 8-12 short statements from the full library (reviews and private notes included; notes are weighted above star ratings). You can edit, delete or add statements, and every shelf follows them. Press **Re-read my library** after importing new notes.
2. `/api/shelf`, one call per shelf: the front table (6 picks mixing your to-read pile with new books), the to-read pile, then themed shelves (closest fit, books that argue back, a different voice, stretch, short and dense, long-haul reads, recent arrivals, wildcards). Each returns only title, author, year, a hook, fiction/non-fiction and approximate pages; every title is checked against Open Library / Google Books and given a cover. The first three shelves load on Build; the rest are stocked as you scroll, so you only spend usage on shelves you reach.
3. `/api/explain`: the full "why / links / themes / might not land" for one book, fetched when you click it and cached.

- `/api/ask`: the "Ask the shop" box. A free-form question ("does X fit my taste?") answered from your library, notes, taste statements, pins, dismissals and whatever is on the shelves right now, with the last few turns for follow-ups. It never changes the shelves.

Feedback loop and browsing:
- **Not for me** asks why (optional chips and free text). The reason is sent with every later shelf request, so the shop learns from rejections.
- **I've read this** takes a rating and a one-line note, updates your library (a to-read book moves to read) and marks the taste statements as stale.
- **More like this** opens a new shelf seeded from that book. **Show more like this** adds a fresh batch to a shelf without repeating anything shown; **Freshen the window** replaces the front table.
- Filters (type, length, era) hide books already on the shelves. Kind and page counts come from the model, so they are approximate; books with unknown values are never hidden.
- Re-importing a Goodreads CSV keeps your shop, picks, dismissals and statement edits, and keeps books you marked as read in the app.
- Each shelf holds at most one book per author, for variety.

Time is dominated by how many words Claude has to write, so shelf size is the main dial: edit `SHELVES` in `server/prompt.js` (`count` per shelf, or add and remove shelves; the page reads the list from `/api/config`). The local server logs how long each call and each `claude -p` run took. Set `CLAUDE_MODEL` (for example `haiku`) for faster, lighter calls. The page keeps at most three shelf requests in flight so the local server's limit of five is never hit.

## Missing a cover?

`npm run cover-debug -- "<title>" "<author>" [isbn]` shows every catalogue query for one book, what came back, and why each result was accepted or rejected. The server also logs a line for each lookup that finds no match or no cover image.

Covers are looked up by exact ISBN first (taken from your Goodreads export, so re-import the CSV after pulling this change), then by title and author with several variants (series suffix removed, accents folded, title only), in Open Library then Google Books. Brand-new or self-published books may simply not be in either; those keep the generated cover.

### Google Books rate limits (HTTP 429)

Without an API key Google Books limits requests per IP address and often refuses them. After a 429 the app stops asking that site for the time it says (default 60s) instead of retrying, and logs a line saying so. A free key gives a much higher limit: in Google Cloud Console enable the **Books API**, create an **API key**, then run `GOOGLE_BOOKS_API_KEY=your-key npm run local` (on Cloudflare, add it as a secret named `GOOGLE_BOOKS_API_KEY`). The key is only ever sent to Google and never printed by `cover-debug`.

### Set a cover by hand

Open any book and use **Set cover image**: paste an image address, or choose a file (it is shrunk and saved in your browser). Useful for new or self-published books that no free catalogue has. Stored per book in this browser; **Remove custom cover** puts the automatic one back.

## Tests

```bash
npm test
```

## Roadmap

- Compare view for the shortlist
- Richer "why": how different authors treat the same theme
- Two-pass picking: generate a larger pool, then choose and de-duplicate in a second call
- Ground obscure titles with a Google Books description before explaining them
- Cache catalogue lookups across sessions (today the cache lives in the server process)
- Streaming the response so long runs can't hit a gateway timeout
