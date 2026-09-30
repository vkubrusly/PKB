#!/usr/bin/env node
// =============================================================================
// Rule R9 — Buildertrend Daily Log for every county plan-review change on a building permit:
//   - plans submitted (round 1) / corrections resubmitted (round N > 1);
//   - review round finished: approved, or corrections required (with the departments and
//     the reviewers' comments).
// Permit events notify Cristiano + Guilherme in Buildertrend (inspection events go to the
// supervisors — rules R8 and inspection_failed). Only changes from the last RECENT_DAYS days
// are logged; older rounds are a silent baseline.
//   node rules/review_log.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, RECENT_DAYS, brDate, daysAgo, orgId, seen, seenPrefix, recordEvent, queueDailyLog, contacts, REVIEW_FAILED } from './lib.mjs';

const notify = [contacts.internal.contractor_of_record?.bt_name, contacts.internal.permits_owner?.name].filter(Boolean);
const rounds = await sql(`select s.permit_case_id case_id, s.round, s.type, s.status, s.submitted_at, s.completed_at, c.number, c.job_id, j.job_number
  from ops.submittals s join ops.permit_cases c on c.id = s.permit_case_id join ops.jobs j on j.id = c.job_id
  where j.org_id = ${q(await orgId())} and c.kind = 'building' order by s.submitted_at, s.round`);

await seenPrefix('review.');
let logged = 0, baseline = 0;
async function step({ key, kind, at, r, title, notes, payload }) {
  if (!at || await seen(key)) return;
  if (daysAgo(at) > RECENT_DAYS) { baseline++; await recordEvent({ jobId: r.job_id, caseId: r.case_id, kind, at, payload: { ...payload, baseline: true }, key }); return; }
  const ev = await recordEvent({ jobId: r.job_id, caseId: r.case_id, kind, at, payload, key });
  await queueDailyLog({ rule: 'R9', jobId: r.job_id, eventId: ev, title, notes, notify });
  console.log(`${r.job_number} ${r.number} — ${title}`);
  logged++;
}

for (const r of rounds) {
  await step({
    key: `review.submitted:${r.case_id}:${r.round}`, kind: 'review.submitted', at: r.submitted_at, r, payload: { round: r.round },
    title: r.round > 1 ? `Corrections resubmitted — round ${r.round}` : 'Plans submitted to the county',
    notes: r.round > 1
      ? `Permit ${r.number}: corrections resubmitted to the county on ${brDate(r.submitted_at)} — review round ${r.round} (${r.type}).`
      : `Permit ${r.number}: plans submitted to the county on ${brDate(r.submitted_at)} (${r.type}).`,
  });
  if (!r.completed_at) continue;
  const failed = REVIEW_FAILED.test(r.status || '');
  let detail = '';
  if (failed) {
    const items = await sql(`select department, status, reviewer, comments from ops.review_items where permit_case_id = ${q(r.case_id)} and round = ${r.round} and failed order by department`);
    detail = items.map((i) => `- ${i.department}: ${i.status}${i.reviewer ? ` (${i.reviewer})` : ''}${i.comments ? ` — ${String(i.comments).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`).join('\n');
  }
  await step({
    key: `review.completed:${r.case_id}:${r.round}`, kind: 'review.completed', at: r.completed_at, r, payload: { round: r.round, status: r.status, failed },
    title: failed ? `County review round ${r.round}: corrections` : `County review round ${r.round}: approved`,
    notes: failed
      ? `Permit ${r.number}: county review round ${r.round} came back on ${brDate(r.completed_at)} — ${r.status}.\n${detail}\nCorrections sent to the designer (Sovereign), 2 business days per item.`
      : `Permit ${r.number}: county review round ${r.round} ${r.status.toLowerCase()} on ${brDate(r.completed_at)}.`,
  });
}
console.log(`review log: ${logged} Daily Log(s) queued · ${baseline} baseline${DRY ? ' · DRY RUN' : ''}`);
