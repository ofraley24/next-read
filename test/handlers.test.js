'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { titleMatches, authorMatches } = require('../functions/lib/covers');
const { recommend } = require('../functions/lib/handlers');
const { parseJSON } = require('../functions/lib/anthropic');

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
  const lookup = async (title) => title === 'Totally Fake Book'
    ? { verified: false, cover: null, source: null }
    : { verified: true, cover: `https://example.test/${encodeURIComponent(title)}.jpg`, source: 'test' };
  const out = await recommend({ library, profile: 'x' }, { claude: async () => reply, lookup });
  assert.deepStrictEqual(out.shelves[0].books.map(x => x.title), ['Anathem']);
  assert.deepStrictEqual(out.shelves[1].books.map(x => x.title), ['Diaspora']);
  assert.ok(out.shelves[1].books[0].cover.includes('Diaspora'));
  assert.strictEqual(out.dropped, 3);
});

test('recommend rejects an empty library', async () => {
  await assert.rejects(() => recommend({ library: [] }, { claude: async () => '[]' }), /library is required/);
});
