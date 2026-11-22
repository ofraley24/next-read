
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

async function getJSON(url, fetchImpl = fetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal, headers: { 'user-agent': 'next-read/1.0 (personal project)' } });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function openLibrary(title, author, fetchImpl) {
  const q = new URLSearchParams({ title, author, limit: '6', fields: 'title,author_name,first_publish_year,cover_i' });
  const data = await getJSON(`https://openlibrary.org/search.json?${q}`, fetchImpl);
  const docs = (data && data.docs) || [];
  const hit = docs.find(d => titleMatches(title, d.title) && authorMatches(author, d.author_name) && d.cover_i)
    || docs.find(d => titleMatches(title, d.title) && authorMatches(author, d.author_name));
  if (!hit) return null;
  return { verified: true, cover: hit.cover_i ? `https://covers.openlibrary.org/b/id/${hit.cover_i}-M.jpg` : null, source: 'openlibrary' };
}

async function googleBooks(title, author, fetchImpl) {
  const q = `intitle:${title}+inauthor:${author}`;
  const data = await getJSON(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q).replace(/%2B/g, '+')}&maxResults=5&printType=books`, fetchImpl);
  const items = (data && data.items) || [];
  const hit = items.map(i => i.volumeInfo || {}).find(v => titleMatches(title, v.title) && authorMatches(author, v.authors));
  if (!hit) return null;
  const img = hit.imageLinks && (hit.imageLinks.thumbnail || hit.imageLinks.smallThumbnail);
  return { verified: true, cover: img ? img.replace(/^http:/, 'https:') : null, source: 'googlebooks' };
}

// Returns {verified, cover, source}. Prefers a result that has a cover.
async function lookup(title, author, fetchImpl = fetch) {
  const ol = await openLibrary(title, author, fetchImpl);
  if (ol && ol.cover) return ol;
  const gb = await googleBooks(title, author, fetchImpl);
  if (gb && gb.cover) return gb;
  return ol || gb || { verified: false, cover: null, source: null };
}

export { lookup, titleMatches, authorMatches, norm };
