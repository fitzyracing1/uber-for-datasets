// Dataset parsing and profiling. Pure functions, shared by the browser and Node.

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  if (!rows.length) return { columns: [], records: [] };
  const columns = rows[0].map((c, i) => c.trim() || `col${i + 1}`);
  const records = rows.slice(1).map(r => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])));
  return { columns, records };
}

export function toCSV(columns, records) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.map(esc).join(','), ...records.map(r => columns.map(c => esc(r[c])).join(','))].join('\n') + '\n';
}

/** Parse CSV, JSON (array of objects / {records:[...]}), JSON Lines, or plain text logs. */
export function parseDataset(name, text) {
  const lower = (name || '').toLowerCase();
  const t = text.trim();
  let format, columns, records;
  if (lower.endsWith('.json') || lower.endsWith('.jsonl') || lower.endsWith('.ndjson') || t.startsWith('[') || t.startsWith('{')) {
    let arr;
    try {
      const v = JSON.parse(t);
      arr = Array.isArray(v) ? v : Array.isArray(v.records) ? v.records : Array.isArray(v.data) ? v.data : [v];
      format = 'json';
    } catch {
      arr = t.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
      format = 'jsonl';
    }
    records = arr.map(o => (o && typeof o === 'object' ? flatten(o) : { value: o }));
    columns = [...new Set(records.flatMap(r => Object.keys(r)))];
  } else if (lower.endsWith('.csv') || lower.endsWith('.tsv') || /,/.test(t.split(/\r?\n/)[0] || '')) {
    ({ columns, records } = parseCSV(lower.endsWith('.tsv') ? text.replace(/\t/g, ',') : text));
    format = 'csv';
  } else {
    records = t.split(/\r?\n/).filter(Boolean).map((line, i) => ({ line: i + 1, text: line }));
    columns = ['line', 'text'];
    format = 'text';
  }
  return { name: name || 'dataset', format, columns, records, bytes: byteLength(text) };
}

function flatten(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.join('; ') : v;
  }
  return out;
}

function byteLength(s) {
  let n = 0;
  for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const PHONE_RE = /(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

export function isNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  const s = v.replace(/[$,%\s]/g, '');
  return s !== '' && Number.isFinite(Number(s));
}
export const num = v => (typeof v === 'number' ? v : Number(String(v).replace(/[$,%\s]/g, '')));

/** Column types, PII detection and the privacy level the dataset suggests. */
export function profile(ds) {
  const cols = ds.columns.map(c => {
    const vals = ds.records.map(r => r[c]).filter(v => v !== '' && v != null);
    const numeric = vals.length > 0 && vals.filter(isNumeric).length / vals.length >= 0.9;
    const str = vals.map(String);
    const emails = str.filter(v => new RegExp(EMAIL_RE.source).test(v)).length;
    const phones = str.filter(v => new RegExp(PHONE_RE.source).test(v) && !numeric).length;
    const dates = str.filter(v => /^\d{4}-\d{2}(-\d{2})?/.test(v)).length;
    const pii = emails > 0 || phones > 0 || /(^|_|\b)(email|phone|ssn|dob|address|name)(\b|_|$)/i.test(c);
    return {
      name: c, type: numeric ? 'number' : dates / Math.max(1, vals.length) > 0.8 ? 'date' : 'text',
      filled: vals.length, missing: ds.records.length - vals.length, unique: new Set(str).size, pii,
    };
  });
  const piiCols = cols.filter(c => c.pii).map(c => c.name);
  return {
    rows: ds.records.length, columns: cols, bytes: ds.bytes, format: ds.format, piiColumns: piiCols,
    suggestedPrivacy: piiCols.length ? 'private' : 'any',
  };
}
