#!/usr/bin/env node
// =============================================================================
// daily_logs.mjs — every Buildertrend Daily Log of every job: who wrote it, when, title, text.
//   BT_COOKIES_FILE=... node collectors/buildertrend/daily_logs.mjs [--days 30 | --all] [--dry]
// Read-only. Opens one job's Daily Logs page, captures the list call the page itself makes
// (POST /apix/v2/DailyLogs/grid, with its headers), then replays it for all jobs at once,
// 100 rows a page, with the date filter set to the last N days (--days, default 30) or
// cleared (--all, the full history). Validated on 2026-10-06 against job 0022.
// Row fields used: dailyLogId, jobsiteId, addedBy, logDate (the log's own date and time,
// Florida), addedByDateUtc (when it was written), logTitle, logNotes, viewableBy,
// customFields ("Employees on Site"). Buildertrend's list does not say who was notified.
// Writes data/buildertrend/daily_logs.json (--dry prints a summary only).
// =============================================================================
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBuildertrend } from './session.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'buildertrend');
mkdirSync(OUT, { recursive: true });
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ALL = process.argv.includes('--all'), DRY = process.argv.includes('--dry');
const DAYS = Number(arg('--days') || 30);
const jobs = JSON.parse(readFileSync(join(OUT, 'jobs.json'), 'utf8')).jobs.filter((j) => j.id);
if (!jobs.length) { console.error('no jobs in jobs.json — run list_jobs.mjs first'); process.exit(1); }

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired — re-export the bot cookies'); process.exit(1); }

// 1. Let the page make its own list call once, and keep the request (url, headers, body).
let seen = null;
page.on('request', (r) => { if (!seen && r.method() === 'POST' && /\/apix\/v2\/DailyLogs\/grid/i.test(r.url())) seen = { url: r.url(), headers: r.headers(), body: r.postData() }; });
await page.goto(`https://buildertrend.net/app/DailyLogs?jobId=${jobs[0].id}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 180 && !seen; i++) await page.waitForTimeout(500);
if (!seen) { console.error('Daily Logs list call not seen'); await browser.close(); process.exit(1); }
const base = JSON.parse(seen.body);
const headers = Object.fromEntries(Object.entries(seen.headers).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));

// 2. Replay it for every job. Filter "8" is the date range; '' means any date.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const filters = { ...base.filters, 8: ALL ? '' : JSON.stringify({ SelectedValue: -DAYS, StartDate: null, EndDate: null }) };
async function grid(jobIds, pageNumber) {
  const body = { ...base, jobIds, filters, gridRequest: { ...(base.gridRequest || {}), hideMultiJobsColumns: false },
    pagingData: { ...(base.pagingData || {}), pageNumber, currentPage: pageNumber, pageSize: 100, firstRow: (pageNumber - 1) * 100 + 1, lastRow: pageNumber * 100 } };
  for (let attempt = 0; ; attempt++) {
    await sleep(600);
    const r = await page.request.post(seen.url, { headers, data: JSON.stringify(body) });
    if (r.status() === 429 && attempt < 5) { await sleep(Math.min(Number(r.headers()['retry-after']) || 5 * 2 ** attempt, 30) * 1000); continue; }
    if (!r.ok()) throw new Error(`${r.status()} DailyLogs/grid page ${pageNumber}`);
    const b = await r.json();
    if (b.needsToRelogin) throw new Error('session expired');
    return b;
  }
}
const name = new Map(jobs.map((j) => [Number(j.id), j.name]));
const logs = new Map();
// Jobs in batches of 25 keep each call small; pages until Buildertrend says there are no more rows.
for (let i = 0; i < jobs.length; i += 25) {
  const ids = jobs.slice(i, i + 25).map((j) => Number(j.id));
  for (let p = 1; p <= 200; p++) {
    const b = await grid(ids, p);
    const rows = Array.isArray(b.data) ? b.data : Object.values(b.data || {});
    for (const x of rows) {
      const cf = Object.fromEntries((x.customFields || []).map((c) => [c.label, c.value]));
      logs.set(x.dailyLogId, {
        bt_log_id: x.dailyLogId, bt_job_id: x.jobsiteId, job: name.get(Number(x.jobsiteId)) || x.jobsiteName || null,
        log_at: x.logDate || null, written_utc: x.addedByDateUtc || x.dailyLogUserInfo?.addedByUserDate || null,
        author: x.addedBy || x.dailyLogUserInfo?.addedByUserName || null, published_by: x.dailyLogUserInfo?.publishedByUserName || null,
        title: x.logTitle || null, notes: x.logNotes || null, viewable_by: x.viewableBy || null,
        employees_on_site: cf['Employees on Site'] ?? null, photos: (x.images || []).length, updated_utc: x.updatedByDateUtc || null,
      });
    }
    if (!rows.length || !b.hasMoreRows || (b.totalPages && p >= b.totalPages)) break;
  }
  console.log(`… jobs ${Math.min(i + 25, jobs.length)}/${jobs.length} · ${logs.size} logs`);
}
await browser.close();
const out = [...logs.values()];
const by = out.reduce((m, l) => ((m[l.author || '?'] = (m[l.author || '?'] || 0) + 1), m), {});
console.log(`daily logs: ${out.length} (${ALL ? 'all dates' : `last ${DAYS} days`}) · ${new Set(out.map((l) => l.bt_job_id)).size} jobs · by author: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (!DRY) writeFileSync(join(OUT, 'daily_logs.json'), JSON.stringify({ collectedAt: new Date().toISOString(), all: ALL, days: ALL ? null : DAYS, logs: out }, null, 1));
