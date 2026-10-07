#!/usr/bin/env node
// collect_all.mjs — the daily run: ask the database which permits to watch and
// in which stage (ops.monitoring_queue), then run the matching portal collector.
//   node scripts/collect_all.mjs [--limit N]
// Stages: 'permit' → full collection; 'inspections' → inspections/holds only;
// 'done' → skipped. Portals without a collector yet are listed and skipped.
import { spawn } from 'node:child_process';
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

// Each county is its own website, so the portals run at the same time (the round takes as long
// as the slowest portal, not the sum). Within one portal the stages still run one after another,
// so a county never sees more than one bot at a time. Output lines are prefixed with the county.
const run = (script, args, tag) => new Promise((resolve) => {
  const p = spawn('node', [script, ...args], { cwd: ROOT });
  const pipe = (src, dst) => { let buf = ''; src.on('data', (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) dst.write(`[${tag}] ${l}\n`); }); src.on('end', () => { if (buf) dst.write(`[${tag}] ${buf}\n`); }); };
  pipe(p.stdout, process.stdout); pipe(p.stderr, process.stderr);
  p.on('close', (code) => resolve(code));
});
const byPortal = {};
for (const [key, numbers] of Object.entries(groups)) {
  const [portal, stage] = key.split('|');
  const [script, county] = COLLECTORS[portal] || [];
  const list = limit ? numbers.slice(0, limit) : numbers;
  if (!county) { console.log(`skip ${portal} (${stage}): no collector yet — ${numbers.length} permit(s)`); continue; }
  (byPortal[portal] ||= []).push({ script, county, stage, list });
}
const t0 = Date.now();
const results = await Promise.all(Object.entries(byPortal).map(async ([portal, jobs]) => {
  let failed = 0;
  for (const { script, county, stage, list } of jobs) {
    const t = Date.now();
    console.log(`== ${portal} · ${stage} · ${list.length} permit(s) — start`);
    const code = await run(script, ['--county', county, '--stage', stage, ...list], county);
    console.log(`== ${portal} · ${stage} — ${code === 0 ? 'done' : 'FAILED (exit ' + code + ')'} in ${Math.round((Date.now() - t) / 60000)} min`);
    if (code !== 0) failed++;
  }
  return failed;
}));
console.log(`all portals done in ${Math.round((Date.now() - t0) / 60000)} min`);
process.exit(results.some(Boolean) ? 1 : 0);
