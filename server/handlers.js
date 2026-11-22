import { claude, parseJSON } from './anthropic.js';
import { profilePrompt, recommendPrompt } from './prompt.js';
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

export async function recommend(body, ctx = {}) {
  const { library, profile: prof = '' } = body;
  if (!Array.isArray(library) || !library.length) throw badRequest('library is required');
  const ask = ctx.claude || claude, find = ctx.lookup || lookup;

  const reply = await ask({ apiKey: ctx.apiKey, model: ctx.model, prompt: recommendPrompt({ ...body, profile: prof }), maxTokens: 7000 });
  const shelves = parseJSON(reply);
  if (!Array.isArray(shelves)) throw new Error('Model returned an unexpected shape');

  const owned = new Set(library.map(key));
  const toRead = new Set(library.filter(b => b.shelf === 'to-read').map(key));
  const dismissed = new Set(body.dismissedKeys || []);
  let dropped = 0;

  const out = await Promise.all(shelves.map(async (s, idx) => {
    const books = (s.books || []).filter(b => b && b.title && b.author);
    const checked = await pool(books, 6, async b => {
      const k = key(b);
      if (dismissed.has(k)) return null;
      const fromToRead = idx === 0;
      if (fromToRead && !toRead.has(k)) { dropped++; return null; }   // must really be on their list
      if (!fromToRead && owned.has(k)) { dropped++; return null; }    // never re-suggest owned books
      const info = await find(b.title, b.author);
      if (!fromToRead && !info.verified) { dropped++; return null; }  // not in any catalogue: likely invented
      return { ...b, cover: info.cover || null, coverSource: info.source };
    });
    return { shelf: s.shelf, blurb: s.blurb, books: checked.filter(Boolean) };
  }));
  return { shelves: out, dropped };
}
