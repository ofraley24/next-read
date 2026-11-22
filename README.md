# Next Read

A bespoke bookshop built from your Goodreads library. Import your export, get a taste profile you can edit, then browse shelves of recommendations as cover tiles. Click a book for *why* it was picked (which of your books it connects to, and where it may not land). Pin, dismiss and steer to refine.

Recommendations link on underlying ideas and narrative voice rather than genre or popularity. Every pick is checked against Open Library / Google Books, and anything that can't be found is dropped, which guards against invented titles. Covers come from the same lookup.

Hosted the same way as xfpl-web: Cloudflare Pages, direct upload with wrangler.

## Layout

```
public/          static front end (no build step)
functions/api/   Cloudflare Pages Functions: POST /api/profile, POST /api/recommend
server/          the logic they call
  anthropic.js   Claude Messages API client (plain fetch)
  prompt.js      the prompts: iterate here
  covers.js      catalogue verification + covers (Open Library, Google Books)
  handlers.js    pipeline: ask Claude, verify, attach covers
  http.js        auth (passcode), size limit, JSON in/out
test/            node:test unit tests (no network)
```

Your Goodreads CSV is parsed in the browser and kept in that browser's localStorage. It is never committed (`data/` and `*.csv` are git-ignored).

## Deploy (Cloudflare Pages)

```bash
npm install
npx wrangler login                                                    # once, if not already logged in
npx wrangler pages project create next-read --production-branch main  # once
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name next-read
npx wrangler pages secret put APP_PASSCODE --project-name next-read   # anything you like; you type it into the site
npm run deploy
```

Site: `https://next-read.pages.dev` (override the project name by editing the `deploy` script).

**The API refuses to run until `APP_PASSCODE` is set.** Without that, anyone who found the URL could spend your Anthropic credits. To make the site private as well, add a Cloudflare Access application for the `*.pages.dev` hostname, as for xfpl; the passcode still applies on top.

The model defaults to `claude-sonnet-5-5`; set a `CLAUDE_MODEL` secret/variable to change it.

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
