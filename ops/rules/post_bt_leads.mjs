#!/usr/bin/env node
// =============================================================================
// post_bt_leads.mjs — create in Buildertrend the Lead Opportunities a partner confirmed in the
// portal (ops.outbound_messages channel 'bt_lead', status draft; payload = the lead fields).
// Skips a lead that already exists (same parcel / client). Records the outcome on the message, the lead
// and the Ask action: created (with the Buildertrend lead id) or the error; after 5 failed attempts the
// message is 'failed' and is no longer retried. Gated like the Daily Logs by
// OPS_BT_POST=true (or --post).
//   BT_COOKIES_FILE=… node rules/post_bt_leads.mjs [--post | --dry-run]
// =============================================================================
import { sql } from '../scripts/sb.mjs';
import { openBuildertrend } from '../collectors/buildertrend/session.mjs';
import { createLead } from '../collectors/buildertrend/lead.mjs';

const DRY = process.argv.includes('--dry-run') || !(process.env.OPS_BT_POST === 'true' || process.argv.includes('--post'));
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const MAX_ATTEMPTS = 5; // then status 'failed' (no more hourly retries) and the portal shows the error
// The portal's Ask action that confirmed this lead shows the outcome, not just "queued".
const actionResult = (ref, text) => ref ? `update ops.ask_actions set result = ${q(text)} where action = 'bt_lead' and input->>'lead_ref' = ${q(ref)};` : '';

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
  const attempt = Number(p.attempts || 0) + 1;
  try {
    const notes = `${p.notes || d.body}\n\n— Criado por PKB Ops a partir do pedido do site · confirmado: ${d.requested_by || '—'}`;
    const r = await createLead(page, { title: p.title || d.subject, dedupeKey: p.dedupe_key, contact: p.contact, address: p.address, salespeople: p.salespeople, revenue: p.revenue, source: p.source, notes });
    const id = r.leadId || null;
    const result = r.duplicate
      ? `Already in Buildertrend (same parcel/client)${id ? ` — lead #${id}` : ''}; not created again.`
      : `Created in Buildertrend${id ? ` — lead #${id}` : ' (lead id not read)'} on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
    await sql(`update ops.outbound_messages set status = ${q(r.duplicate ? 'cancelled' : 'sent')}, sent_at = now(), external_id = ${q(id ? String(id) : r.url || null)},
        error = ${q(r.duplicate ? 'already in Buildertrend (same parcel/client)' : null)}, payload = coalesce(payload, '{}'::jsonb) || ${q(JSON.stringify({ attempts: attempt, bt_lead_id: id }))}::jsonb where id = ${q(d.id)};
      update ops.leads set bt_lead_status = ${q(r.duplicate ? 'duplicate' : 'created')}, bt_lead_url = ${q(r.url || (id ? String(id) : null))} where ref = ${q(p.lead_ref)};
      ${actionResult(p.lead_ref, result)}`);
    console.log(`${r.duplicate ? 'DUPLICATE' : 'CREATED'} lead "${p.title}"${id ? ` #${id}` : ''} · salespeople ${(r.salespeople || []).join(', ')}`);
  } catch (e) {
    // Keep the reason readable: Playwright's call log is long; the line that says what blocked the click matters.
    const msg = String(e.message || e);
    const why = (msg.match(/.*intercepts pointer events.*/) || [])[0];
    const reason = (msg.split('\n')[0] + (why ? ` — ${why.trim()}` : '')).slice(0, 900);
    const giveUp = attempt >= MAX_ATTEMPTS;
    const result = `Error creating in Buildertrend (attempt ${attempt}/${MAX_ATTEMPTS}${giveUp ? ', stopped — needs a person' : ', retried next hour'}): ${reason}`;
    await sql(`update ops.outbound_messages set error = ${q(reason)}, status = ${q(giveUp ? 'failed' : 'draft')}, payload = coalesce(payload, '{}'::jsonb) || ${q(JSON.stringify({ attempts: attempt }))}::jsonb where id = ${q(d.id)};
      update ops.leads set bt_lead_status = 'failed' where ref = ${q(p.lead_ref)};
      ${actionResult(p.lead_ref, result)}`);
    console.error(`FAILED lead "${p.title}" (attempt ${attempt}/${MAX_ATTEMPTS}): ${reason}`);
  }
}
await browser.close();
