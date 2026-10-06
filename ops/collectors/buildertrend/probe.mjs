#!/usr/bin/env node
// probe.mjs — one-off diagnostics for Buildertrend's Daily Logs list (read-only):
// opens /app/DailyLogs and prints the JSON calls the page makes (method, url, request body,
// top-level keys, the first row's keys with short values). Values are cut to 40 characters.
//   BT_COOKIES_FILE=... node collectors/buildertrend/probe.mjs [jobId]
import { openBuildertrend } from './session.mjs';

const jobId = process.argv[2];
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); process.exit(1); }
const cut = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? `[${v.length}] ${JSON.stringify(v[0] ?? null).slice(0, 300)}` : `{${Object.keys(v).join(',')}}`) : String(v).slice(0, 40));
const firstArray = (o, d = 0) => { if (Array.isArray(o) && o.length && typeof o[0] === 'object') return o; if (o && typeof o === 'object' && d < 5) for (const v of Object.values(o)) { const f = firstArray(v, d + 1); if (f) return f; } return null; };
page.on('response', async (r) => {
  const req = r.request();
  if (!['xhr', 'fetch'].includes(req.resourceType())) return;
  console.log(`-- ${req.method()} ${r.url().slice(0, 160)} → ${r.status()} ${r.headers()['content-type'] || ''}`);
  if (!/dailylog/i.test(r.url())) return;
  console.log(`\n== ${req.method()} ${r.url()} → ${r.status()}`);
  if (req.postData()) console.log('body:', req.postData().slice(0, 1500));
  try {
    const b = await r.json();
    console.log('top keys:', Object.keys(b || {}).join(', '), '| data keys:', Object.keys(b?.data || {}).join(', '));
    const rows = firstArray(b);
    if (rows) { console.log('rows:', rows.length); for (const [k, v] of Object.entries(rows[0])) console.log(`  ${k}: ${cut(v)}`); }
  } catch (e) { console.log('json error', e.message); }
});
await page.goto(`https://buildertrend.net/app/DailyLogs${jobId ? `?jobId=${jobId}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(25000);
console.log('\nurl:', page.url());
console.log((await page.locator('body').innerText()).slice(0, 1500));
await browser.close();
