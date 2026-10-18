// Seeded demo market: compute providers ("drivers"), agents, ambient load, and sample datasets.

export const PROVIDERS = [
  { id: 'p-northgate', name: 'Northgate GPU pool', owner: 'Northgate Data', kind: 'gpu', region: 'us-east', routes: ['public', 'ephemeral'], pricePerCU: 0.004, cuPerSec: 1.6, slots: 6, base: 0.67, rating: 4.8, ratings: 212 },
  { id: 'p-lakeside', name: 'Lakeside A100s', owner: 'Lakeside Labs', kind: 'gpu', region: 'us-central', routes: ['public', 'ephemeral', 'private'], pricePerCU: 0.0065, cuPerSec: 2.4, slots: 3, base: 0.33, rating: 4.9, ratings: 98 },
  { id: 'p-coop', name: 'Spare Cycles co-op', owner: '41 members', kind: 'cpu', region: 'eu-west', routes: ['public'], pricePerCU: 0.0012, cuPerSec: 0.3, slots: 10, base: 0.6, rating: 4.5, ratings: 340 },
  { id: 'p-vaultline', name: 'Vaultline private cloud', owner: 'Vaultline', kind: 'gpu', region: 'us-east', routes: ['private', 'ephemeral'], pricePerCU: 0.0095, cuPerSec: 1.8, slots: 2, base: 0.0, rating: 4.9, ratings: 57 },
  { id: 'p-nightshift', name: 'Render farm night shift', owner: 'Pixelmill Studio', kind: 'gpu', region: 'ap-south', routes: ['public'], pricePerCU: 0.0028, cuPerSec: 1.0, slots: 8, base: 0.75, rating: 4.4, ratings: 131 },
  { id: 'p-campus', name: 'Campus lab cluster', owner: 'State U. HPC', kind: 'cpu', region: 'us-west', routes: ['public', 'ephemeral'], pricePerCU: 0.0018, cuPerSec: 0.45, slots: 4, base: 0.5, rating: 4.6, ratings: 76 },
  { id: 'p-fjord', name: 'Fjord H100 spot', owner: 'Fjord Compute', kind: 'gpu', region: 'eu-north', routes: ['public', 'ephemeral'], pricePerCU: 0.005, cuPerSec: 3.2, slots: 2, base: 0.0, rating: 4.7, ratings: 44, online: false },
  { id: 'p-browser', name: 'Your browser', owner: 'you', kind: 'device', region: 'local', routes: ['on-device', 'private', 'ephemeral'], pricePerCU: 0, cuPerSec: 0.08, slots: 1, base: 0.0, rating: null, ratings: 0 },
];

export const AGENTS = [
  { id: 'a-scrubber', name: 'Scrubber', skills: ['clean'], quality: 0.88, feePerCU: 0.0005, rating: 4.7, ratings: 410 },
  { id: 'a-tidy', name: 'Tidy-L', skills: ['clean'], quality: 0.95, feePerCU: 0.0012, rating: 4.9, ratings: 120 },
  { id: 'a-hawk', name: 'Entity Hawk', skills: ['extract', 'score'], quality: 0.93, feePerCU: 0.0015, rating: 4.8, ratings: 260 },
  { id: 'a-namewise', name: 'Namewise', skills: ['extract'], quality: 0.85, feePerCU: 0.0006, rating: 4.5, ratings: 190 },
  { id: 'a-leadlens', name: 'LeadLens', skills: ['score'], quality: 0.9, feePerCU: 0.001, rating: 4.7, ratings: 150 },
  { id: 'a-sorter', name: 'Sorter', skills: ['classify'], quality: 0.88, feePerCU: 0.0008, rating: 4.6, ratings: 220 },
  { id: 'a-spike', name: 'Spike', skills: ['anomaly', 'forecast'], quality: 0.9, feePerCU: 0.0007, rating: 4.8, ratings: 175 },
  { id: 'a-brief', name: 'Brief', skills: ['report', 'classify'], quality: 0.87, feePerCU: 0.0004, rating: 4.6, ratings: 300 },
  { id: 'a-desk', name: 'Verified desk (human + AI)', skills: ['review'], human: true, quality: 0.98, feePerCU: 0, rating: 4.9, ratings: 64 },
];

export function createMarket() {
  return {
    version: 1, clock: 0, nextId: 1, rush: false,
    providers: PROVIDERS.map(p => ({ online: true, earned: 0, jobs: 0, busy: 0, ambient: 0, ...p })),
    agents: AGENTS.map(a => ({ earned: 0, jobs: 0, ...a })),
    jobs: [], ledger: { spent: 0 },
    templates: [
      { id: 'T-monthly-leads', name: 'Monthly sales lead scoring', description: 'Clean this sales data, extract every company and person, score lead quality, and give me a ranked list with confidence.', types: ['clean', 'extract', 'score', 'report'], privacy: 'any', speedVsCost: 0.5, humanReview: false },
      { id: 'T-sensor-watch', name: 'Sensor anomaly sweep', description: 'Find anomalies and spikes in the sensor log, cheap, no rush.', types: ['anomaly', 'report'], privacy: 'any', speedVsCost: 0.15, humanReview: false },
    ],
  };
}

// Deterministic PRNG so the samples are identical everywhere.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function salesLeads() {
  const r = rng(11);
  const first = ['Ava', 'Liam', 'Maya', 'Noah', 'Zoe', 'Ethan', 'Priya', 'Lucas', 'Sofia', 'Omar', 'Hana', 'Diego', 'Grace', 'Kenji', 'Leah', 'Mateo', 'Nina', 'Ravi', 'Tess', 'Yusuf'];
  const last = ['Chen', 'Okafor', 'Silva', 'Patel', 'Novak', 'Kim', 'Haddad', 'Rossi', 'Berg', 'Mensah', 'Ortiz', 'Sato', 'Walsh', 'Ibrahim', 'Costa', 'Lund', 'Reyes', 'Shah', 'Moreau', 'Dube'];
  const cos = [['Acme Logistics Inc', 'acmelogistics.com'], ['Brightwave Labs', 'brightwave.io'], ['Cobalt Systems Corp', 'cobaltsys.com'], ['Delta Foods LLC', 'deltafoods.com'], ['Evergreen Health Group', 'evergreenhealth.org'], ['Foxglove Technologies', 'foxglove.tech'], ['Granite Bank PLC', 'granitebank.co.uk'], ['Harbor & Pine Co', 'harborpine.com']];
  const titles = ['CEO', 'VP Sales', 'Head of Data', 'Director of Ops', 'Marketing Manager', 'Analyst', 'Founder', 'Engineer', 'Procurement Lead', 'Intern'];
  const notes = ['Asked for pricing', 'Met at conference', 'Downloaded whitepaper', 'Referred by Granite Bank PLC', 'Cold inbound', 'Wants a demo next week', 'Budget approved', ''];
  const rows = [['name', 'title', 'company', 'email', 'phone', 'employees', 'notes']];
  for (let i = 0; i < 36; i++) {
    const f = first[i % 20], l = last[(i * 7) % 20];
    const [co, dom] = cos[Math.floor(r() * cos.length)];
    const free = r() < 0.18;
    let email = `${f}.${l}@${free ? 'gmail.com' : dom}`.toLowerCase();
    if (i % 9 === 4) email = email.toUpperCase();
    const phone = r() < 0.75 ? `+1 (${200 + Math.floor(r() * 700)}) 555-${String(1000 + Math.floor(r() * 9000))}` : '';
    const name = i % 11 === 3 ? `  ${f}   ${l} ` : `${f} ${l}`;
    rows.push([name, titles[Math.floor(r() * titles.length)], co, email, phone, String(Math.round(10 ** (1 + r() * 3.6))), notes[Math.floor(r() * notes.length)]]);
  }
  rows.push(rows[5].slice(), rows[12].slice(), ['', '', '', '', '', '', '']);
  return rows.map(r => r.map(v => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';
}

function sensorLog() {
  const r = rng(29);
  const lines = [];
  const start = Date.UTC(2026, 9, 16, 6, 0);
  for (let i = 0; i < 72; i++) {
    const device = ['pump-a', 'pump-b', 'fan-3'][i % 3];
    let temp = 41 + Math.sin(i / 8) * 2 + (r() - 0.5);
    let vib = 0.32 + (r() - 0.5) * 0.06;
    if (i === 40) temp = 78.4;
    if (i === 57) vib = 2.9;
    lines.push(JSON.stringify({ ts: new Date(start + i * 5 * 60000).toISOString(), device, temp_c: Math.round(temp * 10) / 10, vibration_g: Math.round(vib * 100) / 100, status: 'ok' }));
  }
  return lines.join('\n') + '\n';
}

function monthlyRevenue() {
  const r = rng(5);
  const rows = ['month,revenue,orders,region'];
  for (let i = 0; i < 24; i++) {
    const d = new Date(Date.UTC(2024, 10 + i, 1));
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const rev = Math.round(42000 + i * 1850 + Math.sin(i / 1.9) * 2500 + (r() - 0.5) * 3000);
    rows.push(`${m},${rev},${Math.round(rev / 61)},${i % 2 ? 'EU' : 'NA'}`);
  }
  return rows.join('\n') + '\n';
}

function tickets() {
  const items = [
    ['billing', 'Charged twice this month, need a refund'], ['bug', 'Export button is broken on Safari'], ['praise', 'Love the new dashboard, great work'],
    ['bug', 'App is slow and the sync fails every morning'], ['question', 'How do I add a teammate?'], ['praise', 'Support was fast and helpful, thanks'],
    ['billing', 'Invoice shows the wrong company name'], ['bug', 'Error 500 when uploading a CSV'], ['question', 'Can I export to Excel?'],
    ['praise', 'Excellent onboarding, perfect for our team'], ['bug', 'Login loop after password reset, terrible'], ['billing', 'Please update our card'],
    ['question', 'Do you have an API?'], ['bug', 'Late notifications, poor reliability'], ['praise', 'Amazing feature, happy customer'],
    ['question', 'Where is the audit log?'], ['billing', 'Angry about the price increase'], ['bug', 'Charts fail to load'],
  ];
  return JSON.stringify(items.map(([category, comment], i) => ({ id: 1000 + i, customer: { plan: ['free', 'pro', 'team'][i % 3] }, category, comment })), null, 1) + '\n';
}

export const SAMPLES = [
  { file: 'sales_leads.csv', title: 'Sales leads export', fullRows: 1200000, description: 'Clean this sales data, extract every company and person, score lead quality, and give me a ranked list with confidence.', text: salesLeads() },
  { file: 'sensor_log.jsonl', title: 'Factory sensor log', fullRows: 250000, description: 'Find anomalies and spikes in this sensor log, cheap, no rush.', text: sensorLog() },
  { file: 'monthly_revenue.csv', title: 'Monthly revenue', fullRows: 24, description: 'Forecast revenue for the next quarter and write a short report.', text: monthlyRevenue() },
  { file: 'support_tickets.json', title: 'Support tickets', fullRows: 80000, description: 'Summarize and classify these tickets by sentiment; it is confidential customer data.', text: tickets() },
];
