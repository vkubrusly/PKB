#!/usr/bin/env node
// =============================================================================
// bill_create.mjs — create Buildertrend bills the way a person does (Bills → new Bill form), from JSON specs.
// Victor, 11/19/26 (reconciliation Sistema Gui × Buildertrend):
//   - NOT sent to QuickBooks ("Send to QuickBooks immediately upon save" unchecked);
//   - paid: Date paid = Sistema Gui pay day; with --pay the bill is marked Ready for Payment and the payment is
//     recorded (Record Payment) with the lien waiver NOT sent; the paying account goes in the line description.
// A bill whose number already exists on the job is skipped. Each bill is re-read after saving (amount, paid,
// date paid, cost codes). Without --save it only fills the form (nothing is created).
//   BT_COOKIES_FILE=… node collectors/buildertrend/bill_create.mjs '<spec | [specs] — JSON or base64>' [--save] [--pay]
//   spec: { jobId, title, billNo, payTo, invoiceDate:'MM/DD/YYYY', paidDate:'MM/DD/YYYY', description,
//           lines: [{ title, costCode, amount }] }
// =============================================================================
import { openBuildertrend } from './session.mjs';

// The spec may come base64-encoded (no quotes to escape in the Actions shell).
const rawSpec = process.argv[2];
const specs = [].concat(JSON.parse(/^\s*[[{]/.test(rawSpec) ? rawSpec : Buffer.from(rawSpec, 'base64').toString('utf8')));
const SAVE = process.argv.includes('--save'), PAY = process.argv.includes('--pay');
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const log = (...a) => console.log(...a);
const total = (spec) => Math.round(spec.lines.reduce((a, l) => a + Number(l.amount), 0) * 100) / 100;

// Never picks "Create Sub/Vendor …" (that would register a new vendor).
async function pick(selector, text, optionText = text) {
  const box = page.locator(selector).first();
  await box.click({ force: true }); await box.fill(text); await page.waitForTimeout(2500);
  const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: optionText }).filter({ hasNotText: /^\s*Create\b/ }).first();
  if (!(await opt.count())) { await page.keyboard.press('Escape'); return false; }
  await opt.click(); await page.waitForTimeout(1000);
  return true;
}
// Pay to: the vendor when it exists in Buildertrend; otherwise "Misc" with the vendor's name typed in.
async function payTo(spec) {
  if (await pick('#performingUserId', spec.payTo)) return;
  const box = page.locator('#performingUserId').first();
  await box.click({ force: true }); await box.fill('Misc'); await page.waitForTimeout(2500);
  const misc = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: /^\s*(M\s*)?Misc\s*$/ }).first();
  if (!(await misc.count())) throw new Error(`vendor "${spec.payTo}" not in Buildertrend and no Misc option`);
  await misc.click(); await page.waitForTimeout(1200);
  await page.locator('#miscPaidToName').fill(spec.vendorName || spec.payTo);
}
async function date(selector, value) {
  const box = page.locator(selector).first();
  await box.click({ force: true }); await box.fill(value); await box.press('Enter'); await page.waitForTimeout(800);
}

// The job's bills of every status (the Bills page grid request, status filter cleared); the one with this number.
async function findBill(jobId, number) {
  let req = null;
  const on = (r) => { if (!req && /\/api\/v1\/bills\/grid/i.test(r.url())) req = { url: r.url(), headers: r.headers(), body: r.postData() }; };
  page.on('request', on);
  await page.goto(`https://buildertrend.net/app/Bills?jobId=${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  for (let i = 0; i < 90 && !req; i++) await page.waitForTimeout(500);
  page.off('request', on);
  if (!req) throw new Error('bills grid request not seen');
  const body = JSON.parse(req.body); const f = JSON.parse(body.filters); f['0'] = ''; body.filters = JSON.stringify(f);
  body.pagingData = { ...body.pagingData, pageSize: 200, lastRow: 200, totalRowsAllPages: 200 };
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
  const rows = (await (await page.request.post(req.url, { headers, data: JSON.stringify(body) })).json())?.data?.data || [];
  return rows.find((r) => String(r.billNumberLink?.title || '').toLowerCase() === `bill-${number}`.toLowerCase()) || null;
}

async function createOne(spec) {
  await page.goto(`https://buildertrend.net/app/Bills/Bill/0/${spec.jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.locator('#billTitle').waitFor({ timeout: 60000 }); await page.waitForTimeout(3000);
  await page.locator('#billTitle').fill(spec.title);
  if (spec.billNo) await page.locator('#billNumber').fill(spec.billNo);
  await payTo(spec);
  if (spec.invoiceDate) await date('#invoiceDate', spec.invoiceDate);
  if (spec.paidDate) await date('#paymentDate', spec.paidDate);
  // Cost lines: each line has an "Open untitled item N" button that opens the line editor.
  for (let i = 0; i < spec.lines.length; i++) {
    const L = spec.lines[i];
    if (i > 0) { await page.getByRole('button', { name: /^\+? ?(Add )?Item$/i }).first().click(); await page.waitForTimeout(1500); }
    await page.locator('button[aria-label^="Open untitled item"]').last().click(); await page.waitForTimeout(2500);
    if (L.title) await page.locator('#itemTitle').fill(L.title);
    if (spec.description) await page.locator('textarea#description').first().fill(spec.description).catch(() => {});
    const cc = page.locator('#costCodeId');
    await cc.click({ force: true }); await cc.fill(L.costCode.slice(0, 8)); await page.waitForTimeout(2500);
    const o = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-tree-treenode', { hasText: L.costCode.slice(9) }).first();
    if (!(await o.count())) throw new Error(`cost code not found: ${L.costCode}`);
    await o.click(); await page.waitForTimeout(800);
    const amt = page.locator('#unitCost');
    await amt.click({ clickCount: 3 }); await amt.fill(String(L.amount)); await amt.press('Tab'); await page.waitForTimeout(800);
    const close = page.getByRole('button', { name: 'Close line item' }).first();
    if (await close.count()) { await close.click(); await page.waitForTimeout(1200); }
  }
  if ((await page.locator('#billTitle').inputValue()) !== spec.title) await page.locator('#billTitle').fill(spec.title);
  // QuickBooks: do NOT send.
  const qb = page.locator('#sendToAccounting');
  if (await qb.count() && await qb.isChecked()) await qb.uncheck({ force: true });
  if (await qb.isChecked().catch(() => false)) throw new Error('could not uncheck Send to QuickBooks');
  await page.waitForTimeout(1000);
  if (!SAVE) return;
  await page.getByRole('button', { name: /^Save to Job$/ }).first().click({ timeout: 20000 });
  await page.waitForTimeout(8000);
  const err = await page.locator('.ant-form-item-explain-error, .ant-message-error').allInnerTexts().catch(() => []);
  if (err.length) throw new Error(`form errors: ${err.join(' / ')}`);
}

// Mark Ready for Payment, then Record Payment with the lien waiver NOT sent.
async function pay(jobId, billId) {
  await page.goto(`https://buildertrend.net/app/Bills/Bill/${billId}/${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(10000);
  const ready = page.getByRole('button', { name: /^Mark Ready for Payment$/ }).first();
  if (await ready.count()) { await ready.click(); await page.waitForTimeout(6000); }
  const rec = page.getByRole('button', { name: /^Record Payment$/ }).first();
  if (!(await rec.count())) throw new Error('no Record Payment button');
  await rec.click(); await page.waitForTimeout(4000);
  const lw = page.locator('#sendLienWaiverWithPayment');
  if (await lw.count() && await lw.isChecked()) await lw.uncheck({ force: true });
  if (await lw.isChecked().catch(() => false)) throw new Error('lien waiver still checked — payment NOT recorded');
  const pd = page.locator('.ant-modal-content, [role="dialog"]').filter({ hasText: 'Record payment' }).last();
  await pd.locator('button').filter({ hasText: /^\s*Record\b/ }).filter({ hasNotText: /Record Payment/ }).last().click();
  await page.waitForTimeout(6000);
}

const results = [];
for (const spec of specs) {
  const tag = `${spec.billNo} · ${spec.payTo} · $${total(spec).toFixed(2)}`;
  try {
    const existing = await findBill(spec.jobId, spec.billNo);
    if (existing) { results.push(`SKIP already exists (id ${existing.id}) ${tag}`); continue; }
    await createOne(spec);
    if (!SAVE) { results.push(`DRY filled, not saved ${tag}`); continue; }
    const made = await findBill(spec.jobId, spec.billNo);
    if (!made) throw new Error('saved but not found among the job bills');
    if (Math.abs(Number(made.paymentAmount?.value) - total(spec)) > 0.005) throw new Error(`saved with amount ${made.paymentAmount?.value}`);
    if (PAY) await pay(spec.jobId, made.id);
    const after = await findBill(spec.jobId, spec.billNo);
    results.push(`OK id ${made.id} ${tag} · paid ${after?.amountPaid?.value ?? after?.amountPaid} on ${String(after?.datePaid).slice(0, 10)} · ${(after?.costCodes || []).join(', ')}`);
  } catch (e) {
    results.push(`FAILED ${tag}: ${String(e.message).split('\n')[0]}`);
    const snap = await page.evaluate(() => {
      const sel = (id) => document.getElementById(id)?.closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent ?? null;
      return { payTo: sel('performingUserId'), misc: document.getElementById('miscPaidToName')?.value ?? null,
        dialogs: [...document.querySelectorAll('.ant-modal-content, [role="dialog"]')].map((d) => d.innerText.replace(/\s+/g, ' ').slice(0, 400)),
        dropdown: [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].map((o) => o.innerText.trim()).slice(0, 15) };
    }).catch(() => ({}));
    log('FAIL STATE B64:' + Buffer.from(JSON.stringify(snap, null, 1)).toString('base64'));
  }
}
log('RESULTS B64:' + Buffer.from(results.join('\n')).toString('base64'));
log(results.map((r) => r.split(' ')[0]).join(' '));
await browser.close();
