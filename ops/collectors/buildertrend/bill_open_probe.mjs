#!/usr/bin/env node
// bill_open_probe.mjs — READ-ONLY: open an existing bill and list its buttons, menus and the JSON it loads, to
// find how a bill is marked paid. Opens menus only (no click on an action); nothing is saved.
//   BT_COOKIES_FILE=… node collectors/buildertrend/bill_open_probe.mjs <jobId> <billId>
import { openBuildertrend } from './session.mjs';

const [jobId, billId] = process.argv.slice(2);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const calls = [];
page.on('response', async (r) => { const u = r.url(); if (/buildertrend\.net\/apix?\//i.test(u) && /json/.test(r.headers()['content-type'] || '') && /bill|payment|accounting/i.test(u)) calls.push(`${r.request().method()} ${r.status()} ${u}\n  res: ${(await r.text().catch(() => '')).slice(0, 20000)}`); });
await page.goto(`https://buildertrend.net/app/Bills/Bill/${billId}/${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(12000);
const dlg = page.locator('.ant-modal-content, [role="dialog"]').last();
const buttons = await dlg.locator('button').evaluateAll((bs) => bs.filter((b) => b.offsetParent !== null).map((b) => `${(b.innerText || '').trim()} | aria=${b.getAttribute('aria-label') || ''} | testid=${b.getAttribute('data-testid') || ''}`));
let menu = '';
for (const name of [/^More$/i, /more actions/i]) {
  const m = dlg.getByRole('button', { name }).first();
  if (await m.count()) { await m.click().catch(() => {}); await page.waitForTimeout(1500); menu += (await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').allInnerTexts().catch(() => [])).join(' / '); await page.keyboard.press('Escape'); }
}
const text = (await dlg.innerText().catch(() => '')).slice(0, 6000);
console.log('OUT B64:' + Buffer.from(`BUTTONS:\n${buttons.join('\n')}\n\nMENU: ${menu}\n\nTEXT:\n${text}\n\nCALLS:\n${calls.join('\n\n')}`).toString('base64'));
await browser.close();
