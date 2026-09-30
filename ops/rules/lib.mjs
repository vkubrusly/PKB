// Shared helpers for the rules: org, contacts, who to notify for a job, e-mail + log,
// event dedupe and Buildertrend Daily Log drafts.
import { readFileSync } from 'node:fs';
import { sql } from '../scripts/sb.mjs';
import { sendEmail } from '../notify/email.mjs';

export const DRY = process.argv.includes('--dry-run');
export const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
export const qa = (a) => (a.length ? `array[${a.map(q).join(',')}]::text[]` : `'{}'::text[]`);
export const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
export const brDate = (d) => (d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—');
export const street = (a) => String(a || '').split(',')[0];
export const daysAgo = (d) => (d ? (Date.now() - new Date(String(d).slice(0, 10) + 'T12:00:00Z').getTime()) / 864e5 : Infinity);
export const RECENT_DAYS = Number(process.env.OPS_RECENT_DAYS || 3);
export const REVIEW_FAILED = /revisions? required|disapprov|denied|fail|incomplete|re-?submit|corrections?|rejected/i;

export const contacts = JSON.parse(readFileSync(new URL('../config/contacts.json', import.meta.url), 'utf8'));
const people = [...(contacts.internal.supervisors || []), ...(contacts.internal.project_managers || []), contacts.internal.contractor_of_record, contacts.internal.permits_owner].filter(Boolean);
export const person = (n) => people.find((p) => [p.name, p.bt_name].some((x) => x && norm(x) === norm(n)));
export const EMAIL = {
  cristiano: contacts.internal.contractor_of_record?.email,
  guilherme: contacts.internal.permits_owner?.email,
  victor: contacts.internal.director?.email,
  daniela: (contacts.internal.partners || []).find((p) => /daniela/i.test(p.name))?.email || 'daniela@pkbhomes.com',
};

let orgIdCache = null;
export async function orgId() {
  if (orgIdCache) return orgIdCache;
  orgIdCache = (await sql(`select id from public.orgs where name = ${q(process.env.OPS_ORG_NAME || 'PKB Homes')} limit 1`))[0]?.id;
  if (!orgIdCache) throw new Error('org not found');
  return orgIdCache;
}

// Supervisors and PMs of a job (names from Buildertrend) → e-mails; names without e-mail reported.
export async function team(jobId) {
  const rows = await sql(`select role, name from ops.job_contacts where job_id = ${q(jobId)} and role in ('supervisor', 'pm')`);
  const emails = new Set(), missing = [], names = [];
  for (const r of rows) { names.push(r.name); const p = person(r.name); if (p?.email) emails.add(p.email); else missing.push(r.name); }
  return { emails: [...emails], missing: [...new Set(missing)], names: [...new Set(names)], btNames: [...new Set(names.map((n) => person(n)?.bt_name || n))] };
}

// seenPrefix(p) loads every key starting with p in one query; seen() then answers from it.
const seenCache = new Set(), seenPrefixes = [];
export async function seenPrefix(prefix) {
  const rows = await sql(`select dedupe_key from ops.events where org_id = ${q(await orgId())} and dedupe_key like ${q(prefix + '%')}`);
  for (const r of rows) seenCache.add(r.dedupe_key);
  seenPrefixes.push(prefix);
}
export async function seen(key) {
  if (seenCache.has(key)) return true;
  if (seenPrefixes.some((p) => key.startsWith(p))) return false;
  return (await sql(`select 1 from ops.events where org_id = ${q(await orgId())} and dedupe_key = ${q(key)}`)).length > 0;
}

export async function recordEvent({ jobId = null, caseId = null, kind, source = 'rule', at = null, payload = {}, key }) {
  if (DRY) return null;
  const r = await sql(`insert into ops.events (org_id, job_id, permit_case_id, kind, source, occurred_at, payload, dedupe_key, processed_at)
    values (${q(await orgId())}, ${q(jobId)}, ${q(caseId)}, ${q(kind)}, ${q(source)}, ${at ? `${q(at)}::timestamptz` : 'now()'}, ${q(JSON.stringify(payload))}::jsonb, ${q(key)}, now())
    on conflict (org_id, dedupe_key) do nothing returning id`);
  seenCache.add(key);
  return r[0]?.id ?? null;
}

// Send (or dry-run) and log in ops.outbound_messages. external=true adds the Guilherme Cc (OPS_ALWAYS_CC).
export async function mail({ rule, jobId = null, to, cc = [], subject, text, eventId = null, external = false }) {
  to = [...new Set([].concat(to).filter(Boolean))];
  cc = [...new Set(cc.filter((c) => c && !to.includes(c)))];
  if (!to.length) { console.log(`skip ${rule}: no recipient for "${subject}"`); return 'skipped'; }
  let res = { dryRun: true };
  if (!DRY) { try { res = await sendEmail({ to, cc, subject, text, alwaysCc: external }); } catch (e) { res = { error: e.message }; } }
  const status = res.error ? 'failed' : res.dryRun ? 'draft' : 'sent';
  console.log(`${status.toUpperCase()} ${rule} → ${to.join(', ')}${cc.length ? ` cc ${cc.join(', ')}` : ''} · ${subject}`);
  if (DRY) { console.log(text + '\n'); return status; }
  await sql(`insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, cc_addresses, subject, body, status, error, external_id, in_reply_to_event, sent_at)
    values (${q(await orgId())}, ${q(jobId)}, 'email', ${q(rule)}, ${qa(to)}, ${qa(cc)}, ${q(subject)}, ${q(text)}, ${q(status)}, ${q(res.error || null)}, ${q(res.id || null)}, ${eventId ?? 'null'}, ${status === 'sent' ? 'now()' : 'null'})`);
  return status;
}

// Queue a Buildertrend Daily Log (posted by rules/post_bt_logs.mjs when OPS_BT_POST is on).
export async function queueDailyLog({ rule, jobId, title, notes, notify = [], eventId = null }) {
  if (DRY) { console.log(`[daily log] ${title} → ${notify.join(', ')}`); return; }
  await sql(`insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, subject, body, status, in_reply_to_event)
    values (${q(await orgId())}, ${q(jobId)}, 'bt_daily_log', ${q(rule)}, ${qa([...new Set(notify)])}, ${q(title.slice(0, 50))}, ${q(notes.slice(0, 4000))}, 'draft', ${eventId ?? 'null'})`);
}

export { sql };
