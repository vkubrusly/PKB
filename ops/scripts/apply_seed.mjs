#!/usr/bin/env node
// apply_seed.mjs — apply data/seed/seed_ops_part*.sql to Supabase in order.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from './sb.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed');
for (const f of readdirSync(DIR).filter(f => /^seed_ops_part\d+\.sql$/.test(f)).sort()) {
  const t0 = Date.now();
  await sql(readFileSync(join(DIR, f), 'utf8'));
  console.log(`applied ${f} [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
}
const [c] = await sql(`select (select count(*) from ops.jobs) jobs, (select count(*) from ops.permit_cases) permit_cases,
  (select count(*) from ops.review_items) review_items, (select count(*) from ops.inspections) inspections, (select count(*) from ops.events) events`);
console.log('database now:', JSON.stringify(c));
