#!/usr/bin/env node
// collect_all.mjs — the daily run: ask the database which permits to watch and
// in which stage (ops.monitoring_queue), then run the matching portal collector.
//   node scripts/collect_all.mjs [--limit N]
// Stages: 'permit' → full collection; 'inspections' → inspections/holds only;
// 'done' → skipped. Portals without a collector yet are listed and skipped.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from './sb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const limit = Number((process.argv.find((a, i) => process.argv[i - 1] === '--limit')) || 0);
// portal → [collector script, --county]
const COLLECTORS = {
  'energov:marion': ['collectors/energov/collect.mjs', 'marion'],
  'energov:winterpark': ['collectors/energov/collect.mjs', 'winterpark'],
  'accela:citrus': ['collectors/accela/collect.mjs', 'citrus'],
  'accela:charlotte': ['collectors/accela/collect.mjs', 'charlotte'],
  'accela:northport': ['collectors/accela/collect.mjs', 'northport'],
};

const rows = await sql(`select portal, stage, number from ops.monitoring_queue where stage <> 'done' and number is not null order by portal, stage, number`);
const groups = {};
for (const r of rows) (groups[`${r.portal}|${r.stage}`] ||= []).push(r.number);
let failed = 0;
for (const [key, numbers] of Object.entries(groups)) {
  const [portal, stage] = key.split('|');
  const [script, county] = COLLECTORS[portal] || [];
  const list = limit ? numbers.slice(0, limit) : numbers;
  if (!county) { console.log(`skip ${portal} (${stage}): no collector yet — ${numbers.length} permit(s)`); continue; }
  console.log(`\n== ${portal} · ${stage} · ${list.length} permit(s)`);
  const r = spawnSync('node', [script, '--county', county, '--stage', stage, ...list], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
