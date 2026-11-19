#!/usr/bin/env node
// bills_list.mjs — READ-ONLY: list a job's bills of every status (replays the Bills page grid request with the
// status filter cleared) and print the ones whose number/title matches a text. Nothing is changed.
//   BT_COOKIES_FILE=… node collectors/buildertrend/bills_list.mjs <jobId> [match text]
import { openBuildertrend } from './session.mjs';

const [jobId, match = ''] = process.argv.slice(2);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
let req = null;
page.on('request', (r) => { if (!req && /\/api\/v1\/bills\/grid/i.test(r.url())) req = { url: r.url(), headers: r.headers(), body: r.postData() }; });
await page.goto(`https://buildertrend.net/app/Bills?jobId=${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 90 && !req; i++) await page.waitForTimeout(500);
if (!req) { console.log('grid request not seen'); await browser.close(); process.exit(1); }
const body = JSON.parse(req.body); const f = JSON.parse(body.filters); f['0'] = ''; body.filters = JSON.stringify(f);
body.pagingData = { ...body.pagingData, pageSize: 200, lastRow: 200, totalRowsAllPages: 200 };
const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
const res = await page.request.post(req.url, { headers, data: JSON.stringify(body) });
const rows = (await res.json())?.data?.data || [];
const out = rows.filter((r) => !match || JSON.stringify([r.billNumberLink?.title, r.billTitleLink?.title]).toLowerCase().includes(match.toLowerCase()))
  .map((r) => ({ id: r.id, number: r.billNumberLink?.title, title: r.billTitleLink?.title, payTo: r.payTo?.name || r.payTo, amount: r.paymentAmount?.value, paid: r.amountPaid?.value ?? r.amountPaid, datePaid: r.datePaid, invoiced: r.invoicedDate, costCodes: r.costCodes, accounting: r.purchaseOrderPaymentAccountingStatus, source: r.billSource, created: r.createdDate }));
console.log(`bills of every status: ${rows.length} · matching "${match}": ${out.length}`);
console.log('ROWS B64:' + Buffer.from(JSON.stringify(out, null, 1)).toString('base64'));
await browser.close();
