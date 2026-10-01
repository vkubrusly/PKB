#!/usr/bin/env node
// =============================================================================
// permit_office.mjs — which office coordinates each house's permit (ops.jobs.permit_office).
// Order: Buildertrend job field 'Permit Office' > portal choice (source 'manual') >
// config/permit_offices.json 'jobs' > 'by_county' > 'default'. Runs after the daily load.
//   node scripts/permit_office.mjs [--dry-run]
// =============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { sql } from './sb.mjs';

const DRY = process.argv.includes('--dry-run');
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const cfg = JSON.parse(readFileSync(new URL('../config/permit_offices.json', import.meta.url), 'utf8'));
const BTF = new URL('../data/buildertrend/job_fields.json', import.meta.url);
const bt = new Map((existsSync(BTF) ? JSON.parse(readFileSync(BTF, 'utf8')).jobs || [] : []).map((r) => [String(r.jobId), r]));
const keyOf = (name) => { const n = String(name || '').toLowerCase(); return Object.keys(cfg.offices).find((k) => n.includes(k) || n.includes(cfg.offices[k].name.toLowerCase().split(' ')[0])) || null; };

const jobs = await sql(`select id, job_number, county, bt_job_id, permit_office, permit_office_source from ops.jobs`);
let changed = 0;
for (const j of jobs) {
  const fromBt = keyOf(bt.get(String(j.bt_job_id))?.permitOffice);
  let office, source;
  if (fromBt) [office, source] = [fromBt, 'buildertrend'];
  else if (j.permit_office_source === 'manual' && j.permit_office) [office, source] = [j.permit_office, 'manual'];
  else if (cfg.jobs[j.job_number]) [office, source] = [cfg.jobs[j.job_number], 'config'];
  else [office, source] = [cfg.by_county[j.county] || cfg.default, 'county'];
  if (office === j.permit_office && source === j.permit_office_source) continue;
  changed++;
  console.log(`${j.job_number} (${j.county || '—'}): ${j.permit_office || '—'} → ${office} [${source}]`);
  if (!DRY) {
    await sql(`update ops.jobs set permit_office = ${q(office)}, permit_office_source = ${q(source)}, updated_at = now() where id = ${q(j.id)}`);
    // the ball can't be with Sovereign on a house Sovereign doesn't coordinate
    if (office !== 'sovereign') await sql(`update ops.permit_cases set ball_with = 'pkb' where job_id = ${q(j.id)} and ball_with = 'sovereign'`);
  }
}
console.log(`permit office: ${changed} job(s) updated${DRY ? ' · DRY RUN' : ''}`);
