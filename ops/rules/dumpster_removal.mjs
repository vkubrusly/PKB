#!/usr/bin/env node
// =============================================================================
// dumpster_removal.mjs — dumpster pickup (Victor, 11/19/26). When a Buildertrend Daily Log says the house's
// appliances are installed ("Appliances instalados", "appliances installed", "instalação de appliances
// concluída"… — the same reading as the schedule robot, rules/dailylog_done.mjs), e-mail GFL
// (rsutter@gflenv.com) in English to remove the dumpster, with the job number and address; Cc ONLY the people in the job's Buildertrend Project Manager field. Once per job; logs older than RECENT_DAYS are only recorded (no e-mail).
//   node rules/dumpster_removal.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, RECENT_DAYS, usDate, daysAgo, orgId, team, seenPrefix, seen, recordEvent, mail } from './lib.mjs';
import { doneFromLogs } from './dailylog_done.mjs';

const TO = 'rsutter@gflenv.com';
const org = await orgId();
const logs = await sql(`select l.job_id, l.job_number, j.address, l.log_date::text date, l.author by, l.title, l.notes
  from ops.daily_logs l join ops.jobs j on j.id = l.job_id where j.org_id = ${q(org)}`);
const byJob = new Map(); for (const l of logs) { if (!byJob.has(l.job_id)) byJob.set(l.job_id, []); byJob.get(l.job_id).push(l); }
// --test-to <email> [--job 0024]: send the e-mail of one job ONLY to <email>, marked TEST; nothing recorded.
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const TEST_TO = arg('--test-to'), TEST_JOB = arg('--job');
const body = (job, address) => `Hello,\n\nPlease schedule the removal of the dumpster from the job below:\n\nJob: ${job}\nAddress: ${address}\n\nPlease reply to this e-mail with the pickup date. Thank you!\n\nPKB Homes\n— PKB Ops`;
if (TEST_TO) {
  const [jobId, ls] = [...byJob].find(([, l]) => (!TEST_JOB || l[0].job_number === TEST_JOB) && doneFromLogs(l).get('^appliances$')) || [];
  if (!jobId) { console.log('test: no job whose Daily Log says the appliances are installed'); process.exit(1); }
  const st = await mail({ rule: 'dumpster_removal_test', jobId, to: [TEST_TO], subject: `[TEST] Dumpster removal — Job ${ls[0].job_number} · ${String(ls[0].address || '').split(',')[0]}`,
    text: `[TEST — sent only to ${TEST_TO}; GFL did NOT receive this]\n\n` + body(ls[0].job_number, ls[0].address) });
  console.log(`test e-mail: ${st}`); process.exit(st === 'failed' ? 1 : 0);
}
await seenPrefix('dumpster.removal:');
let sent = 0, recorded = 0;
for (const [jobId, ls] of byJob) {
  const hit = doneFromLogs(ls).get('^appliances$'); if (!hit) continue;
  const key = `dumpster.removal:${jobId}`;
  if (await seen(key)) continue;
  const { job_number, address } = ls[0];
  if (daysAgo(hit.date) > RECENT_DAYS) {
    if (!DRY) await recordEvent({ jobId, kind: 'dumpster.removal_skipped', payload: { log_date: hit.date, text: hit.text, reason: 'logged before this rule' }, key });
    recorded++; continue;
  }
  const t = await team(jobId, { pmFieldOnly: true });
  const text = body(job_number, address);
  const st = await mail({ rule: 'dumpster_removal', jobId, to: [TO], cc: t.emails, subject: `Dumpster removal — Job ${job_number} · ${String(address || '').split(',')[0]}`, text });   // Cc only the job's Project Manager field (no standing external Cc)
  if (t.missing.length) console.log(`  (no e-mail on file for: ${t.missing.join(', ')})`);
  if (st === 'sent' || st === 'draft') { await recordEvent({ jobId, kind: 'dumpster.removal_requested', payload: { log_date: hit.date, text: hit.text, to: TO, cc: t.emails, status: st }, key }); sent++; }
}
console.log(`dumpster_removal: ${sent} e-mail(s) · ${recorded} older log(s) recorded without e-mail`);
