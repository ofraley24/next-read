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

## How a run works (and how to tune it)

1. `/api/profile`: one call writes your taste profile from the full library (reviews and private notes included). Cached in the page; edit it freely.
2. `/api/shelf` x4, in parallel: each shelf returns only title, author, year and a one-line hook, then every title is checked against Open Library / Google Books and given a cover. Shelves appear as they finish.
3. `/api/explain`: the full "why / links / themes / might not land" for one book, fetched when you click it and cached.

Time is dominated by how many words Claude has to write, so shelf size is the main dial: edit `SHELVES` in `server/prompt.js` (`count` per shelf). The local server logs how long each call and each `claude -p` run took. Set `CLAUDE_MODEL` (for example `haiku`) for faster, lighter calls.

## Tests

```bash
npm test
```

## Roadmap

- Compare view for the shortlist
- Richer "why": how different authors treat the same theme
- Cache lookups so refreshes are quicker and cheaper
- Streaming the response so long runs can't hit a gateway timeout
