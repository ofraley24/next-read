import test from 'node:test';
import assert from 'node:assert';
import { lookup, cleanTitle } from '../server/covers.js';

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const noWait = { sleep: async () => {} };
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

test('throttling (429) and server errors are retried, not treated as "no cover"', quiet(async () => {
  let n = 0;
  const fetchImpl = async () => (++n < 3 ? res(n === 1 ? 429 : 503, {}) : res(200, ol('Retry Book', 'Some Author', 7)));
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
  const fetchImpl = async () => { n++; return res(429, {}); };
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
