#!/usr/bin/env node
// bills_list.mjs — READ-ONLY: the bills of a job as Buildertrend's Bills list loads them (grid JSON), filtered by
// a text (e.g. an invoice number). Prints id, bill #, title, amount, status. Changes nothing.
//   node collectors/buildertrend/bills_list.mjs <text> <jobId> [jobId…]
import { openBuildertrend } from './session.mjs';
const [text, ...jobIds] = process.argv.slice(2);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
for (const jobId of jobIds) {
  const grids = [];
  const h = async (r) => { if (/bills\/grid|Bills\/grid|bills\/list/i.test(r.url()) && /json/.test(r.headers()['content-type'] || '')) grids.push(await r.text().catch(() => '')); };
  page.on('response', h);
  await page.goto(`https://buildertrend.net/app/Bills?jobId=${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(15000);
  page.off('response', h);
  console.log(`===== job ${jobId}: ${grids.length} grid answer(s)`);
  const seen = new Set();
  for (const g of grids) {
    let j; try { j = JSON.parse(g); } catch { continue; }
    const rows = j?.data?.rows || j?.rows || j?.data?.records || j?.records || j?.data || [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const s = JSON.stringify(r);
      if (!s.toLowerCase().includes(String(text).toLowerCase())) continue;
      const id = r.id ?? r.billId ?? r.Id;
      if (seen.has(id)) continue; seen.add(id);
      console.log(s.slice(0, 700));
    }
    if (!seen.size) console.log(`(no row with "${text}"; sample) ${g.slice(0, 600)}`);
  }
  const txt = (await page.innerText('body').catch(() => '')).split('\n').filter((l) => l.toLowerCase().includes(String(text).toLowerCase()));
  console.log(`page lines with "${text}": ${txt.length}\n${txt.slice(0, 10).join('\n')}`);
}
await browser.close();
