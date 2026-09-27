#!/usr/bin/env node
// =============================================================================
// Rule R-INSP-FAIL — an inspection failed on the county portal.
//
// For every failed inspection not seen before:
//   1. record an `inspection.failed` event (dedupe: inspection:<permit_case>:<number>)
//   2. e-mail the job's supervisor(s), project manager(s) and Cristiano, in Portuguese,
//      with the inspector's comments and the re-inspection fee flag
//   3. queue a Buildertrend Daily Log on the job (channel bt_daily_log, status draft;
//      posted by rules/post_bt_logs.mjs when OPS_BT_POST=true)
//
// Only failures from the last RECENT_DAYS days are announced. Older ones (and every
// failure on the first run of the rule) are recorded as a baseline without messages,
// so turning the rule on never floods the team with history.
//
//   node rules/inspection_failed.mjs [--dry-run]
// OPS_SEND_ENABLED=false (or no BOT_EMAIL_PASSWORD) keeps e-mail as a logged dry run.
// =============================================================================
import { readFileSync } from 'node:fs';
import { sql } from '../scripts/sb.mjs';
import { sendEmail } from '../notify/email.mjs';

const DRY = process.argv.includes('--dry-run');
const RECENT_DAYS = Number(process.env.OPS_RECENT_DAYS || 3);
const ORG = process.env.OPS_ORG_NAME || 'PKB Homes';
const PANEL_URL = process.env.OPS_PANEL_URL || '';
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const qa = (a) => (a.length ? `array[${a.map(q).join(',')}]::text[]` : `'{}'::text[]`);

const contacts = JSON.parse(readFileSync(new URL('../config/contacts.json', import.meta.url), 'utf8'));
const people = [
  ...(contacts.internal.supervisors || []), ...(contacts.internal.project_managers || []), contacts.internal.contractor_of_record,
].filter(Boolean);
const byName = (n) => people.find((p) => [p.name, p.bt_name].some((x) => x && norm(x) === norm(n)));
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const PORTAL_BASE = {
  'energov:marion': 'https://selfservice.marionfl.org/energov_prod/selfservice#/permit/',
  'energov:winterpark': 'https://selfservice.cityofwinterpark.org/energov_prod/selfservice#/permit/',
};
const shortType = (t) => String(t || '').replace(/ - 1 ?& ?2 Res(idential)? Fam(ily)?/i, '').trim();
const cleanComments = (c) => String(c || '').replace(/\r/g, '').replace(/^\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*\n/, '').replace(/[ \t]+/g, ' ').trim();
const brDate = (d) => (d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—');

const orgId = (await sql(`select id from public.orgs where name = ${q(ORG)} limit 1`))[0]?.id;
if (!orgId) throw new Error(`org "${ORG}" not found`);

const failed = await sql(`
  select i.id, i.number, i.type, i.status, coalesce(i.actual_at, i.scheduled_at, i.requested_at) as at, i.inspector, i.comments,
         c.id as case_id, c.number as permit, c.portal, c.portal_case_id, j.id as job_id, j.job_number, j.address,
         (select array_agg(distinct x.name) from ops.job_contacts x where x.job_id = j.id and x.role = 'supervisor') as supervisors,
         (select array_agg(distinct x.name) from ops.job_contacts x where x.job_id = j.id and x.role = 'pm') as pms
  from ops.inspections i
  join ops.permit_cases c on c.id = i.permit_case_id
  join ops.jobs j on j.id = c.job_id
  where j.org_id = ${q(orgId)} and i.failed
    and not exists (select 1 from ops.events e where e.org_id = j.org_id and e.dedupe_key = 'inspection.failed:' || c.id || ':' || i.number)
  order by 5`);

const firstRun = !(await sql(`select 1 from ops.events where org_id = ${q(orgId)} and kind = 'inspection.failed' limit 1`)).length;
const cutoff = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString().slice(0, 10);
console.log(`failed inspections not yet seen: ${failed.length}${firstRun ? ' (first run: all recorded as baseline)' : ''}`);

let announced = 0, baseline = 0;
const byJob = new Map();
for (const f of failed) {
  const at = String(f.at || '').slice(0, 10);
  const recent = (!firstRun || DRY) && at >= cutoff;
  const payload = { number: f.number, type: f.type, status: f.status, inspector: f.inspector, baseline: !recent };
  const key = `inspection.failed:${f.case_id}:${f.number}`;
  if (recent) { if (!byJob.has(f.job_id)) byJob.set(f.job_id, []); byJob.get(f.job_id).push({ ...f, at, payload, key }); continue; }
  if (!DRY) await sql(`insert into ops.events (org_id, job_id, permit_case_id, kind, source, occurred_at, payload, dedupe_key, processed_at)
    values (${q(orgId)}, ${q(f.job_id)}, ${q(f.case_id)}, 'inspection.failed', 'energov', ${q(at || new Date().toISOString())}, ${q(JSON.stringify(payload))}::jsonb, ${q(key)}, now())
    on conflict (org_id, dedupe_key) do nothing`);
  baseline++;
}

// One e-mail and one Daily Log per job, listing every new failure with the inspector's comments.
for (const list of byJob.values()) {
  const f0 = list[0];
  const names = [...new Set([...(f0.supervisors || []), ...(f0.pms || [])])];
  const emails = new Set([contacts.internal.contractor_of_record.email]);
  const missing = [];
  for (const n of names) { const p = byName(n); if (p?.email) emails.add(p.email); else if (!missing.includes(n)) missing.push(n); }
  const btNotify = [...new Set([...names.map((n) => byName(n)?.bt_name || n), contacts.internal.contractor_of_record.bt_name])];
  const portalLink = PORTAL_BASE[f0.portal] && f0.portal_case_id ? PORTAL_BASE[f0.portal] + f0.portal_case_id : null;
  const street = String(f0.address).split(',')[0];

  const block = (f) => {
    const fee = /fee owed|w\/fee|with fee/i.test(f.status) ? 'SIM — taxa de reinspeção devida' : /no fees?/i.test(f.status) ? 'não' : '—';
    return `■ ${shortType(f.type)} (nº ${f.number}) — ${brDate(f.at)}
Inspetor: ${f.inspector || '—'} · Resultado: ${f.status} · Taxa de reinspeção: ${fee}
Comentários do inspetor:
${cleanComments(f.comments) || '(o inspetor não deixou comentário no portal)'}`;
  };
  const types = list.map((f) => shortType(f.type));
  const subject = `Inspeção REPROVADA — ${types.join(', ')} — ${f0.job_number} · ${street}`;
  const text = `${list.length === 1 ? 'Inspeção reprovada' : `${list.length} inspeções reprovadas`} no portal do condado.

Obra: ${f0.job_number} — ${f0.address}
Permit: ${f0.permit}

${list.map(block).join('\n\n')}

Próximo passo: corrigir os itens acima e pedir a reinspeção no portal.${portalLink ? `\nPortal: ${portalLink}` : ''}${PANEL_URL ? `\nPainel PKB Ops: ${PANEL_URL}` : ''}
${missing.length ? `\n(Sem e-mail cadastrado para: ${missing.join(', ')} — avisado(s) pelo Daily Log do Buildertrend.)` : ''}
— PKB Ops (aviso automático)`;
  const logTitle = `Inspection failed — ${types.join(', ')}`.slice(0, 50);
  const logNotes = list.map((f) => `${shortType(f.type)} (${f.number}) failed on ${brDate(f.at)} — ${f.status}. Inspector: ${f.inspector || '—'}.\nInspector comments:\n${cleanComments(f.comments) || '(none on the portal)'}`).join('\n\n') + '\n\nNext: fix the items and request the re-inspection on the portal.';

  let sendResult = { dryRun: true };
  if (!DRY) {
    try { sendResult = await sendEmail({ to: [...emails], subject, text, alwaysCc: false }); }
    catch (e) { sendResult = { error: e.message }; }
  }
  const status = sendResult.error ? 'failed' : sendResult.dryRun ? 'draft' : 'sent';
  console.log(`${status.toUpperCase()} ${f0.job_number} ${types.join(', ')} → ${[...emails].join(', ')}${missing.length ? ` (no e-mail: ${missing.join(', ')})` : ''}`);
  if (DRY) { console.log(`--- ${subject}\n${text}\n`); announced += list.length; continue; }

  let evId = null;
  for (const f of list) {
    const ev = await sql(`insert into ops.events (org_id, job_id, permit_case_id, kind, source, occurred_at, payload, dedupe_key, processed_at)
      values (${q(orgId)}, ${q(f.job_id)}, ${q(f.case_id)}, 'inspection.failed', 'energov', ${q(f.at)}, ${q(JSON.stringify(f.payload))}::jsonb, ${q(f.key)}, now())
      on conflict (org_id, dedupe_key) do nothing returning id`);
    evId = evId ?? ev[0]?.id ?? null;
  }
  await sql(`insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, subject, body, status, error, external_id, in_reply_to_event, sent_at)
    values (${q(orgId)}, ${q(f0.job_id)}, 'email', 'R-INSP-FAIL', ${qa([...emails])}, ${q(subject)}, ${q(text)}, ${q(status)}, ${q(sendResult.error || null)}, ${q(sendResult.id || null)}, ${evId ?? 'null'}, ${status === 'sent' ? 'now()' : 'null'});
    insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, subject, body, status, in_reply_to_event)
    values (${q(orgId)}, ${q(f0.job_id)}, 'bt_daily_log', 'R-INSP-FAIL', ${qa(btNotify)}, ${q(logTitle)}, ${q(logNotes)}, 'draft', ${evId ?? 'null'});`);
  announced += list.length;
}
console.log(`announced: ${announced} · baseline (no message): ${baseline}${DRY ? ' · DRY RUN (nothing written)' : ''}`);
