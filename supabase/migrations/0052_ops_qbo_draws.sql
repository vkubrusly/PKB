-- =============================================================================
-- 0052 — Draws (installments) per house, from the QuickBooks invoices. Owners only (ops.require_finance).
-- PKB's standard draw schedule (Victor, 11/18/26): 1st 10% · 2nd 32% · 3rd 17% · 4th 18% · 5th 20% · 6th 3%.
-- The stage comes from the invoice's message to the customer (CustomerMemo), e.g. "Second Installment (32%)",
-- "1st & 2nd Installments", "Last Installment" (= 6th). Invoices without "installment" (change orders, extras
-- only, design fees, address-only memos) are listed apart as other invoices. Paid date = latest customer
-- payment linked to the invoice. Expected amounts use ops.jobs.contract_value × the standard percent.
-- =============================================================================

create or replace function public.ops_qbo_draws(p_job text default null, p_open_only boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me jsonb := ops.require_finance();
  std numeric[] := array[10, 32, 17, 18, 20, 3];
  jn text := case when nullif(trim(coalesce(p_job, '')), '') is null then null
                  else lpad(coalesce(nullif(ltrim(regexp_replace(p_job, '[^0-9]', '', 'g'), '0'), ''), '0'), 4, '0') end;
  res jsonb;
begin
  with inv as (
    select r.qbo_id, r.doc_number, r.party, r.txn_date, r.due_date, r.total, r.balance,
      lpad(substring(r.party from '^0*(\d+) - '), 4, '0') as job,
      coalesce(r.data #>> '{CustomerMemo,value}', '') as memo
    from ops.qbo_records r
    where r.entity = 'Invoice' and not r.deleted and r.party ~ '^\d+ - '
  ), lab as (
    select i.*,
      (select l from regexp_split_to_table(i.memo, E'\n') l where l ~* 'install' limit 1) as label
    from inv i
  ), st as (
    select l.*,
      case when l.label is null or l.label ~* 'change\s+(of\s+)?order' then null else
        (select array_agg(distinct n order by n) from (select case
            when w in ('1st', 'first', 'initial') then 1 when w in ('2nd', 'second', '2o') then 2 when w in ('3rd', 'third') then 3
            when w in ('4th', 'fourth') then 4 when w in ('5th', 'fifth') then 5 when w in ('6th', 'sixth', 'last', 'final') then 6
            when w in ('7th', 'seventh') then 7 end n
         from (select lower(m[1]) w from regexp_matches(l.label, '\m(1st|first|initial|2nd|second|2o|3rd|third|4th|fourth|5th|fifth|6th|sixth|7th|seventh|last|final)\M', 'gi') m) x) y)
      end as stages,
      (regexp_match(l.label, '\((\d+(?:\.\d+)?)%\)'))[1]::numeric as label_pct,
      (select max(p.txn_date) from ops.qbo_records p, jsonb_array_elements(case when jsonb_typeof(p.data -> 'Line') = 'array' then p.data -> 'Line' else '[]' end) pl,
              jsonb_array_elements(case when jsonb_typeof(pl.value -> 'LinkedTxn') = 'array' then pl.value -> 'LinkedTxn' else '[]' end) t
        where p.entity = 'Payment' and not p.deleted and t.value ->> 'TxnType' = 'Invoice' and t.value ->> 'TxnId' = l.qbo_id) as last_payment
    from lab l
  ), j as (
    select s.job, max(s.party) party, max(jb.contract_value) contract, max(jb.address) address, max(jb.status) status
    from st s left join ops.jobs jb on jb.job_number = s.job
    where jn is null or s.job = jn
    group by s.job
  ), per as (
    select j.*,
      (select coalesce(max(x), 0) from st s, unnest(s.stages) x where s.job = j.job) as last_stage,
      (select coalesce(sum(total), 0) from st s where s.job = j.job and s.stages is not null) as billed,
      (select coalesce(sum(balance), 0) from st s where s.job = j.job and s.stages is not null) as open_balance
    from j
  )
  select jsonb_build_object(
    'schedule', 'standard: 1st 10% · 2nd 32% · 3rd 17% · 4th 18% · 5th 20% · 6th 3% (custom contracts may differ: see label_pct)',
    'houses', coalesce(jsonb_agg(jsonb_build_object(
      'job', p.job, 'party', p.party, 'address', p.address, 'status', p.status, 'contract_value', p.contract,
      'draws_billed', p.billed, 'draws_open_balance', p.open_balance,
      'billed_pct_of_contract', case when p.contract > 0 then round(100 * p.billed / p.contract, 1) end,
      'last_stage_billed', nullif(p.last_stage, 0),
      'next_stage', case when p.last_stage < 6 then jsonb_build_object('stage', p.last_stage + 1, 'standard_pct', std[p.last_stage + 1],
                      'expected_amount', case when p.contract > 0 then round(p.contract * std[p.last_stage + 1] / 100, 2) end) end,
      'draws', (select jsonb_agg(jsonb_build_object('stages', s.stages, 'label', s.label, 'label_pct', s.label_pct,
                  'standard_pct', (select sum(std[x]) from unnest(s.stages) x where x <= 6),
                  'expected_amount', case when p.contract > 0 then round(p.contract * (select sum(std[x]) from unnest(s.stages) x where x <= 6) / 100, 2) end,
                  'invoice', s.doc_number, 'billed_on', s.txn_date, 'due', s.due_date, 'amount', s.total, 'balance', s.balance,
                  'paid_on', case when s.balance = 0 then s.last_payment end,
                  'days_open', case when s.balance <> 0 then current_date - coalesce(s.due_date, s.txn_date) end)
                order by s.txn_date, s.doc_number) from st s where s.job = p.job and s.stages is not null),
      'other_invoices', (select jsonb_agg(jsonb_build_object('invoice', s.doc_number, 'label', coalesce(s.label, nullif(split_part(s.memo, E'\n', 1), '')),
                  'billed_on', s.txn_date, 'amount', s.total, 'balance', s.balance) order by s.txn_date)
                from st s where s.job = p.job and s.stages is null)
    ) order by p.job), '[]')
  ) into res
  from per p
  where not coalesce(p_open_only, false) or p.open_balance <> 0;
  return res;
end $$;

revoke all on function public.ops_qbo_draws(text, boolean) from public, anon;
grant execute on function public.ops_qbo_draws(text, boolean) to authenticated;
