-- =============================================================================
-- 0058 — ops-bt-post also creates the draft bills of vendor invoices that are ready (rules/bt_bills.mjs,
-- Victor 11/19/26). A ready invoice line without a bill counts as "queued" for the hourly dispatch.
-- =============================================================================
create or replace function ops.dispatch_bt_post_if_queued() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from ops.outbound_messages m left join ops.jobs j on j.id = m.job_id
              where m.status = 'draft' and (m.channel = 'bt_lead' or (m.channel = 'bt_daily_log' and j.bt_job_id is not null)))
     or exists (select 1 from ops.warranty_claims w join ops.jobs j on j.id = w.job_id
                where w.bt_claim_id is null and w.bt_attempts < 5 and j.bt_job_id is not null)
     or exists (select 1 from ops.vendor_invoice_lines l join ops.vendor_invoices v on v.id = l.invoice_id
                where v.status in ('ready', 'creating') and not l.excluded and l.bt_bill_id is null and l.bt_status is null) then
    perform ops.dispatch_workflow('ops-bt-post.yml');
  end if;
end $$;
revoke all on function ops.dispatch_bt_post_if_queued() from public, anon, authenticated;
