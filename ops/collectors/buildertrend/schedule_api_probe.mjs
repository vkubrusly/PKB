#!/usr/bin/env node
// schedule_api_probe.mjs — READ-ONLY: find how Buildertrend marks a schedule item complete, by reading
// the JavaScript the Schedule page loads (no click, no write). Prints every API path near "complete"
// and every schedule-related API path found in the bundles.
//   BT_COOKIES_FILE=… node collectors/buildertrend/schedule_api_probe.mjs <buildertrend job id>
import { openBuildertrend } from './session.mjs';

const jobId = process.argv[2] || '44609047';
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const scripts = new Set();
page.on('response', (r) => { const u = r.url(); if (/\.js(\?|$)/.test(u) && /buildertrend/i.test(u)) scripts.add(u); });
await page.goto(`https://buildertrend.net/app/Schedules/List?jobId=${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(15000);
console.log(`scripts loaded: ${scripts.size}`);
const paths = new Map(), near = new Map();
for (const u of scripts) {
  const res = await page.request.get(u).catch(() => null);
  if (!res || !res.ok()) continue;
  const js = await res.text();
  for (const m of js.matchAll(/["'`]((?:\/?apix?\/)[A-Za-z0-9_\-/{}$.?=&]*?(?:schedul|calendar)[A-Za-z0-9_\-/{}$.?=&]*)["'`]/gi)) paths.set(m[1], u.split('/').pop());
  for (const m of js.matchAll(/.{0,160}(?:markComplete|MarkComplete|markAsComplete|toggleComplete|CompleteScheduleItem|setComplete|isComplete\s*:)[^;]{0,200}/g)) near.set(m[0].replace(/\s+/g, ' ').slice(0, 360), u.split('/').pop());
}
console.log('\n===== schedule/calendar API paths =====');
for (const [p, f] of paths) console.log(`${p}   (${f})`);
console.log('\n===== code near "complete" =====');
let n = 0; for (const [c, f] of near) { if (n++ > 60) break; console.log(`[${f}] ${c}\n`); }
await browser.close();
