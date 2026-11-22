# Next Read

A bespoke bookshop built from your Goodreads library. Import your export, get a taste profile you can edit, then browse shelves of recommendations as cover tiles. Click a book for *why* it was picked (which of your books it connects to, and where it may not land). Pin, dismiss and steer to refine.

Recommendations link on underlying ideas and narrative voice rather than genre or popularity. Every pick is checked against Open Library / Google Books, and anything that can't be found is dropped, which guards against invented titles. Covers come from the same lookup.

## Layout

```
public/      static front end (no build step)
functions/   Firebase Cloud Function `api`: /api/profile and /api/recommend
  lib/anthropic.js  Claude Messages API client (plain fetch, no SDK)
  lib/prompt.js     the prompts: iterate here
  lib/covers.js     catalogue verification + covers
  lib/handlers.js   pipeline: ask Claude, verify, attach covers
test/        node:test unit tests (no network)
```

Your Goodreads CSV is parsed in the browser and stored in that browser's localStorage. It is never committed (`data/` and `*.csv` are git-ignored).

## Setup and deploy (Firebase)

Needs the Blaze plan (Cloud Functions make outbound calls).

```bash
npm i -g firebase-tools
firebase login
firebase use --add                       # pick your project
cd functions && npm install && cd ..
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set APP_PASSCODE   # anything; stops strangers using your API credits
firebase deploy
```

Open the site, enter the passcode when asked, import your CSV, press **Build my shop**.

The function region is `europe-west2` (set in `firebase.json` and `functions/index.js`; change both together). The model defaults to `claude-sonnet-5-5`; override with the `CLAUDE_MODEL` environment variable.

## Tests

```bash
node --test test/handlers.test.js
```

## Roadmap

- Compare view for the shortlist
- Richer "why": how different authors treat the same theme
- Cache lookups so refreshes are quicker and cheaper
- Optional: per-user accounts instead of a shared passcode
