#!/usr/bin/env node
// =============================================================================
// collector_run.mjs — one row in ops.collector_runs per collector run: which connector,
// when it started and finished, how many items it was given, and the errors (exit code +
// the last lines it printed to stderr). Answers "did the Marion collector run, and did it
// fail?" without opening GitHub Actions.
//
// As a wrapper (any command, Node or Python):
//   node scripts/collector_run.mjs <connector> -- <command> [args...]
// exits with the command's exit code. As a module: startRun(connector, items) → id,
// finishRun(id, { items, errors }).
// Logging never blocks a collector: a database error is printed and the command still runs.
// =============================================================================
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sql } from './sb.mjs';

const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (Number.isFinite(v) ? String(Math.trunc(v)) : 'null');

export async function startRun(connector, items = null) {
  try {
    const r = await sql(`insert into ops.collector_runs (org_id, connector, items)
      values ((select id from public.orgs where name = ${q(process.env.OPS_ORG_NAME || 'PKB Homes')} limit 1), ${q(connector)}, ${num(items)}) returning id`);
    return r[0]?.id ?? null;
  } catch (e) {
    console.error(`collector_runs: could not record the start of ${connector}: ${e.message.split('\n')[0]}`);
    return null;
  }
}

export async function finishRun(id, { items = null, errors = [] } = {}) {
  if (id == null) return;
  try {
    await sql(`update ops.collector_runs set finished_at = now(), items = coalesce(${num(items)}, items),
      errors = ${q(JSON.stringify(errors))}::jsonb where id = ${num(id)}`);
  } catch (e) {
    console.error(`collector_runs: could not record the end of run ${id}: ${e.message.split('\n')[0]}`);
  }
}

// Keeps the last lines a process printed to stderr (for the errors column), passing them through.
export function stderrTail(stream, out = process.stderr, keep = 15) {
  const lines = [];
  let buf = '';
  stream.on('data', (d) => {
    out.write(d);
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const l of parts) if (l.trim()) { lines.push(l.slice(0, 300)); if (lines.length > keep) lines.shift(); }
  });
  return () => (buf.trim() ? [...lines, buf.slice(0, 300)].slice(-keep) : lines);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sep = process.argv.indexOf('--');
  const connector = process.argv[2];
  const cmd = sep > 0 ? process.argv.slice(sep + 1) : [];
  if (!connector || connector === '--' || !cmd.length) {
    console.error('usage: node scripts/collector_run.mjs <connector> -- <command> [args...]');
    process.exit(2);
  }
  const id = await startRun(connector);
  const p = spawn(cmd[0], cmd.slice(1), { stdio: ['inherit', 'inherit', 'pipe'] });
  const tail = stderrTail(p.stderr);
  const code = await new Promise((resolve) => {
    p.on('error', (e) => { console.error(`${cmd[0]}: ${e.message}`); resolve(127); });
    p.on('close', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
  });
  await finishRun(id, { errors: code === 0 ? [] : [{ exit: code, stderr: tail() }] });
  process.exit(code);
}
