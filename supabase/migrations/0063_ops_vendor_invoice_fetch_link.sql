-- =============================================================================
-- 0063 — "abre o link para baixar o PDF" (Victor, 11/21/26): an invoice e-mail that came with a link only (Intuit,
-- InvoiceSimple…) can be fetched by the robot's browser when the answer asks for it (rules/invoice_links.mjs in
-- ops-bt-post). fetch_requested_at marks the request; ops-bt-post is dispatched for it.
-- =============================================================================
alter table ops.vendor_invoices add column if not exists fetch_requested_at timestamptz;
alter table ops.vendor_invoices add column if not exists fetch_error text;

create or replace function ops.dispatch_bt_post_if_queued() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from ops.outbound_messages m left join ops.jobs j on j.id = m.job_id
              where m.status = 'draft' and (m.channel = 'bt_lead' or (m.channel = 'bt_daily_log' and j.bt_job_id is not null)))
     or exists (select 1 from ops.warranty_claims w join ops.jobs j on j.id = w.job_id
                where w.bt_claim_id is null and w.bt_attempts < 5 and j.bt_job_id is not null)
     or exists (select 1 from ops.vendor_invoices v where v.is_invoice and v.bt_checked_at is null
                and v.status in ('needs_review', 'ready', 'duplicate'))
     or exists (select 1 from ops.vendor_invoices v where v.fetch_requested_at is not null and v.file_path = '(no file)')
     or exists (select 1 from ops.vendor_invoice_lines l join ops.vendor_invoices v on v.id = l.invoice_id
                where v.status in ('ready', 'creating') and v.bt_checked_at is not null and not l.excluded and l.bt_bill_id is null and l.bt_status is null) then
    perform ops.dispatch_workflow('ops-bt-post.yml');
  end if;
end $$;
revoke all on function ops.dispatch_bt_post_if_queued() from public, anon, authenticated;
