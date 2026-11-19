#!/usr/bin/env node
// =============================================================================
// bill_create.mjs — create ONE Buildertrend bill the way a person does (Bills → new Bill form), from a JSON spec.
// Victor, 11/19/26 (reconciliation Sistema Gui × Buildertrend): bills are created paid (date paid = Sistema Gui
// pay day; the paying account goes in the description) and NOT sent to QuickBooks ("Send to QuickBooks
// immediately upon save" unchecked). Without --save it fills the form, prints what is in it and closes
// (nothing is created).
//   BT_COOKIES_FILE=… node collectors/buildertrend/bill_create.mjs '<json spec>' [--save]
//   spec: { jobId, title, billNo, payTo, invoiceDate:'MM/DD/YYYY', paidDate:'MM/DD/YYYY', description,
//           lines: [{ title, costCode, amount }] }
// =============================================================================
import { openBuildertrend } from './session.mjs';

const spec = JSON.parse(process.argv[2]);
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
// Cost lines (ag-grid): row 1 exists; more rows with "Item".
for (let i = 0; i < spec.lines.length; i++) {
  const L = spec.lines[i];
  if (i > 0) { await page.getByRole('button', { name: /^Item$/ }).first().click(); await page.waitForTimeout(1200); }
  const row = page.locator('.ag-center-cols-container .ag-row').nth(i);
  const cell = async (colId, value, pickText) => {
    const c = row.locator(`[col-id="${colId}"]`).first();
    await c.dblclick({ force: true }); await page.waitForTimeout(700);
    await page.keyboard.press('Control+A'); await page.keyboard.type(String(value)); await page.waitForTimeout(1800);
    if (pickText) { const o = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .ag-popup [role="option"]', { hasText: pickText }).first();
      if (await o.count()) await o.click(); else await page.keyboard.press('Enter'); }
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
  };
  const cols = await row.locator('[col-id]').evaluateAll((els) => els.map((e) => e.getAttribute('col-id')));
  if (i === 0) log('grid columns:', cols.join(', '));
  const colTitle = cols.find((c) => /title/i.test(c)), colCode = cols.find((c) => /cost.?code/i.test(c)), colCost = cols.find((c) => /builder.?cost|cost$|amount|extended/i.test(c) && !/code/i.test(c));
  if (colTitle && L.title) await cell(colTitle, L.title);
  if (colCode) await cell(colCode, L.costCode.slice(0, 8), L.costCode);
  if (colCost) await cell(colCost, L.amount);
}
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
