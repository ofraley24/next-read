
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

// After a 429 from a host we stop asking it for a while: retrying a rate limit only extends it.
const globalBreaker = new Map();   // host -> timestamp until which requests to it are skipped

async function getJSON(url, { fetchImpl = fetch, sleep = realSleep, tries = 3, timeoutMs = 8000, breaker = globalBreaker } = {}) {
  const host = new URL(url).hostname;
  for (let i = 0; i < tries; i++) {
    if ((breaker.get(host) || 0) > Date.now()) return null;   // paused after a 429
    let why;
    try {
      // The timeout starts only once a slot is free, so time spent queueing never counts against the request.
      const out = await gate(async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          const r = await fetchImpl(url, { signal: ctl.signal, headers: { 'user-agent': 'next-read/1.0 (personal project)' } });
          const ra = Number(r.headers && r.headers.get && r.headers.get('retry-after'));
          return { status: r.status, retryAfter: ra, body: r.ok ? await r.json() : null };
        } finally { clearTimeout(timer); }
      });
      if (out.body !== null) return out.body;
      if (out.status === 429) {
        const secs = Math.min(Math.max(out.retryAfter || 60, 10), 300);
        if (!(breaker.get(host) > Date.now())) console.warn(`lookup: ${host} is rate-limiting us (HTTP 429); pausing it for ${secs}s${host.includes('google') ? '. A free GOOGLE_BOOKS_API_KEY avoids this' : ''}`);
        breaker.set(host, Date.now() + secs * 1000);
        return null;
      }
      why = `HTTP ${out.status}`;
      if (out.status < 500) { console.warn(`lookup: ${host} ${why}`); return null; }   // a real "no", don't retry
    } catch (e) { why = e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e); }
    if (i < tries - 1) await sleep(500 * 2 ** i);   // 0.5s, 1s
    else console.warn(`lookup: ${host} gave up after ${tries} tries (${why})`);
  }
  return null;
}

// Drop "(Series, #2)" suffixes: they break catalogue searches. Optionally drop the subtitle too.
const cleanTitle = t => String(t).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
const mainTitle = t => cleanTitle(t).split(':')[0].trim();
const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');   // Benjamín -> Benjamin
const cleanIsbn = s => String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();

// The catalogue queries to try, in order. Each plan says where to ask and how to read the answer.
// byIsbn plans identify the exact edition, so their results are accepted without title/author checks.
function plans(title, author, isbn, googleKey) {
  const t = cleanTitle(title), m = mainTitle(title), a = fold(author);
  const ol = (params, extra = {}) => ({
    source: 'openlibrary', ...extra,
    url: `https://openlibrary.org/search.json?${new URLSearchParams({ ...params, limit: '20', fields: 'title,author_name,cover_i' })}`,
    items: j => ((j && j.docs) || []).map(d => ({ title: d.title, authors: d.author_name, cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg?default=false` : null })),
  });
  const gb = (q, extra = {}) => ({
    source: 'googlebooks', ...extra,
    url: `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q).replace(/%2B/g, '+')}&maxResults=20${googleKey ? `&key=${encodeURIComponent(googleKey)}` : ''}`,
    items: j => ((j && j.items) || []).map(i => i.volumeInfo || {}).map(v => {
      const img = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
      return { title: v.title, authors: v.authors, cover: img ? img.replace(/^http:/, 'https:') : null };
    }),
  });
  const list = [];
  const id = cleanIsbn(isbn);
  if (id.length === 10 || id.length === 13) list.push(ol({ isbn: id }, { byIsbn: true }), gb(`isbn:${id}`, { byIsbn: true }));
  list.push(
    ol({ title: t, author }),                 // strict
    ol({ q: `${m} ${a}` }),                   // looser, accents folded
    gb(`intitle:${m}+inauthor:${a}`),
    ol({ title: t }),                         // title only: immune to author-name formatting
    gb(`${m} ${a}`),
  );
  return list;
}
const accept = (plan, item, title, author) => plan.byIsbn || (titleMatches(title, item.title) && authorMatches(author, item.authors));

// Successful lookups are remembered for the life of the process, so refreshes don't hit the catalogues again.
const cache = new Map();

// Returns {verified, cover, source}. Stops at the first plan that yields a cover; remembers if any plan at least found the book.
async function lookup(title, author, opts = {}) {
  if (typeof opts === 'function') opts = { fetchImpl: opts };   // old call style: lookup(title, author, fetchImpl)
  const k = `${norm(title)}|${norm(author)}`;
  if (cache.has(k)) return cache.get(k);
  let best = null;
  for (const plan of plans(title, author, opts.isbn, opts.googleKey)) {
    const data = await getJSON(plan.url, opts);
    const hits = plan.items(data).filter(it => accept(plan, it, title, author));
    const withCover = hits.find(h => h.cover);
    if (withCover) { const out = { verified: true, cover: withCover.cover, source: plan.source }; cache.set(k, out); return out; }
    if (hits.length && !best) best = { verified: true, cover: null, source: plan.source };
  }
  if (best) console.warn(`lookup: found "${title}" but no cover image in any catalogue`);
  else console.warn(`lookup: no catalogue match for "${title}" by ${author}`);
  return best || { verified: false, cover: null, source: null };
}

// Human-readable trace of every query for one book: what was asked, what came back, what matched.
// Used by `npm run cover-debug`; makes "why is this cover missing?" answerable.
async function diagnose(title, author, isbn, { fetchImpl = fetch, googleKey } = {}) {
  const lines = [`Book: "${title}" by ${author}${isbn ? `  (ISBN ${isbn})` : ''}`, `Cleaned title: "${cleanTitle(title)}"   Main title: "${mainTitle(title)}"   Author folded: "${fold(author)}"`, ''];
  for (const plan of plans(title, author, isbn, googleKey)) {
    lines.push(`[${plan.source}${plan.byIsbn ? ', by ISBN' : ''}] ${plan.url.replace(/([?&]key=)[^&]+/, '$1…')}`);   // never print the key
    let r;
    try { r = await fetchImpl(plan.url, { headers: { 'user-agent': 'next-read/1.0 (personal project)' } }); }
    catch (e) { lines.push(`   request failed: ${e.message}`, ''); continue; }
    if (!r.ok) { lines.push(`   HTTP ${r.status}`, ''); continue; }
    const items = plan.items(await r.json());
    lines.push(`   HTTP ${r.status}, ${items.length} result(s)`);
    items.slice(0, 6).forEach(it => lines.push(`   - "${it.title}" by ${(it.authors || []).join(', ') || '?'}  title:${titleMatches(title, it.title) ? 'match' : 'no'}  author:${authorMatches(author, it.authors) ? 'match' : 'no'}  cover:${it.cover ? 'yes' : 'NO'}${plan.byIsbn ? '  (accepted: exact ISBN)' : ''}`));
    const ok = items.filter(it => accept(plan, it, title, author));
    lines.push(`   => ${ok.length} accepted, ${ok.filter(i => i.cover).length} with a cover`, '');
  }
  return lines.join('\n');
}

export { lookup, diagnose, titleMatches, authorMatches, norm, cleanTitle, cleanIsbn, fold };
