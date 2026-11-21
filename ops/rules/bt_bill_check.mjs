#!/usr/bin/env node
// =============================================================================
// bt_bill_check.mjs — before PKB Ops asks Camila about a vendor invoice or creates its bills, look for it in
// Buildertrend (Victor, 11/20/26: some invoices were entered by hand in Buildertrend). Reads every bill of the
// builder (collectors/buildertrend/bills_index.mjs, all statuses) and matches by invoice number; a number with
// no letters must also match the vendor. Found → status 'in_bt' (nothing else is done; the bills found are kept
// in bt_found). Not found → bt_checked_at set, and the invoice goes on (question to Camila / draft bills).
// READ-ONLY in Buildertrend.
//   node rules/bt_bill_check.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, orgId } from './lib.mjs';
import { openBuildertrend } from '../collectors/buildertrend/session.mjs';
import { billsIndex } from '../collectors/buildertrend/bills_index.mjs';

const org = await orgId();
const todo = await sql(`select id, vendor, invoice_number, total, status from ops.vendor_invoices where org_id = ${q(org)}
  and is_invoice and bt_checked_at is null and status in ('needs_review', 'ready', 'duplicate') order by received_at`);
if (!todo.length) { console.log('bt_bill_check: nothing to check'); process.exit(0); }

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('Buildertrend session expired'); await browser.close(); process.exit(1); }
const bills = await billsIndex(page, { log: console.log });
await browser.close();
console.log(`Buildertrend bills read: ${bills.length}`);
// The builder has thousands of bills: a short read means the index failed — never mark "not found" on it.
if (bills.length < 500) { console.error('too few bills read — not trusting the check'); process.exit(1); }

const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const STOP = new Set(['the', 'inc', 'llc', 'corp', 'services', 'service', 'and', 'usa', 'business', 'company']);
const vendorWord = (v) => (String(v || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).find((w) => !STOP.has(w)) || '';
// The invoice number as a whole token of the bill # / title: "I2426" in "BILL-I2426" or "Invoice #I2426";
// "146" in "Invoice #146" but not in "1460".
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const numMatch = (n, text) => {
  const ts = tokens(text);
  const digits = n.replace(/^[a-z]+/, '');
  return ts.some((t) => t === n || t === `bill${n}` || (digits && t.replace(/^[a-z]+/, '') === digits && /[a-z]/.test(n) === false));
};

for (const v of todo) {
  const n = alnum(v.invoice_number), vw = vendorWord(v.vendor);
  // No number to look for: cannot be checked here — the question to Camila says so.
  if (!n) { console.log(`no invoice number, cannot look it up: ${v.vendor || '?'}`); if (!DRY) await sql(`update ops.vendor_invoices set bt_checked_at = now(), issues = array_append(issues, 'sem número de invoice: não deu para conferir se já está no Buildertrend') where id = ${q(v.id)}`); continue; }
  const found = bills.filter((b) => {
    if (!numMatch(n, `${b.number} ${b.title}`)) return false;
    // a number without letters (146, 7446) could belong to another vendor: the vendor must match too
    return /[a-z]/.test(n) || !vw || `${b.payTo} ${b.title}`.toLowerCase().includes(vw);
  }).map((b) => ({ id: b.id, jobId: b.jobId, number: b.number, title: b.title, payTo: b.payTo, amount: b.amount }));
  console.log(`${found.length ? 'IN BUILDERTREND' : 'not found'} · ${v.vendor} #${v.invoice_number}${found.length ? ` → ${found.map((f) => `${f.number} "${f.title}" ${f.payTo} $${f.amount}`).join(' | ')}` : ''}`);
  if (DRY) continue;
  if (found.length) await sql(`update ops.vendor_invoices set status = 'in_bt', bt_checked_at = now(), bt_found = ${q(JSON.stringify(found))}::jsonb,
      issues = array[${q(`já lançada no Buildertrend: ${found.map((f) => f.number || f.title).join(', ')}`)}], updated_at = now() where id = ${q(v.id)}`);
  else await sql(`update ops.vendor_invoices set bt_checked_at = now(), updated_at = now() where id = ${q(v.id)}`);
}
