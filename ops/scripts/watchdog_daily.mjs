#!/usr/bin/env node
// =============================================================================
// watchdog_daily.mjs — GitHub sometimes starts scheduled workflows hours late (or skips a
// slot). Called every hour by ops-mail: if the 6 AM / 1 PM Florida round is due and the
// portal snapshot is older than that slot, and no ops-daily run is queued or running,
// start ops-daily now (workflow_dispatch with the job's GITHUB_TOKEN).
//   GH_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME (set by Actions) · node scripts/watchdog_daily.mjs
// =============================================================================
import { sql } from './sb.mjs';

const SLOTS = [6, 13];             // Florida hours of the rounds
const GRACE_MIN = 45;              // wait this long after the slot before stepping in
const repo = process.env.GITHUB_REPOSITORY, ref = process.env.GITHUB_REF_NAME, token = process.env.GH_TOKEN;

// "now" and the last slot, in Florida time
const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const offsetMs = new Date().getTime() - ny.getTime();          // UTC − NY
const slot = [...SLOTS].reverse().map((h) => { const d = new Date(ny); d.setHours(h, 0, 0, 0); return d; }).find((d) => d <= ny)
  || (() => { const d = new Date(ny); d.setDate(d.getDate() - 1); d.setHours(SLOTS[SLOTS.length - 1], 0, 0, 0); return d; })();
const slotUtc = new Date(slot.getTime() + offsetMs);
const minutesLate = (Date.now() - slotUtc.getTime()) / 60000;

const [snap] = await sql(`select max(created_at) at from ops.snapshots where kind = 'board'`);
const last = snap?.at ? new Date(snap.at) : null;
const fresh = last && last >= new Date(slotUtc.getTime() - 30 * 60000);   // a round that started a bit early counts
console.log(`slot ${slot.toLocaleString('en-US')} (FL) · ${Math.round(minutesLate)} min ago · last snapshot ${last ? last.toISOString() : 'none'} · ${fresh ? 'fresh' : 'stale'}`);
if (fresh || minutesLate < GRACE_MIN) process.exit(0);
if (!token || !repo) { console.log('::warning::round is late but no GitHub token to start it'); process.exit(0); }

const gh = (path, opts = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) } });
for (const status of ['in_progress', 'queued']) {
  const resp = await gh(`/actions/workflows/ops-daily.yml/runs?status=${status}&per_page=5`);
  if (!resp.ok) { console.log(`::warning::cannot list ops-daily runs (${resp.status}) — not starting a duplicate`); process.exit(0); }
  const r = await resp.json();
  if (r.total_count > 0) { console.log(`ops-daily already ${status} — nothing to do`); process.exit(0); }
}
const res = await gh('/actions/workflows/ops-daily.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref }) });
console.log(res.status === 204 ? `::notice::daily round was ${Math.round(minutesLate)} min late — started ops-daily now` : `::warning::could not start ops-daily (${res.status} ${await res.text()})`);
