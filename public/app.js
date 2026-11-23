'use strict';
const CHIPS = ['More optimistic','Shorter (<350 pages)','Non-fiction','Fiction only','Lighter tone','Older classics','Harder ideas','Recent (last 5 yrs)'];
const REASONS = ["Too similar to what I've read", 'Not my subject', 'Wrong tone', 'Too long', 'Too dense or slow', 'Already know the argument'];
const FILTERS = {
  kind: [['any', 'Any type'], ['fiction', 'Fiction'], ['non-fiction', 'Non-fiction']],
  length: [['any', 'Any length'], ['short', 'Under 300 pages'], ['long', '500+ pages']],
  era: [['any', 'Any era'], ['recent', 'Last 10 years'], ['older', 'Before 2000']],
};
const COLORS = ['#8c3b2a','#2f5d50','#b08a3e','#4a5d8c','#7a4a78','#5d6b3a'];
const EAGER = 3;            // shelves stocked as soon as the shop is built; the rest load as you scroll down
const MAX_PER_SHELF = 120;  // a shelf stops growing sideways after this many books
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const norm = s => String(s||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/\(.*?\)/g,' ').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const key = b => `${norm(b.title)}|${norm(b.author)}`;
const hue = s => { let h = 0; for (const c of s) h = (h*31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };

const KEY = 'nextread.v1';
let state = { library: [], profile: '', profileStale: false, shelves: [], pinned: {}, dismissed: {}, chips: {}, passcode: '', covers: {},
  filters: { kind: 'any', length: 'any', era: 'any' }, tableSeen: [], chat: [], brief: { interests: '', next: '' }, feedback: [], stage: '' };
try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
// Shelves from the first version have no id: drop them. A shelf that was loading when the page closed starts again.
state.shelves = (state.shelves || []).filter(s => s.id).map(s => ({ ...s, status: s.status === 'loading' ? 'idle' : s.status }));
state.brief = { interests: '', next: '', ...(state.brief || {}) };
state.feedback = state.feedback || [];
if (!state.library.length) state.stage = 'import';
else if (!['taste', 'shop'].includes(state.stage)) state.stage = state.shelves.length ? 'shop' : 'taste';
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

/* ---------- 1. Import (the CSV is parsed in the browser and only sent, as JSON, to your own server) ---------- */
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
let libMsg = '';
async function importFile(file) {
  if (!file) return;
  try {
    const lib = fromCSV(parseCSV(await file.text()));
    if (!lib.length) throw new Error('empty');
    const had = state.library.length > 0;
    // Books marked as read inside the app survive a re-import unless the new export already has them.
    const incoming = new Set(lib.map(key));
    const locals = state.library.filter(b => String(b.id).startsWith('local-') && !incoming.has(key(b)));
    state.library = [...lib, ...locals];
    libMsg = `Imported ${lib.length} books, ${lib.filter(b => b.notes).length} with private notes.${had ? ' Your shop, picks and edits were kept.' : ''}`;
    if (!had) Object.assign(state, { profile: '', shelves: [], pinned: {}, dismissed: {}, feedback: [], chat: [], tableSeen: [] });
    else state.profileStale = true;
    state.stage = 'taste';
    save(); renderAll(); window.scrollTo(0, 0);
    if (!state.profile.trim()) generateProfile();
  } catch {
    $('importerr').textContent = $('tasteerr').textContent = 'Could not read that CSV. Use the Goodreads library export.';
  }
}
['csv', 'csv2'].forEach(id => $(id).onchange = e => { importFile(e.target.files[0]); e.target.value = ''; });
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
// Shelf requests share a small queue so the shop never floods the server (the local server allows 5 at once).
const queue = []; let active = 0; const MAX_ACTIVE = 3;
const enqueue = fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const j = queue.shift(); active++;
    j.fn().then(j.resolve, j.reject).finally(() => { active--; pump(); });
  }
}
// Reviews are only needed for the taste profile; other calls get a lighter library (private notes stay).
const slimLibrary = () => state.library.map(({ review, ...rest }) => rest);

/* ---------- Steps ---------- */
function goStage(stage) { state.stage = stage; save(); renderAll(); window.scrollTo(0, 0); }
function renderSteps() {
  const can = { import: true, taste: state.library.length > 0, shop: state.shelves.length > 0 };
  $('steps').innerHTML = [['import', '1 · Import'], ['taste', '2 · Your taste'], ['shop', '3 · Your shop']]
    .map(([s, l]) => `<button data-s="${s}" class="${state.stage === s ? 'on' : ''}" ${can[s] ? '' : 'disabled'}>${l}</button>`).join('');
  $('steps').querySelectorAll('button').forEach(b => b.onclick = () => goStage(b.dataset.s));
  ['import', 'taste', 'shop'].forEach(s => $('step-' + s).hidden = state.stage !== s);
}

/* ---------- 2. Taste description (editable statements) ---------- */
let profiling = false;
async function generateProfile() {
  if (profiling || !state.library.length) return;
  profiling = true; $('tasteerr').textContent = ''; renderTaste();
  try { state.profile = (await api('profile', { library: state.library })).profile; state.profileStale = false; save(); }
  catch (e) { $('tasteerr').textContent = (e && e.message) || 'Could not read your library. Try “Re-read my library”.'; }
  profiling = false; renderTaste();
}
function parseStatements(p) {
  const text = String(p || '');
  const lines = text.split('\n').map(l => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  return lines.length > 1 ? lines : text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);   // older prose profiles become sentences
}
function syncStatements() {
  state.profile = [...$('statements').querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean).map(s => '- ' + s).join('\n');
  save(); renderBuild();
}
function renderStatements() {
  if (profiling) {
    $('statements').innerHTML = '<div class="by" style="margin-bottom:8px">Reading your library and writing up your taste…</div>' + '<div class="skelline"></div>'.repeat(6);
  } else {
    $('statements').innerHTML = parseStatements(state.profile).map(s => `<div class="stmt"><input type="text" value="${esc(s)}"><button class="x" title="Remove" aria-label="Remove">×</button></div>`).join('')
      || '<div class="by" style="margin-bottom:8px">No description yet. Press “Re-read my library”.</div>';
    $('statements').querySelectorAll('.stmt').forEach(row => {
      row.querySelector('input').oninput = syncStatements;
      row.querySelector('.x').onclick = () => { row.remove(); syncStatements(); };
    });
  }
  $('stale').hidden = !(state.profileStale && state.profile.trim() && !profiling);
  $('reprofile').disabled = profiling;
}
function addStatement() {
  const v = $('newstmt').value.trim(); if (!v) return;
  state.profile = (state.profile.trim() ? state.profile.trim() + '\n' : '') + '- ' + v;
  $('newstmt').value = ''; save(); renderStatements(); renderBuild();
}
$('addstmt').onclick = addStatement;
$('newstmt').onkeydown = e => { if (e.key === 'Enter') addStatement(); };
$('reprofile').onclick = () => {
  if (state.profile.trim() && !confirm('Rewrite the description from your library? Your edits to it will be replaced.')) return;
  generateProfile();
};
function renderLib() {
  const lib = state.library;
  const read = lib.filter(b => b.shelf === 'read'), tr = lib.filter(b => b.shelf === 'to-read');
  const rated = read.filter(b => b.rating > 0), notes = lib.filter(b => b.notes).length;
  const avg = rated.length ? (rated.reduce((a, b) => a + b.rating, 0) / rated.length).toFixed(1) : '–';
  $('stats').innerHTML = lib.length ? `<div><b>${read.length}</b>read</div><div><b>${tr.length}</b>to-read</div><div><b>${avg}</b>avg ★</div><div><b>${notes}</b>notes</div>` : '';
  $('rated').innerHTML = [...rated].sort((a, b) => b.rating - a.rating).map(b => `<div class="mini">${'★'.repeat(Math.round(b.rating))} ${esc(b.title)} <span>· ${esc(b.author)}</span></div>`).join('');
  $('libmsg').hidden = !libMsg; $('libmsg').textContent = libMsg;
}

/* ---------- 3. The reader's brief ---------- */
$('interests').oninput = () => { state.brief.interests = $('interests').value; save(); };
$('nextread').oninput = () => { state.brief.next = $('nextread').value; save(); };
function renderBuild() {
  $('build').disabled = profiling || building || !state.profile.trim();
  $('build').textContent = building ? 'Stocking…' : state.shelves.length ? 'Rebuild my shop' : 'Build my shop';
  $('toshop').hidden = !state.shelves.length;
}
function renderTaste() {
  renderLib(); renderStatements(); renderBuild();
  if (document.activeElement !== $('interests')) $('interests').value = state.brief.interests || '';
  if (document.activeElement !== $('nextread')) $('nextread').value = state.brief.next || '';
}
$('build').onclick = () => buildShop();
$('toshop').onclick = () => goStage('shop');
function renderChips() {
  document.querySelectorAll('.chipbox').forEach(box => {
    box.innerHTML = CHIPS.map(c => `<span class="chip ${state.chips[c] ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</span>`).join('');
    box.querySelectorAll('.chip').forEach(el => el.onclick = () => { state.chips[el.dataset.c] = !state.chips[el.dataset.c]; save(); renderChips(); });
  });
}

/* ---------- 6. Refine: written feedback, chips, filters (pins and dismissals count too) ---------- */
function renderFeedback() {
  const np = Object.keys(state.pinned).length, nd = Object.keys(state.dismissed).length;
  $('fbmeta').textContent = `Write what to change and restock. Your ${np} pinned book${np === 1 ? '' : 's'} and ${nd} “not for me” choice${nd === 1 ? '' : 's'} are used as feedback too.`;
  $('fblist').innerHTML = state.feedback.map((f, i) => `<div class="fbitem"><span>“${esc(f)}”</span><button class="x" data-i="${i}" title="Remove" aria-label="Remove">×</button></div>`).join('');
  $('fblist').querySelectorAll('button').forEach(b => b.onclick = () => { state.feedback.splice(+b.dataset.i, 1); save(); renderFeedback(); });
}
$('restock').onclick = () => {
  const v = $('fb').value.trim();
  if (v) { state.feedback.push(v); state.feedback = state.feedback.slice(-10); $('fb').value = ''; }
  save(); renderFeedback(); buildShop();
};
$('fb').onkeydown = e => { if (e.key === 'Enter') $('restock').click(); };
$('edittaste').onclick = () => goStage('taste');
function renderFilters() {
  $('filters').innerHTML = Object.entries(FILTERS).map(([k, opts]) =>
    `<select data-f="${k}" aria-label="${k}">${opts.map(([v, l]) => `<option value="${v}" ${state.filters[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`).join('');
  $('filters').querySelectorAll('select').forEach(sel => sel.onchange = () => { state.filters[sel.dataset.f] = sel.value; save(); draw(); });
}
// Filters hide what is already on the shelves. Kind and pages come from the model, so they are approximate; unknown values are never hidden.
const passes = b => {
  const f = state.filters, y = parseInt(b.year, 10), now = new Date().getFullYear();
  if (f.kind !== 'any' && b.kind && b.kind !== f.kind) return false;
  if (f.length === 'short' && b.pages && b.pages >= 300) return false;
  if (f.length === 'long' && b.pages && b.pages < 500) return false;
  if (f.era === 'recent' && y && y < now - 10) return false;
  if (f.era === 'older' && y && y >= 2000) return false;
  return true;
};

/* ---------- Ask the shop (general) ---------- */
function askContext() {
  return {
    library: slimLibrary(), profile: state.profile, brief: state.brief, feedback: state.feedback,
    shelves: state.shelves.filter(s => s.books.length).map(s => ({ shelf: s.shelf, books: s.books.slice(0, 25).map(b => ({ title: b.title, author: b.author, year: b.year, pitch: b.pitch })) })),
    pinned: Object.values(state.pinned).map(b => `${b.title} — ${b.author}`),
    dismissed: Object.values(state.dismissed).map(d => `${d.title} — ${d.author}${d.reason ? ` (reason: ${d.reason})` : ''}`),
  };
}
const threadHTML = chat => chat.map(m => `<div class="msg q">${esc(m.q)}</div><div class="msg a ${m.a ? '' : 'pending'}">${esc(m.a || 'Thinking…')}</div>`).join('');
let asking = false;
function renderChat() {
  const t = $('thread'); t.innerHTML = threadHTML(state.chat); t.scrollTop = t.scrollHeight;
  $('askacts').hidden = !state.chat.length;
  $('ask').disabled = asking || !state.library.length;
}
async function askShop() {
  const q = $('q').value.trim();
  if (!q || asking || !state.library.length) return;
  asking = true; $('q').value = '';
  const history = state.chat.filter(m => m.a).slice(-6);
  const turn = { q, a: '' }; state.chat.push(turn); renderChat();
  try { turn.a = (await api('ask', { ...askContext(), question: q, history })).answer || 'No answer came back. Try asking again.'; }
  catch (e) { turn.a = `Could not answer: ${(e && e.message) || 'error'}`; }
  state.chat = state.chat.slice(-20); asking = false; save(); renderChat();
}
$('ask').onclick = askShop;
$('q').onkeydown = e => { if (e.key === 'Enter') askShop(); };
$('clearchat').onclick = () => { state.chat = []; save(); renderChat(); };

/* ---------- Tiles and the book sheet (5. dive into one book) ---------- */
function coverHTML(b, big) {
  const c = hue(b.title), c2 = hue(b.author + 'x');
  return `<div class="cover ${big ? 'big' : ''}" style="background:linear-gradient(155deg,${c},${c2})">
    ${state.pinned[key(b)] ? '<span class="badge">★ pinned</span>' : ''}
    <div class="ct">${esc(b.title)}</div><div class="ca">${esc(b.author)}</div>
    ${(state.covers[key(b)] || b.cover) ? `<img src="${esc(state.covers[key(b)] || b.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>`;
}
function hideBrokenCovers(root) {
  if (!root) return;
  root.querySelectorAll('.cover img').forEach(img => {
    const drop = () => img.remove();
    img.addEventListener('error', drop);
    img.addEventListener('load', () => { if (img.naturalWidth < 20) drop(); });   // Open Library's 1x1 "no cover" placeholder
  });
}
const find = k => state.shelves.flatMap(s => s.books).find(x => key(x) === k) || state.pinned[k];
const meta = b => [b.year, b.pages ? `~${b.pages}pp` : ''].filter(Boolean).join(' · ');
const tile = b => `<div class="tile" data-k="${esc(key(b))}">${coverHTML(b)}<div class="tp">${esc(b.pitch || '')}</div>${meta(b) ? `<div class="tm">${esc(meta(b))}</div>` : ''}</div>`;

let openKey = null, sheetMode = '', readStars = 0;
const bookAsking = new Set();
function actionsHTML(b) {
  const pinned = !!state.pinned[key(b)];
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
  const askUI = `<div class="bookask"><h4>Ask about this book</h4><div id="bthread">${threadHTML(b.chat || [])}</div>
    <div class="steer"><input type="text" id="bq" placeholder="e.g. Is it slow to start? How does it compare with Excession?"><button id="bask">Ask</button></div></div>`;
  const setCoverUI = `<details style="margin-top:10px"><summary>Set cover image</summary><div style="margin-top:8px"><input type="text" id="coverurl" placeholder="Paste an image address (https://…)">
    <div class="acts"><button data-a="savecover">Use this address</button><label class="tag link-label">or choose a file<input id="coverfile" type="file" accept="image/*" hidden></label>${state.covers[k] ? '<button data-a="clearcover">Remove custom cover</button>' : ''}</div></div></details>`;
  return `${coverHTML(b, true)}<div style="flex:1;min-width:0"><h2>${esc(b.title)}</h2><div class="by">${esc(b.author)}${meta(b) ? ' · ' + esc(meta(b)) : ''}</div>${b.pitch && !b.why ? `<div class="why" id="pitchline">${esc(b.pitch)}</div>` : ''}<div id="detail">${detailHTML(b)}</div>
    ${actionsHTML(b)}${sheetMode ? '' : askUI + setCoverUI}</div>`;
}
const redrawSheet = k => { const b = find(k); if (b && openKey === k) { $('sheet').innerHTML = sheetHTML(b); bindSheet(k); } };
function renderBookThread(k) {
  const b = find(k), t = $('bthread');
  if (!b || !t || openKey !== k) return;
  t.innerHTML = threadHTML(b.chat || []);
  if (t.lastElementChild) t.lastElementChild.scrollIntoView({ block: 'nearest' });
  if ($('bask')) $('bask').disabled = bookAsking.has(k);
}
async function askBook(k) {
  const b = find(k), inp = $('bq'); if (!b || !inp) return;
  const q = inp.value.trim(); if (!q || bookAsking.has(k)) return;
  b.chat = b.chat || [];
  const history = b.chat.filter(t => t.a).slice(-6), turn = { q, a: '' };
  b.chat.push(turn); inp.value = ''; bookAsking.add(k); renderBookThread(k);
  try {
    turn.a = (await api('ask', { ...askContext(), question: q, history, focus: { title: b.title, author: b.author, year: b.year, pitch: b.pitch, why: b.why } })).answer || 'No answer came back. Try again.';
  } catch (e) { turn.a = `Could not answer: ${(e && e.message) || 'error'}`; }
  b.chat = b.chat.slice(-12); bookAsking.delete(k); save(); renderBookThread(k);
}
function setCover(k, src) {
  if (src) state.covers[k] = src; else delete state.covers[k];
  save(); draw(); redrawSheet(k);
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
  if ($('bask')) { $('bask').onclick = () => askBook(k); $('bq').onkeydown = e => { if (e.key === 'Enter') askBook(k); }; $('bask').disabled = bookAsking.has(k); }
  $('sheet').querySelectorAll('.rchip').forEach(c => c.onclick = () => c.classList.toggle('on'));
  $('sheet').querySelectorAll('button[data-a]').forEach(btn => btn.onclick = () => {
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
    save(); closeModal(); draw(); renderFeedback(); renderLib();
    if (a === 'more') moreLike(b);
  });
}
function refreshDetail(k) {   // only the explanation block, so anything being typed in the sheet survives
  const b = find(k), d = $('detail');
  if (!b || !d || openKey !== k) return;
  d.innerHTML = detailHTML(b);
  d.querySelectorAll('button[data-a=retry]').forEach(btn => btn.onclick = () => explainBook(k));
  if (b.why && $('pitchline')) $('pitchline').remove();
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

/* ---------- 4. Shelves: rows you scroll across; they keep stocking as you reach the end ---------- */
const skel = (n, faint) => `<div class="skel${faint ? ' faint' : ''}"></div>`.repeat(n);
function rowHead(id, title, blurb, count, removable) {
  return `<div class="shelfhead"><div class="grow"><h2>${esc(title)} ${count}</h2><p>${esc(blurb)}</p></div>
    <div class="arrows">${removable ? `<button class="x" data-act="remove" data-id="${id}" title="Remove this shelf" aria-label="Remove this shelf">×</button>` : ''}<button data-act="left" aria-label="Scroll left">‹</button><button data-act="right" aria-label="Scroll right">›</button></div></div>`;
}
function pinnedHTML() {
  const ps = Object.values(state.pinned);
  if (!ps.length) return '';
  return `<section class="shelf" data-id="pinned">${rowHead('pinned', 'Your shortlist', 'Books you pinned. They also steer every restock.', `<span class="tag-s">${ps.length}</span>`)}<div class="row" data-id="pinned">${ps.map(tile).join('')}</div></section>`;
}
function shelfHTML(s) {
  const id = esc(s.id), shown = s.books.filter(passes);
  let tail = '';
  if (s.status === 'idle') tail = skel(7, true);
  else if (s.status === 'loading') tail = skel(s.books.length ? 3 : 7);
  else if (s.status === 'error') tail = `<div class="endcap"><span class="err">${esc(s.error)}</span><button data-act="retry" data-id="${id}">Try again</button></div>`;
  else if (s.idx === 0) tail = `<div class="endcap">Want a different window?<button data-act="fresh" data-id="${id}">Freshen the window</button></div>`;
  else tail = `<div class="endcap">${s.exhausted ? 'That’s all I found for now.' : 'Scroll on for more'}<button data-act="more" data-id="${id}">${s.exhausted ? 'Try for more' : 'More →'}</button></div>`;
  const none = s.status === 'done' && s.books.length && !shown.length ? '<div class="endcap">Nothing here matches your filters.</div>' : '';
  const count = s.books.length ? `<span class="tag-s">${shown.length === s.books.length ? s.books.length : `${shown.length} of ${s.books.length}`}</span>` : '';
  return `<section class="shelf" data-id="${id}">${rowHead(id, s.shelf, s.blurb, count, !!s.seed)}<div class="row" data-id="${id}">${shown.map(tile).join('')}${none}${tail}</div></section>`;
}
function draw() {
  const root = $('shelves');
  const pos = {}; root.querySelectorAll('.row').forEach(r => pos[r.dataset.id] = r.scrollLeft);   // keep each row where you left it
  if (!state.shelves.length) { root.innerHTML = '<div class="empty">Your shelves appear here once you build the shop.</div>'; return; }
  root.innerHTML = pinnedHTML() + state.shelves.map(shelfHTML).join('');
  root.querySelectorAll('.row').forEach(r => { if (pos[r.dataset.id]) r.scrollLeft = pos[r.dataset.id]; });
  hideBrokenCovers(root);
  pumpLazy();
}
function drawShelf(s) {
  const el = $('shelves').querySelector(`section[data-id="${CSS.escape(s.id)}"]`);
  if (!el) return draw();
  const x = el.querySelector('.row') ? el.querySelector('.row').scrollLeft : 0;
  el.outerHTML = shelfHTML(s);
  const now = $('shelves').querySelector(`section[data-id="${CSS.escape(s.id)}"]`);
  now.querySelector('.row').scrollLeft = x;
  hideBrokenCovers(now);
  pumpLazy();
}
$('shelves').addEventListener('click', e => {
  const t = e.target.closest('.tile'); if (t) return openBook(t.dataset.k);
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const a = btn.dataset.act;
  if (a === 'left' || a === 'right') {
    const r = btn.closest('.shelf').querySelector('.row');
    return r.scrollBy({ left: (a === 'left' ? -1 : 1) * r.clientWidth * 0.85, behavior: 'smooth' });
  }
  const s = state.shelves.find(x => x.id === btn.dataset.id); if (!s) return;
  if (a === 'more') loadShelf(s, 'more');
  if (a === 'fresh') loadShelf(s, 'replace');
  if (a === 'retry') loadShelf(s, 'fresh');
  if (a === 'remove') { state.shelves = state.shelves.filter(x => x !== s); save(); draw(); }
});
// Reaching the right-hand end of a row stocks more books on it, so the shelves feel endless.
$('shelves').addEventListener('scroll', e => {
  const row = e.target;
  if (!row.classList || !row.classList.contains('row')) return;
  if (row.scrollLeft + row.clientWidth < row.scrollWidth - 450) return;
  const s = state.shelves.find(x => x.id === row.dataset.id);
  if (s && s.idx !== 0 && s.status === 'done' && !s.exhausted && s.books.length < MAX_PER_SHELF) loadShelf(s, 'more');
}, true);

function baseBody() {
  return {
    library: slimLibrary(), profile: state.profile, brief: state.brief, feedback: state.feedback,
    steer: Object.keys(state.chips).filter(k => state.chips[k]),
    pinned: Object.values(state.pinned).map(b => `${b.title} — ${b.author}`),
    dismissed: Object.values(state.dismissed).map(d => `${d.title} — ${d.author}${d.reason ? ` (reason: ${d.reason})` : ''}`),
    dismissedKeys: Object.keys(state.dismissed),
  };
}
// mode: 'fresh' (new stock), 'more' (add to the end), 'replace' (a new front-table window, avoiding earlier ones)
function shelfBody(s, mode) {
  const body = baseBody();
  if (s.seed) body.seed = s.seed; else body.shelf = s.idx;
  const ex = mode === 'more' ? s.books : mode === 'replace' ? [...s.books, ...(state.tableSeen || [])] : s.idx === 0 ? (state.tableSeen || []) : [];
  if (ex.length) body.exclude = ex.map(x => ({ title: x.title, author: x.author }));
  return body;
}
const inflight = new Map();   // shelf id -> the request already running for it
function loadShelf(s, mode = 'fresh') {
  if (s.status === 'loading' && inflight.has(s.id)) return inflight.get(s.id);
  const p = runShelf(s, mode).finally(() => inflight.delete(s.id));
  inflight.set(s.id, p); return p;
}
async function runShelf(s, mode) {
  s.status = 'loading'; s.error = ''; drawShelf(s);
  try {
    const out = await enqueue(() => api('shelf', shelfBody(s, mode)));
    const have = new Set(s.books.map(key));
    // a book sits on one themed shelf only (the front table and "more like this" shelves may overlap)
    const taken = (s.seed || s.idx === 0) ? new Set() : new Set(state.shelves.filter(x => x !== s && x.idx > 0).flatMap(x => x.books.map(key)));
    const fresh = out.books.filter(b => !taken.has(key(b)) && !state.dismissed[key(b)] && !(mode === 'more' && have.has(key(b))));
    s.books = mode === 'more' ? s.books.concat(fresh) : fresh;
    s.exhausted = mode === 'more' ? fresh.length === 0 || s.books.length >= MAX_PER_SHELF : false;
    s.blurb = out.blurb || s.blurb; s.status = 'done';
    if (s.idx === 0) state.tableSeen = [...s.books.map(b => ({ title: b.title, author: b.author })), ...(state.tableSeen || [])].slice(0, 30);
  } catch (e) { s.status = 'error'; s.error = `Could not load this shelf: ${(e && e.message) || 'error'}`; }
  save(); drawShelf(s);
}
// Shelves further down the page are stocked as you scroll toward them, a couple at a time.
function pumpLazy() {
  if (state.stage !== 'shop') return;
  if (state.shelves.filter(s => s.status === 'loading').length >= 2) return;
  const next = state.shelves.find(s => s.status === 'idle'); if (!next) return;
  const el = $('shelves').querySelector(`section[data-id="${CSS.escape(next.id)}"]`);
  if (el && el.getBoundingClientRect().top < window.innerHeight + 700) loadShelf(next, 'fresh');
}
let scrollTick = false;
window.addEventListener('scroll', () => { if (scrollTick) return; scrollTick = true; requestAnimationFrame(() => { scrollTick = false; pumpLazy(); }); }, { passive: true });

function moreLike(b) {
  const id = 'seed:' + key(b);
  state.shelves = state.shelves.filter(x => x.id !== id);
  const s = { id, idx: null, seed: { title: b.title, author: b.author }, shelf: `More like ${b.title}`, blurb: `Because you were looking at ${b.title} by ${b.author}.`, books: [], status: 'idle' };
  state.shelves.unshift(s); save(); draw();
  $('shelves').scrollIntoView({ behavior: 'smooth', block: 'start' });
  loadShelf(s, 'fresh');
}

let building = false;
async function buildShop() {
  if (building || !state.profile.trim()) return;
  building = true; renderBuild(); $('err').textContent = ''; $('tasteerr').textContent = '';
  try {
    const layout = (await getConfig()).shelves || [];
    if (!layout.length) throw new Error('Could not load the shop layout from the server.');
    const seeded = state.shelves.filter(s => s.seed).map(s => ({ ...s, books: [], status: 'idle', exhausted: false }));
    state.shelves = [...layout.map((s, i) => ({ id: 's' + i, idx: i, shelf: s.title, blurb: s.blurb, books: [], status: 'idle' })), ...seeded];
    state.stage = 'shop'; save(); renderAll(); window.scrollTo(0, 0);
    const first = state.shelves.filter(s => s.idx != null && s.idx < EAGER);
    await Promise.all(first.map(s => loadShelf(s, 'fresh')));
    const failed = first.filter(s => s.status === 'error').length;
    if (failed) $('err').textContent = `${failed} of ${first.length} shelves failed. Use “Try again” on the shelf.`;
  } catch (e) { (state.stage === 'shop' ? $('err') : $('tasteerr')).textContent = (e && e.message) || 'Something went wrong. Try again.'; }
  building = false; renderBuild();
}

function renderAll() {
  renderSteps(); renderTaste(); renderChips(); renderFilters(); renderFeedback(); renderChat(); draw();
}
renderAll();
if (state.stage === 'taste' && !state.profile.trim()) generateProfile();
