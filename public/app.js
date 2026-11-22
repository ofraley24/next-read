'use strict';
const CHIPS = ['More optimistic','Shorter (<350 pages)','Non-fiction','Wildcard: outside my usual','Lighter tone','Older classics','Harder ideas','Recent (last 5 yrs)'];
const REASONS = ["Too similar to what I've read", 'Not my subject', 'Wrong tone', 'Too long', 'Too dense or slow', 'Already know the argument'];
const FILTERS = {
  kind: [['any', 'Any type'], ['fiction', 'Fiction'], ['non-fiction', 'Non-fiction']],
  length: [['any', 'Any length'], ['short', 'Under 300 pages'], ['long', '500+ pages']],
  era: [['any', 'Any era'], ['recent', 'Last 10 years'], ['older', 'Before 2000']],
};
const COLORS = ['#8c3b2a','#2f5d50','#b08a3e','#4a5d8c','#7a4a78','#5d6b3a'];
const EAGER = 3;            // shelves stocked straight away; the rest load as you scroll
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const norm = s => String(s||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/\(.*?\)/g,' ').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const key = b => `${norm(b.title)}|${norm(b.author)}`;
const hue = s => { let h = 0; for (const c of s) h = (h*31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };

const KEY = 'nextread.v1';
let state = { library: [], profile: '', profileStale: false, shelves: [], pinned: {}, dismissed: {}, chips: {}, passcode: '', covers: {},
  filters: { kind: 'any', length: 'any', era: 'any' }, tableSeen: [] };
try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
// Shelves saved by the first version have no id: drop them (the shop restocks). A shelf that was loading when the page closed starts again.
state.shelves = (state.shelves || []).filter(s => s.id).map(s => ({ ...s, status: s.status === 'loading' ? 'idle' : s.status }));
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

/* ---------- Goodreads CSV (parsed in the browser; the file never leaves your machine except as JSON to your own API) ---------- */
function parseCSV(t) {
  const rows = []; let r = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n') { r.push(f); rows.push(r); r = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || r.length) { r.push(f); rows.push(r); }
  const h = rows.shift() || [];
  return rows.filter(x => x.length > 5).map(x => Object.fromEntries(h.map((k, i) => [k, x[i]])));
}
function fromCSV(rows) {
  return rows.filter(r => r.Title).map(r => {
    const m = r.Title.match(/\((.*?)\)\s*$/);
    return { id: r['Book Id'], title: r.Title.replace(/\s*\(.*?\)\s*$/, '').trim(), series: m ? m[1] : '',
      author: r.Author, rating: parseFloat(r['My Rating'] || 0), shelf: r['Exclusive Shelf'],
      year: r['Original Publication Year'], pages: r['Number of Pages'],
      review: (r['My Review'] || '').replace(/<br\s*\/?>/g, ' ').trim(),
      notes: (r['Private Notes'] || '').replace(/<br\s*\/?>/g, ' ').trim(),
      isbn: (r['ISBN13'] || r['ISBN'] || '').replace(/[^0-9Xx]/g, '') };
  });
}
$('csv').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const lib = fromCSV(parseCSV(await f.text()));
    if (!lib.length) throw new Error('empty');
    const had = state.library.length > 0;
    // Books you marked as read inside this app survive a re-import unless the new export already has them.
    const incoming = new Set(lib.map(key));
    const locals = state.library.filter(b => String(b.id).startsWith('local-') && !incoming.has(key(b)));
    state.library = [...lib, ...locals];
    if (!had) Object.assign(state, { profile: '', shelves: [], pinned: {}, dismissed: {} });   // first import starts fresh
    else state.profileStale = true;                                                              // re-import keeps your shop, picks and edits
    save(); renderAll();
    const n = lib.filter(b => b.notes).length;
    $('libmsg').hidden = false; $('libmsg').textContent = `Imported ${lib.length} books, ${n} with private notes.${had ? ' Your shop, picks and edits were kept.' : ''}`;
  } catch { $('err').textContent = 'Could not read that CSV. Use the Goodreads library export.'; }
  e.target.value = '';
};
$('reset').onclick = () => { if (confirm('Clear saved library, picks and passcode on this device?')) { try { localStorage.removeItem(KEY); } catch {} location.reload(); } };

/* ---------- API ---------- */
let config = null;   // from /api/config: whether a passcode is needed, and the shelf layout
async function getConfig() {
  if (!config) {
    try { config = await (await fetch('/api/config')).json(); } catch { config = { passcodeRequired: true, shelves: [] }; }
  }
  return config;
}
async function api(path, body) {
  if (((await getConfig()).passcodeRequired !== false) && !state.passcode) { state.passcode = prompt('Passcode for this site:') || ''; save(); }
  const res = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-passcode': state.passcode }, body: JSON.stringify(body) });
  let data = {}; try { data = await res.json(); } catch {}
  if (res.status === 401) { state.passcode = ''; save(); throw new Error('Wrong passcode. Try again.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
// Shelves share a small queue so a big shop never floods the server (the local server allows 5 at once).
const queue = []; let active = 0; const MAX_ACTIVE = 3;
function enqueue(fn) {
  return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const j = queue.shift(); active++;
    j.fn().then(j.resolve, j.reject).finally(() => { active--; pump(); });
  }
}
// Reviews are only needed for the taste profile; the other calls get a lighter library (notes stay).
const slimLibrary = () => state.library.map(({ review, ...rest }) => rest);

/* ---------- Taste statements ---------- */
function parseStatements(p) {
  const text = String(p || '');
  const lines = text.split('\n').map(l => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  return lines.length > 1 ? lines : text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);   // older prose profiles become sentences
}
function syncStatements() {
  state.profile = [...$('statements').querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean).map(s => '- ' + s).join('\n');
  save();
}
function renderStatements() {
  const st = parseStatements(state.profile);
  $('statements').innerHTML = st.map(s => `<div class="stmt"><input type="text" value="${esc(s)}"><button class="x" title="Remove" aria-label="Remove">×</button></div>`).join('')
    || '<div class="by" style="margin-bottom:8px">Statements about your taste appear here once you build the shop.</div>';
  $('statements').querySelectorAll('.stmt').forEach(row => {
    row.querySelector('input').oninput = syncStatements;
    row.querySelector('.x').onclick = () => { row.remove(); syncStatements(); };
  });
  $('stale').hidden = !(state.profileStale && state.profile.trim());
}
function addStatement() {
  const v = $('newstmt').value.trim(); if (!v) return;
  state.profile = (state.profile.trim() ? state.profile.trim() + '\n' : '') + '- ' + v;
  $('newstmt').value = ''; save(); renderStatements();
}
$('addstmt').onclick = addStatement;
$('newstmt').onkeydown = e => { if (e.key === 'Enter') addStatement(); };
$('reprofile').onclick = async () => {
  if (!state.library.length) return;
  if (state.profile.trim() && !confirm('Rewrite these statements from your library? Your edits to them will be replaced.')) return;
  const b = $('reprofile'); b.disabled = true; b.textContent = 'Reading…'; $('err').textContent = '';
  try { state.profile = (await api('profile', { library: state.library })).profile; state.profileStale = false; save(); renderStatements(); }
  catch (e) { $('err').textContent = e.message || 'Could not re-read your library.'; }
  b.disabled = false; b.textContent = 'Re-read my library';
};

/* ---------- Library, steering, filters ---------- */
function renderLib() {
  const lib = state.library;
  const read = lib.filter(b => b.shelf === 'read'), tr = lib.filter(b => b.shelf === 'to-read');
  const rated = read.filter(b => b.rating > 0), notes = lib.filter(b => b.notes).length;
  const avg = rated.length ? (rated.reduce((a, b) => a + b.rating, 0) / rated.length).toFixed(1) : '–';
  $('stats').innerHTML = lib.length ? `<div><b>${read.length}</b>read</div><div><b>${tr.length}</b>to-read</div><div><b>${avg}</b>avg ★</div><div><b>${notes}</b>notes</div>` : '<span>No library yet.</span>';
  $('rated').innerHTML = [...rated].sort((a, b) => b.rating - a.rating).map(b => `<div class="mini">${'★'.repeat(Math.round(b.rating))} ${esc(b.title)} <span>· ${esc(b.author)}</span></div>`).join('');
}
function renderChips() {
  $('chips').innerHTML = CHIPS.map(c => `<span class="chip ${state.chips[c] ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</span>`).join('');
  $('chips').querySelectorAll('.chip').forEach(el => el.onclick = () => { state.chips[el.dataset.c] = !state.chips[el.dataset.c]; save(); renderChips(); });
}
function renderFilters() {
  $('filters').innerHTML = Object.entries(FILTERS).map(([k, opts]) =>
    `<select data-f="${k}" aria-label="${k}">${opts.map(([v, l]) => `<option value="${v}" ${state.filters[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`).join('');
  $('filters').querySelectorAll('select').forEach(sel => sel.onchange = () => { state.filters[sel.dataset.f] = sel.value; save(); draw(); });
}
// Filters only hide what is already on the shelves. Kind and pages come from the model, so they are approximate; unknown values are never hidden.
const passes = b => {
  const f = state.filters, y = parseInt(b.year, 10), now = new Date().getFullYear();
  if (f.kind !== 'any' && b.kind && b.kind !== f.kind) return false;
  if (f.length === 'short' && b.pages && b.pages >= 300) return false;
  if (f.length === 'long' && b.pages && b.pages < 500) return false;
  if (f.era === 'recent' && y && y < now - 10) return false;
  if (f.era === 'older' && y && y >= 2000) return false;
  return true;
};

/* ---------- Tiles and the book sheet ---------- */
function coverHTML(b, big) {
  const c = hue(b.title), c2 = hue(b.author + 'x');
  return `<div class="cover ${big ? 'big' : ''}" style="background:linear-gradient(155deg,${c},${c2})">
    ${state.pinned[key(b)] ? '<span class="badge">★ pinned</span>' : ''}
    <div class="ct">${esc(b.title)}</div><div class="ca">${esc(b.author)}</div>
    ${(state.covers[key(b)] || b.cover) ? `<img src="${esc(state.covers[key(b)] || b.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>`;
}
function hideBrokenCovers(root) {
  root.querySelectorAll('.cover img').forEach(img => {
    const drop = () => img.remove();
    img.addEventListener('error', drop);
    // Open Library serves a 1x1 placeholder when it has no cover
    img.addEventListener('load', () => { if (img.naturalWidth < 20) drop(); });
  });
}
const find = k => state.shelves.flatMap(s => s.books).find(x => key(x) === k) || state.pinned[k];
const meta = b => [b.year, b.pages ? `~${b.pages}pp` : ''].filter(Boolean).join(' · ');
const tile = b => `<div class="tile" data-k="${esc(key(b))}">${coverHTML(b)}<div class="tp">${esc(b.pitch || '')}</div>${meta(b) ? `<div class="tm">${esc(meta(b))}</div>` : ''}</div>`;

let openKey = null, sheetMode = '', readStars = 0;
function actionsHTML(b) {
  const k = key(b), pinned = !!state.pinned[k];
  if (sheetMode === 'no') return `<div class="reasons"><div class="by">Why not? This teaches the shop (all optional).</div>
    <div class="rchips">${REASONS.map(r => `<span class="rchip">${esc(r)}</span>`).join('')}</div>
    <input type="text" id="noreason" placeholder="Anything else?">
    <div class="acts"><button class="primary" data-a="confirmno">Remove it</button><button data-a="cancelmode">Back</button></div></div>`;
  if (sheetMode === 'read') return `<div class="reasons"><div class="by">You have read this. How was it?</div>
    <div class="stars">${[1,2,3,4,5].map(n => `<button data-a="star" data-n="${n}" class="${readStars >= n ? 'on' : ''}" aria-label="${n} stars">★</button>`).join('')}</div>
    <input type="text" id="readnote" placeholder="One line on why (saved as a private note)">
    <div class="acts"><button class="primary" data-a="confirmread">Add to my library</button><button data-a="cancelmode">Back</button></div></div>`;
  return `<div class="acts"><button class="primary" data-a="pin">${pinned ? 'Unpin' : 'Pin to shortlist'}</button><button data-a="more">More like this</button><button data-a="read">I’ve read this</button><button data-a="no">Not for me</button><button data-a="close">Close</button></div>`;
}
function detailHTML(b) {
  return b.why
    ? `<div class="why">${esc(b.why)}</div>
    <div class="links">${(b.links || []).map(l => `<span class="link">↔ ${esc(l)}</span>`).join('')}</div>
    <div class="links" style="margin-top:8px">${(b.themes || []).map(t => `<span class="tag-s">${esc(t)}</span>`).join('')}</div>
    ${b.caution ? `<div class="caution" style="margin-top:10px">Might not land: ${esc(b.caution)}</div>` : ''}`
    : `<div class="why"><i>${b.explainError ? esc(b.explainError) : 'Working out why this fits you…'}</i></div>${b.explainError ? '<div class="acts"><button data-a="retry">Try again</button></div>' : ''}`;
}
function sheetHTML(b) {
  const k = key(b);
  const setCoverUI = `<details style="margin-top:10px"><summary>Set cover image</summary><div style="margin-top:8px"><input type="text" id="coverurl" placeholder="Paste an image address (https://…)">
    <div class="acts"><button data-a="savecover">Use this address</button><label class="tag link-label">or choose a file<input id="coverfile" type="file" accept="image/*" hidden></label>${state.covers[k] ? '<button data-a="clearcover">Remove custom cover</button>' : ''}</div></div></details>`;
  return `${coverHTML(b, true)}<div><h2>${esc(b.title)}</h2><div class="by">${esc(b.author)}${meta(b) ? ' · ' + esc(meta(b)) : ''}</div>${b.pitch && !b.why ? `<div class="why">${esc(b.pitch)}</div>` : ''}<div id="detail">${detailHTML(b)}</div>
    ${actionsHTML(b)}${sheetMode ? '' : setCoverUI}</div>`;
}
const redrawSheet = k => { const b = find(k); if (b && openKey === k) { $('sheet').innerHTML = sheetHTML(b); bindSheet(k); } };
function setCover(k, src) {
  if (src) state.covers[k] = src; else delete state.covers[k];
  save(); draw(); renderShort(); redrawSheet(k);
}
// Read a local image, shrink it so it fits comfortably in localStorage, and use it as the cover.
function coverFromFile(file, k) {
  const fr = new FileReader();
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 400 / img.height), c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      setCover(k, c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { $('err').textContent = 'That file is not an image I can read.'; };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
}
function closeModal() { $('modal').classList.remove('open'); openKey = null; sheetMode = ''; }
function removeEverywhere(k) {
  delete state.pinned[k];
  state.shelves.forEach(s => s.books = s.books.filter(x => key(x) !== k));
}
function bindSheet(k) {
  hideBrokenCovers($('sheet'));
  const cf = $('coverfile'); if (cf) cf.onchange = () => { if (cf.files[0]) coverFromFile(cf.files[0], k); };
  $('sheet').querySelectorAll('.rchip').forEach(c => c.onclick = () => c.classList.toggle('on'));
  $('sheet').querySelectorAll('button').forEach(btn => btn.onclick = () => {
    const a = btn.dataset.a, b = find(k);
    if (a === 'retry') return explainBook(k);
    if (a === 'savecover') { const u = ($('coverurl').value || '').trim(); return /^https?:\/\//i.test(u) ? setCover(k, u) : ($('coverurl').placeholder = 'That needs to start with https://'); }
    if (a === 'clearcover') return setCover(k, null);
    if (a === 'star') { readStars = +btn.dataset.n; $('sheet').querySelectorAll('[data-a=star]').forEach(s => s.classList.toggle('on', +s.dataset.n <= readStars)); return; }
    if (!b) return;
    if (a === 'no' || a === 'read') { sheetMode = a; readStars = 0; return redrawSheet(k); }
    if (a === 'cancelmode') { sheetMode = ''; return redrawSheet(k); }
    if (a === 'confirmno') {
      const picked = [...$('sheet').querySelectorAll('.rchip.on')].map(c => c.textContent), extra = ($('noreason').value || '').trim();
      state.dismissed[k] = { title: b.title, author: b.author, reason: [...picked, extra].filter(Boolean).join('; ') };
      removeEverywhere(k);
    }
    if (a === 'confirmread') {
      if (!readStars) { $('sheet').querySelector('.reasons .by').textContent = 'Pick a star rating first.'; return; }
      const note = ($('readnote').value || '').trim(), mine = state.library.find(x => key(x) === k);
      if (mine) Object.assign(mine, { rating: readStars, shelf: 'read', notes: [mine.notes, note].filter(Boolean).join(' ') });   // it was on your to-read list
      else state.library.push({ id: 'local-' + Date.now(), title: b.title, series: '', author: b.author, rating: readStars, shelf: 'read', year: b.year || '', pages: b.pages || '', review: '', notes: note, isbn: '' });
      removeEverywhere(k); state.profileStale = true;
    }
    if (a === 'pin') { if (state.pinned[k]) delete state.pinned[k]; else state.pinned[k] = b; }
    save(); closeModal(); draw(); renderShort(); renderLib(); renderStatements();
    if (a === 'more') moreLike(b);
  });
}
function refreshDetail(k) {   // only the explanation block, so anything being typed in the sheet survives
  const b = find(k), d = $('detail');
  if (!b || !d || openKey !== k) return;
  d.innerHTML = detailHTML(b);
  d.querySelectorAll('button').forEach(btn => btn.onclick = () => { if (btn.dataset.a === 'retry') explainBook(k); });
  const pitch = $('sheet').querySelector(':scope > div > .why'); if (pitch && b.why) pitch.remove();
}
async function explainBook(k) {
  const b = find(k); if (!b || b.why) return;
  delete b.explainError; refreshDetail(k);
  try {
    Object.assign(b, await api('explain', { library: slimLibrary(), profile: state.profile, book: { title: b.title, author: b.author, year: b.year } }));
    save();
  } catch (e) { b.explainError = (e && e.message) || 'Could not load the explanation.'; }
  refreshDetail(k);
}
function openBook(k) {
  const b = find(k); if (!b) return;
  openKey = k; sheetMode = ''; readStars = 0;
  $('sheet').innerHTML = sheetHTML(b); bindSheet(k);
  $('modal').classList.add('open');
  if (!b.why) explainBook(k);
}
$('modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ---------- Shelves ---------- */
const skeleton = n => '<div class="skel"></div>'.repeat(n);
function shelfHTML(s) {
  const shown = s.books.filter(passes);
  let body;
  if (s.status === 'idle') body = `<div class="grid">${'<div class="skel faint"></div>'.repeat(6)}</div>`;
  else if (s.status === 'loading' && !s.books.length) body = `<div class="grid">${skeleton(6)}</div>`;
  else body = `<div class="grid">${shown.map(tile).join('')}${s.status === 'loading' ? skeleton(4) : ''}</div>`
    + (s.status === 'done' && !shown.length ? `<div class="empty">${s.books.length ? 'Nothing on this shelf matches your filters.' : 'Nothing left on this shelf.'}</div>` : '');
  const id = esc(s.id);
  const foot = s.status === 'done'
    ? `<div class="foot"><button data-act="${s.idx === 0 ? 'fresh' : 'more'}" data-id="${id}">${s.idx === 0 ? 'Freshen the window' : 'Show more like this'}</button></div>`
    : s.status === 'error' ? `<div class="foot"><button data-act="retry" data-id="${id}">Try this shelf again</button></div>` : '';
  const count = s.status === 'done' ? `<span class="tag-s">${shown.length === s.books.length ? s.books.length : `${shown.length} of ${s.books.length}`}</span>` : '';
  return `<section class="shelf" data-id="${id}"><h2>${esc(s.shelf)} ${count}${s.seed ? `<button class="x" data-act="remove" data-id="${id}" title="Remove this shelf" aria-label="Remove this shelf">×</button>` : ''}</h2>
    <p>${s.error ? `<span class="err">${esc(s.error)}</span>` : esc(s.status === 'idle' ? s.blurb + ' Stocked as you scroll.' : s.blurb)}</p>${body}${foot}</section>`;
}
function draw() {
  if (!state.shelves.length) {
    $('shelves').innerHTML = state.library.length
      ? '<div class="empty">Library loaded. Press <b>Build my shop</b> and I’ll read your taste, then stock your shelves.</div>'
      : '<div class="empty">Import your Goodreads export (Goodreads → My Books → Import and export → Export Library) to begin.</div>';
    return;
  }
  $('shelves').innerHTML = state.shelves.map(shelfHTML).join('');
  hideBrokenCovers($('shelves'));
  pumpLazy();
}
function drawShelf(s) {
  const el = $('shelves').querySelector(`[data-id="${CSS.escape(s.id)}"]`);
  if (!el) return draw();
  el.outerHTML = shelfHTML(s);
  hideBrokenCovers($('shelves').querySelector(`[data-id="${CSS.escape(s.id)}"]`));
  pumpLazy();
}
$('shelves').addEventListener('click', e => {
  const t = e.target.closest('.tile'); if (t) return openBook(t.dataset.k);
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const s = state.shelves.find(x => x.id === btn.dataset.id); if (!s) return;
  const a = btn.dataset.act;
  if (a === 'more') loadShelf(s, 'more');
  if (a === 'fresh') loadShelf(s, 'replace');
  if (a === 'retry') loadShelf(s, 'fresh');
  if (a === 'remove') { state.shelves = state.shelves.filter(x => x !== s); save(); draw(); }
});

function baseBody() {
  return {
    library: slimLibrary(), profile: state.profile,
    steer: [...Object.keys(state.chips).filter(k => state.chips[k]), $('free').value.trim()].filter(Boolean),
    pinned: Object.values(state.pinned).map(b => `${b.title} — ${b.author}`),
    dismissed: Object.values(state.dismissed).map(d => `${d.title} — ${d.author}${d.reason ? ` (reason: ${d.reason})` : ''}`),
    dismissedKeys: Object.keys(state.dismissed),
  };
}
// mode: 'fresh' (new stock), 'more' (add to what is there), 'replace' (new window, avoiding earlier ones)
function shelfBody(s, mode) {
  const body = baseBody();
  if (s.seed) body.seed = s.seed; else body.shelf = s.idx;
  const ex = mode === 'more' ? s.books : mode === 'replace' ? [...s.books, ...(state.tableSeen || [])] : s.idx === 0 ? (state.tableSeen || []) : [];
  if (ex.length) body.exclude = ex.map(x => ({ title: x.title, author: x.author }));
  return body;
}
async function loadShelf(s, mode = 'fresh') {
  if (s.status === 'loading') return;
  s.status = 'loading'; s.error = ''; drawShelf(s);
  try {
    const out = await enqueue(() => api('shelf', shelfBody(s, mode)));
    const have = new Set(s.books.map(key));
    // a book sits on one shelf only (the front table and "more like this" shelves may overlap)
    const taken = (s.seed || s.idx === 0) ? new Set() : new Set(state.shelves.filter(x => x !== s && x.idx > 0).flatMap(x => x.books.map(key)));
    const fresh = out.books.filter(b => !taken.has(key(b)) && !state.dismissed[key(b)] && !(mode === 'more' && have.has(key(b))));
    s.books = mode === 'more' ? s.books.concat(fresh) : fresh;
    s.blurb = out.blurb || s.blurb; s.status = 'done';
    if (s.idx === 0) state.tableSeen = [...s.books.map(b => ({ title: b.title, author: b.author })), ...(state.tableSeen || [])].slice(0, 30);
  } catch (e) { s.status = 'error'; s.error = `Could not load this shelf: ${(e && e.message) || 'error'}`; }
  save(); drawShelf(s);
}
// Shelves beyond the first few are stocked as you scroll toward them, a couple at a time.
function pumpLazy() {
  if (state.shelves.filter(s => s.status === 'loading').length >= 2) return;
  const next = state.shelves.find(s => s.status === 'idle'); if (!next) return;
  const el = $('shelves').querySelector(`[data-id="${CSS.escape(next.id)}"]`);
  if (el && el.getBoundingClientRect().top < window.innerHeight + 700) loadShelf(next, 'fresh');
}
let scrollTick = false;
window.addEventListener('scroll', () => { if (scrollTick) return; scrollTick = true; requestAnimationFrame(() => { scrollTick = false; pumpLazy(); }); }, { passive: true });

function moreLike(b) {
  const id = 'seed:' + key(b);
  let s = state.shelves.find(x => x.id === id);
  if (s) state.shelves = state.shelves.filter(x => x !== s);
  else s = { id, idx: null, seed: { title: b.title, author: b.author }, shelf: `More like ${b.title}`, blurb: `Because you were looking at ${b.title}.`, books: [], status: 'idle' };
  s.status = 'idle'; s.books = [];
  state.shelves.unshift(s); save(); draw();
  $('shelves').scrollIntoView({ behavior: 'smooth', block: 'start' });
  loadShelf(s, 'fresh');
}

function renderShort() {
  const ps = Object.values(state.pinned);
  $('slc').textContent = ps.length;
  $('shortlist').innerHTML = ps.map(b => `<li data-k="${esc(key(b))}"><span class="grow"><b>${esc(b.title)}</b> <span class="by">${esc(b.author)}</span></span><button class="x" data-unpin title="Unpin" aria-label="Unpin">×</button></li>`).join('') || '<li class="by">Nothing pinned yet.</li>';
}
$('shortlist').addEventListener('click', e => {
  const li = e.target.closest('li[data-k]'); if (!li) return;
  if (e.target.closest('[data-unpin]')) { delete state.pinned[li.dataset.k]; save(); renderShort(); draw(); return; }
  openBook(li.dataset.k);
});

function renderAll() {
  renderLib(); renderChips(); renderFilters(); renderStatements(); draw(); renderShort();
  $('go').textContent = state.shelves.some(s => !s.seed) ? 'Refresh the shop' : 'Build my shop';
  $('go').disabled = !state.library.length;
}

$('go').onclick = async () => {
  const btn = $('go'); btn.disabled = true; $('err').textContent = '';
  try {
    if (!state.profile.trim()) {
      btn.textContent = 'Reading your taste…'; $('shelves').innerHTML = `<div class="grid">${skeleton(6)}</div>`;
      state.profile = (await api('profile', { library: state.library })).profile;
      state.profileStale = false; save(); renderStatements();
    }
    btn.textContent = 'Stocking the shelves…';
    const layout = (await getConfig()).shelves || [];
    if (!layout.length) throw new Error('Could not load the shop layout from the server.');
    const custom = state.shelves.filter(s => s.seed);
    state.shelves = [...custom, ...layout.map((s, i) => ({ id: 's' + i, idx: i, shelf: s.title, blurb: s.blurb, books: [], status: 'idle' }))];
    save(); draw();
    const first = state.shelves.filter(s => s.idx != null && s.idx < EAGER);
    await Promise.all(first.map(s => loadShelf(s, 'fresh')));
    const failed = first.filter(s => s.status === 'error').length;
    if (failed) $('err').textContent = `${failed} of ${first.length} shelves failed. Use “Try this shelf again”.`;
  } catch (e) { $('err').textContent = e.message || 'Something went wrong. Try again.'; }
  renderAll();
};
renderAll();
