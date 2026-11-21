-- =============================================================================
-- 0059 — Vendor invoices are checked against the bills already in Buildertrend before anything else (Victor,
-- 11/20/26: "confere se já não estão no buildertrend, pq fizemos alguns via builder trend"). Until checked, no
-- question to Camila and no bill. Found → status 'in_bt' with the bills found.
-- =============================================================================
alter table ops.vendor_invoices drop constraint if exists vendor_invoices_status_check;
alter table ops.vendor_invoices add constraint vendor_invoices_status_check
  check (status in ('new', 'not_invoice', 'needs_review', 'ready', 'creating', 'created', 'duplicate', 'error', 'ignored', 'in_bt'));
alter table ops.vendor_invoices add column if not exists bt_checked_at timestamptz;
alter table ops.vendor_invoices add column if not exists bt_found jsonb;
-- I2426 (Camila re-entered it herself) counts as checked.
update ops.vendor_invoices set bt_checked_at = now() where invoice_number = 'I2426' and bt_checked_at is null;

create or replace function ops.dispatch_bt_post_if_queued() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from ops.outbound_messages m left join ops.jobs j on j.id = m.job_id
              where m.status = 'draft' and (m.channel = 'bt_lead' or (m.channel = 'bt_daily_log' and j.bt_job_id is not null)))
     or exists (select 1 from ops.warranty_claims w join ops.jobs j on j.id = w.job_id
                where w.bt_claim_id is null and w.bt_attempts < 5 and j.bt_job_id is not null)
     or exists (select 1 from ops.vendor_invoices v where v.is_invoice and v.bt_checked_at is null
                and v.status in ('needs_review', 'ready', 'duplicate'))
     or exists (select 1 from ops.vendor_invoice_lines l join ops.vendor_invoices v on v.id = l.invoice_id
                where v.status in ('ready', 'creating') and v.bt_checked_at is not null and not l.excluded and l.bt_bill_id is null and l.bt_status is null) then
    perform ops.dispatch_workflow('ops-bt-post.yml');
  end if;
end $$;
revoke all on function ops.dispatch_bt_post_if_queued() from public, anon, authenticated;
