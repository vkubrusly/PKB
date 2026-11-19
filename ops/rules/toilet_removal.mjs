#!/usr/bin/env node
// =============================================================================
// toilet_removal.mjs — portable toilet pickup (Victor, 11/19/26). When the county approves the house's
// Water Service inspection (the water connection; Citrus: WATER SERVICE), e-mail RC Site Services
// (info@rcsiteservices.com) to remove the portable toilet, with the job number and address; Cc ONLY the people in the job's
// Buildertrend Project Manager field (supervisors and PMs are both kept there now). Once per job. Inspections approved more than RECENT_DAYS ago are only
// recorded (no e-mail), so the first run does not e-mail old jobs.
//   node rules/toilet_removal.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, RECENT_DAYS, usDate, daysAgo, orgId, team, seenPrefix, seen, recordEvent, mail } from './lib.mjs';

const TO = 'info@rcsiteservices.com';
// --test-to <email> [--job 0017]: send the e-mail of one job ONLY to <email>, marked TEST; nothing recorded.
const argv = process.argv, arg = (k) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : null; };
const TEST_TO = arg('--test-to'), TEST_JOB = arg('--job');
const org = await orgId();
const rows = await sql(`select j.id job_id, j.job_number, j.address, i.type, coalesce(i.actual_at, i.scheduled_at, i.requested_at)::date::text passed_on
  from ops.jobs j join ops.permit_cases c on c.job_id = j.id and c.kind = 'building'
  join ops.inspections i on i.permit_case_id = c.id and i.passed and i.type ~* 'water service'
  where j.org_id = ${q(org)} order by passed_on`);
const first = new Map(); for (const r of rows) if (!first.has(r.job_id)) first.set(r.job_id, r);
if (TEST_TO) {
  const r = [...first.values()].find((x) => !TEST_JOB || x.job_number === TEST_JOB);
  if (!r) { console.log('test: no job with a passed Water Service inspection'); process.exit(1); }
  const st = await mail({ rule: 'toilet_removal_test', jobId: r.job_id, to: [TEST_TO], subject: `[TEST] Portable toilet removal — Job ${r.job_number} · ${String(r.address || '').split(',')[0]}`,
    text: `[TEST — sent only to ${TEST_TO}; RC Site Services did NOT receive this]\n\nHello RC Site Services team,\n\nPlease schedule the removal of the portable toilet from the job below:\n\nJob: ${r.job_number}\nAddress: ${r.address}\n\nPlease reply to this e-mail with the pickup date. Thank you!\n\nPKB Homes\n— PKB Ops` });
  console.log(`test e-mail: ${st}`); process.exit(st === 'failed' ? 1 : 0);
}
await seenPrefix('toilet.removal:');
let sent = 0, recorded = 0;
for (const r of first.values()) {
  const key = `toilet.removal:${r.job_id}`;
  if (await seen(key)) continue;
  const recent = daysAgo(r.passed_on) <= RECENT_DAYS;
  if (!recent) {   // old approval: just remember it
    if (!DRY) await recordEvent({ jobId: r.job_id, kind: 'toilet.removal_skipped', payload: { passed_on: r.passed_on, reason: 'approved before this rule' }, key });
    recorded++; continue;
  }
  const t = await team(r.job_id, { pmFieldOnly: true });
  const text = `Hello RC Site Services team,

Please schedule the removal of the portable toilet from the job below:

Job: ${r.job_number}
Address: ${r.address}

Please reply to this e-mail with the pickup date. Thank you!

PKB Homes
— PKB Ops`;
  const st = await mail({ rule: 'toilet_removal', jobId: r.job_id, to: [TO], cc: t.emails, subject: `Portable toilet removal — Job ${r.job_number} · ${String(r.address || '').split(',')[0]}`, text });   // Cc only the job's Project Manager field (no standing external Cc)
  if (t.missing.length) console.log(`  (no e-mail on file for: ${t.missing.join(', ')})`);
  if (st === 'sent' || st === 'draft') { await recordEvent({ jobId: r.job_id, kind: 'toilet.removal_requested', payload: { passed_on: r.passed_on, to: TO, cc: t.emails, status: st }, key }); sent++; }
}
console.log(`toilet_removal: ${sent} e-mail(s) · ${recorded} older approval(s) recorded without e-mail`);
