#!/usr/bin/env node
// =============================================================================
// team_mail.mjs — the bot mailbox is a conversation channel: anyone @pkbhomes.com who writes to it gets an answer
// (Victor, 11/21/26). Senders: collect_mail.py, category 'team_mail' (not invoice@, never an automatic reply). The answer comes from the data PKB Ops has (houses, permits, inspections, vendor invoices and their
// bills) through the Edge Function ops-invoice (mode reply); it goes back in the same thread, Cc Victor. Anything
// that needs an action or a decision is left to Victor (he is in copy) — this rule never acts in Buildertrend.
//   node rules/team_mail.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, orgId, usDate } from './lib.mjs';
import { serviceKey } from '../scripts/sb.mjs';
import { sendEmail } from '../notify/email.mjs';

const REF = process.env.SUPABASE_PROJECT_REF || 'fvjknahpmihueyeasgbx';
const VICTOR = 'victor@pkbhomes.com';
const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const COLS = ['job_number', 'company', 'address', 'county', 'model', 'supervisor', 'stage', 'ops_status', 'permit', 'applied_at', 'issued_at', 'pause', 'insp_next', 'insp_failed_open', 'last_daily_log_at', 'last_daily_log_by', 'permit_office'];

const org = await orgId();
const mails = await sql(`select id, message_id, received_at, from_addr, from_name, subject, body_text, parsed from ops.inbound_emails
  where org_id = ${q(org)} and category = 'team_mail' and received_at > now() - interval '3 days' and not (parsed ? 'replied_at') order by received_at`);
if (!mails.length) { console.log('team_mail: nothing to answer'); process.exit(0); }

// Data the answer may use: the latest board snapshot (houses) and the vendor invoices of the last 45 days.
const snap = (await sql(`select data->'board'->>'asOf' as_of, data->'board'->'jobs' jobs, data->'board'->'directory' dir from ops.snapshots where kind = 'board' or data ? 'board' order by created_at desc limit 1`))[0] || {};
const people = (snap.dir || []).map((p) => `${p.name} <${p.email || '—'}> — ${p.role || ''}`).join('\n');
const jobs = (snap.jobs || []).map((j) => COLS.map((k) => (j[k] == null ? '' : Array.isArray(j[k]) ? j[k].join('+') : String(j[k]))).join('|')).join('\n');
const inv = await sql(`select v.vendor, v.invoice_number, v.total, v.status, v.invoice_date, v.received_at, v.issues, v.bt_found, v.answer,
    coalesce((select json_agg(json_build_object('job', coalesce(l.job_number, case when l.general then 'geral' end), 'amount', l.bill_amount, 'bill', l.bt_bill_id, 'bt', l.bt_status)) from ops.vendor_invoice_lines l where l.invoice_id = v.id), '[]') lines
  from ops.vendor_invoices v where v.org_id = ${q(org)} and v.received_at > now() - interval '45 days' and v.status <> 'not_invoice' order by v.received_at desc limit 80`);
const STATUS = { new: 'recebida, ainda não lida', needs_review: 'aguardando resposta da Camila', ready: 'pronta para criar as bills', creating: 'criando bills', created: 'bills criadas (draft)', duplicate: 'duplicada', error: 'erro', ignored: 'ignorada', in_bt: 'já estava lançada no Buildertrend' };
const invText = inv.map((v) => `${v.vendor || '?'} #${v.invoice_number || '?'} · ${money(v.total)} · ${usDate(v.invoice_date || v.received_at)} · ${STATUS[v.status] || v.status}`
  + `${(v.bt_found || []).length ? ` · no Buildertrend: ${v.bt_found.map((f) => `${f.number} ${money(f.amount)}`).join(', ')}` : ''}`
  + `${(v.lines || []).length ? ` · obras: ${v.lines.map((l) => `${l.job || '????'} ${money(l.amount)}${l.bill ? ` (bill ${l.bill})` : ''}`).join(', ')}` : ''}`
  + `${(v.issues || []).length && ['needs_review', 'duplicate', 'error'].includes(v.status) ? ` · pendências: ${v.issues.join(' | ').slice(0, 400)}` : ''}`).join('\n');
const context = `PKB TEAM (who is writing; use first names):\n${people}\n\nHOUSES / JOBS (pipe-separated: ${COLS.join('|')}):\n${jobs}\n\nVENDOR INVOICES (invoice@, last 45 days):\n${invText || '(none)'}`;

const key = await serviceKey();
for (const m of mails) {
  const r = await fetch(`https://${REF}.supabase.co/functions/v1/ops-invoice`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}`, apikey: key },
    body: JSON.stringify({ mode: 'reply', from: m.from_addr, from_name: m.from_name, subject: m.subject, text: m.body_text, context, as_of: snap.as_of }),
  });
  const a = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || a.error) { console.error(`team_mail ${m.subject}: ${a.error || r.status}`); continue; }
  const subject = /^re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || ''}`;
  const text = `${a.reply}\n\n— PKB Ops (resposta automática)`;
  console.log(`${DRY ? '[dry run] ' : ''}REPLY to ${m.from_addr} · ${a.summary}${a.needs_victor ? ' · needs Victor' : ''}\n${a.reply}`);
  if (DRY) continue;
  let res;
  try { res = await sendEmail({ to: [m.from_addr], cc: m.from_addr === VICTOR ? [] : [VICTOR], subject, text, alwaysCc: false, inReplyTo: m.message_id }); } catch (e) { res = { error: e.message }; }
  const status = res.error ? 'failed' : res.dryRun ? 'draft' : 'sent';
  await sql(`insert into ops.outbound_messages (org_id, channel, rule, to_addresses, cc_addresses, subject, body, status, error, external_id, sent_at)
      values (${q(org)}, 'email', 'R-TEAM-REPLY', array[${q(m.from_addr)}]::text[], array[${(res.cc || []).map(q).join(',') || q(VICTOR)}]::text[], ${q(subject)}, ${q(text)}, ${q(status)}, ${q(res.error || null)}, ${q(res.id || null)}, ${status === 'sent' ? 'now()' : 'null'});
    ${status === 'sent' ? `update ops.inbound_emails set parsed = parsed || ${q(JSON.stringify({ replied_at: new Date().toISOString(), needs_victor: !!a.needs_victor, summary: a.summary }))}::jsonb where id = ${q(m.id)};` : ''}`);
  console.log(`${status.toUpperCase()} reply · ${subject}`);
}
