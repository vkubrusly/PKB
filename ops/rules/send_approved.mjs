#!/usr/bin/env node
// =============================================================================
// Sends the e-mails a partner approved in the portal (Ask assistant → Confirm):
// ops.outbound_messages channel 'email', status 'approved' → sent / failed.
// Runs hourly in ops-mail. The partner's click is the approval, so these go out even
// while OPS_SEND_ENABLED keeps the automatic rules in draft mode.
//   node rules/send_approved.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY } from './lib.mjs';
import { sendEmail } from '../notify/email.mjs';

const rows = await sql(`select id, to_addresses, cc_addresses, subject, body from ops.outbound_messages
  where channel = 'email' and status = 'approved' order by created_at limit 20`);
for (const m of rows) {
  if (DRY) { console.log(`DRY approved e-mail → ${m.to_addresses.join(', ')} · ${m.subject}`); continue; }
  let res;
  try { res = await sendEmail({ to: m.to_addresses, cc: m.cc_addresses || [], subject: m.subject, text: m.body, alwaysCc: false, force: true }); }
  catch (e) { res = { error: e.message }; }
  const status = res.error ? 'failed' : res.dryRun ? 'approved' : 'sent';
  await sql(`update ops.outbound_messages set status = ${q(status)}, error = ${q(res.error || null)}, external_id = ${q(res.id || null)}, sent_at = ${status === 'sent' ? 'now()' : 'null'} where id = ${q(m.id)}`);
  console.log(`${status.toUpperCase()} approved e-mail → ${m.to_addresses.join(', ')} · ${m.subject}`);
}
console.log(`approved e-mails: ${rows.length}${DRY ? ' · DRY RUN' : ''}`);
