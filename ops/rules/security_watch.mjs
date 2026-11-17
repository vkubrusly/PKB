#!/usr/bin/env node
// =============================================================================
// security_watch.mjs — the security robot (Victor, 2026-11-17). Runs every hour (ops-mail workflow).
// Looks for attack attempts and for doors left open, and e-mails Victor at once for anything
// critical or high; the rest goes to a weekly report (Mondays). Each finding is kept in
// ops.security_findings (one row per key) so it alerts once; a condition that goes away is
// marked resolved. Read-only towards the system: it changes nothing but its own table.
// Response plan when something is found: ops/SECURITY.md.
//
// Checks
//   auth config     public sign-up must stay off, passwords ≥ 12, legacy JWT keys off
//   advisor         Supabase security advisor (new WARN / ERROR lints; today's list is the baseline)
//   exposure        tables without RLS in the API schema, public storage buckets
//   accounts        new logins created, new members of a real company (not the demo org)
//   attacks         failed sign-ins (bursts per IP / overall), sign-up attempts
//   abuse           AI calls per hour (cost abuse of the Anthropic key), e-mails sent per hour
//   node rules/security_watch.mjs [--dry-run]
// =============================================================================
import { createHash } from 'node:crypto';
import { sql } from '../scripts/sb.mjs';
import { sendEmail } from '../notify/email.mjs';
import { q, DRY, EMAIL, orgId } from './lib.mjs';

const REF = process.env.SUPABASE_PROJECT_REF || 'fvjknahpmihueyeasgbx';
const API = `https://api.supabase.com/v1/projects/${REF}`;
const DEMO_ORG = '11111111-1111-1111-1111-111111111111';
const LIMITS = { failedPerIp: 10, failedTotal: 25, aiPerHour: 40, emailsPerHour: 30 };   // normal peaks: 12 AI calls, 10 e-mails an hour
const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const mgmt = async (path, params) => {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${(process.env.SUPABASE_ACCESS_TOKEN || '').trim()}` } });
  if (!r.ok) throw new Error(`Management API ${path}: ${r.status}`);
  return r.json();
};

const found = [];   // { key, severity, title, detail, state }  state=true → a condition that resolves when gone
const add = (f) => found.push(f);
const errors = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); } };

// --- auth config ----------------------------------------------------------------------------
await check('auth config', async () => {
  const a = await mgmt('/config/auth');
  if (a.disable_signup !== true) add({ key: 'config:signup_open', severity: 'critical', title: 'Public sign-up is ON', detail: 'Anyone can create an account. Turn it off: Supabase → Authentication → Sign In / Providers → Allow new users to sign up.', state: true });
  if ((a.password_min_length || 0) < 12) add({ key: 'config:password_min', severity: 'high', title: `Minimum password length is ${a.password_min_length}`, detail: 'Should be 12 or more.', state: true });
  const legacy = await mgmt('/api-keys/legacy').catch(() => null);
  if (legacy?.enabled) add({ key: 'config:legacy_keys_on', severity: 'medium', title: 'Legacy JWT API keys (anon / service_role) are still enabled', detail: 'The old JWT secret was exposed on 11/17; disable the legacy keys and revoke the HS256 signing key (ops/SECURITY.md).', state: true });
});

// --- Supabase security advisor --------------------------------------------------------------
await check('advisor', async () => {
  const lints = (await mgmt('/advisors/security')).lints || [];
  for (const l of lints) {
    if (!['WARN', 'ERROR'].includes(l.level)) continue;
    const what = l.metadata ? `${l.metadata.schema || ''}.${l.metadata.name || ''}` : hash(l.detail);
    add({ key: `advisor:${l.name}:${what}`, severity: l.level === 'ERROR' ? 'high' : 'medium', title: `Advisor: ${l.title || l.name}`, detail: String(l.detail || '').replace(/\\`/g, '`').slice(0, 400), state: true, baseline: true });
  }
});

// --- exposure -------------------------------------------------------------------------------
await check('exposure', async () => {
  const open = await sql(`select n.nspname || '.' || c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname = 'public' and not c.relrowsecurity`);
  for (const r of open) add({ key: `rls_off:${r.t}`, severity: 'critical', title: `Table ${r.t} has no row-level security`, detail: 'It is reachable through the public API. Enable RLS.', state: true });
  for (const b of await sql(`select id from storage.buckets where public`)) add({ key: `bucket_public:${b.id}`, severity: 'critical', title: `Storage bucket "${b.id}" is public`, detail: 'Anyone with a file path can download it.', state: true });
});

// --- accounts -------------------------------------------------------------------------------
await check('accounts', async () => {
  const users = await sql(`select u.id, u.email, u.created_at::text c, p.email is not null known
    from auth.users u left join ops.portal_users p on lower(p.email) = lower(u.email) where u.created_at > now() - interval '7 days'`);
  for (const u of users) add({ key: `new_user:${u.id}`, severity: u.known ? 'low' : 'high', title: `New login created: ${u.email}`, detail: `${u.c}${u.known ? ' — listed in PKB Ops users' : ' — NOT in PKB Ops users: check who created it'}` });
  const members = await sql(`select m.org_id, m.user_id, m.role, m.created_at::text c, u.email, o.name from public.org_members m join auth.users u on u.id = m.user_id
    join public.orgs o on o.id = m.org_id where m.org_id <> ${q(DEMO_ORG)} and m.created_at > now() - interval '7 days'`);
  for (const m of members) add({ key: `new_member:${m.org_id}:${m.user_id}`, severity: 'high', title: `${m.email} became ${m.role} of "${m.name}"`, detail: `${m.c} — confirm this was intended.` });
});

// --- attacks (auth logs, last hour) ---------------------------------------------------------
await check('auth logs', async () => {
  const end = new Date(), start = new Date(end.getTime() - 3600e3);
  const iso = (d) => d.toISOString().slice(0, 16) + ':00Z';
  const rows = (await mgmt('/analytics/endpoints/logs', { sql: `select timestamp, event_message from logs where source = 'auth_logs' limit 5000`, iso_timestamp_start: iso(start), iso_timestamp_end: iso(end) })).result || [];
  const failed = new Map(); let signups = 0;
  for (const r of rows) {
    let e; try { e = JSON.parse(r.event_message); } catch { continue; }
    if (e.path === '/token' && e.method === 'POST' && [400, 401, 422, 429].includes(Number(e.status))) failed.set(e.remote_addr || '?', (failed.get(e.remote_addr || '?') || 0) + 1);
    if (e.path === '/signup' && e.method === 'POST') signups++;
  }
  const hour = iso(end).slice(0, 13);
  const total = [...failed.values()].reduce((a, b) => a + b, 0);
  for (const [ip, n] of failed) if (n >= LIMITS.failedPerIp) add({ key: `failed_login:${ip}:${hour}`, severity: 'high', title: `${n} failed sign-ins from ${ip} in the last hour`, detail: 'Password guessing. If it continues, block the IP (Supabase network restrictions) and check the accounts it targeted.' });
  if (total >= LIMITS.failedTotal) add({ key: `failed_login_total:${hour}`, severity: 'high', title: `${total} failed sign-ins in the last hour`, detail: `${failed.size} IP(s).` });
  if (signups) add({ key: `signup_attempt:${hour}`, severity: 'medium', title: `${signups} sign-up attempt(s) in the last hour`, detail: 'Public sign-up is off, so they were refused; someone is trying to create accounts.' });
});

// --- abuse ----------------------------------------------------------------------------------
await check('abuse', async () => {
  const [ai] = await sql(`select count(*)::int n, coalesce(sum(input_tokens + output_tokens), 0)::bigint t, string_agg(distinct email, ', ') who from ops.ai_usage where at > now() - interval '1 hour'`);
  if (ai.n >= LIMITS.aiPerHour) add({ key: `ai_spike:${new Date().toISOString().slice(0, 13)}`, severity: 'high', title: `${ai.n} AI calls in the last hour (normal peak 12)`, detail: `${ai.t} tokens, by ${ai.who || '—'}. Possible misuse of the Anthropic key.` });
  const [em] = await sql(`select count(*)::int n from ops.outbound_messages where channel = 'email' and created_at > now() - interval '1 hour'`);
  if (em.n >= LIMITS.emailsPerHour) add({ key: `email_spike:${new Date().toISOString().slice(0, 13)}`, severity: 'high', title: `${em.n} e-mails sent in the last hour (normal peak 10)`, detail: 'Check the Outbox: a rule may be looping, or the mailbox is being misused.' });
});

if (errors.length) add({ key: `watch_error:${new Date().toISOString().slice(0, 10)}`, severity: 'medium', title: 'The security robot could not run every check', detail: errors.join(' · ') });

// --- store, alert, resolve ------------------------------------------------------------------
const known = new Map((await sql(`select key, alerted_at is not null alerted, resolved_at is not null resolved from ops.security_findings`)).map((r) => [r.key, r]));
const firstRun = known.size === 0;
const fresh = [];
for (const f of found) {
  const k = known.get(f.key);
  if (k && !k.resolved) { if (!DRY) await sql(`update ops.security_findings set last_seen = now() where key = ${q(f.key)}`); continue; }
  // first run: everything found is the baseline (reported weekly, not alerted)
  const silent = firstRun;
  if (!silent) fresh.push(f);
  if (!DRY) await sql(`insert into ops.security_findings (key, severity, title, detail, alerted_at, resolved_at) values (${q(f.key)}, ${q(f.severity)}, ${q(f.title)}, ${q(f.detail || null)},
    ${silent ? 'now()' : 'null'}, ${f.state ? 'null' : 'now()'}) on conflict (key) do update set severity = excluded.severity, title = excluded.title, detail = excluded.detail, last_seen = now(), resolved_at = excluded.resolved_at`);
}
// conditions that are gone
const seenState = new Set(found.filter((f) => f.state).map((f) => f.key));
const gone = (await sql(`select key, title from ops.security_findings where resolved_at is null`)).filter((r) => !seenState.has(r.key) && !found.some((f) => f.key === r.key));
// a check that failed this hour decides nothing: its findings stay open
if (!DRY && !errors.length) for (const g of gone) await sql(`update ops.security_findings set resolved_at = now() where key = ${q(g.key)}`);

const send = async (subject, text) => {
  let res = { dryRun: true };
  if (!DRY) { try { res = await sendEmail({ to: [EMAIL.victor], subject, text, alwaysCc: false, force: true }); } catch (e) { res = { error: e.message }; } }
  const status = res.error ? 'failed' : res.dryRun ? 'draft' : 'sent';
  console.log(`${status.toUpperCase()} SEC → ${EMAIL.victor} · ${subject}`);
  if (!DRY) await sql(`insert into ops.outbound_messages (org_id, channel, rule, to_addresses, subject, body, status, error, external_id, sent_at)
    values (${q(await orgId())}, 'email', 'SEC', array[${q(EMAIL.victor)}], ${q(subject)}, ${q(text)}, ${q(status)}, ${q(res.error || null)}, ${q(res.id || null)}, ${status === 'sent' ? 'now()' : 'null'})`);
  return status;
};
const line = (f) => `• [${f.severity.toUpperCase()}] ${f.title}${f.detail ? `\n  ${f.detail}` : ''}`;

const urgent = fresh.filter((f) => ['critical', 'high'].includes(f.severity));
if (urgent.length) {
  const st = await send(`🚨 PKB Ops security: ${urgent.length} alert(s) — ${urgent[0].title}`.slice(0, 140),
    `${urgent.map(line).join('\n\n')}\n\nWhat to do: ops/SECURITY.md (response plan). Critical = act now; high = today.\n\n— PKB Ops security robot`);
  if (st === 'sent' && !DRY) for (const f of urgent) await sql(`update ops.security_findings set alerted_at = now() where key = ${q(f.key)}`);
}

// weekly report: Mondays, once
const now = new Date();
const week = `weekly:${now.toISOString().slice(0, 10)}`;
if (now.getUTCDay() === 1 && now.getUTCHours() >= 12 && !known.has(week) && !DRY) {
  const open = await sql(`select severity, title, detail from ops.security_findings where resolved_at is null and key not like 'weekly:%'
    order by array_position(array['critical','high','medium','low','info'], severity), first_seen`);
  const week7 = await sql(`select severity, title from ops.security_findings where first_seen > now() - interval '7 days' and key not like 'weekly:%' order by first_seen desc limit 40`);
  const st = await send(`PKB Ops security — weekly report (${open.length} open)`,
    `OPEN (${open.length})\n${open.map(line).join('\n') || '• nothing open'}\n\nSEEN THIS WEEK (${week7.length})\n${week7.map((f) => `• [${f.severity}] ${f.title}`).join('\n') || '• nothing'}\n\nResponse plan: ops/SECURITY.md.\n\n— PKB Ops security robot`);
  if (st === 'sent') await sql(`insert into ops.security_findings (key, severity, title, alerted_at, resolved_at) values (${q(week)}, 'info', 'weekly report sent', now(), now()) on conflict do nothing`);
}

console.log(`security watch: ${found.length} finding(s) · ${fresh.length} new · ${urgent.length} alerted · ${gone.length} resolved${firstRun ? ' · first run: baseline' : ''}${errors.length ? ` · ${errors.length} check error(s)` : ''}${DRY ? ' · dry run' : ''}`);
for (const f of found) console.log(`  [${f.severity}] ${f.title}`);
