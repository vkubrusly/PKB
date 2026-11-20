#!/usr/bin/env node
// bills_index.mjs — READ-ONLY: every bill of the builder (all jobs, all statuses) from the Bills grid API the
// page itself calls (/api/v1/bills/grid), replayed page by page. Export billsIndex(page) → [{id, jobId, number,
// title, payTo, amount, invoiceDate}]; run directly to print the request shape and the bills matching words.
//   node collectors/buildertrend/bills_index.mjs [word …]
import { openBuildertrend } from './session.mjs';

// statuses: values of grid filter "0" (status tab). "" = every bill (2,744 on 11/20/26); 0 draft? 1 ready, 2 paid, 3 other, 9 the default tab — see --discover.
export async function billsIndex(page, { log = () => {}, statuses = (process.env.BT_BILL_STATUSES ?? '').split(','), discover = false } = {}) {
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
  const call = async (status, pageNumber, pageSize) => {
    const body = JSON.parse(JSON.stringify(base));
    const f = JSON.parse(body.filters || '{}'); f['0'] = status; body.filters = JSON.stringify(f);
    body.pagingData = { ...(body.pagingData || {}), pageNumber: String(pageNumber), currentPage: pageNumber, pageSize, firstRow: (pageNumber - 1) * pageSize + 1, lastRow: pageNumber * pageSize, totalRowsAllPages: pageSize };
    const res = await page.request.fetch(req.url, { method: req.method, headers, data: JSON.stringify(body) });
    return (await res.json().catch(() => null))?.data || {};
  };
  if (discover) {
    for (const st of ['', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '-1']) {
      const d = await call(st, 1, 5).catch(() => ({}));
      log(`status filter "${st}": records ${d.records} · rows ${(d.data || []).length}`);
    }
  }
  const out = [], seen = new Set();
  for (const st of statuses) {
    for (let p = 1; p <= 400; p++) {
      const d = await call(st, p, 100);
      const rows = d.data || [];
      for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); out.push({ id: r.id, jobId: r.jobId, number: r.billNumberLink?.title || '', title: r.billTitleLink?.title || '', payTo: r.payTo?.payTo || '', amount: r.paymentAmount?.value ?? null, invoiceDate: String(r.invoicedDate || '').slice(0, 10), status: st }); }
      if (p === 1) log(`status "${st}": records ${d.records}, totalPages ${d.totalPages}`);
      if (!rows.length || (d.totalPages && p >= d.totalPages)) break;
    }
  }
  return out;
}

if (process.argv[1]?.endsWith('bills_index.mjs')) {
  const words = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((w) => w.toLowerCase());
  const { browser, page, loggedIn } = await openBuildertrend();
  if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
  const all = await billsIndex(page, { log: console.log, discover: process.argv.includes('--discover'), statuses: (process.argv.find((a) => a.startsWith('--statuses='))?.slice(11) ?? process.env.BT_BILL_STATUSES ?? '').split(',') });
  console.log(`bills: ${all.length} · distinct ids ${new Set(all.map((b) => b.id)).size}`);
  for (const b of all.filter((b) => words.some((w) => `${b.number} ${b.title} ${b.payTo}`.toLowerCase().includes(w)))) console.log(JSON.stringify(b));
  await browser.close();
}
