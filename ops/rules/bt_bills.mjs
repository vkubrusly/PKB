#!/usr/bin/env node
// =============================================================================
// bt_bills.mjs — vendor invoices with status 'ready' (rules/vendor_invoices.mjs) → one DRAFT bill per job in
// Buildertrend (Victor, 2026-11-19: "VAMOS MANTER SAVE TO DRAFT").
// Each bill: Pay to = the vendor (an existing Sub/Vendor; never creates one), Bill # = the invoice number,
// Title "<vendor> <invoice #>", invoice / due dates, one cost line (cost code by vendor, config/vendor_bills.json,
// or the one Camila named) with the amount of that job, the invoice file attached; "Send to QuickBooks" left as
// Buildertrend sets it (a draft is not sent — Victor, 11/19/26). Lines Camila said to bill without a house go to the general job.
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
import { vendorCostCode } from './vendor_invoices.mjs';

const POST = process.argv.includes('--post');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const LIMIT = Number(arg('--limit') || 40), ONLY_INV = arg('--invoice'), ONLY_JOB = arg('--job');
const CFG = JSON.parse(readFileSync(new URL('../config/vendor_bills.json', import.meta.url), 'utf8'));
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mdy = (d) => (d ? `${String(d).slice(5, 7)}/${String(d).slice(8, 10)}/${String(d).slice(0, 4)}` : null);

const org = await orgId();
// A line left 'filling' by a run that died before Save was never saved: free it (runs do not overlap — the
// ops-bt-post concurrency group).
if (POST) await sql(`update ops.vendor_invoice_lines set bt_status = null where bt_status = 'filling'`);
const lines = await sql(`select l.*, j.bt_job_name, v.vendor, v.invoice_number, v.invoice_date, v.due_date, v.total, v.file_path, v.file_name, v.cost_code inv_cost_code,
    coalesce(l.bt_job_id, j.bt_job_id) bt_job_id, (select count(*) from ops.vendor_invoice_lines x where x.invoice_id = v.id and not x.excluded) n_lines
  from ops.vendor_invoice_lines l join ops.vendor_invoices v on v.id = l.invoice_id left join ops.jobs j on j.id = l.job_id
  where v.org_id = ${q(org)} and not l.excluded
    ${!POST && ONLY_INV ? '' : `and v.status in ('ready', 'creating') and v.bt_checked_at is not null and l.bt_bill_id is null and l.bt_status is null`}   -- dry run of a named invoice: any line (form test, saves nothing)
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
// Dates: Buildertrend shows them as "Nov 16, 2026"; typed as MM/DD/YYYY they were left empty (bill 127431643,
// 11/19). Type the displayed format, then check the field holds a date — a bill without its dates is not saved.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
async function setDate(id, d) {
  if (!d) return;
  const iso = String(d).slice(0, 10), [y, m, dd] = iso.split('-').map(Number);
  const box = page.locator(`[id="${id}"]`).first();
  for (const txt of [`${MON[m - 1]} ${dd}, ${y}`, mdy(iso)]) {
    await box.click({ force: true }); await box.fill(''); await box.type(txt, { delay: 30 });
    await page.keyboard.press('Enter'); await page.waitForTimeout(500);
    const v = await box.inputValue().catch(() => '');
    if (v && (v.includes(String(y)) || v.includes(String(y).slice(2)))) return;
  }
  throw new Error(`date field ${id} stayed empty (${iso})`);
}

let made = 0, failed = 0;
for (const l of lines) {
  const btJob = l.general ? CFG.general_bt_job : l.bt_job_id;
  const tag = `${l.vendor} #${l.invoice_number} · ${l.general ? 'GERAL' : l.job_number} · ${money(l.bill_amount)}`;
  const code = l.inv_cost_code || await vendorCostCode(org, l.vendor);
  const fail = async (msg) => { failed++; console.error(`FAILED ${tag}: ${msg}`); if (POST) await sql(`update ops.vendor_invoice_lines set bt_status = 'error', bt_error = ${q(msg.slice(0, 500))} where id = ${q(l.id)}`); };
  if (!btJob) { await fail('no Buildertrend job'); continue; }
  // No cost code known: a one-house invoice goes in the way Camila does it (11/21/26) — the PDF dropped on "fill this
  // form" (Buildertrend's bulk upload), the cost codes it suggests kept, only the job, vendor and total checked.
  // An invoice split over several houses still needs a cost code (the upload would put the whole amount on one).
  const ocr = !code && Number(l.n_lines) === 1;
  if (!code && !ocr) { await fail(`no cost code for vendor "${l.vendor}" and the invoice is split over ${l.n_lines} houses`); continue; }
  // Reserve the line (only one run fills a given line; ops-bt-post runs one at a time).
  if (POST && !(await sql(`update ops.vendor_invoice_lines set bt_status = 'filling' where id = ${q(l.id)} and bt_status is null returning id`)).length) { console.log(`skip ${tag}: taken by another run`); continue; }
  try {
    if (!files.has(l.file_path)) { const p = join(dir, l.file_name || 'invoice.pdf'); writeFileSync(p, await downloadObject('ops-invoices', l.file_path)); files.set(l.file_path, p); }
    await page.goto(`https://buildertrend.net/app/Bills?jobId=${btJob}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.locator('button[aria-label="Create new Bill"]').first().waitFor({ timeout: 60000 });
    await hide();
    await page.locator('button[aria-label="Create new Bill"]').first().click();
    await page.locator('#billTitle').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2000); await hide();
    const jobName = await page.locator('[id="selectedJobId"]').locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').innerText().catch(() => '');
    // PRIME jobs have no number in Buildertrend ('PRIME - CT - Belvedere - 519 W DANDEE PL'): the job name counts too.
    const sameJob = (n) => n.includes(l.job_number) || (l.bt_job_name && n.toLowerCase().includes(String(l.bt_job_name).slice(0, 30).toLowerCase()));
    if (!l.general && l.job_number && !sameJob(jobName)) throw new Error(`form opened on another job (${jobName.trim()})`);

    let payTo, cc;
    if (ocr) {
      // Bulk upload: the "Browse or drop a file to fill this form" input (the first file input; one file, PDF allowed).
      const fillIn = page.locator('input[type="file"]').first();
      if (!/pdf/i.test(await fillIn.getAttribute('accept').catch(() => '') || '')) throw new Error('the "fill this form" upload was not found');
      await fillIn.setInputFiles(files.get(l.file_path));
      const amountOnForm = async () => Number(((await page.locator('text=/Total:/').locator('xpath=..').innerText().catch(() => '')).match(/\$\s?([\d,]+\.\d{2})/) || [])[1]?.replace(/,/g, '') || 0);
      for (let i = 0; i < 40 && !(await amountOnForm()); i++) await page.waitForTimeout(3000);   // Buildertrend reads the PDF
      const got = await amountOnForm();
      if (!got) throw new Error('Buildertrend did not fill the form from the PDF (bulk upload)');
      if (Math.abs(got - Number(l.bill_amount)) > 0.01) throw new Error(`Buildertrend read ${money(got)} from the PDF; the invoice is ${money(l.bill_amount)}`);
      const jobAfter = await page.locator('[id="selectedJobId"]').locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').innerText().catch(() => '');
      if (!l.general && l.job_number && !sameJob(jobAfter)) throw new Error(`after the upload the job is "${jobAfter.trim()}"`);
      // Vendor: keep Buildertrend's when it is this vendor, else pick the vendor.
      const payNow = (await page.locator('[id="performingUserId"]').locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const vw = (String(l.vendor || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).find((w) => !['the', 'inc', 'llc', 'corp', 'services', 'service'].includes(w)) || '';
      payTo = vw && payNow.toLowerCase().includes(vw) ? payNow : await pick('performingUserId', l.vendor);
      if (!payTo) throw new Error(`Pay to "${l.vendor}" is not a Sub/Vendor in Buildertrend (Buildertrend suggested "${payNow}")`);
      if (!(await page.locator('#billNumber').inputValue().catch(() => ''))) await page.locator('#billNumber').fill(String(l.invoice_number));
      if (!(await page.locator('#billTitle').inputValue().catch(() => ''))) await page.locator('#billTitle').fill(`${l.vendor} ${l.invoice_number}`);
      if (!(await page.locator('#invoiceDate').inputValue().catch(() => ''))) await setDate('invoiceDate', l.invoice_date);
      if (!(await page.locator('#unifiedDeadlineRequest').inputValue().catch(() => ''))) await setDate('unifiedDeadlineRequest', l.due_date);
      cc = 'as Buildertrend suggested: ' + ((await page.locator('text=/Costs/').locator('xpath=..').innerText().catch(() => '')).match(/\d{2}\.\d{2}(\.\d{2})?[^\n$]*/g) || ['?']).slice(0, 4).join(' | ');
    } else {
    await page.locator('#billTitle').fill(`${l.vendor} ${l.invoice_number}`);
    await page.locator('#billNumber').fill(String(l.invoice_number));
    payTo = await pick('performingUserId', l.vendor);
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
    cc = await pick('costCodeId', code);
    if (!cc) throw new Error(`cost code "${code}" not found`);
    const bc = page.locator('#builderCost').first();
    await bc.click({ clickCount: 3 }); await bc.fill(String(Number(l.bill_amount).toFixed(2))); await page.keyboard.press('Tab');
    await page.waitForTimeout(800);
    await page.locator('button[aria-label="Close line item"]').first().click().catch(() => {});
    await page.waitForTimeout(800);
    }

    // QuickBooks: "Send to QuickBooks immediately upon save" stays as Buildertrend sets it — a draft is not sent
    // (Victor, 11/19/26).

    // Attachment: Attachments → Add → (menu) → file chooser — unless the bulk upload already attached the PDF.
    const baseName = String(l.file_name || 'invoice.pdf').replace(/\.[^.]+$/, '');
    const preAttached = ocr && (await page.locator('body').getByText(baseName, { exact: false }).count()) > 0;
    if (!preAttached) {
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
    if (!fc) {
      // Fallback: the file input of the Attachments section (not the "drop a file to fill this form" one at the top).
      const inputs = await page.evaluate(() => [...document.querySelectorAll('input[type="file"]')].map((e, i) => {
        let a = e, txt = ''; for (let k = 0; k < 6 && a; k++) { a = a.parentElement; txt = (a?.innerText || '').slice(0, 80).replace(/\s+/g, ' '); if (txt) break; }
        return { i, accept: e.accept, multiple: e.multiple, near: txt };
      }));
      const menus = await page.locator('.ant-dropdown:not(.ant-dropdown-hidden), .ant-popover:not(.ant-popover-hidden), .ant-modal-content').allInnerTexts().catch(() => []);
      console.log(`attachment diagnostics: file inputs ${JSON.stringify(inputs)} · open menus/dialogs: ${menus.map((t) => t.slice(0, 300).replace(/\s+/g, ' ')).join(' || ')}`);
      const k = inputs.findIndex((x) => !/fill this form/i.test(x.near) && /attach|add|upload|browse/i.test(x.near));
      if (k >= 0) { await page.locator('input[type="file"]').nth(inputs[k].i).setInputFiles(files.get(l.file_path)); fc = true; }
    }
    if (!fc) throw new Error('attachment: no file chooser after Attachments → Add');
    if (fc !== true) await fc.setFiles(files.get(l.file_path));
    await page.waitForTimeout(3000);
    // The "Upload Files" dialog: press its Upload button, then the file must be listed on the form itself
    // (Attachments), with the dialog closed.
    const dlg = page.locator('.ant-modal-content:has-text("Upload Files")').last();
    if (await dlg.count()) {
      await dlg.getByRole('button', { name: /^Upload$/ }).first().click();
      await dlg.waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {});
    }
    await page.waitForTimeout(3000);
    if (await page.locator('.ant-modal-content:has-text("Upload Files")').count()) throw new Error('attachment: the Upload Files dialog did not close');
    const base = String(l.file_name || 'invoice.pdf').replace(/\.[^.]+$/, '');
    const attached = await page.locator('.ant-modal-content:not(:has-text("Upload Files")), body').first().getByText(base, { exact: false }).count();
    if (!attached) throw new Error('attachment did not show on the form');
    }

    const total = (await page.locator('text=/Total:/').locator('xpath=..').innerText().catch(() => '')).replace(/\s+/g, ' ');
    console.log(`${POST ? 'SAVING' : 'FILLED (dry run, not saved)'} ${tag} · job "${jobName.trim()}" · pay to ${payTo} · cost code ${cc} · ${total} · file attached`);
    const dates = await page.evaluate(() => ['invoiceDate', 'unifiedDeadlineRequest'].map((i) => document.getElementById(i)?.value));
    if (!POST) { console.log(`dates on the form: invoice ${dates[0]} · due ${dates[1]}`); break; }

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
