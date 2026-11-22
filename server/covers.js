
// Catalogue lookup: verifies a book exists and finds a cover.
// Sources: Open Library (primary), Google Books (fallback). Both are free, no key required.

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const surname = a => { const p = norm(a).split(' ').filter(Boolean); return p[p.length - 1] || ''; };

// Title match: one contains the other after dropping subtitles, or most tokens overlap.
function titleMatches(want, got) {
  const a = norm(want).split(':')[0].trim(), b = norm(got).split(':')[0].trim();
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(' ')), tb = b.split(' ');
  return tb.filter(t => ta.has(t)).length / Math.max(ta.size, tb.length) >= 0.7;
}
function authorMatches(want, gotList) {
  const s = surname(want);
  return !!s && (gotList || []).some(g => norm(g).split(' ').includes(s));
}

// ---- polite HTTP: limited concurrency, retries with backoff on throttling/timeouts, logged failures ----
const MAX_CONCURRENT = 5;
let active = 0; const waiting = [];
async function gate(fn) {
  if (active >= MAX_CONCURRENT) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; const next = waiting.shift(); if (next) next(); }
}
const realSleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, { fetchImpl = fetch, sleep = realSleep, tries = 3, timeoutMs = 8000 } = {}) {
  const host = new URL(url).hostname;
  for (let i = 0; i < tries; i++) {
    let why;
    try {
      // The timeout starts only once a slot is free, so time spent queueing never counts against the request.
      const out = await gate(async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          const r = await fetchImpl(url, { signal: ctl.signal, headers: { 'user-agent': 'next-read/1.0 (personal project)' } });
          return { status: r.status, body: r.ok ? await r.json() : null };
        } finally { clearTimeout(timer); }
      });
      if (out.body !== null) return out.body;
      why = `HTTP ${out.status}`;
      if (out.status < 500 && out.status !== 429) { console.warn(`lookup: ${host} ${why}`); return null; }   // a real "no", don't retry
    } catch (e) { why = e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e); }
    if (i < tries - 1) await sleep(500 * 2 ** i);   // 0.5s, 1s
    else console.warn(`lookup: ${host} gave up after ${tries} tries (${why})`);
  }
  return null;
}

// Drop "(Series, #2)" suffixes: they break catalogue searches. Optionally drop the subtitle too.
const cleanTitle = t => String(t).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
const mainTitle = t => cleanTitle(t).split(':')[0].trim();

async function openLibrary(title, author, opts) {
  const tries = [
    new URLSearchParams({ title: cleanTitle(title), author, limit: '10', fields: 'title,author_name,first_publish_year,cover_i' }),
    new URLSearchParams({ q: `${mainTitle(title)} ${author}`, limit: '10', fields: 'title,author_name,first_publish_year,cover_i' }),   // looser
  ];
  let best = null;
  for (const q of tries) {
    const data = await getJSON(`https://openlibrary.org/search.json?${q}`, opts);
    const docs = ((data && data.docs) || []).filter(d => titleMatches(title, d.title) && authorMatches(author, d.author_name));
    const hit = docs.find(d => d.cover_i) || docs[0];
    if (hit && hit.cover_i) return { verified: true, cover: `https://covers.openlibrary.org/b/id/${hit.cover_i}-M.jpg?default=false`, source: 'openlibrary' };
    if (hit && !best) best = { verified: true, cover: null, source: 'openlibrary' };
    if (best) break;   // found it but no cover: the looser query won't add one, go to the next source
  }
  return best;
}

async function googleBooks(title, author, opts) {
  const qs = [`intitle:${mainTitle(title)}+inauthor:${author}`, `${mainTitle(title)} ${author}`];
  let best = null;
  for (const q of qs) {
    const data = await getJSON(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q).replace(/%2B/g, '+')}&maxResults=10&printType=books`, opts);
    const vols = ((data && data.items) || []).map(i => i.volumeInfo || {}).filter(v => titleMatches(title, v.title) && authorMatches(author, v.authors));
    const withImg = vols.find(v => v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail));
    if (withImg) { const img = withImg.imageLinks.thumbnail || withImg.imageLinks.smallThumbnail; return { verified: true, cover: img.replace(/^http:/, 'https:'), source: 'googlebooks' }; }
    if (vols.length && !best) best = { verified: true, cover: null, source: 'googlebooks' };
  }
  return best;
}

// Successful lookups are remembered for the life of the process, so refreshes don't hit the catalogues again.
const cache = new Map();

// Returns {verified, cover, source}. Prefers a result that has a cover.
async function lookup(title, author, opts = {}) {
  if (typeof opts === 'function') opts = { fetchImpl: opts };   // old call style: lookup(title, author, fetchImpl)
  const k = `${norm(title)}|${norm(author)}`;
  if (cache.has(k)) return cache.get(k);
  const ol = await openLibrary(title, author, opts);
  let out = ol && ol.cover ? ol : null;
  if (!out) { const gb = await googleBooks(title, author, opts); out = gb && gb.cover ? gb : (ol || gb); }
  if (!out) { console.warn(`lookup: no catalogue match for "${title}" by ${author}`); return { verified: false, cover: null, source: null }; }
  if (!out.cover) console.warn(`lookup: found "${title}" but no cover image`);
  if (out.cover) cache.set(k, out);   // only cache full successes; misses get another chance next time
  return out;
}

export { lookup, titleMatches, authorMatches, norm, cleanTitle };
