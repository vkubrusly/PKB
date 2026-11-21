-- =============================================================================
-- 0064 — Finance → Vendor invoices: "Dismiss" takes an item out of "Needs attention" when it was solved some other
-- way (Victor, 11/21/26). The invoice becomes 'ignored' (the robot does nothing more with it), failed bill lines
-- are marked 'dismissed', and who dismissed it (and why) is kept on the invoice. Finance partners only.
-- =============================================================================
create or replace function public.ops_vendor_invoice_dismiss(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_finance();
begin
  update ops.vendor_invoice_lines set bt_status = 'dismissed' where invoice_id = p_id and bt_status in ('error', 'unknown');
  update ops.vendor_invoices set status = case when status in ('needs_review', 'duplicate', 'error') then 'ignored' else status end,
      fetch_requested_at = null,
      answer = coalesce(answer || ' · ', '') || 'dispensada por ' || coalesce(me->>'name', me->>'email') || ' em '
               || to_char(now() at time zone 'America/New_York', 'MM/DD/YY') || coalesce(': ' || nullif(trim(p_note), ''), ''),
      updated_at = now()
    where id = p_id;
  if not found then raise exception 'invoice not found'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.ops_vendor_invoice_dismiss(uuid, text) from public, anon;
grant execute on function public.ops_vendor_invoice_dismiss(uuid, text) to authenticated;
