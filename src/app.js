import { parseDataset, profile } from './data.js';
import { runPipeline } from './agents.js';
import { SAMPLES, createMarket } from './seed.js';
import {
  JOB_TYPES, TYPE_ORDER, PRIVACY, parseJobDescription, match, book, advance, progress, stage, rate, cancel,
  addProvider, saveTemplate, tickAmbient, surgeMultiplier, used, fmtRows,
} from './market.js';

const KEY = 'hailset.market.v1';
const RKEY = 'hailset.results.v1';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = x => `$${Number(x).toFixed(2)}`;
const stars = r => (r == null ? '<span class="muted">new</span>' : `★ ${Number(r).toFixed(2)}`);

let market = load(KEY) || createMarket();
let results = load(RKEY) || {};
let anchor = { real: Date.now(), sim: market.clock || 0 };
let ds = null, prof = null, sampleRows = null;
let types = [];
let lastOffers = null;
const params = new URLSearchParams(location.search);
const initialHash = location.hash.slice(1);

function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(market)); } catch {}
  try { localStorage.setItem(RKEY, JSON.stringify(results)); } catch {
    // results can be large: keep only the newest few when storage is full
    const keep = market.jobs.slice(0, 5).map(j => j.id);
    results = Object.fromEntries(Object.entries(results).filter(([k]) => keep.includes(k)));
    try { localStorage.setItem(RKEY, JSON.stringify(results)); } catch {}
  }
}
const now = () => anchor.sim + (Date.now() - anchor.real) / 1000; // 1 s = 1 simulated minute

// ---------- tabs ----------
function show(tab) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('on', s.id === `tab-${tab}`));
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `${location.search}#${tab}`);
  render();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.tab); });

// ---------- dataset ----------
$('#samples').innerHTML = SAMPLES.map((s, i) => `<button type="button" data-i="${i}"><b>${esc(s.title)}</b><span>${esc(s.file)} · quote ${fmtRows(s.fullRows)}</span></button>`).join('');
$('#samples').addEventListener('click', e => { const b = e.target.closest('button'); if (b) useSample(+b.dataset.i); });

function useSample(i) {
  const s = SAMPLES[i];
  setDataset(s.file, s.text, s.fullRows);
  $('#desc').value = s.description;
  onDesc();
}

$('#file').addEventListener('change', e => readFile(e.target.files[0]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => readFile(e.dataTransfer.files[0]));

async function readFile(f) {
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) { $('#profile').innerHTML = '<p class="err">That file is over 20 MB. Drop a sample of it and set "Quote for" to the full row count.</p>'; return; }
  setDataset(f.name, await f.text(), null);
}

function setDataset(name, text, fullRows) {
  try { ds = parseDataset(name, text); } catch (err) {
    ds = null; $('#profile').innerHTML = `<p class="err">Couldn't parse ${esc(name)}: ${esc(err.message)}</p>`; return;
  }
  prof = profile(ds);
  sampleRows = fullRows;
  $('#rows').value = fullRows || prof.rows;
  if (prof.suggestedPrivacy === 'private' && $('#privacy').value === 'any') $('#privacy').value = 'private';
  const prev = ds.records.slice(0, 4);
  const cols = ds.columns.slice(0, 7);
  $('#profile').innerHTML = `
    <div class="prof">
      <div><b>${esc(ds.name)}</b> · ${ds.format.toUpperCase()} · ${prof.rows.toLocaleString()} rows × ${ds.columns.length} columns · ${(ds.bytes / 1024).toFixed(1)} KB
      ${fullRows ? `<span class="muted"> (sample of a ${fmtRows(fullRows)} file)</span>` : ''}</div>
      ${prof.piiColumns.length ? `<div class="pii">PII detected in ${prof.piiColumns.map(esc).join(', ')}. Private route suggested.</div>` : ''}
      <div class="colchips">${prof.columns.map(c => `<span class="${c.pii ? 'piic' : ''}">${esc(c.name)} <i>${c.type}</i></span>`).join('')}</div>
      <div class="scroll"><table class="mini"><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
      ${prev.map(r => `<tr>${cols.map(c => `<td>${esc(String(r[c] ?? '').slice(0, 40))}</td>`).join('')}</tr>`).join('')}</table></div>
    </div>`;
  lastOffers = null; renderOffers();
}

// ---------- job ----------
$('#privacy').innerHTML = Object.entries(PRIVACY).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
function renderTemplates() {
  $('#template').innerHTML = '<option value="">Templates…</option>' + market.templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
}
$('#template').addEventListener('change', e => {
  const t = market.templates.find(x => x.id === e.target.value);
  if (!t) return;
  $('#desc').value = t.description; types = [...t.types];
  $('#speed').value = t.speedVsCost; $('#privacy').value = t.privacy; $('#human').checked = t.humanReview;
  renderTypes(); e.target.value = '';
});
$('#saveTpl').addEventListener('click', () => {
  const name = prompt('Template name', $('#desc').value.slice(0, 40) || 'My job');
  if (!name) return;
  saveTemplate(market, name, readRequest()); save(); renderTemplates();
});

$('#desc').addEventListener('input', onDesc);
function onDesc() {
  const { types: t, hints, understood } = parseJobDescription($('#desc').value);
  types = t;
  if (hints.speedVsCost != null) $('#speed').value = hints.speedVsCost;
  if (hints.privacy) $('#privacy').value = hints.privacy;
  if (hints.humanReview) $('#human').checked = true;
  if (hints.maxPrice) $('#maxPrice').value = hints.maxPrice;
  $('#intentHint').textContent = $('#desc').value.trim()
    ? (understood ? `Understood: ${t.map(x => JOB_TYPES[x].label.toLowerCase()).join(', ')}${Object.keys(hints).length ? ` · ${Object.entries(hints).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}. Tap a chip to change.` : 'Not sure what you need, so it defaults to clean + classify. Tap chips to choose.')
    : '';
  renderTypes();
}
function renderTypes() {
  $('#types').innerHTML = TYPE_ORDER.map(t => `<button type="button" class="chip ${types.includes(t) ? 'on' : ''}" data-t="${t}">${esc(JOB_TYPES[t].label)}</button>`).join('');
}
$('#types').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const t = b.dataset.t;
  types = types.includes(t) ? types.filter(x => x !== t) : TYPE_ORDER.filter(x => x === t || types.includes(x));
  renderTypes();
});

function readRequest() {
  return {
    name: ds ? ds.name : 'dataset', datasetName: ds?.name, description: $('#desc').value.trim(), types: TYPE_ORDER.filter(t => types.includes(t)),
    rows: Math.max(1, Math.round(+$('#rows').value || prof?.rows || 1)), columns: ds ? ds.columns.length : 8,
    privacy: $('#privacy').value, speedVsCost: +$('#speed').value, humanReview: $('#human').checked,
    maxPrice: +$('#maxPrice').value || null, deadlineMin: +$('#deadline').value || null,
  };
}

$('#findBtn').addEventListener('click', find);
function find() {
  if (!ds) { $('#offers').innerHTML = '<p class="err">Add a dataset first: pick a sample or drop a file.</p>'; return; }
  const req = readRequest();
  if (!req.types.length) { $('#offers').innerHTML = '<p class="err">Choose at least one job type.</p>'; return; }
  tickAmbient(market, now());
  lastOffers = { req, at: now(), ...match(market, req) };
  renderOffers();
}
['#speed', '#privacy', '#human', '#rows', '#maxPrice', '#deadline'].forEach(s => $(s).addEventListener('change', () => { if (lastOffers) find(); }));

function renderOffers() {
  const el = $('#offers');
  if (!lastOffers) { el.innerHTML = '<p class="empty">Pick a sample or drop a file, then find compute.</p>'; return; }
  const { offers, reason, req } = lastOffers;
  if (!offers.length) { el.innerHTML = `<p class="err">${esc(reason)}</p>`; return; }
  const byId = Object.fromEntries(market.providers.map(p => [p.id, p]));
  const agentName = id => market.agents.find(a => a.id === id)?.name || id;
  el.innerHTML = `<p class="hint">${offers.length} route${offers.length === 1 ? '' : 's'} for ${esc(fmtRows(req.rows))} · ${esc(PRIVACY[req.privacy].label.toLowerCase())} · upfront prices, held for 5 minutes</p>` + offers.map((o, i) => {
    const p = byId[o.providerId];
    return `<div class="offer ${i === 0 ? 'best' : ''}">
      <div class="ohead">
        <div><b>${esc(p.name)}</b> <span class="muted">${esc(p.kind.toUpperCase())} · ${esc(p.region)} · ${stars(p.rating)}${p.ratings ? ` (${p.ratings})` : ''}</span>
          <div class="tags">${o.tags.map(t => `<span class="t-${t.split(' ')[0].toLowerCase()}">${esc(t)}</span>`).join('')}${o.surge > 1 ? `<span class="t-surge">surge ×${o.surge}</span>` : ''}</div></div>
        <div class="price"><b>${money(o.total)}</b><span>${o.etaMin} min</span></div>
      </div>
      <div class="osum">${esc(o.summary)}</div>
      <div class="stack">${o.stack.map(s => `<span>${esc(agentName(s.agentId))}<i>${s.types.map(t => esc(JOB_TYPES[t]?.label || 'review')).join(' · ')}</i></span>`).join('')}</div>
      <details><summary>Price breakdown</summary><table class="bd">${o.lines.map(l => `<tr><td>${esc(l.label)}</td><td>${money(l.amount)}</td></tr>`).join('')}<tr class="tot"><td>Total</td><td>${money(o.total)}</td></tr></table></details>
      <button class="go small" data-book="${i}" type="button">Book · ${money(o.total)}</button>
    </div>`;
  }).join('');
}
$('#offers').addEventListener('click', e => {
  const b = e.target.closest('[data-book]'); if (!b) return;
  const o = lastOffers.offers[+b.dataset.book];
  let job;
  try { job = book(market, lastOffers.req, o, now()); } catch (err) { alert(err.message); find(); return; }
  // The agents run for real, right here, on the uploaded rows. Delivery waits for the simulated ETA.
  const { dataset, results: r } = runPipeline(ds, job.types);
  results[job.id] = pack(dataset, r);
  save(); lastOffers = null; renderOffers(); show('trips');
});

function pack(dataset, r) {
  const out = { summaries: {}, files: {}, view: {} };
  for (const [k, v] of Object.entries(r)) out.summaries[k] = v.summary;
  if (r.clean) out.files[`cleaned_${base(dataset.name)}.csv`] = toCsv(dataset);
  if (r.extract) { out.files['entities.csv'] = r.extract.csv; out.view.entities = r.extract.entities.slice(0, 12); }
  if (r.score) { out.files['ranked_leads.csv'] = r.score.csv; out.view.ranked = r.score.ranked.slice(0, 8).map(x => ({ row: x.row, score: x.score, confidence: x.confidence, why: x.why, label: x.record.name || x.record.company || '' })); }
  if (r.classify) { out.view.distribution = r.classify.distribution; out.view.columns = r.classify.columns; }
  if (r.anomaly) { out.files['anomalies.csv'] = r.anomaly.csv; out.view.flags = r.anomaly.flags.slice(0, 8); }
  if (r.forecast) out.view.forecast = { target: r.forecast.target, points: r.forecast.points, forecast: r.forecast.forecast };
  if (r.report) out.files['report.md'] = r.report.markdown;
  out.files['summary.json'] = JSON.stringify(out.summaries, null, 2) + '\n';
  return out;
}
const base = n => String(n).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
function toCsv(d) {
  const e = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [d.columns.map(e).join(','), ...d.records.map(r => d.columns.map(c => e(r[c])).join(','))].join('\n') + '\n';
}

// ---------- jobs ----------
function renderTrips() {
  const t = now();
  const el = $('#trips');
  const running = market.jobs.filter(j => j.status === 'running').length;
  $('#tripCount').textContent = running ? String(running) : '';
  if (!market.jobs.length) { el.innerHTML = '<div class="card"><p class="empty">No jobs yet. Book one from Request.</p></div>'; return; }
  const byId = Object.fromEntries(market.providers.map(p => [p.id, p]));
  el.innerHTML = market.jobs.map(j => {
    const p = byId[j.providerId];
    const f = progress(j, t);
    const res = results[j.id];
    const left = Math.max(0, Math.ceil(j.dueAt - t));
    return `<div class="card job ${j.status}">
      <div class="jhead">
        <div><span class="jid">${esc(j.id)}</span> <b>${esc(j.datasetName)}</b> <span class="muted">on ${esc(p?.name || j.providerId)}</span>
          <div class="osum">${esc(j.summary)}</div></div>
        <div class="price"><b>${money(j.total)}</b><span>${j.status === 'running' ? `${left} min left` : esc(j.status)}</span></div>
      </div>
      ${j.status === 'running' ? `<div class="bar"><i style="width:${(f * 100).toFixed(1)}%"></i></div>
        <div class="row"><span class="stage">${esc(stage(j, t))}…</span><span class="grow"></span>
        <button class="ghost small" data-skip="${esc(j.id)}" type="button">Skip to delivery</button>
        <button class="ghost small" data-cancel="${esc(j.id)}" type="button">Cancel</button></div>` : ''}
      ${j.status === 'delivered' && res ? renderResult(j, res) : ''}
    </div>`;
  }).join('');
}

function renderResult(j, r) {
  const v = r.view;
  const parts = [`<ul class="sums">${Object.entries(r.summaries).map(([k, s]) => `<li><b>${esc(JOB_TYPES[k]?.label || k)}</b> ${esc(s)}</li>`).join('')}</ul>`];
  if (v.ranked) parts.push(`<h4>Ranked leads</h4><table class="mini"><tr><th>#</th><th>lead</th><th>score</th><th>conf.</th><th>why</th></tr>${v.ranked.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.label)}</td><td><span class="scorebar" style="--s:${x.score}">${x.score}</span></td><td>${x.confidence}</td><td class="muted">${esc(x.why)}</td></tr>`).join('')}</table>`);
  if (v.entities) parts.push(`<h4>Entities</h4><div class="ents">${v.entities.map(e => `<span class="e-${e.type}">${esc(e.value)}<i>${e.type}${e.count > 1 ? ` ×${e.count}` : ''}</i></span>`).join('')}</div>`);
  if (v.distribution) parts.push(`<h4>Classes</h4>${bars(v.distribution)}`);
  if (v.flags) parts.push(`<h4>Anomalies</h4>${v.flags.length ? `<table class="mini"><tr><th>row</th><th>column</th><th>value</th><th>median</th><th>z</th></tr>${v.flags.map(f => `<tr><td>${f.row}</td><td>${esc(f.column)}</td><td><b>${f.value}</b></td><td>${f.median}</td><td>${f.z}</td></tr>`).join('')}</table>` : '<p class="muted">None.</p>'}`);
  if (v.forecast?.points?.length) parts.push(`<h4>Forecast · ${esc(v.forecast.target)}</h4>${spark(v.forecast)}`);
  parts.push(`<div class="files">${Object.keys(r.files).map(n => `<button class="ghost small" data-dl="${esc(j.id)}" data-name="${esc(n)}" type="button">⬇ ${esc(n)}</button>`).join('')}</div>`);
  parts.push(`<div class="rate">${j.rating ? `You rated this ${'★'.repeat(j.rating)}` : `Rate the ride: ${[1, 2, 3, 4, 5].map(s => `<button class="star" data-rate="${esc(j.id)}" data-s="${s}" type="button">★</button>`).join('')}`}</div>`);
  return `<div class="result">${parts.join('')}</div>`;
}

function bars(dist) {
  const max = Math.max(...Object.values(dist), 1);
  return `<div class="bars">${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div><span>${esc(k)}</span><i style="width:${(n / max) * 100}%"></i><b>${n}</b></div>`).join('')}</div>`;
}

function spark({ points, forecast }) {
  const all = [...points, ...forecast.map(f => f.high), ...forecast.map(f => f.low)];
  const lo = Math.min(...all), hi = Math.max(...all), n = points.length + forecast.length;
  const W = 520, H = 120, x = i => 8 + (i / (n - 1)) * (W - 16), y = v => H - 10 - ((v - lo) / (hi - lo || 1)) * (H - 20);
  const hist = points.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const fc = [points.length - 1, ...forecast.map((_, k) => points.length + k)].map((i, k) => `${x(i)},${y(k === 0 ? points[points.length - 1] : forecast[k - 1].value)}`).join(' ');
  const band = forecast.map((f, k) => `${x(points.length + k)},${y(f.high)}`).join(' ') + ' ' + forecast.map((f, k) => `${x(points.length + k)},${y(f.low)}`).reverse().join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polygon points="${band}" fill="#06c16722"/><polyline points="${hist}" fill="none" stroke="#111" stroke-width="2" vector-effect="non-scaling-stroke"/><polyline points="${fc}" fill="none" stroke="#06c167" stroke-width="2.5" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/></svg>
    <div class="muted">${forecast.map(f => `${esc(f.label)}: <b>${f.value.toLocaleString()}</b>`).join(' · ')}</div>`;
}

$('#trips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.skip) {
    const j = market.jobs.find(x => x.id === b.dataset.skip);
    if (j) { anchor = { real: Date.now(), sim: Math.max(now(), j.dueAt) }; tick(); }
  } else if (b.dataset.cancel) {
    cancel(market, b.dataset.cancel); delete results[b.dataset.cancel]; save(); render();
  } else if (b.dataset.rate) {
    rate(market, b.dataset.rate, +b.dataset.s); save(); render();
  } else if (b.dataset.dl) {
    const body = results[b.dataset.dl]?.files[b.dataset.name];
    if (body == null) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: b.dataset.name.endsWith('.csv') ? 'text/csv' : b.dataset.name.endsWith('.json') ? 'application/json' : 'text/markdown' }));
    a.download = `${b.dataset.dl}_${b.dataset.name}`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
});

// ---------- drive ----------
$('#driveForm').addEventListener('submit', e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    addProvider(market, { ...Object.fromEntries(fd), routes: fd.getAll('routes') });
    e.target.reset(); save(); render();
  } catch (err) { alert(err.message); }
});
function renderDrive() {
  $('#drivers').innerHTML = `<table class="mini wide"><tr><th>provider</th><th>kind</th><th>routes</th><th>$/CU</th><th>CU/s</th><th>in use</th><th>rating</th><th>earned</th><th></th></tr>
    ${market.providers.map(p => `<tr class="${p.mine ? 'mine' : ''}"><td><b>${esc(p.name)}</b><div class="muted">${esc(p.owner)} · ${esc(p.region)}</div></td><td>${esc(p.kind)}</td><td>${p.routes.map(esc).join(', ')}</td>
      <td>${p.pricePerCU.toFixed(4)}</td><td>${p.cuPerSec}</td><td>${used(p)}/${p.slots}</td><td>${stars(p.rating)}</td><td>${money(p.earned || 0)}</td>
      <td>${p.kind === 'device' ? '' : `<button class="ghost small" data-online="${esc(p.id)}" type="button">${p.online ? 'Go offline' : 'Go online'}</button>`}</td></tr>`).join('')}</table>`;
  $('#agentsTbl').innerHTML = `<table class="mini wide"><tr><th>agent</th><th>skills</th><th>quality</th><th>fee/CU</th><th>rating</th><th>jobs</th><th>earned</th></tr>
    ${market.agents.map(a => `<tr><td><b>${esc(a.name)}</b></td><td>${a.skills.map(s => esc(JOB_TYPES[s]?.label || s)).join(', ')}</td><td>${a.quality}</td><td>${a.human ? 'flat' : a.feePerCU.toFixed(4)}</td><td>${stars(a.rating)}</td><td>${a.jobs || 0}</td><td>${money(a.earned || 0)}</td></tr>`).join('')}</table>`;
}
$('#drivers').addEventListener('click', e => {
  const b = e.target.closest('[data-online]'); if (!b) return;
  const p = market.providers.find(x => x.id === b.dataset.online);
  if (p) { p.online = !p.online; save(); render(); }
});

// ---------- market ----------
$('#rush').addEventListener('change', e => { market.rush = e.target.checked; tick(); });
$('#reset').addEventListener('click', () => {
  if (!confirm('Reset the demo market, jobs and results?')) return;
  market = createMarket(); results = {}; anchor = { real: Date.now(), sim: 0 }; save(); renderTemplates(); render();
});
function renderMarket(s) {
  $('#rush').checked = !!market.rush;
  $('#load').innerHTML = `<div class="big">${Math.round(s.ratio * 100)}% busy · surge ×${s.multiplier}</div>` +
    market.providers.filter(p => p.kind !== 'device').map(p => `<div class="lrow ${p.online ? '' : 'off'}"><span>${esc(p.name)}</span><div class="slots">${Array.from({ length: p.slots }, (_, i) => `<i class="${i < (p.busy || 0) ? 'yours' : i < used(p) ? 'busy' : ''}"></i>`).join('')}</div><b>${p.online ? `${used(p)}/${p.slots}` : 'offline'}</b></div>`).join('') +
    '<p class="hint"><i class="sw yours"></i> your jobs <i class="sw busy"></i> other riders <i class="sw"></i> free</p>';
  const delivered = market.jobs.filter(j => j.status === 'delivered');
  $('#ledger').innerHTML = `<div class="kpis"><div><b>${market.jobs.length}</b><span>jobs booked</span></div><div><b>${delivered.length}</b><span>delivered</span></div><div><b>${money(market.ledger.spent)}</b><span>you spent</span></div><div><b>${money(market.providers.reduce((a, p) => a + (p.earned || 0), 0))}</b><span>paid to drivers</span></div></div>`;
}

// ---------- loop ----------
function render() {
  const s = surgeMultiplier(market);
  $('#surge').innerHTML = `<span class="dot ${s.multiplier > 1 ? 'hot' : ''}"></span>${s.multiplier > 1 ? `Surge ×${s.multiplier}` : 'Normal pricing'} <span class="muted">${Math.round(s.ratio * 100)}% busy</span>`;
  const tab = document.querySelector('.tab.on')?.id;
  if (tab === 'tab-trips') renderTrips(); else $('#tripCount').textContent = market.jobs.filter(j => j.status === 'running').length || '';
  if (tab === 'tab-drive') renderDrive();
  if (tab === 'tab-market') renderMarket(s);
}
function tick() {
  const t = now();
  const delivered = advance(market, t);
  tickAmbient(market, t);
  market.clock = t;
  if (delivered.length) save();
  if (lastOffers && t - lastOffers.at > 5 && document.querySelector('#tab-request.on')) find(); // fares expire: re-quote
  render();
}

renderTemplates();
renderTypes();
setInterval(tick, 1000);
setInterval(save, 5000);
addEventListener('beforeunload', save);

// deep links: ?sample=0..3&find=1&book=1&deliver=1#tab
const si = params.get('sample');
if (si != null && SAMPLES[+si]) {
  useSample(+si);
  if (params.has('find') || params.has('book')) find();
  if (params.has('book') && lastOffers?.offers.length) {
    document.querySelector('[data-book="0"]').click();
    if (params.has('deliver')) { anchor = { real: Date.now(), sim: market.jobs[0].dueAt }; }
  }
}
tick();
show(initialHash || (params.has('book') ? 'trips' : 'request'));
