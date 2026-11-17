-- =============================================================================
-- 0047 — QuickBooks disconnect (Victor, 2026-11-17). An owner disconnects in the Finance tab, or
-- Intuit sends them to /ops/quickbooks/disconnected after the app was disconnected on the QuickBooks
-- side. The tokens leave Vault, the connection is marked disconnected (who / when) and syncing stops;
-- the data already read stays for history. Idempotent.
-- =============================================================================
alter table ops.qbo_connection add column if not exists disconnected_at timestamptz;
alter table ops.qbo_connection add column if not exists disconnected_by text;

create or replace function public.ops_qbo_disconnect_svc(p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare had boolean;
begin
  select realm_id is not null into had from ops.qbo_connection where id = 1;
  delete from vault.secrets where name in ('pkb_qbo_access_token', 'pkb_qbo_refresh_token');
  update ops.qbo_connection set realm_id = null, access_expires_at = null, refresh_expires_at = null,
    disconnected_at = now(), disconnected_by = p_email where id = 1;
  return jsonb_build_object('was_connected', coalesce(had, false));
end $$;
revoke all on function public.ops_qbo_disconnect_svc(text) from public, anon, authenticated;
grant execute on function public.ops_qbo_disconnect_svc(text) to service_role;

-- a new connection clears the "disconnected" mark (0046 deletes and re-inserts the row, so nothing to do);
-- the overview shows it.
create or replace function public.ops_finance_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_finance(); today date := (now() at time zone 'America/New_York')::date;
begin
  return jsonb_build_object(
    'me', me,
    'connection', (select jsonb_build_object('environment', environment, 'company', company_name, 'connected_by', connected_by, 'connected_at', connected_at,
        'connected', realm_id is not null, 'disconnected_at', disconnected_at, 'disconnected_by', disconnected_by,
        'last_sync_at', last_sync_at, 'last_sync_error', last_sync_error, 'last_webhook_at', last_webhook_at, 'backfilled_at', backfilled_at,
        'refresh_expires_at', refresh_expires_at) from ops.qbo_connection where id = 1),
    'received_30d', (select coalesce(sum(total), 0) from ops.qbo_records where entity = 'Payment' and not deleted and txn_date > today - 30),
    'payments', (select coalesce(jsonb_agg(p order by p.txn_date desc, p.qbo_id desc), '[]') from (
        select r.qbo_id, r.txn_date, r.party, r.total, r.doc_number,
          (select jsonb_agg(distinct i.doc_number) from jsonb_array_elements(coalesce(r.data->'Line', '[]')) l,
             jsonb_array_elements(coalesce(l->'LinkedTxn', '[]')) t left join ops.qbo_records i on i.entity = 'Invoice' and i.qbo_id = t->>'TxnId'
            where t->>'TxnType' = 'Invoice') invoices,
          (r.data->>'UnappliedAmt')::numeric unapplied
        from ops.qbo_records r where r.entity = 'Payment' and not r.deleted and r.txn_date > today - 120 order by r.txn_date desc limit 200) p),
    'open_invoices', (select coalesce(jsonb_agg(i order by i.days_overdue desc nulls last), '[]') from (
        select r.qbo_id, r.doc_number, r.party, r.txn_date, r.due_date, r.total, r.balance,
          today - r.due_date days_overdue   -- negative = days until due; null = no due date
        from ops.qbo_records r where r.entity = 'Invoice' and not r.deleted and coalesce(r.balance, 0) > 0 limit 500) i)
  );
end $$;
