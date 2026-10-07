#!/usr/bin/env node
// =============================================================================
// job_permit.mjs — fill Buildertrend's "Permit number" (Job info) for jobs whose building permit
// is known to PKB Ops (spreadsheet, or found on the county portal by scripts/discover_permits.mjs)
// but still empty in Buildertrend. Never overwrites a number someone typed. Victor, 2026-10-07.
//   BT_COOKIES_FILE=... node collectors/buildertrend/job_permit.mjs [--dry]          # from the database
//   BT_COOKIES_FILE=... node collectors/buildertrend/job_permit.mjs --set <btJobId>=<permit> [--dry]
// --dry types the number and leaves without saving.
// =============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBuildertrend } from './session.mjs';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'buildertrend');
const DRY = process.argv.includes('--dry');
const setArg = process.argv[process.argv.indexOf('--set') + 1];

let todo = [];
if (process.argv.includes('--set') && setArg) {
  const [jobId, permit] = setArg.split('=');
  todo = [{ jobId: Number(jobId), permit, job: String(jobId) }];
} else {
  const { sql } = await import('../../scripts/sb.mjs');
  // Buildertrend's current value comes from this round's Jobs List read (job_fields.json).
  const btPermit = {};
  const f = join(DATA, 'job_fields.json');
  if (!existsSync(f)) { console.log('job_fields.json missing — Buildertrend jobs not read this round'); process.exit(0); }
  for (const j of JSON.parse(readFileSync(f, 'utf8')).jobs || []) btPermit[j.jobId] = j.permit;
  const rows = await sql(`select distinct on (j.id) j.job_number, j.bt_job_id, c.number from ops.jobs j
    join ops.permit_cases c on c.job_id = j.id and c.kind = 'building' and c.number is not null
    where j.bt_job_id is not null and j.co_at is null and j.status not in ('completed', 'cancelled')
    order by j.id, c.created_at desc`);
  todo = rows.filter((r) => r.bt_job_id in btPermit && !String(btPermit[r.bt_job_id] || '').trim())
    .map((r) => ({ jobId: r.bt_job_id, permit: r.number, job: r.job_number }));
}
console.log(`jobs to fill: ${todo.length}`);
if (!todo.length) process.exit(0);

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired — re-export the bot cookies'); process.exit(1); }
let done = 0;
for (const t of todo) {
  try {
    await page.goto(`https://buildertrend.net/app/JobPage/${t.jobId}/1`, { waitUntil: 'domcontentloaded' });
    const box = page.locator('[id="jobInfo.permitNumber"]').first();
    await box.waitFor({ timeout: 45000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => document.getElementById('chmln-dom')?.remove()).catch(() => {});
    const current = (await box.inputValue()).trim();
    if (current) { console.log(`::notice::${t.job}: Buildertrend already has "${current}" — left as is`); continue; }
    await box.fill(t.permit);
    if (DRY) { console.log(`::notice::${t.job}: would save ${t.permit} (dry)`); continue; }
    await page.locator('button', { hasText: /^\s*Save\s*$/ }).first().click();
    await page.waitForTimeout(5000);
    const err = await page.locator('.ant-form-item-explain-error, .ant-message-error').allInnerTexts().catch(() => []);
    if (err.length) throw new Error(err.join('; '));
    // Read it back from a fresh load.
    await page.goto(`https://buildertrend.net/app/JobPage/${t.jobId}/1`, { waitUntil: 'domcontentloaded' });
    await page.locator('[id="jobInfo.permitNumber"]').first().waitFor({ timeout: 45000 });
    await page.waitForTimeout(2000);
    const saved = (await page.locator('[id="jobInfo.permitNumber"]').first().inputValue()).trim();
    if (saved !== t.permit) throw new Error(`after saving, Buildertrend shows "${saved}"`);
    done++;
    console.log(`::notice::${t.job}: Permit number ${t.permit} saved in Buildertrend`);
  } catch (e) { console.log(`::warning::${t.job}: could not fill the permit number (${e.message.slice(0, 160)})`); }
}
await browser.close();
console.log(`filled: ${done}/${todo.length}`);
