#!/usr/bin/env node
// =============================================================================
// panic.mjs — the kill switch of the response plan (ops/SECURITY.md).
//   node scripts/panic.mjs status   what is running, open sessions
//   node scripts/panic.mjs on       pause every robot (pg_cron dispatches) and sign everyone out
//   node scripts/panic.mjs off      resume the robots (sessions are not restored: people sign in again)
// "on" does not delete data and does not touch GitHub: also disable the ops-* workflows in GitHub
// Actions (their own cron lines are a fallback) — ops/SECURITY.md step 1.
// Needs SUPABASE_ACCESS_TOKEN.
// =============================================================================
import { sql } from './sb.mjs';

const mode = process.argv[2] || 'status';
const jobs = () => sql(`select jobid, jobname, schedule, active from cron.job where jobname like 'pkb-ops-%' order by jobname`);

if (mode === 'on') {
  await sql(`select cron.alter_job(jobid, active := false) from cron.job where jobname like 'pkb-ops-%'`);
  // Signing everyone out: refresh tokens and sessions go; an access token already issued lives until it expires (≤ 1 h).
  const [s] = await sql(`with a as (delete from auth.refresh_tokens returning 1), b as (delete from auth.sessions returning 1) select (select count(*) from a)::int tokens, (select count(*) from b)::int sessions`);
  console.log(`PANIC ON: robots paused; ${s.sessions} session(s) / ${s.tokens} refresh token(s) revoked.`);
  console.log('Next: disable the ops-* workflows in GitHub Actions, rotate the credentials (ops/SECURITY.md step 2).');
} else if (mode === 'off') {
  await sql(`select cron.alter_job(jobid, active := true) from cron.job where jobname like 'pkb-ops-%'`);
  console.log('PANIC OFF: robots resumed. Re-enable the ops-* workflows in GitHub Actions if you disabled them.');
} else if (mode !== 'status') {
  console.error('usage: node scripts/panic.mjs status | on | off'); process.exit(2);
}
for (const j of await jobs()) console.log(`  ${j.active ? 'running' : 'PAUSED '} ${j.jobname} (${j.schedule})`);
const [n] = await sql(`select count(*)::int n from auth.sessions`);
console.log(`  open sessions: ${n.n}`);
