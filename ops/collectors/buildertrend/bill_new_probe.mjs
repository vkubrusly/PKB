#!/usr/bin/env node
// bill_new_probe.mjs — READ-ONLY: opens the "New → Bill" form of a job and prints its controls (ids, names,
// labels, placeholders, buttons) and what the Pay-to and Cost-code pickers offer for a search text. Closes the
// browser without saving: creates nothing.
//   BT_COOKIES_FILE=… node collectors/buildertrend/bill_new_probe.mjs <jobId> "<pay-to search>" "<cost code search>"
import { openBuildertrend } from './session.mjs';

const [jobId, payTo = 'RC Site', code = 'Portable'] = process.argv.slice(2);
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
const calls = [];
page.on('response', async (r) => { const u = r.url(); if (/buildertrend\.net\/apix?\//.test(u) && /json/.test(r.headers()['content-type'] || '') && !/datadog|sentry|menu\/|GlobalInfo|context\/init|Notifications|WhatsNew|Filters\/|GridViews|jobpicker|jobsites\/|tab-counts|grid/i.test(u)) calls.push(`${r.request().method()} ${r.status()} ${u.slice(0, 180)}\n  req: ${(r.request().postData() || '').slice(0, 500)}\n  res: ${(await r.text().catch(() => '')).slice(0, 2500)}`); });
await page.goto(`https://buildertrend.net/app/Bills?jobId=${jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(10000);
calls.length = 0;
// "Bill" button (aria-label "Create new Bill") on the job's Bills page.
await page.locator('button[aria-label="Create new Bill"]').first().click().catch((e) => console.log('Create new Bill:', e.message));
await page.waitForTimeout(12000);
console.log(`url: ${page.url()}`);
const controls = await page.evaluate(() => [...document.querySelectorAll('input, textarea, select, button, [role="combobox"]')].filter((e) => e.offsetParent !== null).map((e) => {
  const lab = e.id ? document.querySelector(`label[for="${e.id}"]`)?.innerText : '';
  return `${e.tagName.toLowerCase()} id=${e.id || ''} name=${e.getAttribute('name') || ''} type=${e.getAttribute('type') || ''} role=${e.getAttribute('role') || ''} ph=${e.getAttribute('placeholder') || ''} label=${(lab || e.getAttribute('aria-label') || '').trim()} text=${(e.innerText || e.value || '').trim().slice(0, 40)}`;
}));
console.log(`===== form controls =====\n${controls.join('\n')}`);
// Pickers: type in Pay to and Cost code, print the options (Escape afterwards).
console.log(`===== form text =====\n${(await page.locator('.ant-modal-content, .ant-drawer-content, [role="dialog"]').last().innerText().catch(() => '')).slice(0, 3000)}`);
for (const [label, text] of [['Pay to', payTo], ['Cost code', code]]) {
  const box = page.locator(`input[id*="${label === 'Pay to' ? 'payTo' : 'costCode'}" i], input[aria-label*="${label}" i], .ant-form-item:has(label:text-is("${label}")) input`).first();
  if (!(await box.count())) { console.log(`${label}: input not found by id/aria`); continue; }
  await box.click({ force: true }).catch(() => {}); await box.fill(text).catch(() => {}); await page.waitForTimeout(2500);
  const opts = await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-tree-treenode').allInnerTexts().catch(() => []);
  console.log(`===== ${label} options for "${text}" =====\n${opts.slice(0, 20).join('\n')}`);
  await page.keyboard.press('Escape');
}
const full = await page.locator('.ant-modal-content, .ant-drawer-content, [role="dialog"]').last().innerText().catch(() => '');
console.log('FORM B64:' + Buffer.from(full.slice(0, 12000)).toString('base64'));
console.log('CONTROLS B64:' + Buffer.from(controls.join('\n')).toString('base64'));
console.log('CALLS B64:' + Buffer.from(calls.join('\n\n').slice(0, 60000)).toString('base64'));
console.log(`===== JSON calls while the form loaded =====\n${calls.slice(0, 20).join('\n')}`);
await browser.close();
