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
  const text = `Hello,

The appliances are now installed at the house below (per our Daily Log of ${usDate(hit.date)}), so the dumpster is no longer needed on site. Please schedule its removal:

Job: ${job_number}
Address: ${address}

Please reply to this e-mail with the pickup date. Thank you!

PKB Homes
— PKB Ops`;
  const st = await mail({ rule: 'dumpster_removal', jobId, to: [TO], cc: t.emails, subject: `Dumpster removal — Job ${job_number} · ${String(address || '').split(',')[0]}`, text });   // Cc only the job's Project Manager field (no standing external Cc)
  if (t.missing.length) console.log(`  (no e-mail on file for: ${t.missing.join(', ')})`);
  if (st === 'sent' || st === 'draft') { await recordEvent({ jobId, kind: 'dumpster.removal_requested', payload: { log_date: hit.date, text: hit.text, to: TO, cc: t.emails, status: st }, key }); sent++; }
}
console.log(`dumpster_removal: ${sent} e-mail(s) · ${recorded} older log(s) recorded without e-mail`);
