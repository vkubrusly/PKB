#!/usr/bin/env node
// =============================================================================
// permits_kpi.mjs — first KPIs straight from the collected portal JSON.
//
//   node analysis/permits_kpi.mjs [--county marion] [--md out.md]
//
// For every collected permit it splits the calendar time into:
//   county days   — submittal submitted → submittal completed (reviewers' clock)
//   resubmit days — submittal completed → next submittal submitted (our/designer clock)
// and tallies which departments fail and how often. This is the "where did the
// 143 days go?" question the spreadsheet cannot answer.
// =============================================================================
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : null; };
const county = flag('--county') || 'marion';
const mdOut = flag('--md');
const dir = join(HERE, '..', 'data', 'portal', county);

const days = (a, b) => (a && b) ? Math.round((new Date(b) - new Date(a)) / 86400000) : null;
const today = new Date().toISOString().slice(0, 10);
const median = (xs) => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (xs) => { const s = xs.filter(x => x != null); return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null; };

const permits = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'))
  .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))).filter(p => p.found).map(p => p.permit);

const rows = [];
const deptFails = {};   // department → { fails, reviews }
const deptFailPermits = {};
let countyDaysAll = [], resubmitDaysAll = [], roundsAll = [];
for (const p of permits) {
  const subs = p.submittals;
  let countyDays = 0, resubmitDays = 0, openSince = null;
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    if (s.completedAt) countyDays += days(s.submittedAt, s.completedAt) ?? 0;
    else openSince = s.submittedAt;
    const next = subs[i + 1];
    if (s.completedAt && next) resubmitDays += days(s.completedAt, next.submittedAt) ?? 0;
  }
  const waitingOnCounty = openSince ? days(openSince, today) : 0;
  // days since the last completed round when nothing was resubmitted (ball with us)
  const lastDone = [...subs].reverse().find(s => s.completedAt);
  const waitingOnUs = (!openSince && lastDone && !p.issuedAt && /re-?submit/i.test(lastDone.status)) ? days(lastDone.completedAt, today) : 0;
  const failedDepts = [...new Set(p.reviewItems.filter(r => /re-?submit|denied|fail/i.test(r.status)).map(r => r.department))];
  for (const r of p.reviewItems) {
    const d = (deptFails[r.department] ||= { fails: 0, reviews: 0 });
    d.reviews++;
    if (/re-?submit|denied|fail/i.test(r.status)) { d.fails++; (deptFailPermits[r.department] ||= new Set()).add(p.number); }
  }
  const activeHolds = p.holds.filter(h => h.active).map(h => h.comments || h.name);
  const total = days(p.appliedAt, p.issuedAt || today);
  rows.push({ number: p.number, address: p.address, status: p.status, appliedAt: p.appliedAt, issuedAt: p.issuedAt, total,
    rounds: subs.length, countyDays, resubmitDays, waitingOnCounty, waitingOnUs, failedDepts, activeHolds,
    inspections: p.inspections.length, inspFailed: p.inspections.filter(i => i.failed).length });
  if (subs.length) { countyDaysAll.push(countyDays); resubmitDaysAll.push(resubmitDays); roundsAll.push(subs.length); }
}
rows.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

const issued = rows.filter(r => r.issuedAt);
const inReview = rows.filter(r => !r.issuedAt);
const L = [];
L.push(`# Permit KPIs — ${county} (${permits.length} permits collected on ${today})`, '');
L.push(`| | n | median | mean |`, `|---|---|---|---|`);
L.push(`| Days applied → issued (issued only) | ${issued.length} | ${median(issued.map(r => r.total))} | ${mean(issued.map(r => r.total))} |`);
L.push(`| Submittal rounds per permit | ${roundsAll.length} | ${median(roundsAll)} | ${mean(roundsAll)} |`);
L.push(`| Days at the county (sum of rounds) | ${countyDaysAll.length} | ${median(countyDaysAll)} | ${mean(countyDaysAll)} |`);
L.push(`| Days in resubmission (our side) | ${resubmitDaysAll.length} | ${median(resubmitDaysAll)} | ${mean(resubmitDaysAll)} |`, '');
const totalCounty = countyDaysAll.reduce((a, b) => a + b, 0), totalResub = resubmitDaysAll.reduce((a, b) => a + b, 0);
if (totalCounty + totalResub) L.push(`Of the total review time, **${Math.round(100 * totalCounty / (totalCounty + totalResub))}% was the county** and **${Math.round(100 * totalResub / (totalCounty + totalResub))}% was resubmission** (designer/PKB).`, '');

L.push(`## Departments that fail most`, '', `| Department | reviews | failures | % | permits affected |`, `|---|---|---|---|---|`);
for (const [d, v] of Object.entries(deptFails).sort((a, b) => b[1].fails - a[1].fails)) {
  if (!v.fails) continue;
  L.push(`| ${d} | ${v.reviews} | ${v.fails} | ${Math.round(100 * v.fails / v.reviews)}% | ${deptFailPermits[d]?.size ?? 0} |`);
}
L.push('');

L.push(`## In progress — who has the ball`, '', `| Permit | Address | Status | Rounds | County days | Resubmit days | Waiting on county for | Waiting on us for | Active holds |`, `|---|---|---|---|---|---|---|---|---|`);
for (const r of inReview) L.push(`| ${r.number} | ${r.address} | ${r.status} | ${r.rounds} | ${r.countyDays} | ${r.resubmitDays} | ${r.waitingOnCounty || ''} | ${r.waitingOnUs || ''} | ${r.activeHolds.join('; ')} |`);
L.push('');

L.push(`## Issued — history`, '', `| Permit | Address | Applied | Issued | Total days | Rounds | County days | Resubmit days | Failed in |`, `|---|---|---|---|---|---|---|---|---|`);
for (const r of issued) L.push(`| ${r.number} | ${r.address} | ${r.appliedAt} | ${r.issuedAt} | ${r.total} | ${r.rounds} | ${r.countyDays} | ${r.resubmitDays} | ${r.failedDepts.join('; ')} |`);

const out = L.join('\n');
if (mdOut) writeFileSync(mdOut, out);
console.log(out);
