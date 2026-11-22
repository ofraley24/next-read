# Next Read

A bespoke bookshop built from your Goodreads library. Import your export, get a taste profile you can edit, then browse shelves of recommendations as cover tiles. Click a book for *why* it was picked (which of your books it connects to, and where it may not land). Pin, dismiss and steer to refine.

Recommendations link on underlying ideas and narrative voice rather than genre or popularity. Every pick is checked against Open Library / Google Books, and anything that can't be found is dropped, which guards against invented titles. Covers come from the same lookup.

Runs on Cloudflare Workers (static assets + a small API).

## Layout

```
public/          static front end (no build step)
worker/index.js  Worker entry: routes POST /api/profile and /api/recommend, serves public/ for everything else
wrangler.jsonc   Worker config (name must match the Worker in the Cloudflare dashboard)
server/          the logic the Worker calls
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

## Run locally

Create `.dev.vars` (git-ignored):

```
ANTHROPIC_API_KEY=sk-ant-...
APP_PASSCODE=anything
```

then `npm run dev` and open the printed URL.

## Tests

```bash
npm test
```

## Roadmap

- Compare view for the shortlist
- Richer "why": how different authors treat the same theme
- Cache lookups so refreshes are quicker and cheaper
- Streaming the response so long runs can't hit a gateway timeout
