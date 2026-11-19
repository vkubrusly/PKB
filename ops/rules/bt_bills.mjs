#!/usr/bin/env node
// =============================================================================
// bt_bills.mjs — vendor invoices with status 'ready' (rules/vendor_invoices.mjs) → one DRAFT bill per job in
// Buildertrend (Victor, 2026-11-19: "VAMOS MANTER SAVE TO DRAFT").
// Each bill: Pay to = the vendor (an existing Sub/Vendor; never creates one), Bill # = the invoice number,
// Title "<vendor> <invoice #>", invoice / due dates, one cost line (cost code by vendor, config/vendor_bills.json,
// or the one Camila named) with the amount of that job, the invoice file attached, "Send to QuickBooks" OFF
// (another process handles QuickBooks). Lines Camila said to bill without a house go to the general job.
// A line is marked 'creating' before Save; a run that dies after Save leaves it 'unknown' — never retried by
// itself, so no bill is created twice.
//   node rules/bt_bills.mjs                          (dry run: fills the first form, does not save)
//   node rules/bt_bills.mjs --post [--invoice <number>] [--job 0016] [--limit 1]
// =============================================================================
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, q, orgId } from './lib.mjs';
import { downloadObject } from '../scripts/sb.mjs';
import { openBuildertrend } from '../collectors/buildertrend/session.mjs';

const POST = process.argv.includes('--post');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const LIMIT = Number(arg('--limit') || 40), ONLY_INV = arg('--invoice'), ONLY_JOB = arg('--job');
const CFG = JSON.parse(readFileSync(new URL('../config/vendor_bills.json', import.meta.url), 'utf8'));
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mdy = (d) => (d ? `${String(d).slice(5, 7)}/${String(d).slice(8, 10)}/${String(d).slice(0, 4)}` : null);

const org = await orgId();
const lines = await sql(`select l.*, v.vendor, v.invoice_number, v.invoice_date, v.due_date, v.total, v.file_path, v.file_name, v.cost_code inv_cost_code,
    j.bt_job_id, (select count(*) from ops.vendor_invoice_lines x where x.invoice_id = v.id and not x.excluded) n_lines
  from ops.vendor_invoice_lines l join ops.vendor_invoices v on v.id = l.invoice_id left join ops.jobs j on j.id = l.job_id
  where v.org_id = ${q(org)} and v.status in ('ready', 'creating') and not l.excluded and l.bt_bill_id is null
    and coalesce(l.bt_status, '') not in ('creating', 'unknown', 'created')
    ${ONLY_INV ? `and v.invoice_number = ${q(ONLY_INV)}` : ''} ${ONLY_JOB ? `and l.job_number = ${q(ONLY_JOB)}` : ''}
  order by v.received_at, l.job_number nulls last limit ${LIMIT}`);
if (!lines.length) { console.log('bt_bills: nothing ready'); process.exit(0); }

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('Buildertrend session expired'); await browser.close(); process.exit(1); }
const dir = mkdtempSync(join(tmpdir(), 'bills-'));
const files = new Map();
const hide = () => page.evaluate(() => document.getElementById('chmln-dom')?.remove()).catch(() => {});

async function pick(id, text) {
  const box = page.locator(`[id="${id}"]`).first();
  await box.click({ force: true }); await page.waitForTimeout(600);
  await box.fill(text); await page.waitForTimeout(2000);
  const opts = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option');
  const all = await opts.allInnerTexts();
  const k = all.findIndex((t) => t.toLowerCase().includes(text.toLowerCase()) && !/^Create /i.test(t.trim()) && !/Inactive/i.test(t));
  if (k < 0) { await page.keyboard.press('Escape'); return null; }
  await opts.nth(k).click({ force: true }); await page.waitForTimeout(600);
  return all[k].replace(/\s+/g, ' ').trim();
}
async function setDate(id, d) {
  if (!d) return;
  const box = page.locator(`[id="${id}"]`).first();
  await box.click({ force: true }); await box.fill(mdy(d)); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
}

let made = 0, failed = 0;
for (const l of lines) {
  const btJob = l.general ? CFG.general_bt_job : l.bt_job_id;
  const tag = `${l.vendor} #${l.invoice_number} · ${l.general ? 'GERAL' : l.job_number} · ${money(l.bill_amount)}`;
  const code = l.inv_cost_code || CFG.cost_codes[String(l.vendor || '').toLowerCase()];
  const fail = async (msg) => { failed++; console.error(`FAILED ${tag}: ${msg}`); if (POST) await sql(`update ops.vendor_invoice_lines set bt_status = 'error', bt_error = ${q(msg.slice(0, 500))} where id = ${q(l.id)}`); };
  if (!btJob) { await fail('no Buildertrend job'); continue; }
  if (!code) { await fail(`no cost code for vendor "${l.vendor}" (config/vendor_bills.json or Camila's answer)`); continue; }
  try {
    if (!files.has(l.file_path)) { const p = join(dir, l.file_name || 'invoice.pdf'); writeFileSync(p, await downloadObject('ops-invoices', l.file_path)); files.set(l.file_path, p); }
    await page.goto(`https://buildertrend.net/app/Bills?jobId=${btJob}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.locator('button[aria-label="Create new Bill"]').first().waitFor({ timeout: 60000 });
    await hide();
    await page.locator('button[aria-label="Create new Bill"]').first().click();
    await page.locator('#billTitle').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2000); await hide();
    const jobName = await page.locator('[id="selectedJobId"]').locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').innerText().catch(() => '');
    if (!l.general && l.job_number && !jobName.includes(l.job_number)) throw new Error(`form opened on another job (${jobName.trim()})`);

    await page.locator('#billTitle').fill(`${l.vendor} ${l.invoice_number}`);
    await page.locator('#billNumber').fill(String(l.invoice_number));
    const payTo = await pick('performingUserId', l.vendor);
    if (!payTo) throw new Error(`Pay to "${l.vendor}" is not a Sub/Vendor in Buildertrend`);
    await setDate('invoiceDate', l.invoice_date);
    await setDate('unifiedDeadlineRequest', l.due_date);
    const desc = `${l.address || l.label || ''} — ${l.n_lines > 1 ? `part of invoice ${l.invoice_number} (total ${money(l.total)}, split by house)` : `invoice ${l.invoice_number}`}${Number(l.fee_share) ? `; includes ${money(l.fee_share)} of invoice-wide fees` : ''}. Created by PKB Ops.`;
    const ed = page.locator('.ant-form-item:has(label:text-is("Description")) [contenteditable="true"]').first();
    if (await ed.count()) { await ed.click(); await page.keyboard.insertText(desc); }

    // The cost line: open item 1, title, cost code, builder cost.
    await page.locator('button[aria-label^="Open "]').first().click();
    await page.locator('#costCodeId').first().waitFor({ timeout: 20000 });
    await page.locator('#itemTitle').fill(`${l.label ? `${l.label} ` : ''}${l.address || ''}`.trim().slice(0, 100) || `${l.vendor} ${l.invoice_number}`);
    const cc = await pick('costCodeId', code);
    if (!cc) throw new Error(`cost code "${code}" not found`);
    const bc = page.locator('#builderCost').first();
    await bc.click({ clickCount: 3 }); await bc.fill(String(Number(l.bill_amount).toFixed(2))); await page.keyboard.press('Tab');
    await page.waitForTimeout(800);
    await page.locator('button[aria-label="Close line item"]').first().click().catch(() => {});
    await page.waitForTimeout(800);

    // QuickBooks: never send on save.
    const qb = page.locator('#sendToAccounting').first();
    if (await qb.isChecked().catch(() => false)) await qb.click({ force: true });
    if (await qb.isChecked().catch(() => false)) throw new Error('could not turn off "Send to QuickBooks"');

    // Attachment: Attachments → Add → (menu) → file chooser.
    const addBtn = page.locator('.ant-form-item:has-text("Attachments"), section:has-text("Attachments"), div:has(> h3:text-is("Attachments"))').getByRole('button', { name: /^Add$/ }).first();
    const attachBtn = (await addBtn.count()) ? addBtn : page.getByRole('button', { name: /^Add$/ }).last();
    let chooser = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
    await attachBtn.click();
    let fc = await chooser;
    if (!fc) {
      const item = page.locator('.ant-dropdown:not(.ant-dropdown-hidden) [role="menuitem"], .ant-dropdown:not(.ant-dropdown-hidden) li').filter({ hasText: /computer|upload|browse|device/i }).first();
      chooser = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
      await item.click().catch(() => {});
      fc = await chooser;
    }
    if (!fc) throw new Error('attachment: no file chooser after Attachments → Add');
    await fc.setFiles(files.get(l.file_path));
    await page.waitForTimeout(6000);
    const attached = await page.getByText(l.file_name || 'invoice.pdf', { exact: false }).count();
    if (!attached) throw new Error('attachment did not show on the form');

    const total = (await page.locator('text=/Total:/').locator('xpath=..').innerText().catch(() => '')).replace(/\s+/g, ' ');
    console.log(`${POST ? 'SAVING' : 'FILLED (dry run, not saved)'} ${tag} · job "${jobName.trim()}" · pay to ${payTo} · cost code ${cc} · ${total} · QuickBooks off · file attached`);
    if (!POST) break;

    await sql(`update ops.vendor_invoice_lines set bt_status = 'creating', bt_error = null where id = ${q(l.id)}; update ops.vendor_invoices set status = 'creating' where id = ${q(l.invoice_id)}`);
    let billId = null;
    const onResp = async (r) => { if (r.request().method() !== 'GET' && /\/bills/i.test(r.url())) { const j = await r.json().catch(() => null); const id = j?.data?.id ?? j?.id ?? j?.billId; if (Number(id) > 0) billId = Number(id); } };
    page.on('response', onResp);
    await page.getByRole('button', { name: /^Save draft$/ }).first().click();
    await page.waitForFunction(() => /\/Bill\/[1-9]\d*/.test(location.href), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    page.off('response', onResp);
    const m = /\/Bill\/(\d+)/.exec(page.url());
    if (!billId && m && m[1] !== '0') billId = Number(m[1]);
    const err = await page.locator('.ant-form-item-explain-error, .ant-message-error').allInnerTexts().catch(() => []);
    if (err.length) throw new Error(`Buildertrend did not save: ${err.join('; ')}`);
    if (!billId) { await sql(`update ops.vendor_invoice_lines set bt_status = 'unknown', bt_error = 'saved? no bill id seen — check in Buildertrend' where id = ${q(l.id)}`); failed++; console.error(`UNKNOWN ${tag}: no bill id after Save draft`); continue; }
    await sql(`update ops.vendor_invoice_lines set bt_bill_id = ${billId}, bt_status = 'created' where id = ${q(l.id)}`);
    made++;
    console.log(`CREATED draft bill ${billId} · ${tag} · https://buildertrend.net/app/Bills/Bill/${billId}/${btJob}`);
  } catch (e) {
    await fail(e.message);
    if (!POST) break;
  }
}
// An invoice whose lines all have a bill → created.
if (POST) await sql(`update ops.vendor_invoices v set status = 'created', updated_at = now() where v.status in ('ready', 'creating')
  and not exists (select 1 from ops.vendor_invoice_lines l where l.invoice_id = v.id and not l.excluded and l.bt_bill_id is null)`);
await browser.close();
console.log(`bt_bills: ${made} created · ${failed} failed${POST ? '' : ' · DRY RUN'}`);
