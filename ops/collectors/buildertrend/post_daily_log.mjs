#!/usr/bin/env node
// post_daily_log.mjs — post one Daily Log to a Buildertrend job (seeded bot session).
//
//   BT_COOKIES_FILE=… node collectors/buildertrend/post_daily_log.mjs \
//     --job 0001 --title "Framing inspection failed" --notes-file notes.txt \
//     [--private] [--notify "Cristiano Pedrosa,Guilherme Pinto"] [--dry-run]
//   BT_COOKIES_FILE=… node collectors/buildertrend/post_daily_log.mjs --list-notify
//
// --job takes the PKB job number (the Buildertrend job-name prefix, e.g. "0001").
// --dry-run resolves the job and validates the fields without opening the form.
// --list-notify opens the new-log form, prints the internal users Buildertrend
// pre-selects for notification (their display names), and leaves without saving.
// Prints one JSON line: {ok, logId, jobId, url, job, title} or {ok:false, error}.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBuildertrend } from './session.mjs';
import { createDailyLog, selectJob } from './daily_log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const out = (o) => { console.log(JSON.stringify(o)); process.exitCode = o.ok ? 0 : 1; };

function resolveJobName(job) {
  const f = join(HERE, '..', '..', 'data', 'buildertrend', 'jobs.json');
  if (!existsSync(f)) return null;
  const { jobs } = JSON.parse(readFileSync(f, 'utf8'));
  const hit = jobs.find((j) => j.name.startsWith(`${job} - `));
  return hit ? hit.name : null;
}

// The job picker shows a shortened name; match on its stable head ("0001 - OC - Sunn").
const pickerText = (name) => name.slice(0, 16);

if (flag('list-notify')) {
  const { browser, page, loggedIn } = await openBuildertrend();
  if (!loggedIn) { await browser.close(); out({ ok: false, error: 'Buildertrend session expired — re-export the bot cookies' }); process.exit(); }
  await selectJob(page, pickerText(resolveJobName('0001')));
  await page.goto('https://buildertrend.net/app/DailyLogs', { waitUntil: 'domcontentloaded' });
  const newBtn = page.getByRole('button', { name: /Create new Daily Log|^Daily Log$/ }).first();
  await newBtn.waitFor({ timeout: 90000 }); await newBtn.click();
  await page.locator('textarea[name="logTitle"], textarea#logTitle').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(2000);
  const names = await page.locator('input#usersToNotify').locator('xpath=ancestor::div[contains(@class,"ant-select-multiple")][1]').locator('.ant-select-selection-item').allInnerTexts();
  await browser.close(); // nothing saved
  out({ ok: true, notifyDefaults: names.map((s) => s.trim().split('\n').pop().trim()).filter(Boolean) });
  process.exit();
}

const job = (arg('job') || '').trim();
const title = (arg('title') || '').trim();
const notesFile = arg('notes-file');
const notes = notesFile ? readFileSync(notesFile, 'utf8') : (arg('notes') || '');
const notify = (arg('notify') || '').split(',').map((s) => s.trim()).filter(Boolean);
const privateLog = flag('private');

if (!/^[0-9A-Z]{4}$/.test(job)) { out({ ok: false, error: `bad job number "${job}"` }); process.exit(); }
if (!title || title.length > 50) { out({ ok: false, error: 'title is required and must be ≤ 50 characters' }); process.exit(); }
if (notes.length > 4000) { out({ ok: false, error: 'notes must be ≤ 4000 characters' }); process.exit(); }
const jobName = resolveJobName(job);
if (!jobName) { out({ ok: false, error: `job ${job} not found in Buildertrend jobs list (run list_jobs.mjs)` }); process.exit(); }
if (flag('dry-run')) { out({ ok: true, dryRun: true, job, jobName, title, notesChars: notes.length, notify, privateLog }); process.exit(); }

const { browser, page, loggedIn } = await openBuildertrend();
try {
  if (!loggedIn) throw new Error('Buildertrend session expired — re-export the bot cookies');
  const r = await createDailyLog(page, { jobName: pickerText(jobName), title, notes, privateLog, notify });
  out({ ok: true, job, jobName, title, ...r });
} catch (e) {
  out({ ok: false, job, title, error: e.message });
} finally {
  await browser.close();
}
