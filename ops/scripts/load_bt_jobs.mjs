#!/usr/bin/env node
// load_bt_jobs.mjs — every Buildertrend job (data/buildertrend/job_fields.json, read by the daily round) into
// ops.bt_jobs: name, street, parcel, status. Vendor invoices use it to find a lot by its parcel or street even
// before the house is in ops.jobs (Victor, 11/23/26: "utilize sua inteligência para resolver as dúvidas").
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from './sb.mjs';
import { q } from '../rules/lib.mjs';

const file = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'buildertrend', 'job_fields.json');
if (!existsSync(file)) { console.log(`load_bt_jobs: ${file} not found — nothing loaded`); process.exit(0); }
const jobs = (JSON.parse(readFileSync(file, 'utf8')).jobs || []).filter((j) => j.jobId);
if (!jobs.length) { console.log('load_bt_jobs: no jobs in the file'); process.exit(0); }
const num = (name) => (/^\s*(?:job\s*)?#?\s*(\d{4})\b/i.exec(String(name || '')) || [])[1] || null;
const rows = jobs.map((j) => `(${Number(j.jobId)}, ${q(j.name || null)}, ${q(num(j.name))}, ${q(j.street || null)}, ${q(j.city || null)}, ${q(Array.isArray(j.parcel) ? j.parcel.join(' ') : j.parcel || null)}, ${q(j.status || j.jobStatus || null)}, now())`);
await sql(`insert into ops.bt_jobs (bt_job_id, name, job_number, street, city, parcel, status, updated_at) values ${rows.join(',\n')}
  on conflict (bt_job_id) do update set name = excluded.name, job_number = excluded.job_number, street = excluded.street, city = excluded.city,
    parcel = excluded.parcel, status = coalesce(excluded.status, ops.bt_jobs.status), updated_at = now()`);
console.log(`load_bt_jobs: ${jobs.length} jobs (${jobs.filter((j) => j.parcel).length} with parcel, ${jobs.filter((j) => num(j.name)).length} with job number)`);
