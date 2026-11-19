#!/usr/bin/env node
// bills_probe.mjs — READ-ONLY: how Buildertrend Bills work, to design bill creation from invoice e-mails.
// Opens the Bills list of a job, prints the page text, the JSON calls it makes (sample answers), the bill /
// purchase-order API paths in the page's code (create, bulk upload, defaults), and the "new bill" defaults
// when the code exposes them. No click on New / Save / Upload; creates nothing.
//   BT_COOKIES_FILE=… node collectors/buildertrend/bills_probe.mjs <buildertrend job id>
import { openBuildertrend } from './session.mjs';

const jobId = Number(process.argv[2] || 43923068);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const api = [], scripts = new Set();
let hdr = null;
page.on('request', (r) => { if (!hdr && /buildertrend\.net\/api\//.test(r.url())) hdr = r.headers(); });
page.on('response', async (r) => {
  const u = r.url();
  if (/\.js(\?|$)/.test(u) && /buildertrend/i.test(u)) scripts.add(u);
  if (/buildertrend\.net\/apix?\//i.test(u) && /json/i.test(r.headers()['content-type'] || '') && !/datadog|sentry|menu\/|GlobalInfo|context\/init|Notifications|WhatsNew/i.test(u))
    api.push(`${r.request().method()} ${r.status()} ${u.slice(0, 200)}\n  req: ${(r.request().postData() || '').slice(0, 600)}\n  res: ${(await r.text().catch(() => '')).slice(0, 3000)}`);
});
const text = async () => (await page.innerText('body').catch(() => '')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
for (const url of [`https://buildertrend.net/app/Bills?jobId=${jobId}`, `https://buildertrend.net/app/PurchaseOrders?jobId=${jobId}`]) {
  api.length = 0;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((e) => console.log(`goto ${url}: ${e.message}`));
  await page.waitForTimeout(15000);
  const t = await text(); const i = t.search(/Bills|Purchase Orders/);
  console.log(`\n===== ${url} → ${page.url()} =====\n${t.slice(Math.max(0, i - 200), i + 3500)}`);
  console.log(`\n===== JSON calls =====\n${api.slice(0, 25).join('\n')}`);
}
// Bill / PO API paths and how the page calls them (create, bulk upload, defaults, line items, cost codes).
const paths = new Map(), ctx = new Map();
for (const u of scripts) {
  const js = await (await page.request.get(u)).text().catch(() => '');
  for (const m of js.matchAll(/["'`]((?:\/?apix?\/)[A-Za-z0-9_\-/{}$.?=&]*?(?:Bill|PurchaseOrder|Payable|LienWaiver|CostCode|BulkUpload|Ocr|Scan)[A-Za-z0-9_\-/{}$.?=&]*)["'`]/gi)) paths.set(m[1], u.split('/').pop());
  if (/BulkUpload|bulkUpload|bulk upload/i.test(js)) for (const m of js.matchAll(/.{0,250}[Bb]ulk[Uu]pload.{0,350}/g)) ctx.set(m[0].replace(/\s+/g, ' '), u.split('/').pop());
}
console.log('\n===== bill / PO API paths in the code =====');
for (const [p, f] of paths) console.log(`${p}   (${f})`);
console.log('\n===== code near bulk upload =====');
let n = 0; for (const [c, f] of ctx) { if (n++ > 25) break; console.log(`[${f}] ${c}\n`); }
// Defaults of a new bill for this job, if the code names such a call (GET only).
const headers = Object.fromEntries(Object.entries(hdr || {}).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
for (const p of [...paths.keys()].filter((p) => /Default|Info/i.test(p) && !/\$/.test(p)).slice(0, 4)) {
  const res = await page.request.get(`https://buildertrend.net${p.startsWith('/') ? '' : '/'}${p}${p.includes('?') ? '&' : '?'}jobId=${jobId}`, { headers }).catch(() => null);
  if (res) console.log(`\n===== GET ${p} (job ${jobId}): HTTP ${res.status()} =====\n${(await res.text()).slice(0, 6000)}`);
}
await browser.close();
