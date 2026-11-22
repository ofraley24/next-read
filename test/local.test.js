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
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.strictEqual(cfg.passcodeRequired, false);
    assert.strictEqual(cfg.mode, 'local-claude-code');
    assert.strictEqual(cfg.shelves[0].title, 'On the front table');
    assert.ok(cfg.shelves.every(s => s.title && s.blurb));
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

test('local server: profile, shelf and explain use the injected claude (no network)', async () => {
  const lib = [{ title: 'Excession', author: 'Iain M. Banks', shelf: 'read', rating: 5 }, { title: 'Anathem', author: 'Neal Stephenson', shelf: 'to-read', rating: 0 }];
  const ask = async ({ prompt }) => prompt.includes('taste analyst') ? '  You like big ideas.  '
    : prompt.includes('asking the shop a question') ? 'It fits.'
    : prompt.includes('Explain why') ? JSON.stringify({ why: 'Because.', links: ['Excession'], themes: ['x'], caution: 'c' })
    : JSON.stringify([{ title: 'Diaspora', author: 'Greg Egan', year: '1997', pitch: 'p' }]);
  const lookup = async () => ({ verified: true, cover: 'https://example.test/c.jpg', source: 'test' });
  await withServer({ ask, lookup }, async base => {
    assert.deepStrictEqual(await (await post(base + '/api/profile', { library: lib })).json(), { profile: 'You like big ideas.' });
    const out = await (await post(base + '/api/shelf', { library: lib, profile: 'x', shelf: 2 })).json();
    assert.strictEqual(out.shelf, 'Closest fit');
    assert.strictEqual(out.books[0].cover, 'https://example.test/c.jpg');
    const ex = await (await post(base + '/api/explain', { library: lib, profile: 'x', book: { title: 'Diaspora', author: 'Greg Egan' } })).json();
    assert.deepStrictEqual(ex.links, ['Excession']);
    const ans = await (await post(base + '/api/ask', { library: lib, question: 'does it fit?' })).json();
    assert.ok(typeof ans.answer === 'string' && ans.answer.length);
    assert.strictEqual((await post(base + '/api/ask', { library: lib })).status, 400);
    assert.strictEqual((await post(base + '/api/profile', { library: [] })).status, 400);
    assert.strictEqual((await fetch(base + '/api/shelf')).status, 405);
    assert.strictEqual((await post(base + '/api/recommend', {})).status, 404);
  });
});

test('local server: runs shelves in parallel and caps concurrency', async () => {
  let active = 0, peak = 0;
  const ask = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 80)); active--; return '[]'; };
  const lib = [{ title: 'A', author: 'B', shelf: 'read', rating: 5 }];
  await withServer({ ask }, async base => {
    const rs = await Promise.all([0, 1, 2, 3].map(i => post(base + '/api/shelf', { library: lib, shelf: i })));
    assert.deepStrictEqual(rs.map(r => r.status), [200, 200, 200, 200]);
    assert.strictEqual(peak, 4);                                   // all four shelves ran at the same time
    const many = await Promise.all(Array.from({ length: 7 }, () => post(base + '/api/shelf', { library: lib, shelf: 0 })));
    assert.ok(many.some(r => r.status === 429));                    // more than the cap is refused, not queued forever
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
