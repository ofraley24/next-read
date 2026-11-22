import test from 'node:test';
import assert from 'node:assert';
import { titleMatches, authorMatches } from '../server/covers.js';
import { recommend, profile } from '../server/handlers.js';
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
];
const b = (title, author) => ({ title, author, pitch: 'p', why: 'w', links: [], themes: [], caution: '' });

test('recommend drops invented, owned and off-list books, and attaches covers', async () => {
  const reply = JSON.stringify([
    { shelf: 'From your to-read pile', blurb: '', books: [b('Anathem', 'Neal Stephenson'), b('Not On My List', 'Someone')] },
    { shelf: 'Closest fit', blurb: '', books: [b('Diaspora', 'Greg Egan'), b('Totally Fake Book', 'Nobody Real'), b('Excession', 'Iain M. Banks')] },
    { shelf: 'Stretch', blurb: '', books: [] },
    { shelf: 'Wildcards', blurb: '', books: [] },
  ]);
  const lookup = async title => title === 'Totally Fake Book'
    ? { verified: false, cover: null, source: null }
    : { verified: true, cover: `https://example.test/${encodeURIComponent(title)}.jpg`, source: 'test' };
  const out = await recommend({ library, profile: 'x' }, { claude: async () => reply, lookup });
  assert.deepStrictEqual(out.shelves[0].books.map(x => x.title), ['Anathem']);
  assert.deepStrictEqual(out.shelves[1].books.map(x => x.title), ['Diaspora']);
  assert.ok(out.shelves[1].books[0].cover.includes('Diaspora'));
  assert.strictEqual(out.dropped, 3);
});

test('recommend and profile reject an empty library', async () => {
  await assert.rejects(() => recommend({ library: [] }, { claude: async () => '[]' }), /library is required/);
  await assert.rejects(() => profile({ library: [] }, { claude: async () => 'x' }), /library is required/);
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
