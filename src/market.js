// Marketplace core: job taxonomy, intent parsing, work estimation, pricing (with surge),
// matching datasets/jobs to compute providers + agent stacks, and the job lifecycle.
// Pure data in, data out (the market object is plain JSON so it can live in localStorage).

export const JOB_TYPES = {
  clean:    { label: 'Clean',                verb: 'cleaned',                baseCU: 0.2, cuPerKRow: 0.05, gpu: false },
  extract:  { label: 'Extract entities',     verb: 'entity tagged',          baseCU: 0.5, cuPerKRow: 0.6,  gpu: true },
  score:    { label: 'Score leads',          verb: 'lead scored',            baseCU: 0.3, cuPerKRow: 0.3,  gpu: true },
  classify: { label: 'Summarize + classify', verb: 'summarized + classified', baseCU: 0.4, cuPerKRow: 0.5,  gpu: true },
  anomaly:  { label: 'Anomaly scan',         verb: 'anomaly scanned',        baseCU: 0.2, cuPerKRow: 0.1,  gpu: false },
  forecast: { label: 'Forecast',             verb: 'forecast',               baseCU: 0.3, cuPerKRow: 0.08, gpu: false },
  report:   { label: 'Report',               verb: 'reported',               baseCU: 0.2, cuPerKRow: 0.01, gpu: false },
};
export const TYPE_ORDER = Object.keys(JOB_TYPES);

export const PRIVACY = {
  any:         { label: 'Any route',             route: null },
  ephemeral:   { label: 'Ephemeral container',   route: 'ephemeral' },
  private:     { label: 'Private cloud',         route: 'private' },
  'on-device': { label: 'On-device (this browser)', route: 'on-device' },
};

export const MIN_FARE = 0.5;
export const PLATFORM_FEE = 0.1;
export const REVIEW = { flat: 3, perKRow: 0.004, cap: 60, baseMin: 20, minPerKRow: 0.02 };

const INTENTS = [
  ['clean', /\b(clean|dedupe|de-dupe|duplicates?|normali[sz]e|tidy|fix|scrub|format)\w*/i],
  ['extract', /\b(extract|entit(y|ies)|compan(y|ies)|people|persons?|names?|emails?|contacts?|tag|ner)\b/i],
  ['score', /\b(score|rank|leads?|quality|prioriti[sz]e|qualif)\w*/i],
  ['classify', /\b(summari[sz]e|summary|classify|categori[sz]e|label|sentiment|group|tag by|topics?)\w*/i],
  ['anomaly', /\b(anomal\w*|outliers?|fraud|unusual|spikes?|weird|suspicious)\b/i],
  ['forecast', /\b(forecast|predict|projection|project|next (month|quarter|year)|trend)\w*/i],
  ['report', /\b(report|dashboard|brief|write-?up|pdf|deck)\b/i],
];

/** Turn a plain-language job description into job types and constraint hints. */
export function parseJobDescription(text = '') {
  const types = INTENTS.filter(([, re]) => re.test(text)).map(([t]) => t);
  const hints = {};
  if (/\b(asap|urgent|fast|quick|now|today|rush)\b/i.test(text)) hints.speedVsCost = 0.85;
  if (/\b(cheap|cheapest|budget|low cost|inexpensive|no rush)\b/i.test(text)) hints.speedVsCost = 0.15;
  if (/\b(private|confidential|sensitive|pii|hipaa|gdpr|internal)\b/i.test(text)) hints.privacy = 'private';
  if (/\b(on[- ]device|locally|never leaves|offline)\b/i.test(text)) hints.privacy = 'on-device';
  if (/\b(human|review|verified|double-check|check by a person)\b/i.test(text)) hints.humanReview = true;
  const m = text.match(/\bunder \$?(\d+(?:\.\d+)?)/i);
  if (m) hints.maxPrice = Number(m[1]);
  return { types: types.length ? types : ['clean', 'classify'], hints, understood: types.length > 0 };
}

/** Compute units (1 CU ≈ one GPU-second on a reference card) for a job. */
export function workUnits(types, rows, columns = 8) {
  const width = Math.max(1, columns / 8);
  return round2(types.reduce((sum, t) => {
    const j = JOB_TYPES[t];
    return j ? sum + j.baseCU + j.cuPerKRow * (rows / 1000) * width : sum;
  }, 0));
}

export function needsGpu(types) { return types.some(t => JOB_TYPES[t]?.gpu); }

export function surgeMultiplier(market) {
  const pool = market.providers.filter(p => p.online && p.kind !== 'device');
  const slots = pool.reduce((s, p) => s + p.slots, 0);
  const busy = pool.reduce((s, p) => s + Math.min(p.slots, used(p)), 0);
  const ratio = slots ? busy / slots : 1;
  return { ratio: round2(ratio), multiplier: ratio <= 0.6 ? 1 : Math.min(2.5, Math.round((1 + (ratio - 0.6) * 2.5) * 10) / 10) };
}

/** Slots in use: jobs booked here plus ambient demand from other riders. */
export const used = p => (p.busy || 0) + (p.ambient || 0);

/** Ambient demand from other riders: a deterministic wave per provider, plus rush hour. */
export function tickAmbient(market, now) {
  market.providers.forEach((p, i) => {
    if (p.kind === 'device' || p.mine) { p.ambient = 0; return; }
    const load = (p.base ?? 0.5) + 0.18 * Math.sin(now / 37 + i * 1.7) + (market.rush ? 0.35 : 0);
    p.ambient = Math.max(0, Math.min(p.slots - (p.busy || 0), Math.round(p.slots * load)));
  });
  return surgeMultiplier(market);
}

function providerOk(p, req) {
  if (!p.online || used(p) >= p.slots) return false;
  const route = PRIVACY[req.privacy || 'any'].route;
  if (route && !p.routes.includes(route)) return false;
  if (!route && p.kind === 'device') return false; // the browser route is opt-in
  return true;
}

/** Pick one agent per job type (plus a verified human reviewer when asked). */
export function pickStack(market, req) {
  const w = req.speedVsCost ?? 0.5; // 0 = cheapest, 1 = fastest / best
  const pref = new Set(req.preferredAgents || []);
  const maxFee = Math.max(...market.agents.map(a => a.feePerCU || 0), 1e-9);
  const stack = [];
  for (const t of req.types) {
    if (t === 'report' && stack.some(s => s.agent.skills.includes('report'))) continue;
    const cands = market.agents.filter(a => !a.human && a.skills.includes(t));
    if (!cands.length) return null;
    const value = a => a.quality * (0.6 + 0.4 * w) - (a.feePerCU / maxFee) * 0.35 * (1 - w) + (pref.has(a.id) ? 0.08 : 0) + (a.rating - 4.5) * 0.02;
    const best = cands.reduce((b, a) => (value(a) > value(b) ? a : b));
    const have = stack.find(s => s.agent.id === best.id);
    if (have) have.types.push(t); else stack.push({ agent: best, types: [t] });
  }
  if (req.humanReview) {
    const h = market.agents.find(a => a.human);
    if (!h) return null;
    stack.push({ agent: h, types: ['review'] });
  }
  return stack;
}

/** A priced quote for running req on provider p with an agent stack. */
export function quote(market, req, p, stack, surge = surgeMultiplier(market)) {
  const rows = req.rows, cols = req.columns || 8;
  let cu = workUnits(req.types, rows, cols);
  if (needsGpu(req.types) && p.kind !== 'gpu') cu = round2(cu * 1.5);
  const compute = cu * p.pricePerCU;
  let agentFee = 0, review = 0, reviewMin = 0;
  for (const s of stack) {
    if (s.agent.human) {
      review = Math.min(REVIEW.cap, REVIEW.flat + REVIEW.perKRow * rows / 1000 * 10);
      reviewMin = REVIEW.baseMin + REVIEW.minPerKRow * rows / 1000;
    } else {
      agentFee += workUnits(s.types, rows, cols) * s.agent.feePerCU;
    }
  }
  const surgeMul = p.kind === 'device' ? 1 : surge.multiplier;
  const base = compute + agentFee + review;
  const surged = base * surgeMul;
  const platform = surged * PLATFORM_FEE;
  let total = surged + platform;
  const minFare = p.kind === 'device' ? 0 : MIN_FARE;
  const minFareTopUp = total < minFare ? minFare - total : 0;
  total = round2(total + minFareTopUp);
  const spinUp = req.privacy === 'ephemeral' ? 1.5 : p.kind === 'device' ? 0 : 0.5;
  const etaMin = Math.max(1, Math.ceil(spinUp + cu / p.cuPerSec / 60 + reviewMin));
  const lines = [
    { label: `Compute: ${fmtNum(cu)} CU × $${p.pricePerCU.toFixed(4)} on ${p.name}`, amount: round2(compute) },
    { label: `Agents: ${stack.filter(s => !s.agent.human).map(s => s.agent.name).join(', ')}`, amount: round2(agentFee) },
  ];
  if (review) lines.push({ label: 'Verified human review', amount: round2(review) });
  if (surgeMul > 1) lines.push({ label: `Surge ×${surgeMul} (pool ${Math.round(surge.ratio * 100)}% busy)`, amount: round2(surged - base) });
  lines.push({ label: `Platform fee ${PLATFORM_FEE * 100}%`, amount: round2(platform) });
  if (minFareTopUp) lines.push({ label: `Minimum fare $${MIN_FARE.toFixed(2)}`, amount: round2(minFareTopUp) });
  return {
    providerId: p.id, stack: stack.map(s => ({ agentId: s.agent.id, types: s.types })), cu, total, etaMin,
    surge: surgeMul, lines, payout: round2(compute * surgeMul), agentPayout: round2(agentFee * surgeMul), reviewPayout: round2(review * surgeMul),
    summary: `$${total.toFixed(2)} for ${fmtRows(rows)} ${verbs(req.types)} in ${etaMin} minute${etaMin === 1 ? '' : 's'}`,
  };
}

/** Rank every feasible offer for a request. */
export function match(market, req) {
  const stack = pickStack(market, req);
  if (!stack) return { offers: [], reason: 'No agent can do one of these job types.' };
  const surge = surgeMultiplier(market);
  let offers = market.providers.filter(p => providerOk(p, req)).map(p => quote(market, req, p, stack, surge));
  const all = offers.length;
  if (req.maxPrice) offers = offers.filter(o => o.total <= req.maxPrice);
  if (req.deadlineMin) offers = offers.filter(o => o.etaMin <= req.deadlineMin);
  if (!offers.length) {
    return { offers: [], surge, reason: all ? 'Every route is over your price cap or deadline. Loosen a constraint.' : 'No provider is online with a free slot on that privacy route.' };
  }
  const w = req.speedVsCost ?? 0.5;
  const ps = offers.map(o => o.total), es = offers.map(o => o.etaMin);
  const minP = Math.min(...ps), minE = Math.min(...es);
  const spanP = Math.max(...ps) - minP || 1, spanE = Math.max(...es) - minE || 1;
  const byId = Object.fromEntries(market.providers.map(p => [p.id, p]));
  const pref = new Set(req.preferredProviders || []);
  for (const o of offers) {
    const p = byId[o.providerId];
    // 0 is ideal: normalised price and ETA, weighted by the speed-vs-cost slider, nudged by rating and preference.
    o.score = round2((1 - w) * (o.total - minP) / spanP + w * (o.etaMin - minE) / spanE - ((p.rating || 4.5) - 4.5) * 0.3 - (pref.has(p.id) ? 0.15 : 0));
    o.tags = [];
  }
  offers.sort((a, b) => a.score - b.score || a.total - b.total);
  offers[0].tags.push('Best match');
  offers.reduce((b, o) => (o.total < b.total ? o : b)).tags.push('Cheapest');
  offers.reduce((b, o) => (o.etaMin < b.etaMin ? o : b)).tags.push('Fastest');
  for (const o of offers) if (pref.has(o.providerId)) o.tags.push('Preferred');
  return { offers, surge };
}

/** Book an offer: reserves a provider slot and starts the clock. Results are attached by the caller. */
export function book(market, req, offer, now) {
  const p = market.providers.find(x => x.id === offer.providerId);
  if (!p || !providerOk(p, req)) throw new Error('That provider is no longer available. Re-match.');
  p.busy++;
  const job = {
    id: `J-${String(market.nextId++).padStart(4, '0')}`, name: req.name, datasetName: req.datasetName || req.name,
    types: [...req.types], rows: req.rows, privacy: req.privacy || 'any', humanReview: !!req.humanReview,
    providerId: p.id, stack: offer.stack, total: offer.total, etaMin: offer.etaMin, summary: offer.summary, lines: offer.lines,
    payout: offer.payout, agentPayout: offer.agentPayout, reviewPayout: offer.reviewPayout,
    status: 'running', bookedAt: now, dueAt: now + offer.etaMin, rating: null,
  };
  market.jobs.unshift(job);
  market.ledger.spent = round2(market.ledger.spent + job.total);
  return job;
}

export function progress(job, now) {
  if (job.status !== 'running') return 1;
  return Math.max(0, Math.min(1, (now - job.bookedAt) / Math.max(job.dueAt - job.bookedAt, 1e-9)));
}

export function stage(job, now) {
  if (job.status === 'delivered') return 'Delivered';
  if (job.status === 'cancelled') return 'Cancelled';
  const f = progress(job, now);
  const steps = ['Matched', 'Container up', ...job.types.map(t => JOB_TYPES[t].label), ...(job.humanReview ? ['Human review'] : []), 'Packaging'];
  return steps[Math.min(steps.length - 1, Math.floor(f * steps.length))];
}

/** Move the clock: delivers due jobs, frees slots, pays providers and agents. Returns delivered jobs. */
export function advance(market, now) {
  market.clock = Math.max(market.clock || 0, now);
  const done = [];
  for (const j of market.jobs) {
    if (j.status === 'running' && now >= j.dueAt) {
      j.status = 'delivered';
      j.deliveredAt = j.dueAt;
      const p = market.providers.find(x => x.id === j.providerId);
      if (p) { p.busy = Math.max(0, p.busy - 1); p.earned = round2((p.earned || 0) + j.payout); p.jobs = (p.jobs || 0) + 1; }
      const paid = j.stack.filter(s => s.types[0] !== 'review');
      for (const s of j.stack) {
        const a = market.agents.find(x => x.id === s.agentId);
        if (!a) continue;
        a.jobs = (a.jobs || 0) + 1;
        a.earned = round2((a.earned || 0) + (s.types[0] === 'review' ? j.reviewPayout : j.agentPayout / Math.max(1, paid.length)));
      }
      done.push(j);
    }
  }
  return done;
}

export function cancel(market, jobId) {
  const j = market.jobs.find(x => x.id === jobId);
  if (!j || j.status !== 'running') return false;
  j.status = 'cancelled';
  const p = market.providers.find(x => x.id === j.providerId);
  if (p) p.busy = Math.max(0, p.busy - 1);
  market.ledger.spent = round2(market.ledger.spent - j.total);
  return true;
}

/** Two-sided ratings: the rider rates the provider and the agents. Running averages. */
export function rate(market, jobId, stars) {
  const j = market.jobs.find(x => x.id === jobId);
  if (!j || j.status !== 'delivered' || j.rating) return false;
  const s = Math.max(1, Math.min(5, Math.round(stars)));
  j.rating = s;
  const bump = o => { o.rating = round2(((o.rating || s) * (o.ratings || 0) + s) / ((o.ratings || 0) + 1)); o.ratings = (o.ratings || 0) + 1; };
  const p = market.providers.find(x => x.id === j.providerId);
  if (p) bump(p);
  for (const st of j.stack) { const a = market.agents.find(x => x.id === st.agentId); if (a) bump(a); }
  return true;
}

/** Add capacity as a "driver". */
export function addProvider(market, spec) {
  const name = String(spec.name || '').trim();
  if (!name) throw new Error('Name your compute.');
  const routes = (spec.routes || ['public']).filter(r => ['public', 'ephemeral', 'private'].includes(r));
  const p = {
    id: `p-${market.nextId++}`, name: name.slice(0, 60), owner: 'you', kind: spec.kind === 'cpu' ? 'cpu' : 'gpu',
    region: spec.region || 'us-east', routes: routes.length ? routes : ['public'],
    pricePerCU: clamp(Number(spec.pricePerCU) || 0.004, 0.0001, 1), cuPerSec: clamp(Number(spec.cuPerSec) || 1, 0.01, 1000),
    slots: clamp(Math.round(Number(spec.slots) || 2), 1, 64), busy: 0, ambient: 0, base: 0, online: true, rating: null, ratings: 0, earned: 0, jobs: 0, mine: true,
  };
  market.providers.push(p);
  return p;
}

export function saveTemplate(market, name, req) {
  const t = { id: `T-${market.nextId++}`, name: String(name).slice(0, 60), description: req.description || '', types: [...req.types],
    privacy: req.privacy || 'any', speedVsCost: req.speedVsCost ?? 0.5, humanReview: !!req.humanReview };
  market.templates.unshift(t);
  return t;
}

export function verbs(types) {
  const v = types.filter(t => t !== 'report').map(t => JOB_TYPES[t].verb);
  if (types.includes('report')) v.push('reported');
  return v.length <= 2 ? v.join(' + ') : v.slice(0, -1).join(', ') + ' + ' + v[v.length - 1];
}

export function fmtRows(n) {
  if (n >= 1e6) return `${trim1(n / 1e6)}M rows`;
  if (n >= 1e4) return `${trim1(n / 1e3)}k rows`;
  return `${n.toLocaleString('en-US')} row${n === 1 ? '' : 's'}`;
}
const trim1 = x => (Math.round(x * 10) / 10).toString();
const fmtNum = x => (x >= 100 ? Math.round(x).toLocaleString('en-US') : String(round2(x)));
const round2 = x => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
