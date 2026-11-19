#!/usr/bin/env node
// bill_form_probe.mjs — READ-ONLY: what the "new Bill" form of a job asks for and how the page loads / saves it.
// Prints the bill routes and the create/save calls in the page's code, then opens a NEW bill form (route from
// the code) and logs the JSON calls the form makes (defaults: pay-to list, cost codes, fields). Never clicks
// Save; closing the browser discards the form.
//   BT_COOKIES_FILE=… node collectors/buildertrend/bill_form_probe.mjs <buildertrend job id> [existing bill id]
import { openBuildertrend } from './session.mjs';

const jobId = Number(process.argv[2] || 43923068), billId = process.argv[3] || '';
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const api = [], scripts = new Set();
page.on('response', async (r) => {
  const u = r.url();
  if (/\.js(\?|$)/.test(u) && /buildertrend/i.test(u)) scripts.add(u);
  if (/buildertrend\.net\/apix?\//i.test(u) && /json/i.test(r.headers()['content-type'] || '') && !/datadog|sentry|menu\/|GlobalInfo|context\/init|Notifications|WhatsNew|Filters\/|GridViews|jobpicker|jobsites\//i.test(u))
    api.push(`${r.request().method()} ${r.status()} ${u.slice(0, 220)}\n  req: ${(r.request().postData() || '').slice(0, 800)}\n  res: ${(await r.text().catch(() => '')).slice(0, 7000)}`);
});
await page.goto(`https://buildertrend.net/app/Bills?jobId=${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(12000);
// Routes and save calls of a bill, from the code.
const seen = new Map();
for (const u of scripts) {
  const js = await (await page.request.get(u)).text().catch(() => '');
  for (const re of [/.{0,200}bill:\{list:.{0,700}/g, /.{0,300}["'`]\/apix\/v3\/Bills["'`$].{0,400}/g, /.{0,300}["'`]\/apix\/v2\/Bills["'`$][^l].{0,400}/g, /.{0,250}\/api\/(?:Bills|PurchaseOrderPayments?|bills)\/?\$\{.{0,400}/g, /.{0,300}\/split["'`].{0,400}/g])
    for (const m of js.matchAll(re)) { const t = m[0].replace(/\s+/g, ' '); if (!seen.has(t)) seen.set(t, u.split('/').pop()); }
}
console.log('===== bill routes / create / save / split in the code =====');
let n = 0; for (const [c, f] of seen) { if (n++ > 40) break; console.log(`[${f}] ${c}\n`); }
// Open a NEW bill form (and an existing one, read-only) and log what loads.
for (const url of [`https://buildertrend.net/app/Bills/Bill/0/${jobId}`, `https://buildertrend.net/app/Bills/Bill/0/${jobId}/0`, billId ? `https://buildertrend.net/app/Bills/Bill/${billId}/${jobId}` : null].filter(Boolean)) {
  api.length = 0;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(12000);
  const t = (await page.innerText('body').catch(() => '')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
  console.log(`\n===== ${url} → ${page.url()} =====\n${t.slice(0, 3000)}\n----- JSON calls -----\n${api.slice(0, 15).join('\n')}`);
}
await browser.close();
