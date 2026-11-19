#!/usr/bin/env node
// bill_open_probe.mjs — READ-ONLY: open an existing bill and list its buttons, menus and the JSON it loads, to
// find how a bill is marked paid. Opens menus only (no click on an action); nothing is saved.
//   BT_COOKIES_FILE=… node collectors/buildertrend/bill_open_probe.mjs <jobId> <billId> [--ready]
// --ready: clicks "Mark Ready for Payment" (a status change on that bill), then opens the pay form WITHOUT confirming.
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
let payForm = '';
if (process.argv.includes('--ready')) {
  const ready = dlg.getByRole('button', { name: /^Mark Ready for Payment$/ }).first();
  if (await ready.count()) { await ready.click(); await page.waitForTimeout(6000); }
  const after = await page.locator('.ant-modal-content, [role="dialog"]').last().locator('button').evaluateAll((bs) => bs.filter((b) => b.offsetParent !== null).map((b) => (b.innerText || '').trim()).filter(Boolean));
  payForm += `BUTTONS AFTER READY: ${after.join(' | ')}\n`;
  const pay = page.getByRole('button', { name: /^(Mark Paid|Mark as Paid|Pay|Record Payment|Make Payment|Pay Bill)$/i }).first();
  if (await pay.count()) {
    await pay.click(); await page.waitForTimeout(4000);
    const pd = page.locator('.ant-modal-content, [role="dialog"]').last();
    const ctl = await pd.evaluate((d) => [...d.querySelectorAll('input, textarea, button, [role="combobox"]')].filter((e) => e.offsetParent !== null).map((e) => { const lab = e.id ? document.querySelector(`label[for="${e.id}"]`)?.innerText : ''; return `${e.tagName.toLowerCase()} id=${e.id || ''} type=${e.getAttribute('type') || ''} label=${(lab || e.getAttribute('aria-label') || '').trim()} text=${(e.innerText || e.value || '').trim().slice(0, 40)}`; }));
    payForm += `PAY FORM CONTROLS:\n${ctl.join('\n')}\nPAY FORM TEXT:\n${(await pd.innerText()).slice(0, 3000)}\n(not confirmed)`;
  } else payForm += 'no pay button found';
}
const text = (await dlg.innerText().catch(() => '')).slice(0, 6000);
console.log('OUT B64:' + Buffer.from(`${payForm}\n\nBUTTONS:\n${buttons.join('\n')}\n\nMENU: ${menu}\n\nTEXT:\n${text}\n\nCALLS:\n${calls.join('\n\n')}`).toString('base64'));
await browser.close();
