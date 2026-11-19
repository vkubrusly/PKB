#!/usr/bin/env node
// bill_api_code.mjs — READ-ONLY: from the code the Bills pages load, how a bill is copied to other jobs
// (CopyBills), saved / updated (line items, amounts, cost codes, pay-to) and how files are attached. Also
// opens one existing bill and logs every call the detail makes. No POST/PUT is sent.
//   BT_COOKIES_FILE=… node collectors/buildertrend/bill_api_code.mjs <jobId> <billId>
import { openBuildertrend } from './session.mjs';

const [jobId, billId] = process.argv.slice(2);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const scripts = new Set(), calls = [];
page.on('response', async (r) => {
  const u = r.url();
  if (/\.js(\?|$)/.test(u) && /buildertrend/i.test(u)) scripts.add(u);
  if (/buildertrend\.net\/apix?\//i.test(u) && !/datadog|sentry|menu\/|GlobalInfo|context\/init|Notifications|WhatsNew|Filters\/|GridViews|jobpicker|jobsites\//i.test(u))
    calls.push(`${r.request().method()} ${r.status()} ${u.slice(0, 200)}\n  res: ${(await r.text().catch(() => '')).slice(0, 6000)}`);
});
await page.goto(`https://buildertrend.net/app/Bills?jobId=${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(10000);
calls.length = 0;
// Open the bill by clicking its title in the list (the detail opens as a side panel).
const link = page.locator(`a[href*="${billId}"], [data-id="${billId}"]`).first();
if (await link.count()) { await link.click().catch(() => {}); } else { await page.getByText(/RC Site Services - Invoice/).first().click().catch(() => {}); }
await page.waitForTimeout(15000);
console.log(`===== opening bill ${billId}: ${page.url()} =====\n${calls.join('\n')}`);
const t = (await page.innerText('body').catch(() => '')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
const i = t.indexOf('Pay to'); console.log(`\n----- panel text -----\n${t.slice(Math.max(0, i - 1500), i + 2500)}`);
const seen = new Map();
for (const u of scripts) {
  const js = await (await page.request.get(u)).text().catch(() => '');
  for (const re of [/.{0,400}CopyBills.{0,500}/g, /.{0,300}\/api\/PurchaseOrderPayments?[^"'`]{0,60}["'`].{0,300}/g, /.{0,300}\/apix\/v[23]\/Bills\/\$\{[^}]*\}["'`],.{0,200}method:"(?:PUT|PATCH|POST)".{0,200}/g, /.{0,250}\/apix\/v[23]\/Bills["'`],.{0,300}/g])
    for (const m of js.matchAll(re)) { const s = m[0].replace(/\s+/g, ' '); if (!seen.has(s)) seen.set(s, u.split('/').pop()); }
}
console.log('\n===== copy / save / update in the code =====');
let n = 0; for (const [c, f] of seen) { if (n++ > 30) break; console.log(`[${f}] ${c}\n`); }
await browser.close();
