// Cloudflare Worker entry: runs /api/* here, serves everything else from the static assets in public/.
import { handle } from '../server/http.js';
import { profile, recommend } from '../server/handlers.js';

const routes = { '/api/profile': profile, '/api/recommend': recommend };

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      const fn = routes[pathname.replace(/\/+$/, '')];
      if (!fn) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: { 'content-type': 'application/json', allow: 'POST' } });
      return handle({ request, env }, fn);
    }
    return env.ASSETS.fetch(request);
  },
};
