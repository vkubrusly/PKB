#!/usr/bin/env node
// load_daily_logs.mjs — write data/buildertrend/daily_logs.json (every Daily Log: author, time,
// title, text) into ops.daily_logs, matched to ops.jobs by bt_job_id. Upsert by Buildertrend log id.
//   node scripts/load_daily_logs.mjs          load the file
//   node scripts/load_daily_logs.mjs --span   print the collector's span: --all while the table is
//                                             empty (first run imports the history), else --days 30
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from './sb.mjs';

if (process.argv.includes('--span')) {
  const [c] = await sql(`select count(*)::int n from ops.daily_logs`);
  console.log(c.n ? '--days 30' : '--all');
  process.exit(0);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'buildertrend', 'daily_logs.json'), 'utf8'));
if (!data.logs.length) { console.log('no daily logs'); process.exit(0); }
const q = (v) => (v == null || v === '' ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const [{ org_id }] = await sql(`select org_id from ops.jobs limit 1`);
for (let i = 0; i < data.logs.length; i += 200) {
  const rows = data.logs.slice(i, i + 200).map((l) => {
    const raw = { published_by: l.published_by, viewable_by: l.viewable_by, employees_on_site: l.employees_on_site, photos: l.photos, updated_utc: l.updated_utc, job: l.job };
    return `(${l.bt_log_id}, ${l.bt_job_id ?? 'null'}, ${q((l.job || '').match(/^\d{4}/)?.[0])}, ${q(l.log_at)}::timestamp, ${q(l.written_utc)}::timestamp, ${q(l.author)}, ${q(l.title)}, ${q(l.notes)}, ${q(JSON.stringify(raw))}::jsonb)`;
  });
  // logged_at: when it was written (Buildertrend gives UTC) in Florida time; log_date: the log's own date.
  await sql(`insert into ops.daily_logs (org_id, job_id, bt_log_id, bt_job_id, job_number, log_date, logged_at, author, title, notes, is_private, raw, collected_at)
select '${org_id}', j.id, v.log_id, v.bt_job_id, coalesce(j.job_number, v.job_number), coalesce(v.log_at, (v.written_utc at time zone 'UTC') at time zone 'America/New_York')::date,
  coalesce((v.written_utc at time zone 'UTC') at time zone 'America/New_York', v.log_at), v.author, v.title, v.notes,
  null, v.raw, now()
from (values ${rows.join(',\n')}) as v(log_id, bt_job_id, job_number, log_at, written_utc, author, title, notes, raw)
left join lateral (select id, job_number from ops.jobs x where x.bt_job_id = v.bt_job_id order by (x.job_number ~ '^S') limit 1) j on true
on conflict (org_id, bt_log_id) do update set job_id = excluded.job_id, bt_job_id = excluded.bt_job_id, job_number = excluded.job_number, log_date = excluded.log_date,
  logged_at = excluded.logged_at, author = excluded.author, title = excluded.title, notes = excluded.notes, raw = excluded.raw, collected_at = now();`);
}
const [s] = await sql(`select count(*)::int n, count(distinct job_id)::int jobs, count(*) filter (where log_date >= current_date - 7)::int week from ops.daily_logs`);
console.log(`daily logs loaded: ${data.logs.length} · table: ${s.n} logs on ${s.jobs} jobs · ${s.week} in the last 7 days`);
