import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, toCSV, parseDataset, profile } from '../src/data.js';

test('CSV parser handles quotes, commas, newlines and CRLF', () => {
  const { columns, records } = parseCSV('a,b\r\n"x, y","he said ""hi"""\r\n"multi\nline",2\r\n');
  assert.deepEqual(columns, ['a', 'b']);
  assert.deepEqual(records, [{ a: 'x, y', b: 'he said "hi"' }, { a: 'multi\nline', b: '2' }]);
  assert.equal(parseCSV(toCSV(columns, records)).records[1].a, 'multi\nline');
});

test('parseDataset detects CSV, JSON, JSON Lines and text', () => {
  assert.equal(parseDataset('x.csv', 'a,b\n1,2\n').format, 'csv');
  const j = parseDataset('x.json', '[{"a":1,"n":{"b":2}}]');
  assert.equal(j.format, 'json');
  assert.deepEqual(j.columns, ['a', 'n.b']);
  assert.equal(parseDataset('x.jsonl', '{"a":1}\n{"a":2}\n').records.length, 2);
  const t = parseDataset('x.log', 'boot ok\nerror disk\n');
  assert.equal(t.format, 'text');
  assert.equal(t.records[1].text, 'error disk');
});

test('profile finds column types and PII, and suggests a private route', () => {
  const ds = parseDataset('p.csv', 'name,email,amount,day\nAna,ana@x.com,12.5,2026-01-01\nBo,bo@y.org,"$1,200",2026-01-02\n');
  const p = profile(ds);
  assert.equal(p.rows, 2);
  assert.deepEqual(p.piiColumns, ['name', 'email']);
  assert.equal(p.suggestedPrivacy, 'private');
  assert.equal(p.columns.find(c => c.name === 'day').type, 'date');
  const clean = profile(parseDataset('q.csv', 'x,y\n1,2\n3,4\n'));
  assert.equal(clean.suggestedPrivacy, 'any');
  assert.equal(clean.columns[0].type, 'number');
});
