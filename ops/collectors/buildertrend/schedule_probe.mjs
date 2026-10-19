#!/usr/bin/env node
// schedule_probe.mjs — READ-ONLY look at one job's Schedule in Buildertrend, to design marking the
// construction phases (Victor, 2026-10-19: phases live in the job Schedules). Prints the API calls the
// Schedule page makes (url, method, a sample of the JSON), the schedule items (title, phase, dates,
// complete flag, ids) and, for one item, the controls its detail window offers. Changes nothing:
// no click on save/complete, the detail window is closed with Escape.
//   BT_COOKIES_FILE=… node collectors/buildertrend/schedule_probe.mjs <buildertrend job id>
import { openBuildertrend } from './session.mjs';

const jobId = process.argv[2] || '44609047'; // 0031 by default
const section = (t, s) => console.log(`\n===== ${t} =====\n${s}`);
const shape = (o, depth = 0) => {
  if (Array.isArray(o)) return o.length ? [`array(${o.length})`, shape(o[0], depth + 1)] : 'array(0)';
  if (o && typeof o === 'object') { if (depth > 3) return '{…}'; const r = {}; for (const [k, v] of Object.entries(o).slice(0, 40)) r[k] = shape(v, depth + 1); return r; }
  return typeof o === 'string' ? `"${o.slice(0, 60)}"` : o;
};

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const calls = [];
page.on('response', async (r) => {
  const u = r.url();
  if (!/buildertrend\.net\/(api|apix)\//i.test(u) || !/schedul|calendar|phase|gantt/i.test(u)) return;
  const j = await r.json().catch(() => null);
  calls.push({ method: r.request().method(), url: u.slice(0, 250), status: r.status(), body: (r.request().postData() || '').slice(0, 600), shape: j ? JSON.stringify(shape(j)).slice(0, 2500) : null, json: j });
});

for (const url of [`https://buildertrend.net/app/Schedules?jobId=${jobId}`, `https://buildertrend.net/app/Schedules/List?jobId=${jobId}`]) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((e) => section('goto error', `${url} ${e.message}`));
  await page.waitForTimeout(12000);
  section(`page ${url}`, `${page.url()}\n${(await page.innerText('body').catch(() => '')).replace(/\n{2,}/g, '\n').slice(0, 3000)}`);
  const tabs = await page.$$eval('a, button, [role="tab"]', (els) => els.map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 30 && /list|gantt|month|week|day|phase|baseline|calendar|agenda/i.test(t)));
  section('view controls', JSON.stringify([...new Set(tabs)]));
}

section('schedule API calls', calls.map((c) => `${c.method} ${c.status} ${c.url}\n  body: ${c.body}\n  shape: ${c.shape}`).join('\n\n'));

// Items: find the biggest array of objects that look like schedule items in the captured JSON.
const items = [];
const walk = (o) => { if (Array.isArray(o)) { if (o.length && o[0] && typeof o[0] === 'object' && Object.keys(o[0]).some((k) => /title|name/i.test(k)) && Object.keys(o[0]).some((k) => /start|date|complete|progress/i.test(k))) items.push(o); o.forEach(walk); } else if (o && typeof o === 'object') Object.values(o).forEach(walk); };
for (const c of calls) if (c.json) walk(c.json);
const list = items.sort((a, b) => b.length - a.length)[0] || [];
section(`schedule items (${list.length})`, list.slice(0, 80).map((it) => JSON.stringify(Object.fromEntries(Object.entries(it).filter(([k, v]) => /id$|title|name|phase|start|end|complete|progress|status|duration|isComplete|percent/i.test(k) && (typeof v !== 'object' || v === null)))).slice(0, 400)).join('\n'));

// One item's detail window (read-only): what controls mark it complete.
const first = page.locator('text=/Footing|Slab|Lintel|Inspection/i').first();
if (await first.count()) {
  await first.click().catch(() => {});
  await page.waitForTimeout(6000);
  const modal = page.locator('.ant-modal-content, [role="dialog"]').last();
  section('item detail (text)', (await modal.innerText().catch(() => '(no dialog)')).slice(0, 2500));
  section('item detail (controls)', JSON.stringify(await modal.locator('input, button, [role="checkbox"], [role="switch"], .ant-checkbox, .ant-switch').evaluateAll((els) => els.map((e) => ({ tag: e.tagName, type: e.getAttribute('type'), id: e.id, name: e.getAttribute('name'), role: e.getAttribute('role'), text: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 40), checked: e.checked ?? e.getAttribute('aria-checked') }))).catch(() => []), null, 1));
  await page.keyboard.press('Escape').catch(() => {});
} else section('item detail', 'no item text found to open');
await browser.close();
