#!/usr/bin/env node
// jobs_find.mjs — READ-ONLY: every Buildertrend job the bot can see, in every status (Presale, Open,
// Warranty, Closed), from the job picker the page itself calls. Prints the jobs whose name does not start
// with a 4-digit number and those matching the given words (addresses).
//   BT_COOKIES_FILE=… node collectors/buildertrend/jobs_find.mjs "Jourden" "Dandee" …
import { openBuildertrend } from './session.mjs';

const words = process.argv.slice(2).map((w) => w.toLowerCase());
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
let req = null;
page.on('request', (r) => { if (!req && /jobpicker\/GetJobPickerData/i.test(r.url())) req = { url: r.url(), headers: r.headers(), body: r.postData() }; });
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
for (let i = 0; i < 120 && !req; i++) await page.waitForTimeout(500);
if (!req) { console.error('job picker call not seen'); await browser.close(); process.exit(1); }
const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
const body = JSON.parse(req.body);
const run = async (status) => {
  const f = JSON.parse(body.filters || '{}'); f['3'] = status;
  const res = await page.request.post(req.url, { headers, data: JSON.stringify({ ...body, filters: JSON.stringify(f) }) });
  return (await res.json().catch(() => null))?.data?.jobs || [];
};
const all = new Map();
for (const [label, st] of [['default', JSON.parse(body.filters || '{}')['3'] || ''], ['all statuses', ''], ['presale', '5'], ['open', '1'], ['warranty', '7'], ['closed', '2']]) {
  const jobs = await run(st);
  console.log(`${label}: ${jobs.length} jobs`);
  for (const j of jobs) if (j.jobId) all.set(j.jobId, j);
}
const show = (j) => `${j.jobId} · builder ${j.builderId} · ${j.jobName} · ${[j.street, j.city].filter(Boolean).join(', ')} · status ${j.status} · closed ${j.isClosed}`;
console.log(`\n===== ${all.size} distinct jobs; names NOT starting with a 4-digit number =====`);
for (const j of all.values()) if (!/^\d{4} - /.test(j.jobName || '')) console.log(show(j));
console.log('\n===== matching the words =====');
for (const j of all.values()) { const t = `${j.jobName} ${j.street}`.toLowerCase(); if (words.some((w) => t.includes(w))) console.log(show(j)); }
await browser.close();
