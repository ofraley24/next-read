import test from 'node:test';
import assert from 'node:assert';
import { titleMatches, authorMatches } from '../server/covers.js';
import { shelf, explain, profile } from '../server/handlers.js';
import { SHELVES, shelfPrompt, profilePrompt, libraryText } from '../server/prompt.js';
import { parseJSON } from '../server/anthropic.js';
import { handle } from '../server/http.js';

test('title matching tolerates subtitles, series suffixes and accents', () => {
  assert.ok(titleMatches('Children of Time', 'Children of Time (Children of Time, #1)'));
  assert.ok(titleMatches('The Dispossessed: An Ambiguous Utopia', 'The Dispossessed'));
  assert.ok(titleMatches('Exhalation', 'Exhalation: Stories'));
  assert.ok(!titleMatches('Anathem', 'Snow Crash'));
});

test('author matching uses surname', () => {
  assert.ok(authorMatches('Iain M. Banks', ['Iain Banks']));
  assert.ok(authorMatches('Ursula K. Le Guin', ['Ursula K. Le Guin']));
  assert.ok(!authorMatches('Greg Egan', ['Neal Stephenson']));
});

test('parseJSON survives fences and chatter', () => {
  assert.deepStrictEqual(parseJSON('Sure!\n```json\n[{"a":1}]\n```\nHope that helps'), [{ a: 1 }]);
});

const library = [
  { title: 'Excession', author: 'Iain M. Banks', shelf: 'read', rating: 5 },
  { title: 'Anathem', author: 'Neal Stephenson', shelf: 'to-read', rating: 0 },
  { title: 'Foundation', author: 'Isaac Asimov', shelf: 'to-read', rating: 0 },
];
const bk = (title, author) => ({ title, author, year: '2000', pitch: 'p' });
const okLookup = async title => title === 'Totally Fake Book'
  ? { verified: false, cover: null, source: null }
  : { verified: true, cover: `https://example.test/${encodeURIComponent(title)}.jpg`, source: 'test' };

test('the to-read shelf only keeps books on the reader\'s list', async () => {
  const reply = JSON.stringify([bk('Anathem', 'Neal Stephenson'), bk('Not On My List', 'Someone'), bk('Foundation', 'Isaac Asimov')]);
  const out = await shelf({ library, profile: 'x', shelf: 1 }, { claude: async () => reply, lookup: okLookup });
  assert.strictEqual(out.shelf, 'From your to-read pile');
  assert.deepStrictEqual(out.books.map(x => x.title), ['Anathem', 'Foundation']);
  assert.strictEqual(out.dropped, 1);
  assert.ok(out.books[0].cover.includes('Anathem'));
});

test('other shelves drop invented, owned, duplicate and dismissed books, and attach covers', async () => {
  const reply = JSON.stringify([bk('Diaspora', 'Greg Egan'), bk('Totally Fake Book', 'Nobody Real'), bk('Excession', 'Iain M. Banks'),
    bk('Anathem', 'Neal Stephenson'), bk('Diaspora', 'Greg Egan'), bk('Exhalation', 'Ted Chiang')]);
  const dismissedKeys = ['exhalation|ted chiang'];
  const out = await shelf({ library, profile: 'x', shelf: 2, dismissedKeys }, { claude: async () => reply, lookup: okLookup });
  assert.deepStrictEqual(out.books.map(x => x.title), ['Diaspora']);   // fake, owned (read + to-read), duplicate and dismissed all removed
  assert.strictEqual(out.books[0].cover, 'https://example.test/Diaspora.jpg');
  assert.strictEqual(out.dropped, 3);
});

test('shelf output stays short: only title, author, year, pitch, cover', async () => {
  const noisy = JSON.stringify([{ ...bk('Diaspora', 'Greg Egan'), why: 'long text', links: ['x'] }]);
  const out = await shelf({ library, profile: 'x', shelf: 3 }, { claude: async () => noisy, lookup: okLookup });
  assert.deepStrictEqual(Object.keys(out.books[0]).sort(), ['author', 'cover', 'coverSource', 'kind', 'pages', 'pitch', 'title', 'year']);
});

test('shelf rejects bad input', async () => {
  await assert.rejects(() => shelf({ library: [], shelf: 1 }, { claude: async () => '[]' }), /library is required/);
  await assert.rejects(() => shelf({ library, shelf: 99 }, { claude: async () => '[]' }), /unknown shelf/);
  await assert.rejects(() => profile({ library: [] }, { claude: async () => 'x' }), /library is required/);
});

test('explain keeps only links to books really in the library', async () => {
  const reply = JSON.stringify({ why: 'Because.', links: ['Excession', 'A Book You Never Read'], themes: ['a', 'b'], caution: 'Slow start.' });
  const out = await explain({ library, profile: 'x', book: { title: 'Diaspora', author: 'Greg Egan' } }, { claude: async () => reply });
  assert.deepStrictEqual(out, { why: 'Because.', links: ['Excession'], themes: ['a', 'b'], caution: 'Slow start.' });
  await assert.rejects(() => explain({ library, book: {} }, { claude: async () => '{}' }), /book is required/);
});

const req = (headers = {}, body = '{"library":[1]}') => new Request('https://x.test/api/profile', { method: 'POST', headers, body });
const env = { APP_PASSCODE: 'pw', ANTHROPIC_API_KEY: 'k' };

test('http wrapper fails closed and checks the passcode', async () => {
  const ok = async b => ({ got: b });
  assert.strictEqual((await handle({ request: req(), env: { ANTHROPIC_API_KEY: 'k' } }, ok)).status, 503);   // no passcode configured
  assert.strictEqual((await handle({ request: req(), env: { APP_PASSCODE: 'pw' } }, ok)).status, 503);        // no API key configured
  assert.strictEqual((await handle({ request: req({ 'x-passcode': 'nope' }), env }, ok)).status, 401);
  assert.strictEqual((await handle({ request: req({ 'x-passcode': 'pw' }, 'not json'), env }, ok)).status, 400);
  const good = await handle({ request: req({ 'x-passcode': 'pw' }), env }, ok);
  assert.strictEqual(good.status, 200);
  assert.deepStrictEqual(await good.json(), { got: { library: [1] } });
  const bad = await handle({ request: req({ 'x-passcode': 'pw' }), env }, async () => { throw Object.assign(new Error('boom'), { status: 400 }); });
  assert.strictEqual(bad.status, 400);
});

import worker from '../worker/index.js';

test('worker routes /api/*, rejects other methods, and serves assets for everything else', async () => {
  const assets = { fetch: async r => new Response('asset:' + new URL(r.url).pathname) };
  const e = { ASSETS: assets };                                  // no secrets configured -> API fails closed
  const call = (path, method = 'POST') => worker.fetch(new Request('https://x.test' + path, { method, body: method === 'POST' ? '{}' : undefined }), e);
  assert.strictEqual((await call('/api/profile')).status, 503);
  assert.strictEqual((await call('/api/shelf')).status, 503);
  assert.strictEqual((await call('/api/explain')).status, 503);
  assert.strictEqual((await call('/api/recommend')).status, 404);
  assert.strictEqual((await call('/api/profile', 'GET')).status, 405);
  assert.strictEqual((await call('/api/nope')).status, 404);
  assert.strictEqual(await (await call('/', 'GET')).text(), 'asset:/');
  assert.strictEqual(await (await call('/app.js', 'GET')).text(), 'asset:/app.js');
});

test('shelf retries once for books that came back without a cover', async () => {
  const calls = {};
  const lookup = async title => { calls[title] = (calls[title] || 0) + 1; return calls[title] === 1 ? { verified: true, cover: null, source: 'x' } : { verified: true, cover: 'https://example.test/late.jpg', source: 'x' }; };
  const out = await shelf({ library, profile: 'x', shelf: 1 }, { claude: async () => JSON.stringify([bk('Anathem', 'Neal Stephenson')]), lookup });
  assert.strictEqual(out.books[0].cover, 'https://example.test/late.jpg');
  assert.strictEqual(calls.Anathem, 2);
});

test('shelf passes the ISBN from the reader\'s own library to the cover lookup', async () => {
  const lib = [{ title: 'The Farthest Reaches', author: 'Brett Hall', shelf: 'to-read', rating: 0, isbn: '9798994621219' }, { title: 'Excession', author: 'Iain M. Banks', shelf: 'read', rating: 5 }];
  const seen = [];
  const lookup = async (title, author, opts) => { seen.push([title, opts && opts.isbn]); return { verified: true, cover: 'https://example.test/c.jpg', source: 'x' }; };
  await shelf({ library: lib, profile: 'x', shelf: 1 }, { claude: async () => JSON.stringify([bk('The Farthest Reaches', 'Brett Hall')]), lookup });
  assert.deepStrictEqual(seen, [['The Farthest Reaches', '9798994621219']]);
});

test('shelf list: front table first, to-read second, every shelf has a title, blurb and count', () => {
  assert.strictEqual(SHELVES[0].title, 'On the front table');
  assert.strictEqual(SHELVES[1].fromToRead, true);
  assert.ok(SHELVES.length >= 8);
  for (const s of SHELVES) assert.ok(s.title && s.blurb && s.count > 0 && s.rule);
});

test('front table may mix to-read books with new verified books, but never other owned books', async () => {
  const reply = JSON.stringify([bk('Anathem', 'Neal Stephenson'), bk('Diaspora', 'Greg Egan'), bk('Excession', 'Iain M. Banks'), bk('Totally Fake Book', 'Nobody Real')]);
  const out = await shelf({ library, profile: 'x', shelf: 0 }, { claude: async () => reply, lookup: okLookup });
  assert.deepStrictEqual(out.books.map(b => b.title), ['Anathem', 'Diaspora']);
});

test('"show more": excluded books are never returned again and are listed in the prompt', async () => {
  let prompt = '';
  const reply = JSON.stringify([bk('Diaspora', 'Greg Egan'), bk('Exhalation', 'Ted Chiang')]);
  const out = await shelf({ library, profile: 'x', shelf: 2, exclude: [{ title: 'Diaspora', author: 'Greg Egan' }] }, { claude: async ({ prompt: p }) => { prompt = p; return reply; }, lookup: okLookup });
  assert.deepStrictEqual(out.books.map(b => b.title), ['Exhalation']);
  assert.match(prompt, /ALREADY SHOWN, do not repeat: Diaspora — Greg Egan/);
});

test('new-book shelves keep one book per author; the to-read shelf may repeat an author', async () => {
  const two = JSON.stringify([bk('Diaspora', 'Greg Egan'), bk('Permutation City', 'Greg Egan'), bk('Exhalation', 'Ted Chiang')]);
  const out = await shelf({ library, profile: 'x', shelf: 2 }, { claude: async () => two, lookup: okLookup });
  assert.deepStrictEqual(out.books.map(b => b.title), ['Diaspora', 'Exhalation']);
  const lib2 = [...library, { title: 'Baptism of Fire', author: 'Isaac Asimov', shelf: 'to-read', rating: 0 }];
  const tr = await shelf({ library: lib2, profile: 'x', shelf: 1 }, { claude: async () => JSON.stringify([bk('Foundation', 'Isaac Asimov'), bk('Baptism of Fire', 'Isaac Asimov')]), lookup: okLookup });
  assert.strictEqual(tr.books.length, 2);
});

test('kind and pages are normalised; junk becomes null', async () => {
  const reply = JSON.stringify([{ ...bk('Diaspora', 'Greg Egan'), kind: 'Fiction', pages: '320' }, { ...bk('Exhalation', 'Ted Chiang'), kind: 'essay', pages: 0 }, { ...bk('Anathem2', 'Someone'), kind: 'non-fiction', pages: 999999 }]);
  const out = await shelf({ library, profile: 'x', shelf: 2 }, { claude: async () => reply, lookup: okLookup });
  assert.deepStrictEqual(out.books.map(b => [b.kind, b.pages]), [['fiction', 320], [null, null], ['non-fiction', null]]);
});

test('"more like this" builds a seeded shelf and validates the seed', async () => {
  let prompt = '';
  const out = await shelf({ library, profile: 'x', seed: { title: 'Excession', author: 'Iain M. Banks' } }, { claude: async ({ prompt: p }) => { prompt = p; return JSON.stringify([bk('Diaspora', 'Greg Egan')]); }, lookup: okLookup });
  assert.strictEqual(out.shelf, 'More like Excession');
  assert.match(prompt, /closest to "Excession" by Iain M\. Banks/);
  assert.strictEqual(out.books.length, 1);
  await assert.rejects(() => shelf({ library, seed: { title: 'x' } }, { claude: async () => '[]' }), /seed needs/);
});

test('dismiss reasons and pinned picks reach the prompt; notes reach the library text', () => {
  const p = shelfPrompt({ library: [{ title: 'A', author: 'B', shelf: 'read', rating: 5, notes: 'loved the narrator' }], profile: '- You like ideas', pinned: ['P — Q'], dismissed: ['Foo — Bar (reason: too long)'] }, SHELVES[2]);
  assert.match(p, /DISMISSED[^\n]*: Foo — Bar \(reason: too long\)/);
  assert.match(p, /PINNED[^\n]*: P — Q/);
  assert.match(p, /NOTE: loved the narrator/);
  assert.match(libraryText([{ title: 'A', author: 'B', shelf: 'read', rating: 5, notes: 'n1', review: 'r1' }], true), /MY NOTES: n1/);
});

test('recent shelf asks for the right window and the profile prompt asks for statements', () => {
  const recent = SHELVES.find(s => s.title === 'Recent arrivals');
  assert.match(shelfPrompt({ library }, recent), new RegExp(`published in ${new Date().getFullYear() - 5} or later`));
  assert.match(profilePrompt(library), /ONE PER LINE/);
});

test('worker config lists the shelves for the front end', async () => {
  const r = await worker.fetch(new Request('https://x.test/api/config'), { ASSETS: { fetch: async () => new Response('') } });
  const cfg = await r.json();
  assert.strictEqual(cfg.passcodeRequired, true);
  assert.strictEqual(cfg.shelves.length, SHELVES.length);
});
