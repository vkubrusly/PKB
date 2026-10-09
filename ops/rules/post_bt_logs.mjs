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
//   BT_COOKIES_FILE=… node rules/post_bt_logs.mjs [--post | --dry-run]
// =============================================================================
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, downloadObject } from '../scripts/sb.mjs';
import { openBuildertrend } from '../collectors/buildertrend/session.mjs';
import { createDailyLog } from '../collectors/buildertrend/daily_log.mjs';

// --post publishes (same as OPS_BT_POST=true); without it the script only lists the drafts.
const DRY = process.argv.includes('--dry-run') || !(process.env.OPS_BT_POST === 'true' || process.argv.includes('--post'));
// Every Daily Log says who asked for it (Victor, 2026-09-30).
const signature = (d) => d.rule === 'FIELD' ? `— Enviado por ${d.requested_by || 'equipe'} via PKB Ops (canal de campo)`
  : d.rule === 'ASK' ? `— Pedido por ${d.requested_by || 'sócio'} via PKB Ops (Ask)`
  : `— Registro automático do PKB Ops (regra ${d.rule})`;
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

const drafts = await sql(`select m.id, m.rule, m.requested_by, m.subject, m.body, m.to_addresses, m.media, j.job_number, j.bt_job_id, j.bt_job_name
  from ops.outbound_messages m join ops.jobs j on j.id = m.job_id
  where m.channel = 'bt_daily_log' and m.status = 'draft' order by m.created_at limit 20`);
if (!drafts.length) { console.log('no Daily Logs to post'); process.exit(0); }
if (DRY) { for (const d of drafts) console.log(`[dry run] ${d.job_number} "${d.subject}" → notify ${d.to_addresses.join(', ')}`); process.exit(0); }

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('Buildertrend session expired — nothing posted'); await browser.close(); process.exit(0); }
let ok = 0;
for (const d of drafts) {
  if (!d.bt_job_id) {
    // A house with no Buildertrend job (spreadsheet-only "S…" rows) can't take a Daily Log; after 3 days
    // stop retrying, so the hourly poster doesn't open Buildertrend for it every hour.
    console.log(`skip ${d.job_number}: not in Buildertrend`);
    await sql(`update ops.outbound_messages set status = 'cancelled', error = 'house has no Buildertrend job — not posted' where id = ${q(d.id)} and status = 'draft' and created_at < now() - interval '3 days'`);
    continue;
  }
  // claim the draft so a parallel run (hourly poster / daily round) never posts it twice
  const claim = await sql(`update ops.outbound_messages set error = 'posting:' || now()::text where id = ${q(d.id)} and status = 'draft'
    and (error is null or error not like 'posting:%' or substring(error from 9)::timestamptz < now() - interval '30 minutes') returning id`);
  if (!claim.length) { console.log(`skip ${d.job_number}: being posted by another run`); continue; }
  const dir = join(tmpdir(), `btlog_${d.id}`);
  try {
    // photos and videos sent from the field channel (Supabase Storage 'field-media') → local files to attach
    const attachments = [];
    for (const [i, m] of (d.media || []).filter((x) => x.kind === 'video' || (x.kind === 'photo' && !x.from_video)).entries()) {
      mkdirSync(dir, { recursive: true });
      const ext = (m.path.match(/\.(\w+)$/)?.[1] || 'jpg').toLowerCase();
      const f = join(dir, `${d.job_number}_${String(i + 1).padStart(2, '0')}.${ext}`);
      writeFileSync(f, await downloadObject('field-media', m.path));
      attachments.push(f);
    }
    const r = await createDailyLog(page, { jobId: d.bt_job_id, jobName: d.bt_job_name, title: d.subject.slice(0, 50), notes: `${d.body.trim().slice(0, 3850)}\n\n${signature(d)}`.slice(0, 4000), notify: d.to_addresses, attachments });
    await sql(`update ops.outbound_messages set status = 'sent', sent_at = now(), external_id = ${q(r.logId ? String(r.logId) : r.url)},
      error = ${q(r.skipped?.length ? `not notified (not Buildertrend users on the job): ${r.skipped.join(', ')}` : null)} where id = ${q(d.id)}`);
    console.log(`POSTED ${d.job_number} "${d.subject}" log ${r.logId} · notified ${r.notified.join(', ')}${r.attached ? ` · ${r.attached} photo(s)` : ''}${r.skipped.length ? ` · skipped ${r.skipped.join(', ')}` : ''}`);
    ok++;
  } catch (e) {
    await page.screenshot({ path: new URL(`../data/buildertrend/probe/post_fail_${d.job_number}.png`, import.meta.url).pathname }).catch(() => {}); // gitignored
    await sql(`update ops.outbound_messages set error = ${q(e.message.slice(0, 500))} where id = ${q(d.id)}`); // releases the claim
    console.error(`FAILED ${d.job_number}: ${e.message.split('\n')[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
await browser.close();
console.log(`Daily Logs posted: ${ok}/${drafts.length}`);
