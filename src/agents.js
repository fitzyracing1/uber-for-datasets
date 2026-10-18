// The agents that actually do the work. Every job type runs for real on the uploaded data,
// in the browser or in Node. No network, no model API: deterministic, inspectable heuristics.
import { EMAIL_RE, PHONE_RE, isNumeric, num, toCSV } from './data.js';

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com']);
const COMPANY_RE = /\b((?:[A-Z][\w&'-]*\s){0,3}[A-Z][\w&'-]*,?\s(?:Inc|LLC|Ltd|Corp|Corporation|GmbH|Co|Company|Group|Labs|Systems|Technologies|AG|SA|PLC|BV)\.?)(?=\W|$)/g;
const URL_RE = /\bhttps?:\/\/[^\s"',)]+/g;
const SENIOR = [[/\b(ceo|cto|cfo|coo|founder|owner|president|chief)\b/i, 25], [/\b(vp|vice president|head of|director)\b/i, 18], [/\b(manager|lead|principal)\b/i, 10]];

const textCols = (ds) => ds.columns.filter(c => !ds.records.every(r => r[c] === '' || r[c] == null || isNumeric(r[c])));
const numCols = (ds) => ds.columns.filter(c => {
  const vals = ds.records.map(r => r[c]).filter(v => v !== '' && v != null);
  return vals.length >= 2 && vals.filter(isNumeric).length / vals.length >= 0.9;
});
const findCol = (ds, re) => ds.columns.find(c => re.test(c));

/** Clean: trim, collapse whitespace, normalise emails/numbers, drop empty and duplicate rows. */
export function clean(ds) {
  const nums = new Set(numCols(ds));
  let trimmed = 0, normalised = 0, empty = 0, dupes = 0;
  const seen = new Set();
  const records = [];
  for (const r of ds.records) {
    const out = {};
    for (const c of ds.columns) {
      let v = r[c] == null ? '' : r[c];
      if (typeof v === 'string') {
        const t = v.replace(/\s+/g, ' ').trim();
        if (t !== v) trimmed++;
        v = t;
        if (new RegExp(`^${EMAIL_RE.source}$`).test(v) && v !== v.toLowerCase()) { v = v.toLowerCase(); normalised++; }
        else if (nums.has(c) && v !== '' && isNumeric(v) && String(num(v)) !== v) { v = String(num(v)); normalised++; }
      }
      out[c] = v;
    }
    if (ds.columns.every(c => out[c] === '')) { empty++; continue; }
    const key = JSON.stringify(ds.columns.map(c => String(out[c]).toLowerCase()));
    if (seen.has(key)) { dupes++; continue; }
    seen.add(key);
    records.push(out);
  }
  return {
    dataset: { ...ds, records },
    summary: `${records.length} clean rows (removed ${dupes} duplicate${dupes === 1 ? '' : 's'} and ${empty} empty; trimmed ${trimmed} cells, normalised ${normalised}).`,
    stats: { rowsIn: ds.records.length, rowsOut: records.length, dupes, empty, trimmed, normalised },
  };
}

/** Extract entities: emails, phones, URLs, companies, people. */
export function extract(ds) {
  const found = new Map();
  const add = (type, value, row) => {
    value = String(value).trim().replace(/[.,;]$/, '');
    if (!value) return;
    const key = `${type}|${type === 'email' ? value.toLowerCase() : value}`;
    const e = found.get(key) || { type, value, count: 0, rows: [] };
    e.count++;
    if (e.rows.length < 5 && !e.rows.includes(row)) e.rows.push(row);
    found.set(key, e);
  };
  const personCol = findCol(ds, /^(name|full.?name|contact|person|owner|customer)$/i);
  const companyCol = findCol(ds, /^(company|organi[sz]ation|org|employer|account)$/i);
  ds.records.forEach((r, i) => {
    const row = i + 1;
    for (const c of ds.columns) {
      const v = r[c];
      if (v == null || v === '') continue;
      const s = String(v);
      for (const m of s.match(EMAIL_RE) || []) add('email', m.toLowerCase(), row);
      for (const m of s.match(URL_RE) || []) add('url', m, row);
      if (!isNumeric(s)) for (const m of s.match(PHONE_RE) || []) add('phone', m, row);
      if (c !== companyCol) for (const m of s.matchAll(COMPANY_RE)) add('company', m[1], row);
    }
    if (personCol && r[personCol]) add('person', r[personCol], row);
    if (companyCol && r[companyCol]) add('company', r[companyCol], row);
  });
  const entities = [...found.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type) || a.value.localeCompare(b.value));
  const byType = entities.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {});
  const PLURAL = { email: 'emails', phone: 'phones', url: 'URLs', company: 'companies', person: 'people' };
  const parts = Object.entries(byType).map(([t, n]) => `${n} ${n === 1 ? t : PLURAL[t] || t + 's'}`);
  return {
    entities, byType,
    summary: entities.length ? `Found ${parts.join(', ')}.` : 'No entities found.',
    csv: toCSV(['type', 'value', 'count', 'rows'], entities.map(e => ({ ...e, rows: e.rows.join(' ') }))),
  };
}

/** Score leads: a ranked list with a score (0-100) and confidence (share of signals present). */
export function score(ds) {
  const emailCol = findCol(ds, /e-?mail/i);
  const phoneCol = findCol(ds, /phone|mobile|tel/i);
  const titleCol = findCol(ds, /title|role|position|job/i);
  const companyCol = findCol(ds, /company|organi[sz]ation|org|employer|account/i);
  const sizeCol = numCols(ds).find(c => /employees|size|revenue|deal|value|amount|budget|arr/i.test(c));
  const sizes = sizeCol ? ds.records.map(r => num(r[sizeCol])).filter(Number.isFinite) : [];
  const maxSize = Math.max(1, ...sizes);
  const signals = [emailCol, phoneCol, titleCol, companyCol, sizeCol].filter(Boolean).length || 1;
  const ranked = ds.records.map((r, i) => {
    let s = 0, present = 0;
    const why = [];
    const email = emailCol ? String(r[emailCol] || '') : (JSON.stringify(r).match(EMAIL_RE) || [''])[0];
    if (email && new RegExp(EMAIL_RE.source).test(email)) {
      present++;
      const domain = email.split('@')[1].toLowerCase();
      if (FREE_MAIL.has(domain)) { s += 15; why.push('personal email'); } else { s += 28; why.push('work email'); }
    }
    if (phoneCol && r[phoneCol]) { present++; s += 12; why.push('phone'); }
    if (companyCol && r[companyCol]) { present++; s += 12; why.push('company'); }
    if (titleCol && r[titleCol]) {
      present++;
      const hit = SENIOR.find(([re]) => re.test(r[titleCol]));
      s += hit ? hit[1] : 4;
      if (hit) why.push(String(r[titleCol]));
    }
    if (sizeCol && isNumeric(r[sizeCol])) {
      present++;
      const v = num(r[sizeCol]);
      s += Math.round(23 * Math.log10(1 + v) / Math.log10(1 + maxSize));
      why.push(`${sizeCol} ${v.toLocaleString('en-US')}`);
    }
    return { row: i + 1, record: r, score: Math.min(100, s), confidence: Math.round((present / signals) * 100) / 100, why: why.join(', ') };
  }).sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.row - b.row);
  const label = r => r.record[findCol(ds, /^(name|full.?name|contact)$/i)] || r.record[companyCol] || `row ${r.row}`;
  return {
    ranked,
    summary: ranked.length ? `Top lead: ${label(ranked[0])} (${ranked[0].score}/100, confidence ${ranked[0].confidence}).` : 'Nothing to score.',
    csv: toCSV(['rank', 'row', 'score', 'confidence', 'why', ...ds.columns],
      ranked.map((r, i) => ({ ...r.record, rank: i + 1, row: r.row, score: r.score, confidence: r.confidence, why: r.why }))),
  };
}

/** Summarise + classify: per-column stats, category columns, and a label per row. */
export function classify(ds) {
  const numeric = new Set(numCols(ds));
  const columns = ds.columns.map(c => {
    const vals = ds.records.map(r => r[c]).filter(v => v !== '' && v != null);
    if (numeric.has(c)) {
      const xs = vals.map(num).sort((a, b) => a - b);
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      return { name: c, kind: 'number', min: xs[0], max: xs[xs.length - 1], mean: round(mean), median: xs[Math.floor(xs.length / 2)] };
    }
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    const distinct = Object.keys(counts).length;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { name: c, kind: distinct <= Math.max(6, ds.records.length * 0.3) && distinct < vals.length ? 'category' : 'text', distinct, top };
  });
  const cat = columns.find(c => c.kind === 'category');
  const sentimentCol = textCols(ds).find(c => /comment|review|feedback|note|text|message|description/i.test(c));
  const POS = /\b(great|love|excellent|good|happy|fast|helpful|amazing|perfect|thanks)\b/gi;
  const NEG = /\b(bad|slow|broken|hate|terrible|poor|late|refund|angry|bug|error|fail)\w*/gi;
  const labels = ds.records.map(r => {
    if (sentimentCol) {
      const t = String(r[sentimentCol] || '');
      const p = (t.match(POS) || []).length, n = (t.match(NEG) || []).length;
      return p > n ? 'positive' : n > p ? 'negative' : 'neutral';
    }
    return cat ? String(r[cat.name] || 'unlabelled') : 'unlabelled';
  });
  const dist = labels.reduce((m, l) => ((m[l] = (m[l] || 0) + 1), m), {});
  const by = sentimentCol ? `sentiment of "${sentimentCol}"` : cat ? `"${cat.name}"` : 'no category column';
  return {
    columns, labels, distribution: dist,
    summary: `${ds.records.length} rows × ${ds.columns.length} columns; classified by ${by}: ${Object.entries(dist).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
  };
}

/** Anomaly scan: robust z-score (median / MAD) on every numeric column. */
export function anomaly(ds, threshold = 3.5) {
  const flags = [];
  for (const c of numCols(ds)) {
    const xs = ds.records.map(r => (isNumeric(r[c]) ? num(r[c]) : NaN));
    const vals = xs.filter(Number.isFinite).sort((a, b) => a - b);
    const med = median(vals);
    const mad = median(vals.map(v => Math.abs(v - med)).sort((a, b) => a - b)) || (vals[vals.length - 1] - vals[0]) / 10 || 1;
    xs.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const z = (0.6745 * (v - med)) / mad;
      if (Math.abs(z) >= threshold) flags.push({ row: i + 1, column: c, value: v, z: round(z), median: med });
    });
  }
  flags.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return {
    flags,
    summary: flags.length ? `${flags.length} anomal${flags.length === 1 ? 'y' : 'ies'}; biggest: row ${flags[0].row} ${flags[0].column}=${flags[0].value} (median ${flags[0].median}).` : 'No anomalies above the threshold.',
    csv: toCSV(['row', 'column', 'value', 'z', 'median'], flags),
  };
}

/** Forecast: least-squares trend on the first numeric target, ordered by a date column when present. */
export function forecast(ds, periods = 3) {
  const dateCol = ds.columns.find(c => ds.records.length && ds.records.every(r => /^\d{4}-\d{2}/.test(String(r[c] || ''))));
  const target = numCols(ds).find(c => c !== dateCol && /revenue|sales|amount|value|total|count|units|orders|y$/i.test(c)) || numCols(ds).find(c => c !== dateCol);
  if (!target) return { points: [], forecast: [], summary: 'No numeric column to forecast.' };
  const recs = dateCol ? [...ds.records].sort((a, b) => String(a[dateCol]).localeCompare(String(b[dateCol]))) : ds.records;
  const ys = recs.map(r => num(r[target])).filter(Number.isFinite);
  const n = ys.length;
  const xm = (n - 1) / 2, ym = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  ys.forEach((y, x) => { sxy += (x - xm) * (y - ym); sxx += (x - xm) ** 2; });
  const slope = sxx ? sxy / sxx : 0, intercept = ym - slope * xm;
  const resid = Math.sqrt(ys.reduce((a, y, x) => a + (y - (intercept + slope * x)) ** 2, 0) / Math.max(1, n - 2));
  const nextLabel = (i) => {
    if (!dateCol) return `t+${i}`;
    const last = String(recs[recs.length - 1][dateCol]);
    const [y, m] = last.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const out = Array.from({ length: periods }, (_, k) => {
    const x = n + k, y = intercept + slope * x;
    return { label: nextLabel(k + 1), value: round(y), low: round(y - 1.96 * resid), high: round(y + 1.96 * resid) };
  });
  const pct = ym ? round((slope / ym) * 100) : 0;
  return {
    target, dateColumn: dateCol || null, points: ys, slope: round(slope), forecast: out,
    summary: `${target} trend ${slope >= 0 ? '+' : ''}${round(slope)} per period (${pct >= 0 ? '+' : ''}${pct}%); next: ${out.map(f => `${f.label} ≈ ${f.value}`).join(', ')}.`,
  };
}

/** Report: a Markdown digest of the other agents' outputs. */
export function report(ds, results) {
  const lines = [`# ${ds.name}`, '', `${ds.records.length} rows, ${ds.columns.length} columns (${ds.format}).`, ''];
  for (const [type, r] of Object.entries(results)) if (type !== 'report' && r && r.summary) lines.push(`- **${type}**: ${r.summary}`);
  if (results.score?.ranked?.length) {
    lines.push('', '## Top 5 leads', '', '| rank | row | score | confidence | why |', '|---|---|---|---|---|');
    results.score.ranked.slice(0, 5).forEach((r, i) => lines.push(`| ${i + 1} | ${r.row} | ${r.score} | ${r.confidence} | ${r.why} |`));
  }
  if (results.anomaly?.flags?.length) {
    lines.push('', '## Anomalies', '');
    results.anomaly.flags.slice(0, 10).forEach(f => lines.push(`- row ${f.row}: ${f.column} = ${f.value} (z ${f.z})`));
  }
  if (results.forecast?.forecast?.length) {
    lines.push('', `## Forecast: ${results.forecast.target}`, '');
    results.forecast.forecast.forEach(f => lines.push(`- ${f.label}: ${f.value} (95% ${f.low} to ${f.high})`));
  }
  const markdown = lines.join('\n') + '\n';
  const n = Object.keys(results).filter(k => k !== 'report').length;
  return { markdown, summary: `Report with ${n} section${n === 1 ? '' : 's'}.` };
}

const median = xs => (xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2) : 0);
const round = x => Math.round(x * 100) / 100;

export const RUNNERS = { clean, extract, score, classify, anomaly, forecast };

/** Run a pipeline in order. Clean goes first so later agents see the cleaned data. */
export function runPipeline(ds, types) {
  const order = ['clean', 'extract', 'score', 'classify', 'anomaly', 'forecast', 'report'];
  const results = {};
  let cur = ds;
  for (const t of order.filter(t => types.includes(t))) {
    if (t === 'report') continue;
    results[t] = RUNNERS[t](cur);
    if (t === 'clean') cur = results.clean.dataset;
  }
  if (types.includes('report')) results.report = report(cur, results);
  return { dataset: cur, results };
}
