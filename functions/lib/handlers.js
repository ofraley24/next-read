'use strict';
const { claude, parseJSON } = require('./anthropic');
const { profilePrompt, recommendPrompt } = require('./prompt');
const { lookup, norm } = require('./covers');

const key = b => `${norm(b.title)}|${norm(b.author)}`;

async function profile({ library }) {
  if (!Array.isArray(library) || !library.length) throw badRequest('library is required');
  return { profile: (await claude({ prompt: profilePrompt(library), maxTokens: 700 })).trim() };
}

// Runs async fn over items with limited concurrency.
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function recommend(body, deps = {}) {
  const { library, profile: prof = '' } = body;
  if (!Array.isArray(library) || !library.length) throw badRequest('library is required');
  const ask = deps.claude || claude, find = deps.lookup || lookup;

  const reply = await ask({ prompt: recommendPrompt({ ...body, profile: prof }), maxTokens: 9000 });
  const shelves = parseJSON(reply);
  if (!Array.isArray(shelves)) throw new Error('Model returned an unexpected shape');

  const owned = new Set(library.map(b => key(b)));
  const toRead = new Set(library.filter(b => b.shelf === 'to-read').map(b => key(b)));
  const dismissed = new Set((body.dismissedKeys || []));
  let dropped = 0;

  const out = await Promise.all(shelves.map(async (s, idx) => {
    const books = (s.books || []).filter(b => b && b.title && b.author);
    const checked = await pool(books, 6, async b => {
      const k = key(b);
      if (dismissed.has(k)) return null;
      const fromToRead = idx === 0;
      if (fromToRead && !toRead.has(k)) { dropped++; return null; }          // must really be on their list
      if (!fromToRead && owned.has(k)) { dropped++; return null; }           // never re-suggest owned books
      const info = await find(b.title, b.author);
      if (!fromToRead && !info.verified) { dropped++; return null; }         // not in any catalogue: likely invented
      return { ...b, cover: info.cover || null, coverSource: info.source };
    });
    return { shelf: s.shelf, blurb: s.blurb, books: checked.filter(Boolean) };
  }));
  return { shelves: out, dropped };
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

module.exports = { profile, recommend, key };
