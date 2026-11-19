#!/usr/bin/env node
// schedule_date_test.mjs — change ONE schedule item's start date the way a person does (open the item, type the
// date, Save) and report every item of the job whose dates changed. Victor approved a single test on 0010.
// Without --save it only opens the editor and lists its fields/buttons (no change).
//   BT_COOKIES_FILE=… node collectors/buildertrend/schedule_date_test.mjs <job id> <item id> <MM/DD/YYYY> [--save]
import { openBuildertrend } from './session.mjs';

const [jobId, itemId, newDate] = process.argv.slice(2);
const SAVE = process.argv.includes('--save');
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
let listReq = null; const writes = [];
page.on('request', (r) => {
  if (!listReq && /\/api\/calendar\/CalendarList/i.test(r.url())) listReq = { url: r.url(), headers: r.headers(), body: r.postData() };
  if (/\/api\/calendar|\/apix\/v2\/Schedules/i.test(r.url()) && r.method() !== 'GET' && !/CalendarList/i.test(r.url())) writes.push(`${r.method()} ${r.url()} ${String(r.postData() || '').slice(0, 1500)}`);
});
await page.goto(`https://buildertrend.net/app/Schedules/List?jobId=${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 90 && !listReq; i++) await page.waitForTimeout(500);
const clean = (h) => Object.fromEntries(Object.entries(h || {}).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
async function snapshot() {
  const items = new Map();
  for (let k = -14; k <= 8; k++) {
    const now = new Date(); const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1)).toISOString().slice(0, 10) + 'T00:00:00';
    const res = await page.request.post(listReq.url, { headers: { ...clean(listReq.headers), 'content-type': 'application/json' }, data: JSON.stringify({ ...JSON.parse(listReq.body), startDate: d, selectedJobIds: [Number(jobId)], perDayLimit: 200 }) });
    for (const it of (await res.json().catch(() => null))?.data?.calendarItems || []) items.set(String(it.id), it);
  }
  return items;
}
const before = await snapshot();
const target = before.get(String(itemId));
console.log(`job ${jobId}: ${before.size} items · target ${itemId} "${target?.title}" start ${String(target?.startDate).slice(0, 10)} end ${String(target?.endDate).slice(0, 10)} completed=${target?.completed}`);
await page.waitForTimeout(3000);
// Open the item editor: the route the app uses (found in its bundles), else click the title in the list.
const routes = new Set();
for (const u of await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /\.js(\?|$)/.test(n)))) {
  const js = await (await page.request.get(u).catch(() => null))?.text().catch(() => '') || '';
  for (const m of js.matchAll(/["'`](\/?(?:app\/)?Schedules?\/[A-Za-z]*(?:Item|Details|Edit)[A-Za-z/:${}._-]*)["'`]/g)) routes.add(m[1]);
}
console.log('item routes in bundles:', [...routes].slice(0, 40).join(' | '));
const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /chedul/i.test(h)).slice(0, 20));
console.log('schedule links on the page:', hrefs.join(' | '));
const rowTitles = await page.evaluate(() => [...document.querySelectorAll('[role=row], tr')].slice(0, 12).map((r) => r.innerText.replace(/\s+/g, ' ').slice(0, 120)));
console.log('first rows:', rowTitles.join(' || '));
let opened = false;
for (const r of [...routes].filter((x) => /:id|\$\{|:scheduleId|:itemId/i.test(x)).slice(0, 6)) {
  const url = 'https://buildertrend.net/' + r.replace(/^\//, '').replace(/:jobId|\$\{[^}]*job[^}]*\}/i, jobId).replace(/:id|:scheduleId|:itemId|\$\{[^}]*\}/i, itemId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await page.waitForTimeout(6000);
  const ok = await page.evaluate((t) => document.body.innerText.includes(t), String(target?.title || '').trim());
  console.log(`try ${url} → title on page: ${ok}`); if (ok) { opened = true; break; }
}
if (!opened) await page.getByText(String(target?.title || '').trim(), { exact: true }).first().click({ timeout: 30000 });
await page.waitForTimeout(6000);
const fields = await page.evaluate(() => [...document.querySelectorAll('input, button, [role=button], label')].filter((e) => e.offsetParent !== null)
  .map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.name ? '[name=' + e.name + ']' : ''}${e.getAttribute('data-testid') ? '[testid=' + e.getAttribute('data-testid') + ']' : ''} ${e.placeholder ? 'ph=' + e.placeholder : ''} ${e.value ? 'val=' + String(e.value).slice(0, 30) : ''} ${String(e.innerText || '').trim().slice(0, 40)}`));
console.log('--- visible fields/buttons in the editor ---\n' + fields.slice(0, 160).join('\n'));
if (!SAVE) { await browser.close(); process.exit(0); }
// Start date input: the first visible date input of the editor (label "Start").
const start = page.locator('#startDate, input[name="startDate"], [data-testid="startDate"] input').first();
await start.click({ clickCount: 3 }); await start.fill(newDate); await start.press('Tab'); await page.waitForTimeout(1500);
const dialogText = async () => page.evaluate(() => [...document.querySelectorAll('.ant-modal, [role=dialog]')].map((d) => d.innerText.replace(/\s+/g, ' ').slice(0, 600)).join(' || '));
console.log('dialog after typing:', await dialogText());
await page.getByRole('button', { name: /^save$/i }).first().click({ timeout: 20000 });
await page.waitForTimeout(6000);
console.log('dialog after save:', await dialogText());
const after = await snapshot();
console.log('--- writes sent ---\n' + writes.join('\n'));
console.log('--- items whose dates changed ---');
let n = 0;
for (const [id, a] of after) { const b = before.get(id); if (!b) continue;
  if (String(a.startDate) !== String(b.startDate) || String(a.endDate) !== String(b.endDate)) { n++; console.log(`${id} "${String(a.title).trim()}" start ${String(b.startDate).slice(0, 10)} → ${String(a.startDate).slice(0, 10)} · end ${String(b.endDate).slice(0, 10)} → ${String(a.endDate).slice(0, 10)} · completed=${a.completed}`); } }
console.log(`changed: ${n} item(s)`);
await browser.close();
