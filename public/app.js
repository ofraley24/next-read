'use strict';
const CHIPS = ['More optimistic','Shorter (<350 pages)','Non-fiction','Wildcard: outside my usual','Lighter tone','Older classics','Harder ideas','Recent (last 5 yrs)'];
const COLORS = ['#8c3b2a','#2f5d50','#b08a3e','#4a5d8c','#7a4a78','#5d6b3a'];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const norm = s => String(s||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/\(.*?\)/g,' ').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const key = b => `${norm(b.title)}|${norm(b.author)}`;
const hue = s => { let h = 0; for (const c of s) h = (h*31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };

const KEY = 'nextread.v1';
let state = { library: [], profile: '', shelves: [], pinned: {}, dismissed: {}, chips: {}, passcode: '' };
try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
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
      review: (r['My Review'] || '').replace(/<br\s*\/?>/g, ' ').trim() };
  });
}
$('csv').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const lib = fromCSV(parseCSV(await f.text()));
    if (!lib.length) throw new Error('empty');
    Object.assign(state, { library: lib, profile: '', shelves: [], pinned: {}, dismissed: {} });
    save(); renderAll();
  } catch { $('err').textContent = 'Could not read that CSV. Use the Goodreads library export.'; }
};
$('reset').onclick = () => { if (confirm('Clear saved library, picks and passcode on this device?')) { try { localStorage.removeItem(KEY); } catch {} location.reload(); } };

/* ---------- API ---------- */
async function api(path, body) {
  if (!state.passcode) { state.passcode = prompt('Passcode for this site:') || ''; save(); }
  const res = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-passcode': state.passcode }, body: JSON.stringify(body) });
  let data = {}; try { data = await res.json(); } catch {}
  if (res.status === 401) { state.passcode = ''; save(); throw new Error('Wrong passcode. Try again.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------- UI ---------- */
function renderLib() {
  const lib = state.library;
  const read = lib.filter(b => b.shelf === 'read'), tr = lib.filter(b => b.shelf === 'to-read');
  const rated = read.filter(b => b.rating > 0);
  const avg = rated.length ? (rated.reduce((a, b) => a + b.rating, 0) / rated.length).toFixed(1) : '–';
  $('stats').innerHTML = lib.length ? `<div><b>${read.length}</b>read</div><div><b>${tr.length}</b>to-read</div><div><b>${avg}</b>avg ★</div>` : '<span>No library yet.</span>';
  $('rated').innerHTML = [...rated].sort((a, b) => b.rating - a.rating).map(b => `<div class="mini">${'★'.repeat(Math.round(b.rating))} ${esc(b.title)} <span>· ${esc(b.author)}</span></div>`).join('');
}
function renderChips() {
  $('chips').innerHTML = CHIPS.map(c => `<span class="chip ${state.chips[c] ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</span>`).join('');
  $('chips').querySelectorAll('.chip').forEach(el => el.onclick = () => { state.chips[el.dataset.c] = !state.chips[el.dataset.c]; save(); renderChips(); });
}
function coverHTML(b, big) {
  const c = hue(b.title), c2 = hue(b.author + 'x');
  return `<div class="cover ${big ? 'big' : ''}" style="background:linear-gradient(155deg,${c},${c2})">
    ${state.pinned[key(b)] ? '<span class="badge">★ pinned</span>' : ''}
    <div class="ct">${esc(b.title)}</div><div class="ca">${esc(b.author)}</div>
    ${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>`;
}
function hideBrokenCovers(root) {
  root.querySelectorAll('.cover img').forEach(img => {
    const drop = () => img.remove();
    img.addEventListener('error', drop);
    // Open Library serves a 1x1 placeholder when it has no cover
    img.addEventListener('load', () => { if (img.naturalWidth < 20) drop(); });
  });
}
const find = k => state.shelves.flatMap(s => s.books).find(x => key(x) === k);
const tile = b => `<div class="tile" data-k="${esc(key(b))}">${coverHTML(b)}<div class="tp">${esc(b.pitch || '')}</div></div>`;

function openBook(k) {
  const b = find(k); if (!b) return;
  const pinned = !!state.pinned[k];
  $('sheet').innerHTML = `${coverHTML(b, true)}<div><h2>${esc(b.title)}</h2><div class="by">${esc(b.author)}${b.year ? ' · ' + esc(b.year) : ''}</div>
    <div class="why">${esc(b.why)}</div>
    <div class="links">${(b.links || []).map(l => `<span class="link">↔ ${esc(l)}</span>`).join('')}</div>
    <div class="links" style="margin-top:8px">${(b.themes || []).map(t => `<span class="tag-s">${esc(t)}</span>`).join('')}</div>
    ${b.caution ? `<div class="caution" style="margin-top:10px">Might not land: ${esc(b.caution)}</div>` : ''}
    <div class="acts"><button class="primary" data-a="pin">${pinned ? 'Unpin' : 'Pin to shortlist'}</button><button data-a="more">More like this</button><button data-a="no">Not for me</button><button data-a="close">Close</button></div></div>`;
  hideBrokenCovers($('sheet'));
  $('modal').classList.add('open');
  $('sheet').querySelectorAll('button').forEach(btn => btn.onclick = () => {
    const a = btn.dataset.a;
    if (a === 'pin') { if (state.pinned[k]) delete state.pinned[k]; else state.pinned[k] = b; }
    if (a === 'no') { state.dismissed[k] = { title: b.title, author: b.author }; delete state.pinned[k]; state.shelves.forEach(s => s.books = s.books.filter(x => key(x) !== k)); }
    if (a === 'more') $('free').value = `more like ${b.title} by ${b.author}`;
    save(); $('modal').classList.remove('open'); renderShelves(); renderShort();
    if (a === 'more') $('free').focus();
  });
}
$('modal').onclick = e => { if (e.target.id === 'modal') $('modal').classList.remove('open'); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('modal').classList.remove('open'); });

function renderShelves() {
  if (!state.shelves.length) {
    $('shelves').innerHTML = state.library.length
      ? '<div class="empty">Library loaded. Press <b>Build my shop</b> and I’ll read your taste, then stock your shelves.</div>'
      : '<div class="empty">Import your Goodreads export (Goodreads → My Books → Import and export → Export Library) to begin.</div>';
    return;
  }
  $('shelves').innerHTML = state.shelves.map(s => `<section class="shelf"><h2>${esc(s.shelf)}</h2><p>${esc(s.blurb)}</p><div class="grid">${s.books.map(tile).join('') || '<div class="empty">Nothing left on this shelf. Refresh.</div>'}</div></section>`).join('');
  $('shelves').querySelectorAll('.tile').forEach(el => el.onclick = () => openBook(el.dataset.k));
  hideBrokenCovers($('shelves'));
}
function renderShort() {
  const ps = Object.values(state.pinned);
  $('slc').textContent = ps.length;
  $('shortlist').innerHTML = ps.map(b => `<li><b>${esc(b.title)}</b> <span class="by">${esc(b.author)}</span></li>`).join('') || '<li class="by">Nothing pinned yet.</li>';
}
function renderAll() {
  renderLib(); renderChips(); renderShelves(); renderShort();
  $('profile').value = state.profile || '';
  $('go').textContent = state.shelves.length ? 'Refresh the shop' : 'Build my shop';
  $('go').disabled = !state.library.length;
}
$('profile').oninput = () => { state.profile = $('profile').value; save(); };

$('go').onclick = async () => {
  const btn = $('go'); btn.disabled = true; $('err').textContent = '';
  const skel = n => `<div class="grid">${'<div class="skel"></div>'.repeat(n)}</div>`;
  try {
    if (!state.profile.trim()) {
      btn.textContent = 'Reading your taste…'; $('shelves').innerHTML = skel(6);
      state.profile = (await api('profile', { library: state.library })).profile;
      $('profile').value = state.profile; save();
    }
    btn.textContent = 'Stocking the shelves…'; $('shelves').innerHTML = skel(8);
    const steer = [...Object.keys(state.chips).filter(k => state.chips[k]), $('free').value.trim()].filter(Boolean);
    const out = await api('recommend', {
      library: state.library, profile: state.profile, steer,
      pinned: Object.values(state.pinned).map(b => `${b.title} — ${b.author}`),
      dismissed: Object.values(state.dismissed).map(b => `${b.title} — ${b.author}`),
      dismissedKeys: Object.keys(state.dismissed),
    });
    state.shelves = out.shelves; save();
  } catch (e) { $('err').textContent = e.message || 'Something went wrong. Try again.'; }
  renderAll();
};
renderAll();
