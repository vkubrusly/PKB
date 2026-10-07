#!/usr/bin/env node
// probe.mjs — Buildertrend diagnostics for the ops-probe workflow (read-only): lists the jobs,
// then runs the Daily Logs collector without writing anything and prints its summary.
//   BT_COOKIES_FILE=... node collectors/buildertrend/probe.mjs [days | all]
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 'jobpage:<jobId>' → the job details form (jobpage_probe.mjs).
// 'setpermit:<btJobId>=<permit>[:dry]' → fill one job's Permit number (job_permit.mjs).
if (/^setpermit:/.test(process.argv[2] || '')) { const [, pair, dry] = process.argv[2].split(':'); execFileSync('node', [join(HERE, 'job_permit.mjs'), '--set', pair, ...(dry ? ['--dry'] : [])], { stdio: 'inherit' }); process.exit(0); }
if (/^jobpage:/.test(process.argv[2] || '')) { execFileSync('node', [join(HERE, 'jobpage_probe.mjs'), process.argv[2].split(':')[1]], { stdio: 'inherit' }); process.exit(0); }
const span = process.argv[2] === 'all' ? ['--all'] : ['--days', process.argv[2] || '30'];
execFileSync('node', [join(HERE, 'list_jobs.mjs')], { stdio: ['ignore', 'ignore', 'inherit'] });
execFileSync('node', [join(HERE, 'daily_logs.mjs'), ...span, '--dry'], { stdio: 'inherit' });
