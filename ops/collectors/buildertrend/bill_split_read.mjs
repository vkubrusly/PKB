#!/usr/bin/env node
// bill_split_read.mjs — READ-ONLY: GET the split of existing bills (GET /apix/v2/Bills/{id}/split, what the
// "Split" screen loads: lines, jobs, cost codes, amounts) and the bill's own split suggestion. No POST/PUT.
//   BT_COOKIES_FILE=… node collectors/buildertrend/bill_split_read.mjs <billId> [<billId>…]
import { openBuildertrend } from './session.mjs';

const ids = process.argv.slice(2);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
let hdr = null;
page.on('request', (r) => { if (!hdr && /buildertrend\.net\/apix\//.test(r.url())) hdr = r.headers(); });
await page.goto('https://buildertrend.net/app/Bills', { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 60 && !hdr; i++) await page.waitForTimeout(500);
const headers = Object.fromEntries(Object.entries(hdr || {}).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
for (const id of ids) {
  for (const url of [`/apix/v2/Bills/${id}/split`, `/apix/v2/Bills/split-suggestion?billId=${id}`]) {
    const res = await page.request.get(`https://buildertrend.net${url}`, { headers }).catch((e) => ({ status: () => 0, text: async () => e.message }));
    console.log(`\n===== GET ${url}: HTTP ${res.status()} =====\n${(await res.text()).slice(0, 15000)}`);
  }
}
await browser.close();
