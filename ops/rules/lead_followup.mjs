#!/usr/bin/env node
// =============================================================================
// Rule R-LEAD — a website work request must turn into a contract.
//
// Runs every hour (ops-mail workflow), after the mailbox is read:
//   1. every new work_request e-mail becomes a row in ops.leads (status open);
//   2. a lead closes by itself when a job with the same parcel (or street
//      address) appears in ops.jobs — i.e. in the spreadsheet or Buildertrend;
//   3. a lead is answered when the permits owner replies to the follow-up
//      (the reply reaches the bot mailbox; matched by the [Lead …] tag);
//   4. otherwise: follow-up e-mail to the permits owner 24 h after the request,
//      then every 48 h, asking whether the contract was issued.
//
//   node rules/lead_followup.mjs [--dry-run]
// =============================================================================
import { readFileSync } from 'node:fs';
import { sql } from '../scripts/sb.mjs';
import { sendEmail } from '../notify/email.mjs';

const DRY = process.argv.includes('--dry-run');
const FIRST_H = Number(process.env.OPS_LEAD_FIRST_H || 24);
const EVERY_H = Number(process.env.OPS_LEAD_EVERY_H || 48);
const ORG = process.env.OPS_ORG_NAME || 'PKB Homes';
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const digits = (s) => String(s || '').replace(/\D/g, '');
const street = (s) => String(s || '').split(',')[0].toLowerCase().replace(/\b(street|st|road|rd|lane|ln|place|pl|court|ct|circle|cir|terrace|ter|avenue|ave|drive|dr|loop|way)\b\.?/g, '').replace(/(\d+)(st|nd|rd|th)\b/g, '$1').replace(/[^a-z0-9]/g, '');
const brDate = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const contacts = JSON.parse(readFileSync(new URL('../config/contacts.json', import.meta.url), 'utf8'));
const owner = contacts.internal.permits_owner; // Guilherme
const orgId = (await sql(`select id from public.orgs where name = ${q(ORG)} limit 1`))[0]?.id;
if (!orgId) throw new Error(`org "${ORG}" not found`);

// 1. new work requests → leads
const fresh = await sql(`select e.id, e.received_at, e.parsed from ops.inbound_emails e
  where e.org_id = ${q(orgId)} and e.category = 'work_request'
    and not exists (select 1 from ops.leads l where l.inbound_email_id = e.id)`);
for (const e of fresh) {
  const p = e.parsed || {};
  const d = new Date(e.received_at);
  const ref = `L-${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (DRY) { console.log(`new lead ${ref} ${p.client}`); continue; }
  await sql(`insert into ops.leads (org_id, ref, inbound_email_id, received_at, client, company, phone, email, address, city, parcel, county, model, price, agent)
    values (${q(orgId)}, ${q(ref)}, ${q(e.id)}, ${q(e.received_at)}, ${q(p.client)}, ${q(p.company)}, ${q(p.phone)}, ${q(p.email)}, ${q(p.address)}, ${q(p.city)}, ${q(p.parcel)}, ${q(p.county)}, ${q(p.model)}, ${q(p.price)}, ${q(p.agent)})
    on conflict (org_id, ref) do nothing`);
  console.log(`new lead ${ref} ${p.client}`);
}

const leads = await sql(`select * from ops.leads where org_id = ${q(orgId)} and status = 'open' order by received_at`);
const jobs = await sql(`select id, job_number, parcel, address, bt_job_name from ops.jobs where org_id = ${q(orgId)}`);
let sent = 0;
for (const l of leads) {
  // 2. job exists (spreadsheet or Buildertrend) → matched
  const job = jobs.find((j) => (digits(l.parcel).length >= 8 && digits(j.parcel) === digits(l.parcel))
    || (l.address && street(l.address).length > 6 && [j.address, j.bt_job_name?.split(' - ').pop()].some((a) => street(a) === street(l.address))));
  if (job) {
    console.log(`${l.ref} ${l.client}: matched job ${job.job_number}`);
    if (!DRY) await sql(`update ops.leads set status = 'matched', matched_job_id = ${q(job.id)} where id = ${q(l.id)}`);
    continue;
  }
  // 3. the permits owner replied to a follow-up
  const reply = (await sql(`select received_at, body_text from ops.inbound_emails
    where org_id = ${q(orgId)} and from_addr ilike ${q(owner.email)} and subject ilike ${q(`%[Lead ${l.ref}]%`)}
    order by received_at desc limit 1`))[0];
  if (reply) {
    const answer = String(reply.body_text || '').split(/\n\s*(On .+wrote:|Em .+escreveu:|-----Original|De: )/)[0].trim().slice(0, 2000);
    console.log(`${l.ref} ${l.client}: answered`);
    if (!DRY) await sql(`update ops.leads set status = 'answered', answered_at = ${q(reply.received_at)}, answer = ${q(answer)} where id = ${q(l.id)}`);
    continue;
  }
  // 4. follow-up due?
  const due = l.last_followup_at ? new Date(l.last_followup_at).getTime() + EVERY_H * 36e5 : new Date(l.received_at).getTime() + FIRST_H * 36e5;
  if (Date.now() < due) continue;
  const n = l.followups + 1;
  const where = [l.address, l.city].filter(Boolean).join(', ') || '—';
  const subject = `${n > 1 ? `(${n}ª cobrança) ` : ''}Contrato emitido? ${l.client || 'novo cliente'} — ${l.model || ''} [Lead ${l.ref}]`.replace(/\s+/g, ' ');
  const text = `Guilherme,

Chegou uma solicitação de obra pelo site em ${brDate(l.received_at)} e ainda não vejo a obra na planilha nem no Buildertrend.

Cliente: ${l.client || '—'}${l.company ? ` (${l.company})` : ''}
Telefone: ${l.phone || '—'} · E-mail: ${l.email || '—'}
Lote: ${where}${l.parcel ? ` · Parcel ${l.parcel}` : ''}${l.county ? ` · ${l.county}` : ''}
Modelo: ${l.model || '—'} · Valor: ${l.price || '—'}
Corretor: ${l.agent || '—'}

O contrato já foi emitido? Responda este e-mail (basta "sim", "não, porque…" ou a previsão).
Paro de cobrar quando você responder ou quando a obra aparecer na planilha/Buildertrend.

— PKB Ops (${n}ª cobrança; próxima em ${EVERY_H} h se não houver resposta)`;
  let res = { dryRun: true };
  if (!DRY) { try { res = await sendEmail({ to: owner.email, subject, text, alwaysCc: false }); } catch (e) { res = { error: e.message }; } }
  const status = res.error ? 'failed' : res.dryRun ? 'draft' : 'sent';
  console.log(`${status.toUpperCase()} ${l.ref} ${l.client} follow-up #${n} → ${owner.email}`);
  if (DRY || status === 'failed') continue;
  await sql(`update ops.leads set followups = ${n}, last_followup_at = now() where id = ${q(l.id)};
    insert into ops.outbound_messages (org_id, channel, rule, to_addresses, subject, body, status, external_id, sent_at)
    values (${q(orgId)}, 'email', 'R-LEAD', array[${q(owner.email)}]::text[], ${q(subject)}, ${q(text)}, ${q(status)}, ${q(res.id || null)}, ${status === 'sent' ? 'now()' : 'null'});`);
  sent++;
}
console.log(`leads: ${fresh.length} new · ${leads.length} open · ${sent} follow-up(s) sent${DRY ? ' · DRY RUN' : ''}`);
