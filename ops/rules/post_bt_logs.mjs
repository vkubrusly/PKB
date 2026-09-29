#!/usr/bin/env node
// =============================================================================
// post_bt_logs.mjs — publish the Buildertrend Daily Logs the rules queued
// (ops.outbound_messages, channel bt_daily_log, status draft) on each job.
//
// Opens the job's Daily Logs by its Buildertrend id, fills title and notes,
// notifies exactly the people listed in to_addresses (Buildertrend display names;
// names that are not Buildertrend users on the job are skipped and reported),
// checks the form is on the right job, then publishes.
// Enabled by OPS_BT_POST=true (repository variable); otherwise lists what it would post.
//   BT_COOKIES_FILE=… node rules/post_bt_logs.mjs [--dry-run]
// =============================================================================
import { sql } from '../scripts/sb.mjs';
import { openBuildertrend } from '../collectors/buildertrend/session.mjs';
import { createDailyLog } from '../collectors/buildertrend/daily_log.mjs';

const DRY = process.argv.includes('--dry-run') || process.env.OPS_BT_POST !== 'true';
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

const drafts = await sql(`select m.id, m.subject, m.body, m.to_addresses, j.job_number, j.bt_job_id, j.bt_job_name
  from ops.outbound_messages m join ops.jobs j on j.id = m.job_id
  where m.channel = 'bt_daily_log' and m.status = 'draft' order by m.created_at limit 20`);
if (!drafts.length) { console.log('no Daily Logs to post'); process.exit(0); }
if (DRY) { for (const d of drafts) console.log(`[dry run] ${d.job_number} "${d.subject}" → notify ${d.to_addresses.join(', ')}`); process.exit(0); }

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('Buildertrend session expired — nothing posted'); await browser.close(); process.exit(0); }
let ok = 0;
for (const d of drafts) {
  if (!d.bt_job_id) { console.log(`skip ${d.job_number}: not in Buildertrend`); continue; }
  try {
    const r = await createDailyLog(page, { jobId: d.bt_job_id, jobName: d.bt_job_name, title: d.subject.slice(0, 50), notes: d.body.slice(0, 4000), notify: d.to_addresses });
    await sql(`update ops.outbound_messages set status = 'sent', sent_at = now(), external_id = ${q(r.logId ? String(r.logId) : r.url)},
      error = ${q(r.skipped?.length ? `not notified (not Buildertrend users on the job): ${r.skipped.join(', ')}` : null)} where id = ${q(d.id)}`);
    console.log(`POSTED ${d.job_number} "${d.subject}" log ${r.logId} · notified ${r.notified.join(', ')}${r.skipped.length ? ` · skipped ${r.skipped.join(', ')}` : ''}`);
    ok++;
  } catch (e) {
    await sql(`update ops.outbound_messages set error = ${q(e.message.slice(0, 500))} where id = ${q(d.id)}`);
    console.error(`FAILED ${d.job_number}: ${e.message.split('\n')[0]}`);
  }
}
await browser.close();
console.log(`Daily Logs posted: ${ok}/${drafts.length}`);
