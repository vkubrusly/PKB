#!/usr/bin/env node
// warranty_probe.mjs — READ-ONLY: how Buildertrend shows Warranty claims, to design the warranty collector
// and the claim creation. Opens the Warranty list (all jobs, then one job), prints the page text, the JSON
// calls the page makes (with a sample of their answers) and the warranty API paths in the page's code.
// No click on New/Save, no write.
//   BT_COOKIES_FILE=… node collectors/buildertrend/warranty_probe.mjs [buildertrend job id]
import { openBuildertrend } from './session.mjs';

const jobId = process.argv[2] || '';
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const api = [], scripts = new Set();
page.on('response', async (r) => {
  const u = r.url();
  if (/\.js(\?|$)/.test(u) && /buildertrend/i.test(u)) scripts.add(u);
  if (/\/apix?\//i.test(u) && /json/i.test(r.headers()['content-type'] || '')) api.push(`${r.request().method()} ${r.status()} ${u.slice(0, 220)}\n  req: ${(r.request().postData() || '').slice(0, 400)}\n  res: ${(await r.text().catch(() => '')).slice(0, 2500)}`);
});
const text = async () => (await page.innerText('body').catch(() => '')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
for (const url of [`https://buildertrend.net/app/Warranties`, jobId ? `https://buildertrend.net/app/Warranties?jobId=${jobId}` : null].filter(Boolean)) {
  api.length = 0;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((e) => console.log(`goto ${url}: ${e.message}`));
  await page.waitForTimeout(15000);
  console.log(`\n===== ${url} → ${page.url()} =====\n${(await text()).slice(0, 5000)}`);
  console.log(`\n===== JSON calls on ${url} =====\n${api.slice(0, 40).join('\n')}`);
}
// The menu link to Warranty, in case the URL above is not the right one.
const links = await page.$$eval('a', (els) => els.map((e) => `${(e.innerText || '').trim().slice(0, 40)} -> ${e.getAttribute('href') || ''}`).filter((s) => /warrant/i.test(s)));
console.log(`\n===== warranty links =====\n${links.join('\n')}`);
const paths = new Map(), near = new Map();
for (const u of scripts) {
  const res = await page.request.get(u).catch(() => null);
  if (!res || !res.ok()) continue;
  const js = await res.text();
  for (const m of js.matchAll(/["'`]((?:\/?apix?\/)[A-Za-z0-9_\-/{}$.?=&]*?warrant[A-Za-z0-9_\-/{}$.?=&]*)["'`]/gi)) paths.set(m[1], u.split('/').pop());
  for (const m of js.matchAll(/.{0,120}(?:claimStatus|ClaimStatus|warrantyStatus|WarrantyStatus|isResolved|IsResolved|ownerAcknowledged|builderClosed)[^;]{0,160}/g)) near.set(m[0].replace(/\s+/g, ' ').slice(0, 280), u.split('/').pop());
}
console.log('\n===== warranty API paths in the code =====');
for (const [p, f] of paths) console.log(`${p}   (${f})`);
console.log('\n===== code near claim status =====');
let n = 0; for (const [c, f] of near) { if (n++ > 40) break; console.log(`[${f}] ${c}\n`); }
await browser.close();
