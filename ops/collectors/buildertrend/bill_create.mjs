#!/usr/bin/env node
// =============================================================================
// bill_create.mjs — create ONE Buildertrend bill the way a person does (Bills → new Bill form), from a JSON spec.
// Victor, 11/19/26 (reconciliation Sistema Gui × Buildertrend): bills are created paid (date paid = Sistema Gui
// pay day; the paying account goes in the description) and NOT sent to QuickBooks ("Send to QuickBooks
// immediately upon save" unchecked). Without --save it fills the form, prints what is in it and closes
// (nothing is created).
//   BT_COOKIES_FILE=… node collectors/buildertrend/bill_create.mjs '<json spec | base64 of it>' [--save]
//   spec: { jobId, title, billNo, payTo, invoiceDate:'MM/DD/YYYY', paidDate:'MM/DD/YYYY', description,
//           lines: [{ title, costCode, amount }] }
// =============================================================================
import { openBuildertrend } from './session.mjs';

// The spec may come base64-encoded (no quotes to escape in the Actions shell).
const rawSpec = process.argv[2]; const spec = JSON.parse(/^\s*\{/.test(rawSpec) ? rawSpec : Buffer.from(rawSpec, 'base64').toString('utf8'));
const SAVE = process.argv.includes('--save');
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const writes = [];
page.on('request', (r) => { if (/buildertrend\.net\/apix?\//i.test(r.url()) && !['GET'].includes(r.method()) && !/Grid|datadog|Filters|tab-counts/i.test(r.url())) writes.push(`${r.method()} ${r.url()} ${String(r.postData() || '').slice(0, 3000)}`); });
const log = (...a) => console.log(...a);
await page.goto(`https://buildertrend.net/app/Bills/Bill/0/${spec.jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.locator('#billTitle').waitFor({ timeout: 60000 }); await page.waitForTimeout(3000);

async function pick(selector, text, optionText = text) {
  const box = page.locator(selector).first();
  await box.click({ force: true }); await box.fill(text); await page.waitForTimeout(2500);
  const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: optionText }).first();
  if (!(await opt.count())) throw new Error(`no option "${optionText}" for ${selector}`);
  await opt.click(); await page.waitForTimeout(1000);
}
async function date(selector, value) {
  const box = page.locator(selector).first();
  await box.click({ force: true }); await box.fill(value); await box.press('Enter'); await page.waitForTimeout(800);
}
await page.locator('#billTitle').fill(spec.title);
if (spec.billNo) { await page.locator('#billNumber').fill(spec.billNo); }
await pick('#performingUserId', spec.payTo);
if (spec.invoiceDate) await date('#invoiceDate', spec.invoiceDate);
if (spec.paidDate) await date('#paymentDate', spec.paidDate);
// Description (rich text editor)
if (spec.description) {
  const ed = page.locator('[contenteditable="true"]').first();
  if (await ed.count()) { await ed.click(); await page.keyboard.type(spec.description); }
}
// Cost lines: each line has an "Open untitled item N" button that opens the line editor.
for (let i = 0; i < spec.lines.length; i++) {
  const L = spec.lines[i];
  if (i > 0) { await page.getByRole('button', { name: /^Item$/ }).first().click(); await page.waitForTimeout(1500); }
  const open = page.locator(`button[aria-label^="Open untitled item"]`).last();
  await open.click(); await page.waitForTimeout(2500);
  const dlg = page.locator('.ant-modal-content, .ant-drawer-content, [role="dialog"]').last();
  const ctl = await dlg.evaluate((d) => [...d.querySelectorAll('input, textarea, button, [role="combobox"]')].filter((e) => e.offsetParent !== null).map((e) => {
    const lab = e.id ? document.querySelector(`label[for="${e.id}"]`)?.innerText : '';
    return `${e.tagName.toLowerCase()} id=${e.id || ''} name=${e.getAttribute('name') || ''} type=${e.getAttribute('type') || ''} label=${(lab || e.getAttribute('aria-label') || '').trim()} text=${(e.innerText || e.value || '').trim().slice(0, 30)}`; }));
  log('LINE EDITOR B64:' + Buffer.from(ctl.join('\n') + '\n---\n' + (await dlg.innerText()).slice(0, 3000)).toString('base64'));
  const byLabel = async (re) => { for (const c of await dlg.locator('input, textarea').all()) { const id = await c.getAttribute('id'); const lab = id ? await page.locator(`label[for="${id}"]`).first().innerText().catch(() => '') : ''; if (re.test(lab) || re.test(id || '')) return c; } return null; };
  if (L.title) await page.locator('#itemTitle').fill(L.title);
  const cc = page.locator('#costCodeId');
  if (cc) { await cc.click({ force: true }); await cc.fill(L.costCode.slice(0, 8)); await page.waitForTimeout(2500);
    const o = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-tree-treenode', { hasText: L.costCode.slice(9) }).first();
    if (await o.count()) await o.click(); else log('cost code option not found:', L.costCode); await page.waitForTimeout(800); }
  const amt = page.locator('#unitCost');
  if (amt) { await amt.click({ clickCount: 3 }); await amt.fill(String(L.amount)); await amt.press('Tab'); }
  await page.waitForTimeout(800);
  const values = await dlg.evaluate((d) => [...d.querySelectorAll('input')].filter((e) => e.offsetParent !== null).map((e) => `${e.id}=${e.value}${e.closest('.ant-select') ? ' [' + (e.closest('.ant-select').querySelector('.ant-select-selection-item')?.textContent || '') + ']' : ''}`));
  log('LINE VALUES B64:' + Buffer.from(values.join('\n')).toString('base64'));
  const close = page.getByRole('button', { name: 'Close line item' }).first();
  if (await close.count()) { await close.click(); await page.waitForTimeout(1200); }
}
if ((await page.locator('#billTitle').inputValue()) !== spec.title) await page.locator('#billTitle').fill(spec.title);
// QuickBooks: do NOT send.
const qb = page.locator('#sendToAccounting');
if (await qb.count() && await qb.isChecked()) { await qb.uncheck({ force: true }); }
await page.waitForTimeout(1000);
const state = await page.evaluate(() => {
  const v = (id) => document.getElementById(id)?.value ?? null;
  const sel = (id) => document.getElementById(id)?.closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent ?? null;
  const rows = [...document.querySelectorAll('.ag-center-cols-container .ag-row')].map((r) => [...r.querySelectorAll('[col-id]')].map((c) => `${c.getAttribute('col-id')}=${c.textContent.trim()}`).join(' | '));
  return { title: v('billTitle'), billNo: v('billNumber'), payTo: sel('performingUserId'), invoiceDate: v('invoiceDate'), paymentDate: v('paymentDate'),
    sendToQuickBooks: document.getElementById('sendToAccounting')?.checked, rows, total: [...document.querySelectorAll('*')].find((e) => /^Total:/.test(e.textContent?.trim() || '') && e.children.length < 3)?.parentElement?.textContent?.trim().slice(0, 60) };
});
log('FORM STATE B64:' + Buffer.from(JSON.stringify(state, null, 1)).toString('base64'));
if (!SAVE) { log('dry run: form filled, NOT saved'); await browser.close(); process.exit(0); }
await page.getByRole('button', { name: /^Save to Job$/ }).first().click({ timeout: 20000 });
await page.waitForTimeout(8000);
log('url after save:', page.url());
log('WRITES B64:' + Buffer.from(writes.join('\n\n')).toString('base64'));
const err = await page.locator('.ant-form-item-explain-error, .ant-message-error, .ant-notification-notice').allInnerTexts().catch(() => []);
log('errors on page:', JSON.stringify(err).slice(0, 500));
await browser.close();
