#!/usr/bin/env node
// load_photos.mjs — upsert data/buildertrend/photos.json into ops.job_photos.
// Photos no longer in Buildertrend (deleted) are removed for the jobs collected.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from './sb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'buildertrend', 'photos.json'), 'utf8'));
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const org = `(select id from public.orgs where name = ${q(process.env.OPS_ORG_NAME || 'PKB Homes')} limit 1)`;

const rows = data.files.map((f) => `(${f.bt_job_id}, ${f.bt_document_id}, ${q(f.title)}, ${q(f.folder)}, ${!!f.site}, ${q(f.added_by)}, ${q(f.attached_at)}::timestamp, ${q(f.taken_at)}::timestamp, ${q(f.linked_type)}, ${f.linked_id ?? 'null'}, ${q(f.linked_title)})`);
for (let i = 0; i < rows.length; i += 400) {
  await sql(`insert into ops.job_photos (org_id, job_id, bt_job_id, bt_document_id, title, folder, site, added_by, attached_at, taken_at, linked_type, linked_id, linked_title)
select ${org}, (select j.id from ops.jobs j where j.bt_job_id = v.bt_job_id limit 1), v.* from (values ${rows.slice(i, i + 400).join(',\n')})
  as v(bt_job_id, bt_document_id, title, folder, site, added_by, attached_at, taken_at, linked_type, linked_id, linked_title)
on conflict (org_id, bt_document_id) do update set job_id = excluded.job_id, folder = excluded.folder, site = excluded.site, title = excluded.title, collected_at = now();`);
}
// Jobs that were collected: drop photos that are gone from Buildertrend.
const jobs = [...new Set(data.jobs.map((j) => j.bt_job_id))];
if (jobs.length) await sql(`delete from ops.job_photos where bt_job_id in (${jobs.join(',')}) and collected_at < ${q(data.collectedAt)}::timestamptz - interval '1 hour';`);
const [s] = await sql(`select count(*)::int photos, count(distinct job_id)::int jobs, max(attached_at) last from ops.job_photos`);
console.log(`job_photos: ${s.photos} photos · ${s.jobs} jobs · last ${s.last}`);
