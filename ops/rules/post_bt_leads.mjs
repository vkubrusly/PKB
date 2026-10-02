#!/usr/bin/env node
// =============================================================================
// post_bt_leads.mjs — create in Buildertrend the Lead Opportunities a partner confirmed in the
// portal (ops.outbound_messages channel 'bt_lead', status draft; payload = the lead fields).
// Skips a lead that already exists (same parcel / client). Gated like the Daily Logs by
// OPS_BT_POST=true (or --post).
//   BT_COOKIES_FILE=… node rules/post_bt_leads.mjs [--post | --dry-run]
// =============================================================================
import { sql } from '../scripts/sb.mjs';
import { openBuildertrend } from '../collectors/buildertrend/session.mjs';
import { createLead } from '../collectors/buildertrend/lead.mjs';

const DRY = process.argv.includes('--dry-run') || !(process.env.OPS_BT_POST === 'true' || process.argv.includes('--post'));
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

const drafts = await sql(`select id, subject, body, payload, requested_by from ops.outbound_messages where channel = 'bt_lead' and status = 'draft' order by created_at limit 10`);
if (!drafts.length) { console.log('no Lead Opportunities to create'); process.exit(0); }
if (DRY) { for (const d of drafts) console.log(`[dry run] lead "${d.subject}"`); process.exit(0); }

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('Buildertrend session expired — nothing created'); await browser.close(); process.exit(0); }
for (const d of drafts) {
  const claim = await sql(`update ops.outbound_messages set error = 'posting:' || now()::text where id = ${q(d.id)} and status = 'draft'
    and (error is null or error not like 'posting:%' or substring(error from 9)::timestamptz < now() - interval '30 minutes') returning id`);
  if (!claim.length) continue;
  const p = d.payload || {};
  try {
    const notes = `${p.notes || d.body}\n\n— Criado por PKB Ops a partir do pedido do site · confirmado: ${d.requested_by || '—'}`;
    const r = await createLead(page, { title: p.title || d.subject, dedupeKey: p.dedupe_key, contact: p.contact, address: p.address, salespeople: p.salespeople, revenue: p.revenue, source: p.source, notes });
    const status = r.duplicate ? 'cancelled' : 'sent';
    await sql(`update ops.outbound_messages set status = ${q(status)}, sent_at = now(), external_id = ${q(r.url || null)}, error = ${q(r.duplicate ? 'already in Buildertrend (same parcel/client)' : null)} where id = ${q(d.id)};
      update ops.leads set bt_lead_status = ${q(r.duplicate ? 'duplicate' : 'created')}, bt_lead_url = ${q(r.url || null)} where ref = ${q(p.lead_ref)};`);
    console.log(`${r.duplicate ? 'DUPLICATE' : 'CREATED'} lead "${p.title}"${r.leadId ? ` #${r.leadId}` : ''} · salespeople ${(r.salespeople || []).join(', ')}`);
  } catch (e) {
    await sql(`update ops.outbound_messages set error = ${q(e.message.slice(0, 500))} where id = ${q(d.id)}; update ops.leads set bt_lead_status = 'failed' where ref = ${q(p.lead_ref)};`);
    console.error(`FAILED lead "${p.title}": ${e.message.split('\n')[0]}`);
  }
}
await browser.close();
