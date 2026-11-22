// Shared request wrapper for the Pages Functions: auth, size limit, JSON in/out.
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Constant-time-ish string compare.
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function handle({ request, env }, fn) {
  // Fail closed: without a passcode set, anyone who finds the URL could spend your API credits.
  if (!env.APP_PASSCODE) return json({ error: 'APP_PASSCODE is not set on the server' }, 503);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set on the server' }, 503);
  if (!same(request.headers.get('x-passcode') || '', env.APP_PASSCODE)) return json({ error: 'Wrong passcode' }, 401);
  if (Number(request.headers.get('content-length') || 0) > 2_000_000) return json({ error: 'Request too large' }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  try {
    return json(await fn(body || {}, { apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL || undefined }));
  } catch (e) {
    console.error(e);
    return json({ error: e.message || 'Server error' }, e.status || 500);
  }
}
