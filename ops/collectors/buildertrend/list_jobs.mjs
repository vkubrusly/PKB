#!/usr/bin/env node
// list_jobs.mjs — with a seeded session, list the Jobs the bot user can see.
//   BT_COOKIES_FILE=/path/to/bt_cookies.json node collectors/buildertrend/list_jobs.mjs
// Writes data/buildertrend/jobs.json ({ name, id? }) and prints a summary.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBuildertrend } from './session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'data', 'buildertrend');
mkdirSync(OUT, { recursive: true });

const { browser, page, loggedIn } = await openBuildertrend();
console.log('url:', page.url(), '| loggedIn:', loggedIn);
if (!loggedIn) { await browser.close(); process.exit(1); }
await page.screenshot({ path: join(OUT, 'probe', 'landing.png') }).catch(() => {});

// The job picker loads all jobs as JSON; capture it instead of scraping the sidebar.
let picker = null, pickerReq = null;
page.on('response', async (r) => { if (/jobpicker\/GetJobPickerData/i.test(r.url())) { try { picker = await r.json(); pickerReq ??= { url: r.url(), headers: r.request().headers(), body: r.request().postData() }; } catch {} } });
// Buildertrend keeps polling, so 'networkidle' never settles on CI runners: wait for the JSON itself.
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
for (let i = 0; i < 120 && !picker; i++) await page.waitForTimeout(500);
if (!picker) { console.error('job picker JSON not seen'); await browser.close(); process.exit(1); }
// The page's own list holds the Open / Warranty jobs. Matching houses to jobs also needs Presale and Closed
// ones (e.g. 0095 Rosevear, 0063 130th Ln Rd were Presale, 11/11): ask the same call for every status.
let every = null;
try {
  const body = JSON.parse(pickerReq.body), f = JSON.parse(body.filters || '{}'); f['3'] = '';
  const headers = Object.fromEntries(Object.entries(pickerReq.headers).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
  const res = await page.request.post(pickerReq.url, { headers, data: JSON.stringify({ ...body, filters: JSON.stringify(f) }) });
  every = (await res.json())?.data?.jobs || null;
} catch (e) { console.error('all-status job list not read:', e.message); }
writeFileSync(join(OUT, 'jobpicker_raw.json'), JSON.stringify(every?.length ? { data: { jobs: every } } : picker, null, 2));
// Job names: "0001 - OC - …", and Prime jobs without a number ("PRIME - CT - Florida - 9370 N Jourden Dr").
const JOBNAME = /^(\d{4}|PRIME) - /i;
// Find the array of jobs wherever it sits in the payload.
const findJobs = (o) => { if (Array.isArray(o) && o.length && o.some(x => x && typeof x === 'object' && Object.values(x).some(v => typeof v === 'string' && JOBNAME.test(v)))) return o; if (o && typeof o === 'object') for (const v of Object.values(o)) { const f = findJobs(v); if (f) return f; } return null; };
const arr = findJobs(picker) || [];
const jobs = arr.map(j => { const name = Object.values(j).find(v => typeof v === 'string' && JOBNAME.test(v)); const id = j.jobId ?? j.JobId ?? j.id ?? j.Id ?? j.value ?? null; return { id, name, raw: j }; }).filter(j => j.name);
writeFileSync(join(OUT, 'jobs.json'), JSON.stringify({ collectedAt: new Date().toISOString(), count: jobs.length, jobs: jobs.map(({ id, name }) => ({ id, name })) }, null, 2));
console.log(`jobs: ${jobs.length}`);
if (jobs[0]) console.log('sample raw keys:', Object.keys(jobs[0].raw).join(', '));
console.log(jobs.map(j => `${j.id}\t${j.name}`).join('\n'));
await browser.close();
