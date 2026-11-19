#!/usr/bin/env node
// page_calls_probe.mjs — READ-ONLY: open one or more Buildertrend app pages and print the JSON API calls each page
// makes (method, url, request, response), base64-encoded so the Actions log does not mask them. Never clicks.
//   BT_COOKIES_FILE=… node collectors/buildertrend/page_calls_probe.mjs "/app/OwnerInvoices?jobId=…" ["/app/…"]
import { openBuildertrend } from './session.mjs';

const paths = process.argv.slice(2);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
let calls = [];
page.on('response', async (r) => { const u = r.url();
  if (!/buildertrend\.net\/apix?\//i.test(u) || !/json/.test(r.headers()['content-type'] || '') || /datadog|sentry|menu\/|GlobalInfo|context\/init|Notifications|WhatsNew|GridViews|jobpicker|jobsites\/|tab-counts|Filters\//i.test(u)) return;
  calls.push(`${r.request().method()} ${r.status()} ${u}\n  req: ${(r.request().postData() || '').slice(0, 1500)}\n  res: ${(await r.text().catch(() => '')).slice(0, 60000)}`); });
for (const p of paths) {
  calls = [];
  await page.goto(`https://buildertrend.net${p}`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((e) => console.log('goto', e.message));
  await page.waitForTimeout(15000);
  const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 5000));
  console.log(`===== ${p} · ${calls.length} calls · url now ${page.url()}`);
  console.log('B64:' + Buffer.from(`PAGE TEXT:\n${text}\n\nCALLS:\n${calls.join('\n\n')}`).toString('base64'));
}
await browser.close();
