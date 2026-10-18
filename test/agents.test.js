import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDataset, parseCSV } from '../src/data.js';
import { clean, extract, score, classify, anomaly, forecast, runPipeline } from '../src/agents.js';
import { SAMPLES } from '../src/seed.js';

const leads = parseDataset('sales_leads.csv', SAMPLES[0].text);

test('clean trims, lowercases emails, drops duplicates and empty rows', () => {
  const ds = parseDataset('d.csv', 'name,email,amt\n  Ana  Li ,ANA@X.COM,"1,200"\nAna Li,ana@x.com,1200\n,,\nBo,bo@y.org,5\n');
  const r = clean(ds);
  assert.equal(r.stats.rowsOut, 2);
  assert.equal(r.stats.dupes, 1);
  assert.equal(r.stats.empty, 1);
  assert.deepEqual(r.dataset.records[0], { name: 'Ana Li', email: 'ana@x.com', amt: '1200' });
  const s = clean(leads);
  assert.equal(s.stats.rowsIn, 39);
  assert.equal(s.stats.rowsOut, 36);
});

test('extract finds emails, phones, companies (incl. in free text) and people', () => {
  const ds = parseDataset('d.csv', 'name,company,notes\nAna Li,Acme Inc,call +1 (212) 555-0100 or ana@acme.com\nBo Ek,Acme Inc,Referred by Globex Corp\n');
  const r = extract(ds);
  const has = (type, value) => r.entities.some(e => e.type === type && e.value === value);
  assert.ok(has('email', 'ana@acme.com'));
  assert.ok(has('phone', '+1 (212) 555-0100'));
  assert.ok(has('company', 'Globex Corp'));
  assert.ok(has('person', 'Bo Ek'));
  assert.equal(r.entities.find(e => e.value === 'Acme Inc').count, 2);
  assert.match(r.summary, /2 companies/);
  assert.equal(parseCSV(r.csv).records.length, r.entities.length);
});

test('score ranks senior leads with work email above interns with free mail', () => {
  const ds = parseDataset('d.csv', 'name,title,company,email,employees\nIvy,Intern,,ivy@gmail.com,\nCal,CEO,Big Co,cal@big.co,5000\nMo,Manager,Mid Co,mo@mid.co,200\n');
  const r = score(ds);
  assert.deepEqual(r.ranked.map(x => x.record.name), ['Cal', 'Mo', 'Ivy']);
  assert.ok(r.ranked[0].score > 80 && r.ranked[0].confidence === 1);
  assert.ok(r.ranked[2].confidence < 1);
  assert.match(r.summary, /^Top lead: Cal/);
});

test('classify uses sentiment when there is a free-text column', () => {
  const r = classify(parseDataset('t.json', SAMPLES[3].text));
  assert.equal(r.labels.length, 18);
  assert.ok(r.distribution.negative > 0 && r.distribution.positive > 0);
  assert.match(r.summary, /sentiment of "comment"/);
});

test('anomaly flags the injected spikes in the sensor log', () => {
  const r = anomaly(parseDataset('sensor_log.jsonl', SAMPLES[1].text));
  const rows = r.flags.map(f => `${f.row}:${f.column}`).sort();
  assert.deepEqual(rows, ['41:temp_c', '58:vibration_g']);
});

test('forecast fits the upward revenue trend and labels the next months', () => {
  const r = forecast(parseDataset('monthly_revenue.csv', SAMPLES[2].text));
  assert.equal(r.target, 'revenue');
  assert.ok(r.slope > 1500 && r.slope < 2200, String(r.slope));
  assert.deepEqual(r.forecast.map(f => f.label), ['2026-11', '2026-12', '2027-01']);
  assert.ok(r.forecast.every(f => f.low < f.value && f.value < f.high));
});

test('pipeline runs clean first and the report digests every section', () => {
  const { dataset, results } = runPipeline(leads, ['report', 'score', 'clean', 'extract']);
  assert.equal(dataset.records.length, 36);
  assert.deepEqual(Object.keys(results), ['clean', 'extract', 'score', 'report']);
  assert.match(results.report.markdown, /## Top 5 leads/);
  assert.match(results.report.markdown, /\*\*extract\*\*/);
});
