#!/usr/bin/env node
// =============================================================================
// Rule R1/R2 — county review asked for corrections (latest round failed).
//
// R1: e-mail the designer (Sovereign) with the corrections itemized by department,
//     with the reviewer's comments, and the resubmission deadline:
//     2 business days per failed item (OPS_R1_DAYS_PER_ITEM), counted from the
//     day the round came back. Guilherme in Cc (OPS_ALWAYS_CC) on every e-mail.
// R2: no resubmission (no newer round on the portal) by the deadline → follow-up,
//     then again every 2 business days; from the 3rd follow-up Victor is in Cc.
// Stops as soon as a new round appears or the permit leaves "corrections".
//
// Only rounds that came back in the last RECENT_DAYS are announced; older ones are
// recorded as a baseline (no e-mail), so turning the rule on sends no history.
// Only permits tracked by the designer (Sovereign); PKB-tracked custom homes are listed.
//   node rules/corrections.mjs [--dry-run]
// =============================================================================
import { readFileSync } from 'node:fs';
import { sql } from '../scripts/sb.mjs';
import { sendEmail } from '../notify/email.mjs';

const DRY = process.argv.includes('--dry-run');
const PER_ITEM = Number(process.env.OPS_R1_DAYS_PER_ITEM || 2);
const RECENT_DAYS = Number(process.env.OPS_RECENT_DAYS || 3);
const ORG = process.env.OPS_ORG_NAME || 'PKB Homes';
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const qa = (a) => (a.length ? `array[${a.map(q).join(',')}]::text[]` : `'{}'::text[]`);
const brDate = (d) => (d instanceof Date ? d : new Date(String(d).slice(0, 10) + 'T12:00:00Z')).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
const addBusinessDays = (d, n) => { const x = new Date(String(d).slice(0, 10) + 'T12:00:00Z'); while (n > 0) { x.setUTCDate(x.getUTCDate() + 1); if (x.getUTCDay() % 6) n--; } return x; };
const clean = (c) => String(c || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

const contacts = JSON.parse(readFileSync(new URL('../config/contacts.json', import.meta.url), 'utf8'));
const sov = contacts.designers.sovereign;
const director = contacts.internal.director.email;
const orgId = (await sql(`select id from public.orgs where name = ${q(ORG)} limit 1`))[0]?.id;
if (!orgId) throw new Error(`org "${ORG}" not found`);

const cases = await sql(`select c.id, c.number, c.portal, c.tracked_by, j.id as job_id, j.job_number, j.address,
    (select max(round) from ops.review_items r where r.permit_case_id = c.id) as round
  from ops.permit_cases c join ops.jobs j on j.id = c.job_id
  where j.org_id = ${q(orgId)} and c.kind = 'building' and c.ops_status = 'corrections'`);

const today = new Date();
for (const c of cases) {
  const items = await sql(`select department, status, reviewer, completed_at, comments from ops.review_items
    where permit_case_id = ${q(c.id)} and round = ${c.round} and failed order by department`);
  if (!items.length) continue;
  if (c.tracked_by !== 'designer') { console.log(`${c.job_number} ${c.number}: PKB-tracked (custom) — not e-mailed`); continue; }
  const backAt = items.map((i) => i.completed_at).filter(Boolean).sort().pop();
  const deadline = addBusinessDays(backAt, PER_ITEM * items.length);
  const street = String(c.address).split(',')[0];
  const keyReq = `r1.request:${c.id}:${c.round}`;
  const sentReq = (await sql(`select occurred_at, payload from ops.events where org_id = ${q(orgId)} and dedupe_key = ${q(keyReq)}`))[0];
  const followups = await sql(`select occurred_at from ops.events where org_id = ${q(orgId)} and dedupe_key like ${q(`r2.followup:${c.id}:${c.round}:%`)} order by occurred_at`);

  const list = items.map((i, n) => `${n + 1}. ${i.department}${i.reviewer ? ` (${i.reviewer})` : ''} — ${i.status} em ${brDate(i.completed_at)}
${clean(i.comments) ? clean(i.comments).split('\n').map((l) => '   ' + l).join('\n') : '   (sem comentário no portal: ver os documentos de revisão do condado)'}`).join('\n\n');

  let kind, subject, text, cc = [...(sov.cc || [])];
  if (!sentReq) {
    const recent = (today - new Date(backAt + 'T12:00:00Z')) / 864e5 <= RECENT_DAYS;
    if (!recent) {
      console.log(`${c.job_number} ${c.number} round ${c.round}: baseline (back on ${backAt}, no e-mail)`);
      if (!DRY) await sql(`insert into ops.events (org_id, job_id, permit_case_id, kind, source, occurred_at, payload, dedupe_key, processed_at)
        values (${q(orgId)}, ${q(c.job_id)}, ${q(c.id)}, 'corrections.requested', 'rule', ${q(backAt)}, ${q(JSON.stringify({ round: c.round, items: items.length, deadline, baseline: true }))}::jsonb, ${q(keyReq)}, now()) on conflict do nothing`);
      continue;
    }
    kind = 'R1';
    subject = `Correções do condado — ${c.job_number} · ${street} · Permit ${c.number} (rodada ${c.round})`;
    text = `Prezados da Sovereign,

O condado devolveu o permit ${c.number} (obra ${c.job_number} — ${c.address}) pedindo correções em ${items.length} ${items.length === 1 ? 'item' : 'itens'}:

${list}

Prazo para reenviar: ${brDate(deadline)} (${PER_ITEM} dias úteis por item).
Por favor, confirmem o recebimento e a previsão de reenvio.

Atenciosamente,
PKB Homes — ${contacts.internal.permits_owner.name}
(e-mail automático do PKB Ops)`;
  } else {
    if (today < deadline) continue;
    const last = followups.at(-1)?.occurred_at || deadline;
    if (followups.length && today < addBusinessDays(last, PER_ITEM)) continue;
    const n = followups.length + 1;
    kind = 'R2';
    if (n >= 3) cc.push(director);
    subject = `${n > 1 ? `(${n}º lembrete) ` : ''}Reenvio pendente — ${c.job_number} · ${street} · Permit ${c.number}`;
    text = `Prezados da Sovereign,

O prazo de reenvio das correções do permit ${c.number} (obra ${c.job_number} — ${c.address}) venceu em ${brDate(deadline)} e ainda não vemos o reenvio no portal do condado.

Itens pendentes:
${items.map((i, k) => `${k + 1}. ${i.department} — ${i.status} em ${brDate(i.completed_at)}`).join('\n')}

Qual a previsão de reenvio?

Atenciosamente,
PKB Homes — ${contacts.internal.permits_owner.name}
(e-mail automático do PKB Ops)`;
  }
  let res = { dryRun: true };
  if (!DRY) { try { res = await sendEmail({ to: sov.to, cc, subject, text }); } catch (e) { res = { error: e.message }; } }
  const status = res.error ? 'failed' : res.dryRun ? 'draft' : 'sent';
  console.log(`${status.toUpperCase()} ${kind} ${c.job_number} ${c.number} → ${sov.to.join(', ')} cc ${[...cc, process.env.OPS_ALWAYS_CC].filter(Boolean).join(', ')}`);
  if (DRY) { console.log(`--- ${subject}\n${text}\n`); continue; }
  if (status === 'failed') continue;
  const key = kind === 'R1' ? keyReq : `r2.followup:${c.id}:${c.round}:${followups.length + 1}`;
  const ev = await sql(`insert into ops.events (org_id, job_id, permit_case_id, kind, source, occurred_at, payload, dedupe_key, processed_at)
    values (${q(orgId)}, ${q(c.job_id)}, ${q(c.id)}, ${q(kind === 'R1' ? 'corrections.requested' : 'corrections.followup')}, 'rule', now(), ${q(JSON.stringify({ round: c.round, items: items.length, deadline }))}::jsonb, ${q(key)}, now())
    on conflict (org_id, dedupe_key) do nothing returning id`);
  await sql(`update ops.permit_cases set ball_with = 'sovereign' where id = ${q(c.id)};
    insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, cc_addresses, subject, body, status, external_id, in_reply_to_event, sent_at)
    values (${q(orgId)}, ${q(c.job_id)}, 'email', ${q(kind)}, ${qa(sov.to)}, ${qa([...cc, process.env.OPS_ALWAYS_CC].filter(Boolean))}, ${q(subject)}, ${q(text)}, ${q(status)}, ${q(res.id || null)}, ${ev[0]?.id ?? 'null'}, now())`);
}
console.log(`corrections: ${cases.length} permit(s) waiting for resubmission${DRY ? ' · DRY RUN' : ''}`);
