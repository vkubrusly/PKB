#!/usr/bin/env node
// bills_index.mjs — READ-ONLY: every bill of the builder (all jobs, all statuses) from the Bills grid API the
// page itself calls (/api/v1/bills/grid), replayed page by page. Export billsIndex(page) → [{id, jobId, number,
// title, payTo, amount, invoiceDate}]; run directly to print the request shape and the bills matching words.
//   node collectors/buildertrend/bills_index.mjs [word …]
import { openBuildertrend } from './session.mjs';

export async function billsIndex(page, { log = () => {} } = {}) {
  let req = null;
  const h = (r) => { if (!req && /\/api\/v1\/bills\/grid/i.test(r.url()) && r.method() !== 'GET') req = { url: r.url(), headers: r.headers(), body: r.postData(), method: r.method() }; };
  page.on('request', h);
  await page.goto('https://buildertrend.net/app/Bills', { waitUntil: 'domcontentloaded', timeout: 120000 });
  for (let i = 0; i < 120 && !req; i++) await page.waitForTimeout(500);
  page.off('request', h);
  if (!req) throw new Error('bills grid call not seen');
  log(`grid call: ${req.method} ${req.url}\nbody: ${String(req.body).slice(0, 1500)}`);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
  const base = JSON.parse(req.body || '{}');
  const out = [];
  for (let p = 1; p <= 200; p++) {
    const body = { ...base };
    // Page and page size live in the body (names seen in the answer: page, pageSize); status tabs in filters.
    if ('page' in body) body.page = p; else if ('pageNumber' in body) body.pageNumber = p; else if ('currentPage' in body) body.currentPage = p;
    if ('pageSize' in body) body.pageSize = 500;
    const res = await page.request.fetch(req.url, { method: req.method, headers, data: JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    const d = j?.data || {};
    const rows = d.data || [];
    for (const r of rows) out.push({ id: r.id, jobId: r.jobId, number: r.billNumberLink?.title || '', title: r.billTitleLink?.title || '', payTo: r.payTo?.payTo || '', amount: r.paymentAmount?.value ?? null, invoiceDate: String(r.invoicedDate || '').slice(0, 10) });
    log(`page ${p}: ${rows.length} rows (records ${d.records}, totalPages ${d.totalPages}, hasMoreRows ${d.hasMoreRows})`);
    if (!rows.length || (d.totalPages && p >= d.totalPages) || d.hasMoreRows === false) break;
  }
  return out;
}

if (process.argv[1]?.endsWith('bills_index.mjs')) {
  const words = process.argv.slice(2).map((w) => w.toLowerCase());
  const { browser, page, loggedIn } = await openBuildertrend();
  if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
  const all = await billsIndex(page, { log: console.log });
  console.log(`bills: ${all.length} · distinct ids ${new Set(all.map((b) => b.id)).size}`);
  for (const b of all.filter((b) => words.some((w) => `${b.number} ${b.title} ${b.payTo}`.toLowerCase().includes(w)))) console.log(JSON.stringify(b));
  await browser.close();
}
