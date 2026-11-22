import test from 'node:test';
import assert from 'node:assert';
import { lookup, cleanTitle } from '../server/covers.js';

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const noWait = { sleep: async () => {}, get breaker() { return new Map(); } };   // fresh 429-pause list per lookup, so tests can't affect each other
const quiet = fn => async () => { const w = console.warn; console.warn = () => {}; try { await fn(); } finally { console.warn = w; } };
const ol = (title, author, cover_i) => ({ docs: [{ title, author_name: [author], cover_i }] });

test('cleanTitle drops series suffixes', () => {
  assert.strictEqual(cleanTitle('Children of Ruin (Children of Time, #2)'), 'Children of Ruin');
});

test('series suffix is not sent to the catalogue and the cover is found', quiet(async () => {
  const urls = [];
  const fetchImpl = async u => { urls.push(u); return res(200, ol('Children of Ruin', 'Adrian Tchaikovsky', 123)); };
  const out = await lookup('Children of Ruin (Children of Time, #2)', 'Adrian Tchaikovsky', { fetchImpl, ...noWait });
  assert.strictEqual(out.cover, 'https://covers.openlibrary.org/b/id/123-M.jpg?default=false');
  assert.ok(!urls[0].includes('%23') && !urls[0].includes('%2C+%23') && !decodeURIComponent(urls[0]).includes('Children of Time'));
}));

test('server errors and timeouts are retried, not treated as "no cover"', quiet(async () => {
  let n = 0;
  const fetchImpl = async () => (++n < 3 ? res(n === 1 ? 500 : 503, {}) : res(200, ol('Retry Book', 'Some Author', 7)));
  const out = await lookup('Retry Book', 'Some Author', { fetchImpl, ...noWait });
  assert.strictEqual(n, 3);
  assert.strictEqual(out.source, 'openlibrary');
  assert.ok(out.cover);
}));

test('falls back to Google Books (https thumbnail) when Open Library has nothing', quiet(async () => {
  const fetchImpl = async u => u.includes('openlibrary')
    ? res(200, { docs: [] })
    : res(200, { items: [{ volumeInfo: { title: 'Fallback Book', authors: ['Jo Writer'], imageLinks: { thumbnail: 'http://books.google.com/x.jpg' } } }] });
  const out = await lookup('Fallback Book', 'Jo Writer', { fetchImpl, ...noWait });
  assert.deepStrictEqual(out, { verified: true, cover: 'https://books.google.com/x.jpg', source: 'googlebooks' });
}));

test('uses the looser query when the strict one finds nothing', quiet(async () => {
  let calls = 0;
  const fetchImpl = async u => { calls++; return u.includes('q=') ? res(200, ol('Loose Book', 'Ann Author', 9)) : res(200, { docs: [] }); };
  const out = await lookup('Loose Book', 'Ann Author', { fetchImpl, ...noWait });
  assert.ok(out.cover); assert.strictEqual(calls, 2);
}));

test('successful lookups are cached; failures are not', quiet(async () => {
  let n = 0;
  const good = async () => { n++; return res(200, ol('Cached Book', 'Cee Author', 5)); };
  await lookup('Cached Book', 'Cee Author', { fetchImpl: good, ...noWait });
  await lookup('Cached Book', 'Cee Author', { fetchImpl: good, ...noWait });
  assert.strictEqual(n, 1);
  const bad = async () => res(200, { docs: [], items: [] });
  const miss = await lookup('Nonexistent Zzz', 'Nobody Q', { fetchImpl: bad, ...noWait });
  assert.deepStrictEqual(miss, { verified: false, cover: null, source: null });
}));

test('gives up after three tries and reports not verified', quiet(async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return res(503, {}); };
  const out = await lookup('Throttled Book', 'Tee Author', { fetchImpl, ...noWait });
  assert.strictEqual(out.verified, false);
  assert.ok(n >= 3);
}));

test('never more than 5 catalogue requests in flight at once', quiet(async () => {
  let active = 0, peak = 0;
  const fetchImpl = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 20)); active--; return res(200, { docs: [], items: [] }); };
  await Promise.all(Array.from({ length: 12 }, (_, i) => lookup(`Many ${i}`, 'Em Author', { fetchImpl, ...noWait })));
  assert.ok(peak <= 5 && peak > 1, `peak was ${peak}`);
}));

test('time spent waiting in the queue does not count against a request\'s timeout', quiet(async () => {
  // 10 lookups, each fetch takes 40ms, timeout is 60ms, 5 slots: later ones queue for ~40-80ms.
  // Before the fix the clock started at enqueue, so queued requests were aborted before they ran.
  const fetchImpl = (u, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const t = setTimeout(() => resolve(res(200, { docs: [{ title: decodeURIComponent(new URL(u).searchParams.get('title') || '').replace(/\+/g, ' '), author_name: ['Q Author'], cover_i: 1 }] })), 40);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  });
  const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => lookup(`Queued ${i}`, 'Q Author', { fetchImpl: (u, o) => fetchImpl(u, o), timeoutMs: 60, tries: 1, ...noWait })));
  assert.ok(outs.every(o => o.cover), `missing covers: ${outs.filter(o => !o.cover).length}`);
}));

import { diagnose } from '../server/covers.js';

test('exact ISBN is tried first and accepted even when the catalogue title differs (new/self-published books)', quiet(async () => {
  const urls = [];
  const fetchImpl = async u => { urls.push(u); return u.includes('isbn=') ? res(200, ol('The Farthest Reaches (paperback)', 'B. Hall', 42)) : res(200, { docs: [] }); };
  const out = await lookup('The Farthest Reaches: Why People Are the Most Important Entities in the Universe', 'Brett Hall', { isbn: '="9798994621219"', fetchImpl, ...noWait });
  assert.ok(out.cover.includes('/id/42-'));
  assert.ok(urls[0].includes('isbn=9798994621219'), urls[0]);   // ISBN digits only, first query
  assert.strictEqual(urls.length, 1);
}));

test('accented author names: queries use the folded name and match either spelling', quiet(async () => {
  const urls = [];
  // the catalogue stores "Benjamin Labatut" (no accent); the strict query finds nothing, the folded one does
  const fetchImpl = async u => { urls.push(u); return u.includes('q=') ? res(200, ol('When We Cease to Understand the World', 'Benjamin Labatut', 77)) : res(200, { docs: [] }); };
  const out = await lookup('When We Cease to Understand the World', 'Benjamín Labatut', { fetchImpl, ...noWait });
  assert.ok(out.cover);
  assert.ok(urls.some(u => u.includes('Benjamin+Labatut')), urls.join('\n'));
  // and the reverse: catalogue has the accent, reader's CSV does not
  const out2 = await lookup('When We Cease To Understand The World!', 'Benjamin Labatut', { fetchImpl: async () => res(200, ol('When We Cease to Understand the World', 'Benjamín Labatut', 78)), ...noWait });
  assert.ok(out2.cover);
}));

test('title-only query finds the book when the author is formatted unexpectedly', quiet(async () => {
  const fetchImpl = async u => (u.includes('author=') || u.includes('q=') || u.includes('googleapis')) ? res(200, { docs: [], items: [] }) : res(200, ol('Odd Author Book', 'Dr. J. R. R. Odd-Author', 3));
  const out = await lookup('Odd Author Book', 'Odd-Author', { fetchImpl, ...noWait });
  assert.ok(out.cover);
}));

test('diagnose explains every query and what matched', async () => {
  const fetchImpl = async u => u.includes('googleapis') ? res(500, {}) : res(200, ol('Some Book', 'Wrong Person', null));
  const text = await diagnose('Some Book', 'Ann Author', '9780000000002', { fetchImpl });
  assert.match(text, /\[openlibrary, by ISBN\]/);
  assert.match(text, /HTTP 500/);
  assert.match(text, /title:match  author:no  cover:NO/);
  assert.match(text, /=> 0 accepted/);
});


test('after a 429 the host is left alone (no retries, no further queries) and the other source still works', quiet(async () => {
  const breaker = new Map();   // shared across lookups, like the real process
  const hits = { google: 0, ol: 0 };
  const fetchImpl = async u => {
    if (u.includes('googleapis')) { hits.google++; return res(429, {}); }
    hits.ol++; return res(200, { docs: [] });
  };
  const a = await lookup('Rate Limited One', 'Ann Author', { fetchImpl, sleep: async () => {}, breaker });
  const googleAfterFirst = hits.google;
  assert.strictEqual(googleAfterFirst, 1, 'one 429 only: no retries');
  assert.strictEqual(a.verified, false);
  await lookup('Rate Limited Two', 'Bea Author', { fetchImpl, sleep: async () => {}, breaker });
  await lookup('Rate Limited Three', 'Cee Author', { fetchImpl, sleep: async () => {}, breaker });
  assert.strictEqual(hits.google, googleAfterFirst, 'Google is not asked again while paused');
  assert.ok(hits.ol > 3, 'Open Library keeps being asked');
}));

test('Retry-After sets how long the host is paused, and the pause ends', quiet(async () => {
  const breaker = new Map();
  let google = 0;
  const fetchImpl = async u => u.includes('googleapis') ? (google++, { ok: false, status: 429, headers: { get: () => '30' }, json: async () => ({}) }) : res(200, { docs: [] });
  const before = Date.now();
  await lookup('Pause One', 'Dee Author', { fetchImpl, sleep: async () => {}, breaker });
  const until = breaker.get('www.googleapis.com');
  assert.ok(until - before >= 29_000 && until - before <= 31_500, `paused for ${(until - before) / 1000}s`);
  breaker.set('www.googleapis.com', Date.now() - 1);   // pause over
  await lookup('Pause Two', 'Eee Author', { fetchImpl, sleep: async () => {}, breaker });
  assert.strictEqual(google, 2);
}));

test('Google Books API key is added to Google requests, and never shown in diagnose output', quiet(async () => {
  const urls = [];
  const fetchImpl = async u => { urls.push(u); return res(200, { docs: [], items: [] }); };
  await lookup('Keyed Book', 'Fay Author', { fetchImpl, googleKey: 'SECRET123', ...noWait });
  const g = urls.filter(u => u.includes('googleapis'));
  assert.ok(g.length > 0 && g.every(u => u.includes('&key=SECRET123')));
  assert.ok(!urls.filter(u => u.includes('openlibrary')).some(u => u.includes('SECRET123')), 'key must not go to other hosts');
  const text = await diagnose('Keyed Book', 'Fay Author', undefined, { fetchImpl, googleKey: 'SECRET123' });
  assert.ok(!text.includes('SECRET123'));
}));
