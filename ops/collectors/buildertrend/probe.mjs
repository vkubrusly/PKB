#!/usr/bin/env node
// probe.mjs — Buildertrend diagnostics for the ops-probe workflow (read-only): lists the jobs,
// then runs the Daily Logs collector without writing anything and prints its summary.
//   BT_COOKIES_FILE=... node collectors/buildertrend/probe.mjs [days | all]
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const span = process.argv[2] === 'all' ? ['--all'] : ['--days', process.argv[2] || '30'];
execFileSync('node', [join(HERE, 'list_jobs.mjs')], { stdio: ['ignore', 'ignore', 'inherit'] });
execFileSync('node', [join(HERE, 'daily_logs.mjs'), ...span, '--dry'], { stdio: 'inherit' });
