-- =============================================================================
-- 0061 — Finance → Payments received for a chosen period (Victor, 11/21/26: "colocar só as 15 primeiras, opção
-- de expandir, e poder escolher o período"). Same rows as ops_finance_overview().payments, between two dates;
-- partners with finance access only (ops.require_finance). The page shows 15 and expands to all.
-- =============================================================================
create or replace function public.ops_finance_payments(p_from date, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_finance(); d_to date := coalesce(p_to, (now() at time zone 'America/New_York')::date);
begin
  return jsonb_build_object(
    'from', p_from, 'to', d_to,
    'total', (select coalesce(sum(total), 0) from ops.qbo_records where entity = 'Payment' and not deleted and txn_date between p_from and d_to),
    'count', (select count(*) from ops.qbo_records where entity = 'Payment' and not deleted and txn_date between p_from and d_to),
    'payments', (select coalesce(jsonb_agg(p order by p.txn_date desc, p.qbo_id desc), '[]') from (
        select r.qbo_id, r.txn_date, r.party, r.total, r.doc_number,
          (select jsonb_agg(distinct i.doc_number) from jsonb_array_elements(coalesce(r.data->'Line', '[]')) l,
             jsonb_array_elements(coalesce(l->'LinkedTxn', '[]')) t left join ops.qbo_records i on i.entity = 'Invoice' and i.qbo_id = t->>'TxnId'
            where t->>'TxnType' = 'Invoice') invoices,
          (r.data->>'UnappliedAmt')::numeric unapplied
        from ops.qbo_records r where r.entity = 'Payment' and not r.deleted and r.txn_date between p_from and d_to
        order by r.txn_date desc limit 2000) p)
  );
end $$;
revoke all on function public.ops_finance_payments(date, date) from public, anon;
grant execute on function public.ops_finance_payments(date, date) to authenticated;
