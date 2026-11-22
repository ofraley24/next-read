import { claude, parseJSON } from './anthropic.js';
import { profilePrompt, shelfPrompt, explainPrompt, SHELVES } from './prompt.js';
import { lookup, norm } from './covers.js';

export const key = b => `${norm(b.title)}|${norm(b.author)}`;
const badRequest = msg => Object.assign(new Error(msg), { status: 400 });

// ctx: { apiKey, model, claude?, lookup? }  (claude/lookup are injectable for tests)
export async function profile({ library }, ctx = {}) {
  if (!Array.isArray(library) || !library.length) throw badRequest('library is required');
  const ask = ctx.claude || claude;
  const text = await ask({ apiKey: ctx.apiKey, model: ctx.model, prompt: profilePrompt(library), maxTokens: 700 });
  return { profile: text.trim() };
}

// Runs async fn over items with limited concurrency.
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// One shelf of picks: short fields only (title, author, year, pitch), verified and given covers.
export async function shelf(body, ctx = {}) {
  const { library } = body;
  const idx = Number(body.shelf);
  if (!Array.isArray(library) || !library.length) throw badRequest('library is required');
  if (!Number.isInteger(idx) || idx < 0 || idx >= SHELVES.length) throw badRequest('unknown shelf');
  const spec = SHELVES[idx];
  const ask = ctx.claude || claude, find = ctx.lookup || lookup;

  const books = parseJSON(await ask({ apiKey: ctx.apiKey, model: ctx.model, prompt: shelfPrompt(body, idx), maxTokens: 2500 }));
  if (!Array.isArray(books)) throw new Error('Model returned an unexpected shape');

  const owned = new Set(library.map(key));
  const toRead = new Set(library.filter(b => b.shelf === 'to-read').map(key));
  const isbns = new Map(library.filter(b => b.isbn).map(b => [key(b), b.isbn]));   // exact-edition lookups for books already in the library
  const dismissed = new Set(body.dismissedKeys || []);
  const seen = new Set();
  let dropped = 0;

  const checked = await pool(books.filter(b => b && b.title && b.author).slice(0, spec.count + 2), 6, async b => {
    const k = key(b);
    if (dismissed.has(k) || seen.has(k)) return null;
    seen.add(k);
    if (spec.fromToRead && !toRead.has(k)) { dropped++; return null; }    // must really be on their list
    if (!spec.fromToRead && owned.has(k)) { dropped++; return null; }     // never re-suggest owned books
    const info = await find(b.title, b.author, { isbn: isbns.get(k), googleKey: ctx.googleKey });
    if (!spec.fromToRead && !info.verified) { dropped++; return null; }   // not in any catalogue: likely invented
    return { title: b.title, author: b.author, year: b.year, pitch: b.pitch, cover: info.cover || null, coverSource: info.source };
  });
  const result = checked.filter(Boolean);
  // One more try for any book that has no cover yet (a miss is never cached, so this really asks again).
  await pool(result.filter(b => !b.cover), 2, async b => {
    const again = await find(b.title, b.author, { isbn: isbns.get(key(b)), googleKey: ctx.googleKey });
    if (again.cover) { b.cover = again.cover; b.coverSource = again.source; }
  });
  return { shelf: spec.title, blurb: spec.blurb, books: result, dropped };
}

// The long explanation for one book, fetched when you click it.
export async function explain(body, ctx = {}) {
  const { library, book } = body;
  if (!Array.isArray(library) || !library.length) throw badRequest('library is required');
  if (!book || !book.title || !book.author) throw badRequest('book is required');
  const ask = ctx.claude || claude;
  const out = parseJSON(await ask({ apiKey: ctx.apiKey, model: ctx.model, prompt: explainPrompt(body), maxTokens: 700 }));
  const titles = new Set(library.map(b => norm(b.title)));
  return {
    why: String(out.why || ''),
    links: (out.links || []).filter(l => titles.has(norm(l))),     // only books that really are in the library
    themes: (out.themes || []).slice(0, 4).map(String),
    caution: String(out.caution || ''),
  };
}
