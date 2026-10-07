#!/usr/bin/env node
// =============================================================================
// watchdog_daily.mjs — makes sure the 4 AM / 1 PM Florida round happens (Victor, 2026-10-02:
// "if it fails, try again every 15 min until it works").
// Runs every 15 min (ops-watchdog.yml). A round is done when the portal snapshot is newer than
// the slot. Otherwise — GitHub started it late, skipped it, or it failed — and when no ops-daily
// is queued or running, it starts ops-daily now. From the 3rd attempt on a slot, Victor gets
// one e-mail per slot.
//   GH_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME (set by Actions) · node scripts/watchdog_daily.mjs
// =============================================================================
import { sql } from './sb.mjs';

const SLOTS = [4, 13];             // Florida hours of the rounds
const GRACE_MIN = 15;              // the scheduled run starts at :47 before the slot; step in 15 min after the slot
const repo = process.env.GITHUB_REPOSITORY, ref = process.env.GITHUB_REF_NAME, token = process.env.GH_TOKEN;
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

// "now" and the last slot, in Florida time
const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const offsetMs = Date.now() - ny.getTime();          // UTC − NY
const slot = [...SLOTS].reverse().map((h) => { const d = new Date(ny); d.setHours(h, 0, 0, 0); return d; }).find((d) => d <= ny)
  || (() => { const d = new Date(ny); d.setDate(d.getDate() - 1); d.setHours(SLOTS[SLOTS.length - 1], 0, 0, 0); return d; })();
const slotUtc = new Date(slot.getTime() + offsetMs);
const minutesLate = (Date.now() - slotUtc.getTime()) / 60000;
const windowStart = new Date(slotUtc.getTime() - 30 * 60000);   // the :47 scheduled run starts before the slot

// The Supabase access token expires (1 year, created 2026-10-03). When it stops working, every job
// fails — tell Victor right away (once a day, 8 AM Florida) with the links to replace it.
let snap;
try { [snap] = await sql(`select max(created_at) at from ops.snapshots where kind = 'board'`); }
catch (e) {
  // anything but a refused token is a momentary hiccup: the next check is 15 min away
  if (!/\b(401|403)\b/.test(e.message)) { console.log('::warning::Supabase unavailable (' + e.message.slice(0, 120) + ') — trying again at the next check'); process.exit(0); }
  console.log('::error::Supabase access token refused (' + e.message.slice(0, 80) + ')');
  if (ny.getHours() === 8 && ny.getMinutes() < 15 && process.env.BOT_EMAIL_PASSWORD) {
    const { sendEmail } = await import('../notify/email.mjs');
    await sendEmail({ to: ['victor@pkbhomes.com'], subject: 'PKB Ops PARADO — a chave do Supabase expirou', alwaysCc: false, force: true,
      text: `A chave de acesso do Supabase (SUPABASE_ACCESS_TOKEN) parou de funcionar, então as rodadas, o e-mail do bot e os posts no Buildertrend estão parados.\n\n1. Gere uma nova: https://supabase.com/dashboard/account/tokens (validade máxima)\n2. Troque no GitHub: https://github.com/${process.env.GITHUB_REPOSITORY || 'vkubrusly/PKB'}/settings/secrets/actions/SUPABASE_ACCESS_TOKEN\n\nDepois disso o sistema se recupera sozinho em até 15 minutos.\n\n— PKB Ops (aviso automático, 1x por dia até resolver)` });
    console.log('alert e-mail sent to Victor');
  }
  process.exit(1);
}
const last = snap?.at ? new Date(snap.at) : null;
const fresh = last && last >= windowStart;
console.log(`slot ${slot.toLocaleString('en-US')} (FL) · ${Math.round(minutesLate)} min ago · last snapshot ${last ? last.toISOString() : 'none'} · ${fresh ? 'done' : 'not done'}`);
if (fresh || minutesLate < GRACE_MIN) process.exit(0);
if (!token || !repo) { console.log('::warning::round not done but no GitHub token to start it'); process.exit(0); }

const gh = (path, opts = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) } });
for (const status of ['in_progress', 'queued']) {
  const resp = await gh(`/actions/workflows/ops-daily.yml/runs?status=${status}&per_page=5`);
  if (!resp.ok) { console.log(`::warning::cannot list ops-daily runs (${resp.status}) — not starting a duplicate`); process.exit(0); }
  if ((await resp.json()).total_count > 0) { console.log(`ops-daily ${status} — waiting for it`); process.exit(0); }
}
// attempts already made for this slot (runs created since the window opened)
const recent = await (await gh(`/actions/workflows/ops-daily.yml/runs?per_page=20&created=>=${windowStart.toISOString().slice(0, 19)}Z`)).json().catch(() => ({}));
const attempts = (recent.workflow_runs || []).length;
const res = await gh('/actions/workflows/ops-daily.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref }) });
if (res.status !== 204) { console.log(`::warning::could not start ops-daily (${res.status} ${await res.text()})`); process.exit(0); }
console.log(`::notice::round not done ${Math.round(minutesLate)} min after the slot — started ops-daily (attempt ${attempts + 1})`);

// from the 3rd attempt: tell Victor once per slot
if (attempts + 1 >= 3) {
  const key = `watchdog.alert:${slotUtc.toISOString()}`;
  const [org] = await sql(`select id from public.orgs where name = 'PKB Homes' limit 1`);
  const done = (await sql(`select 1 from ops.events where org_id = ${q(org.id)} and dedupe_key = ${q(key)}`)).length;
  if (!done && process.env.BOT_EMAIL_PASSWORD) {
    const { sendEmail } = await import('../notify/email.mjs');
    const contacts = JSON.parse((await import('node:fs')).readFileSync(new URL('../config/contacts.json', import.meta.url), 'utf8'));
    await sendEmail({ to: [contacts.internal.director.email], subject: `PKB Ops — a rodada das ${slot.getHours()}h ainda não concluiu (tentativa ${attempts + 1})`, alwaysCc: false, force: true,
      text: `A atualização das ${slot.getHours()}h (${slot.toLocaleDateString('pt-BR')}) ainda não terminou com sucesso. O sistema está tentando de novo a cada 15 minutos.\n\nÚltimos dados no portal: ${last ? last.toLocaleString('pt-BR', { timeZone: 'America/New_York' }) : '—'} (Flórida).\nDetalhes: https://github.com/${repo}/actions/workflows/ops-daily.yml\n\n— PKB Ops (aviso automático)` });
    await sql(`insert into ops.events (org_id, kind, source, occurred_at, payload, dedupe_key, processed_at) values (${q(org.id)}, 'watchdog.alert', 'rule', now(), ${q(JSON.stringify({ attempts: attempts + 1 }))}::jsonb, ${q(key)}, now()) on conflict do nothing`);
    console.log('alert e-mail sent to Victor');
  }
}
