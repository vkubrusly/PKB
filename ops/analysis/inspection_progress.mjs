// Inspection progress per job against the county checklist (config/inspection_checklists.json).
// Answers: which inspections passed, which failed and are still open, what is next,
// how many remain, and a date estimate for the remaining steps and the CO.
//
// Estimates use PKB's own history: for each checklist step, the median days from permit
// issued to the step's first pass across jobs. A job is anchored on its latest passed step
// and the remaining steps are projected with the median gaps. Steps with fewer than
// MIN_SAMPLES jobs of history get no date (reported as insufficient history).
//
// CLI: node ops/analysis/inspection_progress.mjs [--json out.json]   (reads Supabase via sb.mjs)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIN_SAMPLES = 3;
const DAY = 864e5;
const toDate = (s) => (s ? new Date(String(s).slice(0, 10) + 'T12:00:00Z') : null);
const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export function loadChecklists() {
  const p = new URL('../config/inspection_checklists.json', import.meta.url);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const out = {};
  for (const [portal, steps] of Object.entries(raw)) {
    if (portal.startsWith('_')) continue;
    out[portal] = steps.map((s) => ({ ...s, re: new RegExp(s.match, 'i') }));
  }
  return out;
}

const isPass = (i) => i.passed ?? /^(approved|passed)/i.test(i.status || '');
const isFail = (i) => i.failed ?? /disapprov|fail|partial|denied/i.test(i.status || '');
const isCancel = (i) => /cancel/i.test(i.status || '');
const when = (i) => i.actual_at || i.scheduled_at || i.requested_at;

// inspections: [{type, status, passed, failed, requested_at, scheduled_at, actual_at}]
export function stepStatus(inspections, checklist) {
  const steps = checklist.map((s) => ({ key: s.key, name: s.name, optional: !!s.optional, final: !!s.final, attempts: 0, failures: 0, passedAt: null, lastAt: null, lastStatus: null }));
  const unmatched = [];
  const sorted = [...inspections].sort((a, b) => String(when(a) || '').localeCompare(String(when(b) || '')));
  for (const i of sorted) {
    const idx = checklist.findIndex((s) => s.re.test(i.type || ''));
    if (idx < 0) { unmatched.push(i.type); continue; }
    const st = steps[idx];
    if (isCancel(i)) continue;
    st.attempts++;
    if (isFail(i)) st.failures++;
    if (isPass(i) && !st.passedAt) st.passedAt = when(i);
    st.lastAt = when(i);
    st.lastStatus = i.status;
    st.lastComments = i.comments || null;
  }
  for (const st of steps) {
    st.state = st.passedAt ? 'passed'
      : st.lastStatus && isFail({ status: st.lastStatus }) ? 'failed_open'
      : st.lastStatus ? 'requested'
      : 'pending';
  }
  // A never-requested step that sits before the last passed non-final step was done off-portal
  // (or under another permit): don't report it as remaining.
  const lastPassedIdx = steps.reduce((m, s, i) => (s.state === 'passed' && !s.final ? i : m), -1);
  steps.forEach((s, i) => { if (s.state === 'pending' && i < lastPassedIdx) s.state = 'not_recorded'; });
  return { steps, unmatched: [...new Set(unmatched)] };
}

// jobs: [{job_number, portal, issued_at, inspections: [...]}]
export function benchmarks(jobs, checklists) {
  const acc = {};
  for (const j of jobs) {
    const cl = checklists[j.portal];
    const issued = toDate(j.issued_at);
    if (!cl || !issued) continue;
    const { steps } = stepStatus(j.inspections, cl);
    for (const s of steps) {
      if (!s.passedAt) continue;
      ((acc[j.portal] ??= {})[s.key] ??= []).push(Math.round((toDate(s.passedAt) - issued) / DAY));
    }
  }
  const out = {};
  for (const [portal, keys] of Object.entries(acc)) {
    out[portal] = {};
    for (const [k, arr] of Object.entries(keys)) out[portal][k] = { medianDays: median(arr), n: arr.length };
  }
  return out;
}

export function jobProgress(job, checklists, bench, asOf = new Date()) {
  const cl = checklists[job.portal];
  if (!cl) return { supported: false, reason: `no checklist for ${job.portal || 'unknown portal'}` };
  const { steps, unmatched } = stepStatus(job.inspections || [], cl);
  const b = bench[job.portal] || {};
  const today = toDate(iso(asOf));
  const required = steps.filter((s) => !s.optional);
  const passed = required.filter((s) => s.state === 'passed');
  const remaining = required.filter((s) => s.state !== 'passed' && s.state !== 'not_recorded');
  const failedOpen = steps.filter((s) => s.state === 'failed_open');

  // Anchor: latest passed step that has a benchmark; fall back to permit issuance.
  let anchor = null;
  for (const s of steps) {
    if (s.state === 'passed' && b[s.key]?.n >= MIN_SAMPLES && (!anchor || toDate(s.passedAt) >= toDate(anchor.passedAt))) anchor = s;
  }
  const anchorDate = anchor ? toDate(anchor.passedAt) : toDate(job.issued_at);
  const anchorDays = anchor ? b[anchor.key].medianDays : 0;

  let insufficient = [];
  const projected = remaining.map((s) => {
    const bm = b[s.key];
    if (!anchorDate || !bm || bm.n < MIN_SAMPLES) { insufficient.push(s.name); return { name: s.name, state: s.state, final: s.final, estimate: null }; }
    let est = addDays(anchorDate, Math.max(0, bm.medianDays - anchorDays));
    if (est < today) est = today; // overdue against the median: earliest is now
    return { name: s.name, state: s.state, final: s.final, estimate: iso(est), basisJobs: bm.n };
  });

  const nonFinal = projected.filter((p) => !p.final);
  const readyForFinals = nonFinal.length ? nonFinal.reduce((m, p) => (p.estimate && (!m || p.estimate > m) ? p.estimate : m), null) : 'now';
  const finals = projected.filter((p) => p.final);
  const coEstimate = finals.length && finals.every((p) => p.estimate) ? finals.reduce((m, p) => (p.estimate > m ? p.estimate : m), '') : null;

  return {
    supported: true,
    passed: passed.length,
    required: required.length,
    percent: Math.round((passed.length / required.length) * 100),
    lastPassed: passed.sort((x, y) => String(y.passedAt).localeCompare(String(x.passedAt)))[0]?.name || null,
    failedOpen: failedOpen.map((s) => ({ name: s.name, since: s.lastAt, failures: s.failures, comments: s.lastComments })),
    // Next = open failures first (re-inspection), then the remaining step expected soonest.
    next: (failedOpen[0] || [...projected].sort((x, y) => String(x.estimate || '9').localeCompare(String(y.estimate || '9')))[0])?.name || null,
    remaining: projected,
    readyForFinalsEstimate: readyForFinals,
    coEstimate,
    coEstimateNote: coEstimate ? null : `final inspections lack history (${insufficient.filter((n) => finals.some((f) => f.name === n)).join(', ') || 'n/a'}); estimate CO from ready-for-finals plus the finals turnaround once more jobs close`,
    unmatchedTypes: unmatched,
    steps: steps.map((s) => ({ name: s.name, state: s.state, optional: s.optional, final: s.final, passedAt: s.passedAt, failures: s.failures, lastComments: s.state === 'failed_open' ? s.lastComments : undefined })),
  };
}

async function main() {
  const { sql } = await import('../scripts/sb.mjs');
  const rows = await sql(`
    select j.job_number, c.portal, c.issued_at, i.type, i.status, i.passed, i.failed, i.requested_at, i.scheduled_at, i.actual_at, i.comments
    from ops.permit_cases c join ops.jobs j on j.id = c.job_id
    left join ops.inspections i on i.permit_case_id = c.id
    where c.kind = 'building' and c.issued_at is not null`);
  const jobs = {};
  for (const r of rows) {
    const j = (jobs[r.job_number] ??= { job_number: r.job_number, portal: r.portal, issued_at: r.issued_at, inspections: [] });
    if (r.type) j.inspections.push(r);
  }
  const cls = loadChecklists();
  const bench = benchmarks(Object.values(jobs), cls);
  const out = { benchmarks: bench, jobs: {} };
  for (const j of Object.values(jobs)) out.jobs[j.job_number] = jobProgress(j, cls, bench);
  const i = process.argv.indexOf('--json');
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(out, null, 1));
  else console.log(JSON.stringify(out, null, 1));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
