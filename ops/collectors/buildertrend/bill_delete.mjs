#!/usr/bin/env node
// bill_delete.mjs — delete specific Buildertrend bills Victor asked to delete (11/20/26: the two earlier BILL-I2426
// drafts, 127403452 on 0016 and 127419884 on the general job, replaced by the 35 split bills). Only the ids in
// ALLOWED, only when the open bill shows the expected bill #, and never a bill PKB Ops created
// (ops.vendor_invoice_lines.bt_bill_id). Without --delete it only opens and prints.
//   node collectors/buildertrend/bill_delete.mjs [--delete]
import { openBuildertrend } from './session.mjs';
import { sql } from '../../scripts/sb.mjs';

const ALLOWED = [{ billId: 127403452, jobId: 43923068, number: 'I2426' }, { billId: 127419884, jobId: 41763140, number: 'I2426' }];
const DELETE = process.argv.includes('--delete');
const ours = new Set((await sql(`select bt_bill_id from ops.vendor_invoice_lines where bt_bill_id is not null`)).map((r) => Number(r.bt_bill_id)));
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
for (const b of ALLOWED) {
  if (ours.has(b.billId)) { console.log(`${b.billId}: created by PKB Ops — not deleted`); continue; }
  await page.goto(`https://buildertrend.net/app/Bills/Bill/${b.billId}/${b.jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const ok = await page.locator('#billNumber').first().waitFor({ timeout: 60000 }).then(() => true).catch(() => false);
  if (!ok) { console.log(`${b.billId}: bill did not open (already deleted?)`); continue; }
  await page.waitForTimeout(4000);
  const num = await page.locator('#billNumber').first().inputValue().catch(() => '');
  const title = await page.locator('#billTitle').first().inputValue().catch(() => '');
  const total = (await page.locator('text=/Total:/').first().locator('xpath=..').innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log(`${b.billId}: bill # "${num}" · title "${title}" · ${total}`);
  if (!num.toUpperCase().includes(b.number)) { console.log(`${b.billId}: bill # is not ${b.number} — not deleted`); continue; }
  if (!DELETE) continue;
  await page.evaluate(() => document.getElementById('chmln-dom')?.remove()).catch(() => {});
  await page.getByRole('button', { name: /^Delete$/ }).last().click();
  await page.waitForTimeout(1500);
  const confirm = page.locator('.ant-modal-confirm, .ant-popover:not(.ant-popover-hidden), .ant-modal-content').last();
  console.log(`  confirm: ${(await confirm.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`);
  await confirm.getByRole('button', { name: /^(Delete|Yes|OK|Confirm)$/i }).first().click();
  await page.waitForTimeout(5000);
  // Gone? Open it again.
  await page.goto(`https://buildertrend.net/app/Bills/Bill/${b.billId}/${b.jobId}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const still = await page.locator('#billNumber').first().waitFor({ timeout: 20000 }).then(async () => (await page.locator('#billNumber').first().inputValue().catch(() => '')).toUpperCase().includes(b.number)).catch(() => false);
  console.log(`${b.billId}: ${still ? 'STILL THERE — check' : 'DELETED'}`);
}
await browser.close();
