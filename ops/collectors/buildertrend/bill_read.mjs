#!/usr/bin/env node
// bill_read.mjs — READ-ONLY: open a bill (/app/Bills/Bill/<billId>/<jobId>) and print its form text
// (title, bill #, pay to, dates, cost lines, total, status, attachments). Changes nothing.
//   node collectors/buildertrend/bill_read.mjs <billId> <jobId>
import { openBuildertrend } from './session.mjs';
const pairs = process.argv.slice(2);   // billId jobId [billId jobId …]
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
for (let k = 0; k < pairs.length; k += 2) {
const [billId, jobId] = [pairs[k], pairs[k + 1]];
const calls = [];
const h = async (r) => { if (/buildertrend\.net\/apix?\//.test(r.url()) && /bill/i.test(r.url()) && /json/.test(r.headers()['content-type'] || '')) calls.push(`${r.status()} ${r.url().slice(0, 160)} → ${(await r.text().catch(() => '')).slice(0, 400)}`); };
page.on('response', h);
await page.goto(`https://buildertrend.net/app/Bills/Bill/${billId}/${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.locator('#billTitle').first().waitFor({ timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);
const t = (await page.locator('.ant-modal-content, [role="dialog"]').last().innerText().catch(() => '')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
const v = await page.evaluate(() => Object.fromEntries(['billTitle', 'billNumber', 'invoiceDate', 'unifiedDeadlineRequest'].map((id) => [id, document.getElementById(id)?.value])));
page.off('response', h);
console.log(`===== bill ${billId} / job ${jobId} → ${page.url()}\n${JSON.stringify(v)}\n${t.slice(0, 1200)}\n--- bill calls ---\n${calls.slice(0, 6).join('\n')}`);
}
await browser.close();
