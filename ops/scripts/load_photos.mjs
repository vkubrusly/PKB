#!/usr/bin/env node
// load_photos.mjs — write data/buildertrend/photos.json (last site photo per job)
// onto ops.jobs, matched by bt_job_id.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from './sb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'buildertrend', 'photos.json'), 'utf8'));
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
if (!data.jobs.length) { console.log('no photo data'); process.exit(0); }
const rows = data.jobs.map((j) => `(${j.bt_job_id}, ${q(j.last_at)}::timestamp, ${q(j.last_by)}, ${q(j.last_folder)}, ${q(j.last_daily_log)}::timestamp, ${j.count ?? 'null'})`);
await sql(`update ops.jobs x set photos_last_at = v.last_at, photos_last_by = v.last_by, photos_last_folder = v.folder, photos_last_daily_log = v.daily_log, photos_count = v.count, photos_checked_at = ${q(data.collectedAt)}::timestamptz
from (values ${rows.join(',\n')}) as v(bt_job_id, last_at, last_by, folder, daily_log, count) where x.bt_job_id = v.bt_job_id;`);
const [s] = await sql(`select count(*) filter (where photos_checked_at is not null)::int checked, count(photos_last_at)::int with_photos from ops.jobs`);
console.log(`jobs checked: ${s.checked} · with site photos: ${s.with_photos}`);
