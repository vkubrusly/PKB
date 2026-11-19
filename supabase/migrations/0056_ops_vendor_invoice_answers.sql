-- =============================================================================
-- 0056 — Vendor invoices: Camila's / Victor's e-mail answers (Victor, 2026-11-19). The answer to an
-- "Invoice para revisar" question is read (ops-invoice, mode answer) and applied: an address assigned to a job,
-- a line left out, "pode criar" → ready; "não lançar" → ignored. The cost code they name goes on the bills.
-- =============================================================================
alter table ops.vendor_invoices drop constraint if exists vendor_invoices_status_check;
alter table ops.vendor_invoices add constraint vendor_invoices_status_check
  check (status in ('new', 'not_invoice', 'needs_review', 'ready', 'creating', 'created', 'duplicate', 'error', 'ignored'));
alter table ops.vendor_invoices add column if not exists answer_email_id uuid references ops.inbound_emails(id);
alter table ops.vendor_invoices add column if not exists answered_at timestamptz;
alter table ops.vendor_invoices add column if not exists cost_code text;
alter table ops.vendor_invoice_lines add column if not exists excluded boolean not null default false;
