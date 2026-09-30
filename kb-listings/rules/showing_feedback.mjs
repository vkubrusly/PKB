#!/usr/bin/env node
// =============================================================================
// Feedback after every showing — and an open door to an offer.
//
// Runs every hour after the mailboxes are read (collectors/mail/collect_mail.py):
//   1. showing confirmed and over for KB_FEEDBACK_DELAY_H (2 h), buyer's agent e-mail known,
//      no feedback yet → e-mail the agent: how did it go, what did the buyers think of the
//      price, anything that would keep them from an offer — and that we are open to one.
//   2. no answer after KB_FEEDBACK_FOLLOWUP_H (48 h) → one follow-up (KB_FEEDBACK_MAX_FOLLOWUPS).
//   3. feedback that arrived (platform e-mail or a reply with "[Showing S-XXXXXX]") and was not
//      read yet → classify it (interest, price view, offer expected) with Claude, or by rules.
//      An expected offer is flagged to the listing agent right away (KB_ALERT_TO).
//
// Sends only when KB_SEND_ENABLED=true; otherwise everything is stored as a draft.
//   node rules/showing_feedback.mjs [--dry-run]
// =============================================================================
import { q, sql } from '../lib/db.mjs';
import { sendEmail, sendingEnabled } from '../lib/mail.mjs';
import { classifyFeedback } from '../lib/ai.mjs';

const DRY = process.argv.includes('--dry-run');
const DELAY_H = Number(process.env.KB_FEEDBACK_DELAY_H || 2);
const FOLLOW_H = Number(process.env.KB_FEEDBACK_FOLLOWUP_H || 48);
const MAX_FOLLOW = Number(process.env.KB_FEEDBACK_MAX_FOLLOWUPS || 1);
const AGENT = process.env.KB_AGENT_NAME || 'Victor Kubrusly';
const PHONE = process.env.KB_AGENT_PHONE || '';
const ALERT_TO = (process.env.KB_ALERT_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US')}`);
const when = (d) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const first = (name) => (String(name || '').trim().split(/\s+/)[0] || 'there');

function requestEmail(s, followup) {
  const subject = `${followup ? 'Following up: ' : ''}Feedback on ${s.address} [Showing ${s.ref}]`;
  const text = `Hi ${first(s.agent_name)},

${followup
    ? `Just following up on your showing at ${s.address}${s.starts_at ? ` on ${when(s.starts_at)}` : ''}. Even a one-line answer helps my sellers a lot.`
    : `Thank you for showing ${s.address}${s.starts_at ? ` on ${when(s.starts_at)}` : ''}. I'd really appreciate your buyers' feedback — a quick reply to this e-mail is perfect:`}

1. How interested are your buyers (1–5)?
2. What did they think of the price (${money(s.list_price)})?
3. Is anything keeping them from making an offer?

If they are considering it, my sellers are motivated and I'm happy to talk through terms or answer any question${PHONE ? ` — call or text me at ${PHONE}` : ''}.

Thank you!
${AGENT}`;
  return { subject, text };
}

async function log(kind, s, to, subject, body, res) {
  const status = res.error ? 'failed' : res.dryRun ? 'draft' : 'sent';
  await sql(`insert into kb.outbound_messages (kind, listing_id, showing_id, to_addrs, subject, body, status, error, external_id, sent_at)
    values (${q(kind)}, ${q(s.listing_id)}, ${q(s.id)}, array[${to.map(q).join(',')}]::text[], ${q(subject)}, ${q(body)}, ${q(status)}, ${q(res.error || null)}, ${q(res.id || null)}, ${status === 'sent' ? 'now()' : 'null'})`);
  return status;
}

// 1 + 2: requests and follow-ups
const due = await sql(`select s.*, l.address, l.list_price from kb.showings s join kb.listings l on l.id = s.listing_id
  where s.status in ('confirmed', 'rescheduled', 'completed') and s.agent_email is not null and s.feedback_received_at is null
    and l.status in ('active', 'coming_soon', 'pending')
    and coalesce(s.ends_at, s.starts_at + interval '30 minutes') < now() - interval '${DELAY_H} hours'
    and s.starts_at > now() - interval '10 days'
    and (s.feedback_requested_at is null
         or (s.feedback_followups < ${MAX_FOLLOW} and s.feedback_requested_at < now() - interval '${FOLLOW_H} hours'))
  order by s.starts_at`);
let sent = 0;
for (const s of due) {
  const followup = !!s.feedback_requested_at;
  // A draft-only run must not advance the schedule (otherwise turning sending on would skip them).
  if (!DRY && !sendingEnabled() && (await sql(`select 1 from kb.outbound_messages where showing_id = ${q(s.id)} and status = 'draft' and kind = ${q(followup ? 'feedback_followup' : 'feedback_request')} limit 1`)).length) continue;
  const { subject, text } = requestEmail(s, followup);
  if (DRY) { console.log(`[dry] ${followup ? 'follow-up' : 'request'} ${s.ref} → ${s.agent_email} (${s.address})`); continue; }
  let res; try { res = await sendEmail({ to: s.agent_email, subject, text }); } catch (e) { res = { error: e.message }; }
  const status = await log(followup ? 'feedback_followup' : 'feedback_request', s, [s.agent_email], subject, text, res);
  console.log(`${status.toUpperCase()} ${followup ? 'follow-up' : 'request'} ${s.ref} → ${s.agent_email} (${s.address})`);
  if (status === 'sent') {
    sent++;
    await sql(`update kb.showings set status = 'completed', updated_at = now(), ${followup ? 'feedback_followups = feedback_followups + 1' : 'feedback_requested_at = now()'} where id = ${q(s.id)}`);
  }
}

// 3: read the feedback that arrived
const unread = await sql(`select s.*, l.address, l.list_price from kb.showings s join kb.listings l on l.id = s.listing_id
  where s.feedback_text is not null and s.feedback_interest is null order by s.feedback_received_at`);
for (const s of unread) {
  const c = await classifyFeedback(s.feedback_text, s);
  console.log(`feedback ${s.ref} ${s.address}: ${c.interest}, price ${c.price_view}${c.offer_expected ? ', OFFER EXPECTED' : ''}`);
  if (DRY) continue;
  await sql(`update kb.showings set feedback_interest = ${q(c.interest)}, feedback_price_view = ${q(c.price_view === 'unknown' ? null : c.price_view)},
    offer_expected = ${c.offer_expected}, feedback_summary = ${q(JSON.stringify({ pt: c.summary_pt, en: c.summary_en }))}, updated_at = now() where id = ${q(s.id)}`);
  if (c.offer_expected && ALERT_TO.length) {
    const subject = `Possível oferta — ${s.address} (${s.agent_name || s.agent_email})`;
    const text = `${s.agent_name || ''} ${s.agent_brokerage ? `(${s.agent_brokerage}) ` : ''}${s.agent_email || ''} ${s.agent_phone || ''}\n\n${c.summary_pt}\n\n---\n${s.feedback_text}`;
    let res; try { res = await sendEmail({ to: ALERT_TO, subject, text }); } catch (e) { res = { error: e.message }; }
    await log('internal', s, ALERT_TO, subject, text, res);
  }
}
console.log(`feedback: ${due.length} due · ${sent} sent · ${unread.length} read${sendingEnabled() ? '' : ' · SENDING OFF (drafts)'}${DRY ? ' · DRY RUN' : ''}`);
