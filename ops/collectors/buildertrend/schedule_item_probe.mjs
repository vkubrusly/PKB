#!/usr/bin/env node
// schedule_item_probe.mjs — READ-ONLY: how the Schedule item editor loads and saves an item.
// Prints the code around every /api/calendar call in the Schedule API handler bundle (method + payload),
// and the JSON the editor loads for one item (GET only). No write.
//   BT_COOKIES_FILE=… node collectors/buildertrend/schedule_item_probe.mjs <job id> <schedule item id>
import { openBuildertrend } from './session.mjs';

const [jobId = '43923060', itemId = '270909180'] = process.argv.slice(2);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const scripts = new Set(); let apiHeaders = null;
page.on('response', (r) => { const u = r.url(); if (/\.js(\?|$)/.test(u) && /buildertrend/i.test(u)) scripts.add(u); });
page.on('request', (r) => { if (!apiHeaders && /\/api\/calendar\//i.test(r.url())) apiHeaders = r.headers(); });
await page.goto(`https://buildertrend.net/app/Schedules/List?jobId=${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(15000);
for (const u of scripts) {
  if (!/Schedule\.api\.handler|ScheduleItem|schedule-item|ScheduleDetails/i.test(u)) continue;
  const js = await (await page.request.get(u)).text();
  console.log(`\n===== ${u.split('/').pop()} (${js.length} chars) =====`);
  const li = js.indexOf('l=t=>'); if (li >= 0) console.log(`--- save transform l()\n${js.slice(li, li + 2500)}\n`);
  for (const m of js.matchAll(/\/api\/calendar[^"'`]*/gi)) {
    const i = m.index; console.log(`--- ${m[0]}\n${js.slice(Math.max(0, i - 260), i + 360).replace(/\s+/g, ' ')}\n`);
  }
}
const clean = (h) => Object.fromEntries(Object.entries(h || {}).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
for (const path of [`/api/calendar/${itemId}`, `/api/calendar/${itemId}/LinkList`]) {
  const res = await page.request.get(`https://buildertrend.net${path}`, { headers: clean(apiHeaders) });
  const t = await res.text();
  console.log(`\n===== GET ${path} → ${res.status()} =====\n${t.slice(0, 40000)}`);
}
await browser.close();
