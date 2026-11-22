import test from 'node:test';
import assert from 'node:assert';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServer, claudeCLI } from '../local/server.mjs';

async function withServer(opts, fn) {
  const s = makeServer(opts);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  try { await fn(base); } finally { s.close(); }
}
const post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('local server: config, static files, no path traversal, no passcode needed', async () => {
  await withServer({ ask: async () => 'ok' }, async base => {
    assert.deepStrictEqual(await (await fetch(base + '/api/config')).json(), { passcodeRequired: false, mode: 'local-claude-code' });
    const home = await fetch(base + '/');
    assert.strictEqual(home.status, 200);
    assert.match(await home.text(), /Next Read/);
    assert.strictEqual((await fetch(base + '/app.js')).headers.get('content-type').split(';')[0], 'text/javascript');
    assert.strictEqual((await fetch(base + '/nope.txt')).status, 404);
    const raw = await new Promise(r => { // bypass URL normalisation
      import('node:http').then(({ request }) => request(base + '/%2e%2e/%2e%2e/package.json', res => r(res.statusCode)).end());
    });
    assert.ok([403, 404].includes(raw));
  });
});

test('local server: /api/profile and /api/recommend use the injected claude (no network)', async () => {
  const lib = [{ title: 'Excession', author: 'Iain M. Banks', shelf: 'read', rating: 5 }, { title: 'Anathem', author: 'Neal Stephenson', shelf: 'to-read', rating: 0 }];
  const book = (title, author) => ({ title, author, pitch: 'p', why: 'w', links: [], themes: [], caution: '' });
  const reply = JSON.stringify([
    { shelf: 'From your to-read pile', blurb: '', books: [book('Anathem', 'Neal Stephenson')] },
    { shelf: 'Closest fit', blurb: '', books: [book('Diaspora', 'Greg Egan')] }, { shelf: 'Stretch', blurb: '', books: [] }, { shelf: 'Wildcards', blurb: '', books: [] },
  ]);
  const ask = async ({ prompt }) => prompt.includes('taste analyst') ? '  You like big ideas.  ' : reply;
  const lookup = async () => ({ verified: true, cover: 'https://example.test/c.jpg', source: 'test' });
  await withServer({ ask, lookup }, async base => {
    assert.deepStrictEqual(await (await post(base + '/api/profile', { library: lib })).json(), { profile: 'You like big ideas.' });
    const out = await (await post(base + '/api/recommend', { library: lib, profile: 'x' })).json();
    assert.deepStrictEqual(out.shelves.map(s => s.books.length), [1, 1, 0, 0]);
    assert.strictEqual(out.shelves[1].books[0].cover, 'https://example.test/c.jpg');
    assert.strictEqual((await post(base + '/api/profile', { library: [] })).status, 400);
    assert.strictEqual((await fetch(base + '/api/profile')).status, 405);
  });
});

test('local server: rejects a second request while one is running', async () => {
  let release; const gate = new Promise(r => release = r);
  await withServer({ ask: async () => { await gate; return 'text'; } }, async base => {
    const lib = [{ title: 'A', author: 'B', shelf: 'read', rating: 5 }];
    const first = post(base + '/api/profile', { library: lib });
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual((await post(base + '/api/profile', { library: lib })).status, 429);
    release();
    assert.strictEqual((await first).status, 200);
  });
});

test('claudeCLI: sends the prompt on stdin, returns stdout; helpful errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const ok = join(dir, 'ok.sh'); writeFileSync(ok, '#!/bin/sh\necho "ARGS:$*"\ncat\n'); chmodSync(ok, 0o755);
  const out = await claudeCLI({ prompt: 'hello prompt' }, { bin: ok });
  assert.match(out, /ARGS:-p --output-format text --tools  --no-session-persistence --disable-slash-commands/);
  assert.match(out, /hello prompt/);
  const bad = join(dir, 'bad.sh'); writeFileSync(bad, '#!/bin/sh\necho "Authentication error" >&2\nexit 1\n'); chmodSync(bad, 0o755);
  await assert.rejects(() => claudeCLI({ prompt: 'x' }, { bin: bad }), /Authentication error/);
  await assert.rejects(() => claudeCLI({ prompt: 'x' }, { bin: join(dir, 'missing') }), /Could not find/);
});
