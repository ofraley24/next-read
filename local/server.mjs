// Local server: serves the site and answers /api/* by running your signed-in Claude Code (`claude -p`),
// so usage comes from your Claude plan instead of API billing. Listens on 127.0.0.1 only.
//   npm run local     ->  http://localhost:8787
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { profile, recommend } from '../server/handlers.js';

const PUBLIC = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };

// Run one prompt through `claude -p` (prompt on stdin, plain-text answer on stdout).
// Tools are disabled and it runs in an empty temp directory, so it is just a text-in/text-out call.
export function claudeCLI({ prompt }, { bin = process.env.CLAUDE_BIN || 'claude', model = process.env.CLAUDE_MODEL, timeoutMs = 300_000 } = {}) {
  return new Promise((resolveP, reject) => {
    const args = ['-p', '--output-format', 'text', '--tools', '', '--no-session-persistence', '--disable-slash-commands'];
    if (model) args.push('--model', model);
    const child = spawn(bin, args, { cwd: mkdtempSync(join(tmpdir(), 'next-read-')), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Claude took too long (5 min).')); }, timeoutMs);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `Could not find the "${bin}" command. Install Claude Code and sign in (run "claude" once).` : e.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) return resolveP(out);
      reject(new Error(`claude exited with code ${code}: ${(err || out).trim().slice(0, 300) || 'no output. Are you signed in? Run "claude" once to log in.'}`));
    });
    child.stdin.end(prompt);
  });
}

export function makeServer({ ask = claudeCLI, lookup } = {}) {
  const ctx = { claude: ask, ...(lookup ? { lookup } : {}) };
  let busy = false; // one Claude call at a time: keeps usage predictable and the CLI happy
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/config') return json(res, 200, { passcodeRequired: false, mode: 'local-claude-code' });
      if (url.pathname.startsWith('/api/')) {
        const fn = { '/api/profile': profile, '/api/recommend': recommend }[url.pathname.replace(/\/+$/, '')];
        if (!fn) return json(res, 404, { error: 'Not found' });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        if (busy) return json(res, 429, { error: 'Still working on the previous request. Give it a minute.' });
        let raw = ''; for await (const c of req) { raw += c; if (raw.length > 2_000_000) return json(res, 413, { error: 'Request too large' }); }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
        busy = true;
        try { return json(res, 200, await fn(body, ctx)); }
        catch (e) { console.error(e.message); return json(res, e.status || 500, { error: e.message || 'Server error' }); }
        finally { busy = false; }
      }
      // static files from public/
      let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (rel === sep || rel === '.') rel = 'index.html';
      const file = resolve(PUBLIC, '.' + sep + rel);
      if (!file.startsWith(PUBLIC + sep)) return json(res, 403, { error: 'Forbidden' });
      const data = await readFile(file).catch(() => null);
      if (!data) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch (e) { console.error(e); json(res, 500, { error: 'Server error' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  makeServer().listen(port, '127.0.0.1', () => {
    console.log(`Next Read running at http://localhost:${port}`);
    console.log('Using your signed-in Claude Code (claude -p), so usage comes from your Claude plan.');
  });
}
