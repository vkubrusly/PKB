#!/usr/bin/env node
// =============================================================================
// Rule R-JOB-IDLE — a job under construction shows no activity in Buildertrend
// for STALE_DAYS days (default 10): no site photo AND no Daily Log. Either one
// resets the clock, so a job is flagged only when everything has stopped.
// Daily Log activity comes from Buildertrend's notification e-mails to the bot
// (ops.inbound_emails, category bt_daily_log) and from photos attached to logs.
//
// Reads ops.jobs.photos_last_at (collectors/buildertrend/photos.mjs, daily).
// A house that is ready gets no more photos, so a job is left out as soon as it reaches
// the power-release stage (Preliminary Power Release / Pre-Power passed: only the utility
// connection and the finals remain) or construction is over: status completed (control
// sheet), CO recorded, Final Building passed on the portal, or the job closed in Buildertrend.
// One e-mail per job to its supervisor(s) and project manager(s), Cristiano in Cc.
// Repeats every STALE_DAYS days while the gap lasts (dedupe key per job, last photo
// and period), so a job is never announced twice in the same period.
//
//   node rules/job_idle.mjs [--dry-run]
// OPS_SEND_ENABLED=false (or no BOT_EMAIL_PASSWORD) keeps e-mail as a logged dry run.
// =============================================================================
import { readFileSync } from 'node:fs';
import { sql } from '../scripts/sb.mjs';
import { sendEmail } from '../notify/email.mjs';

const DRY = process.argv.includes('--dry-run');
const STALE_DAYS = Number(process.env.OPS_PHOTO_STALE_DAYS || 10);
const ORG = process.env.OPS_ORG_NAME || 'PKB Homes';
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const qa = (a) => (a.length ? `array[${a.map(q).join(',')}]::text[]` : `'{}'::text[]`);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const brDate = (d) => (d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—');

const contacts = JSON.parse(readFileSync(new URL('../config/contacts.json', import.meta.url), 'utf8'));
const people = [...(contacts.internal.supervisors || []), ...(contacts.internal.project_managers || []), contacts.internal.contractor_of_record].filter(Boolean);
const byName = (n) => people.find((p) => [p.name, p.bt_name].some((x) => x && norm(x) === norm(n)));

const orgId = (await sql(`select id from public.orgs where name = ${q(ORG)} limit 1`))[0]?.id;
if (!orgId) throw new Error(`org "${ORG}" not found`);

// Under construction, checked in Buildertrend, and no photo (or none recently).
const jobs = await sql(`
  select j.id, j.job_number, j.address, j.photos_last_at, j.photos_last_by, j.photos_checked_at,
         greatest(j.photos_last_daily_log, (select max(e.received_at) from ops.inbound_emails e
           where e.category = 'bt_daily_log' and (e.job_id = j.id or e.job_number = j.job_number))) as log_last_at,
         (select array_agg(distinct x.name) from ops.job_contacts x where x.job_id = j.id and x.role = 'supervisor') as supervisors,
         (select array_agg(distinct x.name) from ops.job_contacts x where x.job_id = j.id and x.role = 'pm') as pms
  from ops.jobs j
  where j.org_id = ${q(orgId)} and j.status = 'construction' and j.photos_checked_at is not null and j.co_at is null
    and (j.photos_last_at is null or j.photos_last_at < now() - interval '${STALE_DAYS} days')
    and not exists (select 1 from ops.inbound_emails e where e.category = 'bt_daily_log' and (e.job_id = j.id or e.job_number = j.job_number)
                    and e.received_at > now() - interval '${STALE_DAYS} days')
    and (j.photos_last_daily_log is null or j.photos_last_daily_log < now() - interval '${STALE_DAYS} days')
    and not exists (select 1 from ops.inspections i join ops.permit_cases c on c.id = i.permit_case_id
                    where c.job_id = j.id and c.kind = 'building' and i.passed
                      and (i.type ~* 'final\\s*(building|structural)' or i.type ~* 'building\\s*final'
                           or i.type ~* 'preliminary\\s*power\\s*release|^power\\s*release|pre[\\s-]*power'))
  order by j.job_number`);
// Buildertrend: a job whose status is no longer Open (1) is closed/finished.
let btClosed = new Set();
try {
  const f = JSON.parse(readFileSync(new URL('../data/buildertrend/job_fields.json', import.meta.url), 'utf8'));
  btClosed = new Set((f.jobs || f).filter((r) => r.status != null && r.status !== 1).map((r) => String(r.jobId)));
} catch { /* no Buildertrend snapshot in this run */ }
const btIds = btClosed.size ? Object.fromEntries((await sql(`select id, bt_job_id from ops.jobs where bt_job_id is not null`)).map((r) => [r.id, String(r.bt_job_id)])) : {};
for (let i = jobs.length - 1; i >= 0; i--) if (btClosed.has(btIds[jobs[i].id])) jobs.splice(i, 1);

let sent = 0;
for (const j of jobs) {
  const lastAct = [j.photos_last_at, j.log_last_at].filter(Boolean).map((d) => new Date(d).getTime()).sort().pop();
  const days = lastAct ? Math.floor((Date.now() - lastAct) / 864e5) : null;
  const period = days == null ? 0 : Math.floor(days / STALE_DAYS); // 1 at 10 days, 2 at 20, …
  const key = `job.idle:${j.id}:${lastAct || 'none'}:${period}`;
  if ((await sql(`select 1 from ops.events where org_id = ${q(orgId)} and dedupe_key = ${q(key)}`)).length) continue;

  const names = [...new Set([...(j.supervisors || []), ...(j.pms || [])])];
  const to = new Set(), missing = [];
  for (const n of names) { const p = byName(n); if (p?.email) to.add(p.email); else missing.push(n); }
  const cc = [contacts.internal.contractor_of_record?.email].filter((e) => e && !to.has(e));
  if (!to.size) to.add(cc.shift());
  const street = String(j.address).split(',')[0];
  const subject = days == null
    ? `Obra sem movimento no Buildertrend — ${j.job_number} · ${street}`
    : `Obra parada há ${days} dias — ${j.job_number} · ${street}`;
  const text = `A obra ${j.job_number} — ${j.address} está em construção e ${days == null
    ? 'não tem fotos nem Daily Logs no Buildertrend.'
    : `está sem fotos novas e sem Daily Log há ${days} dias.`}

Última foto: ${j.photos_last_at ? `${brDate(j.photos_last_at)}${j.photos_last_by ? ` · ${j.photos_last_by}` : ''}` : 'nenhuma'}
Último Daily Log: ${j.log_last_at ? brDate(j.log_last_at) : 'nenhum registrado'}

Se a obra está andando, registre o andamento (fotos no Daily Log). Se está parada por algum motivo, avise para marcarmos a pausa.
${missing.length ? `\n(Sem e-mail cadastrado para: ${missing.join(', ')}.)\n` : ''}
— PKB Ops (aviso automático; repete a cada ${STALE_DAYS} dias enquanto não houver movimento)`;

  let res = { dryRun: true };
  if (!DRY) { try { res = await sendEmail({ to: [...to], cc, subject, text, alwaysCc: false }); } catch (e) { res = { error: e.message }; } }
  const status = res.error ? 'failed' : res.dryRun ? 'draft' : 'sent';
  console.log(`${status.toUpperCase()} ${j.job_number} (${days ?? 'no'} days) → ${[...to].join(', ')}${cc.length ? ` cc ${cc.join(', ')}` : ''}`);
  if (DRY) continue;
  const ev = await sql(`insert into ops.events (org_id, job_id, kind, source, occurred_at, payload, dedupe_key, processed_at)
    values (${q(orgId)}, ${q(j.id)}, 'job.idle', 'buildertrend', now(), ${q(JSON.stringify({ days, photo_at: j.photos_last_at, log_at: j.log_last_at }))}::jsonb, ${q(key)}, now())
    on conflict (org_id, dedupe_key) do nothing returning id`);
  await sql(`insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, subject, body, status, error, external_id, in_reply_to_event, sent_at)
    values (${q(orgId)}, ${q(j.id)}, 'email', 'R-JOB-IDLE', ${qa([...to, ...cc])}, ${q(subject)}, ${q(text)}, ${q(status)}, ${q(res.error || null)}, ${q(res.id || null)}, ${ev[0]?.id ?? 'null'}, ${status === 'sent' ? 'now()' : 'null'})`);
  sent++;
}
console.log(`idle jobs: ${jobs.length} with no photo and no Daily Log for ${STALE_DAYS}+ days · ${sent} new alert(s)${DRY ? ' · DRY RUN' : ''}`);
