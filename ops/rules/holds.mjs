#!/usr/bin/env node
// =============================================================================
// Rule R5 — a new active hold on a permit (county portal).
// Immediate e-mail to Guilherme (Victor in Cc) with the hold and its reason; the ball is
// with PKB. Accela "Notice" conditions (document requirements such as the termite
// certificate) are not holds and are left out. Holds that already existed when the rule
// was turned on are a silent baseline.
//   node rules/holds.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, EMAIL, brDate, street, orgId, seen, recordEvent, mail } from './lib.mjs';

const holds = await sql(`select h.id, h.name, h.type, h.reason, h.comments, h.created_at, h.blocking, c.id case_id, c.number, c.portal, j.id job_id, j.job_number, j.address
  from ops.holds h join ops.permit_cases c on c.id = h.permit_case_id join ops.jobs j on j.id = c.job_id
  where j.org_id = ${q(await orgId())} and h.active and coalesce(h.type, '') !~* '^notice$'`);
const firstRun = !(await sql(`select 1 from ops.events where org_id = ${q(await orgId())} and kind = 'hold.active' limit 1`)).length;
let sent = 0;
for (const h of holds) {
  const key = `hold.active:${h.id}`;
  if (await seen(key)) continue;
  const ev = await recordEvent({ jobId: h.job_id, caseId: h.case_id, kind: 'hold.active', at: h.created_at, payload: { name: h.name, type: h.type, baseline: firstRun }, key });
  if (firstRun) continue;
  await mail({
    rule: 'R5', jobId: h.job_id, eventId: ev, to: EMAIL.guilherme, cc: [EMAIL.victor],
    subject: `HOLD no permit — ${h.job_number} · ${street(h.address)} — ${h.name}`,
    text: `O condado colocou um hold no permit ${h.number} da obra ${h.job_number} — ${h.address}.

Hold: ${h.name}${h.type ? ` (${h.type}${h.blocking ? ' — bloqueia o andamento' : ''})` : ''}
Desde: ${brDate(h.created_at)}${h.reason ? `\nMotivo: ${h.reason}` : ''}${h.comments ? `\nComentário do condado: ${h.comments}` : ''}

A bola está com a PKB: resolver o hold para o permit seguir.

— PKB Ops (aviso automático)`,
  });
  sent++;
}
console.log(`holds: ${holds.length} active · ${sent} new alert(s)${firstRun ? ' · first run: baseline only' : ''}${DRY ? ' · DRY RUN' : ''}`);
