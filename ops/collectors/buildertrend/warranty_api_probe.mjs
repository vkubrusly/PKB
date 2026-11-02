#!/usr/bin/env node
// warranty_api_probe.mjs — READ-ONLY: the Buildertrend Warranty API for one job — the defaults the "New
// claim" form starts from (GET /api/Warranty/DefaultInfo) and the job's existing claims (POST /api/Warranty/Grid,
// a read). Used to build the claim creation; creates nothing.
//   BT_COOKIES_FILE=… node collectors/buildertrend/warranty_api_probe.mjs <buildertrend job id>
import { openBuildertrend } from './session.mjs';

const jobId = Number(process.argv[2] || 43923046);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); // The request the "New claim" form sends on Save, from the page's own code (field names of the POST body).
const scripts = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((u) => /\.js(\?|$)/.test(u)));
const seen = new Set();
for (const u of scripts) {
  const js = await (await page.request.get(u)).text().catch(() => '');
  if (!/problemDescription/.test(js)) continue;
  for (const m of js.matchAll(/.{0,700}problemDescription.{0,700}/g)) { const t = m[0].replace(/\s+/g, ' '); if (!seen.has(t)) { seen.add(t); console.log(`\n[${u.split('/').pop()}] ${t}`); } if (seen.size > 25) break; }
}
await browser.close(); process.exit(1); }
let hdr = null;
page.on('request', (r) => { if (!hdr && /buildertrend\.net\/api\//.test(r.url())) hdr = r.headers(); });
await page.goto('https://buildertrend.net/app/Warranties', { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 60 && !hdr; i++) await page.waitForTimeout(500);
const headers = { ...Object.fromEntries(Object.entries(hdr || {}).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k))), 'content-type': 'application/json' };
const show = async (label, res) => console.log(`\n===== ${label}: HTTP ${res.status()} =====\n${(await res.text()).slice(0, 12000)}`);
const defRes = await page.request.get(`https://buildertrend.net/api/Warranty/DefaultInfo?jobId=${jobId}`, { headers });
const def = (await defRes.json().catch(() => null))?.data || {};
console.log(`\n===== DefaultInfo job ${jobId}: HTTP ${defRes.status()} · fields: ${Object.keys(def).join(', ')} =====`);
for (const [k, v] of Object.entries(def)) if (/coordinat|owner|assign|user|service/i.test(k)) console.log(`\n--- ${k} ---\n${JSON.stringify(v).slice(0, 4000)}`);
for (const body of [
  { gridRequest: { hasFooter: true }, pagingData: { pageNumber: 1, pageSize: 50 }, filters: '{}', jobIds: [jobId] },
  { gridRequest: {}, pagingData: { pageNumber: 1, pageSize: 50, sortColumn: null, sortDirection: 0 }, filters: {}, jobIds: [jobId] },
]) await show(`Grid ${JSON.stringify(body).slice(0, 120)}`, await page.request.post('https://buildertrend.net/api/Warranty/Grid', { headers, data: JSON.stringify(body) }));
await browser.close();
