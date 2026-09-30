#!/usr/bin/env node
// =============================================================================
// Rule R4 — the building permit was issued on the county portal.
//   1. e-mail the job's supervisor(s) and project manager(s) + Cristiano: permit issued,
//      time to request the vendors (stake-out, power, water, dumpster…);
//   2. e-mail Daniela about the fees (impact fees / NOC), Guilherme in Cc;
//   3. queue a Buildertrend Daily Log (permit events → Cristiano + Guilherme).
// Only permits issued in the last RECENT_DAYS days are announced; older ones are a
// silent baseline, so turning the rule on sends no history.
//   node rules/permit_issued.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, EMAIL, RECENT_DAYS, brDate, street, daysAgo, orgId, team, seen, recordEvent, mail, queueDailyLog, contacts } from './lib.mjs';

const money = (n) => (n == null ? null : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const cases = await sql(`select c.id, c.number, c.portal, c.issued_at, c.fee_total, c.fee_unpaid, c.expires_at, j.id job_id, j.job_number, j.address, j.model
  from ops.permit_cases c join ops.jobs j on j.id = c.job_id
  where j.org_id = ${q(await orgId())} and c.kind = 'building' and c.issued_at is not null order by c.issued_at`);

let sent = 0, baseline = 0;
for (const c of cases) {
  const key = `permit.issued:${c.id}`;
  if (await seen(key)) continue;
  const recent = daysAgo(c.issued_at) <= RECENT_DAYS;
  if (!recent) { baseline++; await recordEvent({ jobId: c.job_id, caseId: c.id, kind: 'permit.issued', at: c.issued_at, payload: { number: c.number, baseline: true }, key }); continue; }
  const ev = await recordEvent({ jobId: c.job_id, caseId: c.id, kind: 'permit.issued', at: c.issued_at, payload: { number: c.number }, key });
  const t = await team(c.job_id);
  const where = `${c.job_number} · ${street(c.address)}`;

  await mail({
    rule: 'R4', jobId: c.job_id, eventId: ev, to: [...t.emails, EMAIL.cristiano],
    subject: `Permit EMITIDO — ${where}`,
    text: `O permit de construção da obra ${c.job_number} — ${c.address} foi emitido pelo condado em ${brDate(c.issued_at)}.

Permit: ${c.number}${c.model ? ` · Modelo: ${c.model}` : ''}${c.expires_at ? `\nValidade: ${brDate(c.expires_at)}` : ''}

Próximos passos (supervisor):
- Pedir os fornecedores: marcação (stake-out), energia provisória / T-pole, água, caçamba e banheiro químico.
- Primeira inspeção de campo: controle de erosão / pre-work (conforme o condado).
${t.missing.length ? `\n(Sem e-mail cadastrado para: ${t.missing.join(', ')}.)\n` : ''}
— PKB Ops (aviso automático)`,
  });
  await mail({
    rule: 'R4-fees', jobId: c.job_id, eventId: ev, to: EMAIL.daniela, cc: [EMAIL.guilherme],
    subject: `Taxas do permit — ${where} (permit ${c.number} emitido)`,
    text: `Daniela,

O permit ${c.number} da obra ${c.job_number} — ${c.address} foi emitido em ${brDate(c.issued_at)}.

Por favor, verifique e providencie:
- Impact fees do condado${c.fee_unpaid != null ? ` — em aberto no portal: ${money(c.fee_unpaid)}` : ''}${c.fee_total != null ? ` (total de taxas do permit: ${money(c.fee_total)})` : ''}
- Notice of Commencement (NOC) registrado e enviado ao condado.

— PKB Ops (aviso automático)`,
  });
  await queueDailyLog({
    rule: 'R4', jobId: c.job_id, eventId: ev, title: `Permit issued — ${c.number}`,
    notes: `Building permit ${c.number} issued by the county on ${brDate(c.issued_at)}.\nNext: supervisor requests vendors (stake-out, temporary power / T-pole, water, dumpster, portable toilet); first field inspection: erosion control / pre-work.`,
    notify: [contacts.internal.contractor_of_record?.bt_name, contacts.internal.permits_owner?.name].filter(Boolean),
  });
  sent++;
}
console.log(`permit issued: ${sent} announced · ${baseline} baseline${DRY ? ' · DRY RUN' : ''}`);
