#!/usr/bin/env node
// =============================================================================
// Rule R0 — the 1st installment (licensing invoice) was paid → start licensing.
// Trigger: Buildertrend "invoice paid" e-mail for the 1st Installment (bot mailbox),
// for a job with no building permit requested yet. The e-mail goes to Guilherme with the
// "start licensing" request to Sovereign ready to forward (templates/start_licensing.pt.md)
// — he adds the attachments (owner's Sunbiz, Property Record Card / Warranty Deed) and sends.
// Custom homes (other designers, PKB tracks the permit) are skipped. Only payments seen in
// the last RECENT_DAYS days are handled; older ones are a silent baseline.
//   node rules/start_licensing.mjs [--dry-run]
// =============================================================================
import { readFileSync } from 'node:fs';
import { sql, q, DRY, EMAIL, RECENT_DAYS, brDate, daysAgo, orgId, seen, recordEvent, mail, contacts } from './lib.mjs';

const tpl = readFileSync(new URL('../templates/start_licensing.pt.md', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->\s*/, '');
const sov = contacts.designers.sovereign;

const paid = await sql(`select distinct on (e.job_number) e.job_number, e.received_at, e.parsed, j.id job_id, j.address, j.parcel, j.model, j.owner_name, j.county, j.permit_office
  from ops.inbound_emails e join ops.jobs j on j.job_number = e.job_number and j.org_id = e.org_id
  where e.org_id = ${q(await orgId())} and e.category = 'bt_invoice_paid' and e.parsed->>'title' ~* '1st\\s+installment'
  order by e.job_number, e.received_at`);
let sent = 0, skipped = 0;
for (const p of paid) {
  const key = `licensing.start:${p.job_id}`;
  if (await seen(key)) continue;
  const requested = (await sql(`select 1 from ops.permit_cases where job_id = ${q(p.job_id)} and kind = 'building' and (number is not null or applied_at is not null)`)).length > 0;
  const custom = /custom/i.test(p.model || '');
  const recent = daysAgo(p.received_at) <= RECENT_DAYS;
  if (requested || custom || !recent) {
    skipped++;
    await recordEvent({ jobId: p.job_id, kind: 'licensing.start', at: p.received_at, payload: { baseline: true, reason: requested ? 'permit already requested' : custom ? 'custom home' : 'old payment' }, key });
    continue;
  }
  const ev = await recordEvent({ jobId: p.job_id, kind: 'licensing.start', at: p.received_at, payload: { amount: p.parsed?.invoice_amount ?? p.parsed?.amount }, key });
  const body = tpl
    .replaceAll('{{job.parcel}}', p.parcel || '(parcel)')
    .replaceAll('{{job.address}}', p.address || '(endereço)')
    .replaceAll('{{job.model}}', p.model || '(modelo)')
    .replaceAll('{{job.water_label}} / {{job.sewer_label}}', '(confirmar água / esgoto ou septic)')
    .replaceAll('{{job.owner}}', p.owner_name || 'proprietário')
    .replaceAll('{{internal.permits_owner.name}}', contacts.internal.permits_owner.name);
  // Houses Sovereign doesn't coordinate (config/permit_offices.json): PKB starts the licensing itself.
  if (p.permit_office !== 'sovereign') {
    await mail({
      rule: 'R0', jobId: p.job_id, eventId: ev, to: EMAIL.guilherme,
      subject: `1ª parcela paga — iniciar licenciamento (PKB): ${p.job_number} · ${p.address}`,
      text: `Guilherme,

A 1ª parcela da obra ${p.job_number} — ${p.address} (${p.county || 'condado?'}) foi paga (aviso do Buildertrend em ${brDate(p.received_at)}) e ainda não há permit pedido.

Esta obra NÃO é coordenada pela Sovereign (escritório responsável: PKB). Iniciar o licenciamento pelo nosso lado.
Modelo: ${p.model || '—'} · Parcel: ${p.parcel || '—'} · Proprietário: ${p.owner_name || '—'}

— PKB Ops (aviso automático)`,
    });
    sent++;
    continue;
  }
  await mail({
    rule: 'R0', jobId: p.job_id, eventId: ev, to: EMAIL.guilherme,
    subject: `1ª parcela paga — iniciar licenciamento: ${p.job_number} · ${p.address}`,
    text: `Guilherme,

A 1ª parcela da obra ${p.job_number} foi paga (aviso do Buildertrend em ${brDate(p.received_at)}) e ainda não há permit pedido.

Encaminhe à Sovereign o pedido abaixo, com os anexos:
- Sunbiz do proprietário (${p.owner_name || '—'})
- Property Record Card e/ou Warranty Deed

Para: ${sov.to.join(', ')}
Cc: ${(sov.cc || []).join(', ')}

------------------------------------------------------------
${body.trim()}
------------------------------------------------------------

— PKB Ops (aviso automático)`,
  });
  sent++;
}
console.log(`start licensing: ${sent} sent to Guilherme · ${skipped} skipped/baseline${DRY ? ' · DRY RUN' : ''}`);
