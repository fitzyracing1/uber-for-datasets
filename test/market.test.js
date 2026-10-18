import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket } from '../src/seed.js';
import {
  parseJobDescription, workUnits, surgeMultiplier, tickAmbient, match, quote, pickStack, book, advance, progress, stage,
  rate, cancel, addProvider, saveTemplate, fmtRows, verbs, MIN_FARE, used,
} from '../src/market.js';

const req = (o = {}) => ({ name: 'leads', types: ['clean', 'extract'], rows: 1200000, columns: 8, privacy: 'any', speedVsCost: 0.5, ...o });
const calm = () => { const m = createMarket(); m.providers.forEach(p => { p.base = 0; }); tickAmbient(m, 0); return m; };

test('plain-language job descriptions become job types and hints', () => {
  const r = parseJobDescription('Clean this sales data, extract every company and person, score lead quality, and give me a ranked list with confidence.');
  assert.deepEqual(r.types, ['clean', 'extract', 'score']);
  const h = parseJobDescription('Forecast next quarter ASAP, confidential, under $20, human review please').hints;
  assert.deepEqual(h, { speedVsCost: 0.85, privacy: 'private', humanReview: true, maxPrice: 20 });
  assert.equal(parseJobDescription('hmm').understood, false);
});

test('work units scale with rows and width', () => {
  assert.equal(workUnits(['clean'], 0), 0.2);
  assert.equal(workUnits(['extract'], 1000), 1.1);
  assert.equal(workUnits(['extract'], 1000, 16), 1.7);
});

test('the chat example prices out near "$4.20 for 1.2M rows cleaned + entity tagged in 9 minutes"', () => {
  const m = calm();
  const p = m.providers.find(x => x.id === 'p-northgate');
  const q = quote(m, req(), p, pickStack(m, req()));
  assert.equal(q.surge, 1);
  assert.ok(q.total > 3 && q.total < 6, String(q.total));
  assert.ok(q.etaMin >= 7 && q.etaMin <= 10, String(q.etaMin));
  assert.match(q.summary, /^\$\d+\.\d\d for 1\.2M rows cleaned \+ entity tagged in \d+ minutes$/);
  const total = q.lines.reduce((a, l) => a + l.amount, 0);
  assert.ok(Math.abs(total - q.total) < 0.02);
});

test('surge kicks in above 60% busy and caps at 2.5', () => {
  const m = calm();
  assert.equal(surgeMultiplier(m).multiplier, 1);
  m.providers.forEach(p => { p.ambient = Math.round(p.slots * 0.8); });
  assert.equal(surgeMultiplier(m).multiplier, 1.5);
  m.providers.forEach(p => { p.ambient = p.slots; });
  assert.equal(surgeMultiplier(m).multiplier, 2);
  m.rush = true; m.providers.forEach(p => { p.base = 0.9; });
  tickAmbient(m, 0);
  assert.ok(surgeMultiplier(m).multiplier >= 1.9);
});

test('matching ranks by the slider and tags cheapest/fastest', () => {
  const m = calm();
  const cheap = match(m, req({ speedVsCost: 0 })).offers;
  const fast = match(m, req({ speedVsCost: 1 })).offers;
  assert.ok(cheap[0].tags.includes('Cheapest'));
  assert.ok(fast[0].tags.includes('Fastest'));
  assert.ok(!cheap.some(o => o.providerId === 'p-browser'), 'on-device route is opt-in');
  assert.ok(!cheap.some(o => o.providerId === 'p-fjord'), 'offline provider excluded');
});

test('privacy routes are hard filters', () => {
  const m = calm();
  const ids = r => match(m, req({ privacy: r })).offers.map(o => o.providerId).sort();
  assert.deepEqual(ids('private'), ['p-browser', 'p-lakeside', 'p-vaultline']);
  assert.deepEqual(ids('on-device'), ['p-browser']);
  const dev = match(m, req({ privacy: 'on-device' })).offers[0];
  assert.equal(dev.surge, 1);
});

test('price cap and deadline filter offers with a reason', () => {
  const m = calm();
  const r = match(m, req({ maxPrice: 0.1 }));
  assert.equal(r.offers.length, 0);
  assert.match(r.reason, /price cap or deadline/);
  assert.ok(match(m, req({ deadlineMin: 10 })).offers.every(o => o.etaMin <= 10));
});

test('human review adds the verified desk, a fee and time', () => {
  const m = calm();
  const a = match(m, req()).offers.find(o => o.providerId === 'p-northgate');
  const b = match(m, req({ humanReview: true })).offers.find(o => o.providerId === 'p-northgate');
  assert.ok(b.stack.some(s => s.agentId === 'a-desk'));
  assert.ok(b.total > a.total && b.etaMin >= a.etaMin + 20);
});

test('small jobs pay the minimum fare', () => {
  const m = calm();
  const o = match(m, req({ rows: 10 })).offers[0];
  assert.equal(o.total, MIN_FARE);
});

test('lifecycle: book holds a slot, advance delivers and pays, rating updates averages', () => {
  const m = calm();
  const r = req();
  const offer = match(m, r).offers[0];
  const p = m.providers.find(x => x.id === offer.providerId);
  const job = book(m, r, offer, 100);
  assert.equal(p.busy, 1);
  assert.equal(job.id, 'J-0001');
  assert.equal(progress(job, 100 + job.etaMin / 2), 0.5);
  assert.notEqual(stage(job, 100.1), 'Delivered');
  assert.deepEqual(advance(m, 100 + job.etaMin - 0.5), []);
  assert.deepEqual(advance(m, 100 + job.etaMin).map(j => j.id), ['J-0001']);
  assert.equal(p.busy, 0);
  assert.equal(p.earned, offer.payout);
  assert.equal(stage(job, 1e9), 'Delivered');
  const before = p.ratings;
  assert.ok(rate(m, job.id, 1));
  assert.equal(p.ratings, before + 1);
  assert.ok(p.rating < 4.8);
  assert.equal(rate(m, job.id, 5), false, 'one rating per job');
});

test('cancel refunds and frees the slot; full providers drop out of matching', () => {
  const m = calm();
  const r = req({ privacy: 'private', speedVsCost: 1 });
  const o = match(m, r).offers.find(x => x.providerId === 'p-vaultline');
  const j = book(m, r, o, 0);
  assert.ok(cancel(m, j.id));
  assert.equal(m.ledger.spent, 0);
  const v = m.providers.find(x => x.id === 'p-vaultline');
  v.ambient = v.slots;
  assert.equal(used(v), 2);
  assert.ok(!match(m, r).offers.some(x => x.providerId === 'p-vaultline'));
  assert.throws(() => book(m, r, o, 0), /no longer available/);
});

test('drivers can add capacity and get matched', () => {
  const m = calm();
  const p = addProvider(m, { name: 'Garage rig', kind: 'gpu', pricePerCU: 0.0001, cuPerSec: 5, slots: 1, routes: ['public', 'bogus'] });
  assert.deepEqual(p.routes, ['public']);
  const offers = match(m, req({ speedVsCost: 0 })).offers;
  assert.equal(offers[0].providerId, p.id);
  assert.throws(() => addProvider(m, { name: ' ' }), /Name/);
});

test('templates and formatting helpers', () => {
  const m = createMarket();
  const t = saveTemplate(m, 'Weekly', req({ description: 'clean it' }));
  assert.equal(m.templates[0], t);
  assert.equal(fmtRows(1200000), '1.2M rows');
  assert.equal(fmtRows(80000), '80k rows');
  assert.equal(fmtRows(24), '24 rows');
  assert.equal(verbs(['clean', 'extract', 'score', 'report']), 'cleaned, entity tagged, lead scored + reported');
});

test('market state is plain JSON', () => {
  const m = createMarket();
  book(m, req(), match(m, req()).offers[0], 0);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
});
