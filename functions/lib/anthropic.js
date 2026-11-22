'use strict';
// Minimal Claude Messages API client (no SDK, uses Node's built-in fetch).
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

async function claude({ prompt, maxTokens = 4000 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// Pull a JSON value out of a model reply, tolerating code fences / stray prose.
function parseJSON(text) {
  const t = String(text).replace(/```json|```/g, '').trim();
  const starts = ['[', '{'].map(c => t.indexOf(c)).filter(i => i >= 0);
  if (!starts.length) throw new Error('No JSON in model reply');
  const a = Math.min(...starts);
  const b = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  return JSON.parse(t.slice(a, b + 1));
}

module.exports = { claude, parseJSON, MODEL };
