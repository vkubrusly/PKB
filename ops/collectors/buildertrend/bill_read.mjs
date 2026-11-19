#!/usr/bin/env node
// bill_read.mjs — READ-ONLY: open a bill (/app/Bills/Bill/<billId>/<jobId>) and print its form text
// (title, bill #, pay to, dates, cost lines, total, status, attachments). Changes nothing.
//   node collectors/buildertrend/bill_read.mjs <billId> <jobId>
import { openBuildertrend } from './session.mjs';
const [billId, jobId] = process.argv.slice(2);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
await page.goto(`https://buildertrend.net/app/Bills/Bill/${billId}/${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.locator('#billTitle').first().waitFor({ timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);
const t = (await page.locator('.ant-modal-content, [role="dialog"]').last().innerText().catch(() => '')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
const v = await page.evaluate(() => Object.fromEntries(['billTitle', 'billNumber', 'invoiceDate', 'unifiedDeadlineRequest'].map((id) => [id, document.getElementById(id)?.value])));
console.log(JSON.stringify(v), '\n', t.slice(0, 2500));
await browser.close();
