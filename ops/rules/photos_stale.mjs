#!/usr/bin/env node
// =============================================================================
// Rule R-PHOTO-GAP — a job under construction got no site photo in Buildertrend
// for STALE_DAYS days (default 10).
//
// Reads ops.jobs.photos_last_at (collectors/buildertrend/photos.mjs, daily).
// One e-mail per job to its supervisor(s) and project manager(s), Cristiano in Cc.
// Repeats every STALE_DAYS days while the gap lasts (dedupe key per job, last photo
// and period), so a job is never announced twice in the same period.
//
//   node rules/photos_stale.mjs [--dry-run]
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
         (select array_agg(distinct x.name) from ops.job_contacts x where x.job_id = j.id and x.role = 'supervisor') as supervisors,
         (select array_agg(distinct x.name) from ops.job_contacts x where x.job_id = j.id and x.role = 'pm') as pms
  from ops.jobs j
  where j.org_id = ${q(orgId)} and j.status = 'construction' and j.photos_checked_at is not null
    and (j.photos_last_at is null or j.photos_last_at < now() - interval '${STALE_DAYS} days')
  order by j.job_number`);

let sent = 0;
for (const j of jobs) {
  const days = j.photos_last_at ? Math.floor((Date.now() - new Date(j.photos_last_at).getTime()) / 864e5) : null;
  const period = days == null ? 0 : Math.floor(days / STALE_DAYS); // 1 at 10 days, 2 at 20, …
  const key = `photos.stale:${j.id}:${j.photos_last_at || 'none'}:${period}`;
  if ((await sql(`select 1 from ops.events where org_id = ${q(orgId)} and dedupe_key = ${q(key)}`)).length) continue;

  const names = [...new Set([...(j.supervisors || []), ...(j.pms || [])])];
  const to = new Set(), missing = [];
  for (const n of names) { const p = byName(n); if (p?.email) to.add(p.email); else missing.push(n); }
  const cc = [contacts.internal.contractor_of_record?.email].filter((e) => e && !to.has(e));
  if (!to.size) to.add(cc.shift());
  const street = String(j.address).split(',')[0];
  const subject = days == null
    ? `Obra sem fotos no Buildertrend — ${j.job_number} · ${street}`
    : `Obra sem fotos há ${days} dias — ${j.job_number} · ${street}`;
  const text = `A obra ${j.job_number} — ${j.address} está em construção e ${days == null
    ? 'não tem nenhuma foto da obra no Buildertrend.'
    : `não recebe fotos no Buildertrend há ${days} dias.\n\nÚltima foto: ${brDate(j.photos_last_at)}${j.photos_last_by ? ` · enviada por ${j.photos_last_by}` : ''}.`}

Por favor, registre o andamento com fotos no Daily Log da obra.
${missing.length ? `\n(Sem e-mail cadastrado para: ${missing.join(', ')}.)\n` : ''}
— PKB Ops (aviso automático; repete a cada ${STALE_DAYS} dias enquanto não houver fotos novas)`;

  let res = { dryRun: true };
  if (!DRY) { try { res = await sendEmail({ to: [...to], cc, subject, text, alwaysCc: false }); } catch (e) { res = { error: e.message }; } }
  const status = res.error ? 'failed' : res.dryRun ? 'draft' : 'sent';
  console.log(`${status.toUpperCase()} ${j.job_number} (${days ?? 'no'} days) → ${[...to].join(', ')}${cc.length ? ` cc ${cc.join(', ')}` : ''}`);
  if (DRY) continue;
  const ev = await sql(`insert into ops.events (org_id, job_id, kind, source, occurred_at, payload, dedupe_key, processed_at)
    values (${q(orgId)}, ${q(j.id)}, 'photos.stale', 'buildertrend', now(), ${q(JSON.stringify({ days, last_at: j.photos_last_at, last_by: j.photos_last_by }))}::jsonb, ${q(key)}, now())
    on conflict (org_id, dedupe_key) do nothing returning id`);
  await sql(`insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, subject, body, status, error, external_id, in_reply_to_event, sent_at)
    values (${q(orgId)}, ${q(j.id)}, 'email', 'R-PHOTO-GAP', ${qa([...to, ...cc])}, ${q(subject)}, ${q(text)}, ${q(status)}, ${q(res.error || null)}, ${q(res.id || null)}, ${ev[0]?.id ?? 'null'}, ${status === 'sent' ? 'now()' : 'null'})`);
  sent++;
}
console.log(`photo gap: ${jobs.length} job(s) over ${STALE_DAYS} days · ${sent} new alert(s)${DRY ? ' · DRY RUN' : ''}`);
