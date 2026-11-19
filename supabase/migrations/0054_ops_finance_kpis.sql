-- =============================================================================
-- 0054 — KPI of late invoices (Victor, 11/19/26). Owners only (ops.require_finance).
-- Late invoice = a QuickBooks customer invoice past its due date with a balance still open.
--   now:    count, amount, aging (1–30, 31–60, 61–90, 90+ days), amount-weighted average days late, oldest;
--   paid in the last 90 days: % paid by the due date, median days from due date to payment;
--   trend:  late invoices every 7 days over the last 26 weeks — an invoice counts on a day when its due date
--           had passed and it was not fully paid yet (latest linked customer payment); past days use the full
--           invoice amount (partial payments are not dated per invoice);
--   also:   draws whose trigger passed with no invoice (ops.qbo_draws_core) — ends once Buildertrend issues
--           every draw automatically.
-- =============================================================================

create or replace function public.ops_finance_kpis()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me jsonb := ops.require_finance();
  dd jsonb := ops.qbo_draws_core();
  res jsonb;
begin
  with inv as (
    select r.qbo_id, r.doc_number, r.party, r.txn_date, coalesce(r.due_date, r.txn_date) as due, r.total, coalesce(r.balance, 0) as balance,
      (select max(p.txn_date) from ops.qbo_records p, jsonb_array_elements(case when jsonb_typeof(p.data -> 'Line') = 'array' then p.data -> 'Line' else '[]' end) pl,
              jsonb_array_elements(case when jsonb_typeof(pl.value -> 'LinkedTxn') = 'array' then pl.value -> 'LinkedTxn' else '[]' end) t
        where p.entity = 'Payment' and not p.deleted and t.value ->> 'TxnType' = 'Invoice' and t.value ->> 'TxnId' = r.qbo_id) as last_payment
    from ops.qbo_records r
    where r.entity = 'Invoice' and not r.deleted and coalesce(r.total, 0) > 0
  ), paid as (
    select i.*, case when i.balance = 0 then coalesce(i.last_payment, i.txn_date) end as paid_on from inv i
  ), late as (
    select p.*, current_date - p.due as days_late from paid p where p.balance > 0 and p.due < current_date
  ), pts as (
    select (current_date - 7 * g)::date as d from generate_series(0, 25) g
  ), nd as (   -- draws not issued
    select (d.value ->> 'expected_amount')::numeric as expected
    from jsonb_array_elements(case when jsonb_typeof(dd -> 'houses') = 'array' then dd -> 'houses' else '[]' end) h,
         jsonb_array_elements(case when jsonb_typeof(h.value -> 'due_not_invoiced') = 'array' then h.value -> 'due_not_invoiced' else '[]' end) d
  )
  select jsonb_build_object(
    'as_of', current_date,
    'late_count', (select count(*) from late),
    'late_amount', coalesce((select sum(balance) from late), 0),
    'open_count', (select count(*) from paid where balance > 0),
    'open_amount', coalesce((select sum(balance) from paid where balance > 0), 0),
    'avg_days_late', (select round(sum(balance * days_late) / nullif(sum(balance), 0)) from late),
    'oldest', (select jsonb_build_object('invoice', doc_number, 'party', party, 'days_late', days_late, 'balance', balance) from late order by days_late desc limit 1),
    'aging', (select jsonb_agg(jsonb_build_object('bucket', b.label, 'amount', coalesce(x.amount, 0), 'count', coalesce(x.n, 0)) order by b.ord)
              from (values (1, '1–30', 1, 30), (2, '31–60', 31, 60), (3, '61–90', 61, 90), (4, '90+', 91, 100000)) b(ord, label, lo, hi)
              left join lateral (select sum(balance) amount, count(*) n from late where days_late between b.lo and b.hi) x on true),
    'paid_90d', (select jsonb_build_object('count', count(*),
                   'on_time_pct', round(100.0 * count(*) filter (where paid_on <= due) / nullif(count(*), 0), 1),
                   'median_days_after_due', percentile_cont(0.5) within group (order by greatest(paid_on - due, 0)))
                 from paid where paid_on is not null and paid_on > current_date - 90),
    'trend', (select jsonb_agg(jsonb_build_object('date', w.d,
                 'count', (select count(*) from paid p where p.txn_date <= w.d and p.due < w.d and (p.paid_on is null or p.paid_on > w.d)),
                 'amount', coalesce((select sum(case when w.d = current_date then p.balance else p.total end) from paid p
                                     where p.txn_date <= w.d and p.due < w.d and (p.paid_on is null or p.paid_on > w.d)), 0))
               order by w.d) from pts w),
    'late', coalesce((select jsonb_agg(jsonb_build_object('invoice', doc_number, 'party', party, 'billed', txn_date, 'due', due, 'total', total, 'balance', balance, 'days_late', days_late) order by days_late desc) from late), '[]'),
    'not_issued', jsonb_build_object('count', (select count(*) from nd), 'expected_amount', coalesce((select sum(expected) from nd), 0))
  ) into res;
  return res;
end $$;
revoke all on function public.ops_finance_kpis() from public, anon;
grant execute on function public.ops_finance_kpis() to authenticated;
