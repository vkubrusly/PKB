-- =============================================================================
-- 0053 — Draws: when each one is due (Victor, 11/19/26), and the invoice-text quirks.
-- Triggers (the county evidence that the house reached the point where the draw is billed — PKB template
-- and the billing history):
--   2nd: building permit issued · 3rd: Roof Assembly (Citrus: Roof Sheathing / Roofing Deck) ·
--   4th: Framing (Citrus: Frame) · 5th: Power Release (Citrus: Pre Power) ·
--   6th: Final Structural (Citrus: Building Final) — before the CO.
-- A draw is "due" when its trigger passed and no invoice for that stage exists in QuickBooks.
-- Invoice-text quirks fixed here: a 1st installment whose message is only the address (an invoice without
-- "installment", not a change order, dated before the first labelled draw) counts as the 1st (inferred);
-- an invoice labelled as one stage whose amount equals two consecutive standard stages of the contract
-- counts as both (e.g. "First Installment (10%)" for 42%).
-- ops.qbo_draws_core has no permission check and is not granted to anyone (scripts run it as the owner);
-- public.ops_qbo_draws keeps the owners-only check (ops.require_finance).
-- =============================================================================

create or replace function ops.qbo_draws_core(p_job text default null, p_open_only boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
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
    select i.*, (select l from regexp_split_to_table(i.memo, E'\n') l where l ~* 'install' limit 1) as label
    from inv i
  ), st0 as (
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
        where p.entity = 'Payment' and not p.deleted and t.value ->> 'TxnType' = 'Invoice' and t.value ->> 'TxnId' = l.qbo_id) as last_payment,
      jb.contract_value as contract
    from lab l left join ops.jobs jb on jb.job_number = l.job
  ), first_draw as (
    select job, min(txn_date) d, bool_or(1 = any(stages)) has1 from st0 where stages is not null group by job
  ), st as (
    select s.*,
      case
        when s.stages is null and f.d is not null and not f.has1 and s.txn_date < f.d and s.memo !~* 'change\s+(of\s+)?order|extra|fee|design|retainer|architect'
          then array[1]
        when array_length(s.stages, 1) = 1 and s.stages[1] < 6 and s.contract > 0
             and abs(s.total - s.contract * (std[s.stages[1]] + std[s.stages[1] + 1]) / 100) <= s.contract * 0.005
             and abs(s.total - s.contract * std[s.stages[1]] / 100) > s.contract * 0.005
          then array[s.stages[1], s.stages[1] + 1]
        else s.stages end as stg,
      (s.stages is null and f.d is not null and not f.has1 and s.txn_date < f.d and s.memo !~* 'change\s+(of\s+)?order|extra|fee|design|retainer|architect') as inferred
    from st0 s left join first_draw f on f.job = s.job
  ), ev as (   -- county evidence per job (building permit)
    select j.job_number as job,
      min(c.issued_at)::date as t2,
      min(coalesce(i.actual_at, i.scheduled_at, i.requested_at)) filter (where i.type ~* 'roof assembly|roof sheathing|roofing deck')::date as t3,
      min(coalesce(i.actual_at, i.scheduled_at, i.requested_at)) filter (where i.type ~* '^(framing|frame)\M')::date as t4,
      min(coalesce(i.actual_at, i.scheduled_at, i.requested_at)) filter (where i.type ~* '^(power release|pre power)')::date as t5,
      min(coalesce(i.actual_at, i.scheduled_at, i.requested_at)) filter (where i.type ~* 'final structural|building final')::date as t6
    from ops.jobs j join ops.permit_cases c on c.job_id = j.id and c.kind = 'building'
    left join ops.inspections i on i.permit_case_id = c.id and i.passed
    group by j.job_number
  ), j as (   -- every house with a draw invoice or a building permit issued (PKB numbering; Prime keeps other books)
    select x.job, jb.address, jb.status, jb.company, jb.contract_value contract,
      (select max(party) from st where st.job = x.job) party, e.t2, e.t3, e.t4, e.t5, e.t6
    from (select job from st union select job from ev where t2 is not null) x
    left join ops.jobs jb on jb.job_number = x.job
    left join ev e on e.job = x.job
    where (jn is null or x.job = jn) and x.job ~ '^\d{4}$' and coalesce(jb.company, 'PKB') <> 'Prime'
  ), per as (
    select j.*,
      coalesce((select array_agg(distinct x order by x) from st s, unnest(s.stg) x where s.job = j.job), '{}') as billed_stages,
      (select coalesce(sum(total), 0) from st s where s.job = j.job and s.stg is not null) as billed,
      (select coalesce(sum(balance), 0) from st s where s.job = j.job and s.stg is not null) as open_balance
    from j
  ), due as (
    select p.job, jsonb_agg(jsonb_build_object('stage', d.n, 'standard_pct', std[d.n],
             'expected_amount', case when p.contract > 0 then round(p.contract * std[d.n] / 100, 2) end,
             'trigger', d.what, 'trigger_on', d.at, 'days_since_trigger', current_date - d.at) order by d.n) as due
    from per p cross join lateral (values (2, p.t2, 'building permit issued'), (3, p.t3, 'Roof Assembly passed'), (4, p.t4, 'Framing passed'),
                                          (5, p.t5, 'Power Release passed'), (6, p.t6, 'Final Structural passed')) d(n, at, what)
    where d.at is not null and not (d.n = any(p.billed_stages)) and not coalesce(p.contract > 0 and p.billed >= p.contract, false)   -- fully billed (older splits)
    group by p.job
  )
  select jsonb_build_object(
    'schedule', 'standard: 1st 10% · 2nd 32% · 3rd 17% · 4th 18% · 5th 20% · 6th 3% (custom contracts may differ: see label_pct)',
    'triggers', '2nd: building permit issued · 3rd: Roof Assembly (Citrus Roof Sheathing) · 4th: Framing (Citrus Frame) · 5th: Power Release (Citrus Pre Power) · 6th: Final Structural (Citrus Building Final), before the CO',
    'houses', coalesce(jsonb_agg(jsonb_build_object(
      'job', p.job, 'party', p.party, 'address', p.address, 'status', p.status, 'contract_value', p.contract,
      'draws_billed', p.billed, 'draws_open_balance', p.open_balance,
      'billed_pct_of_contract', case when p.contract > 0 then round(100 * p.billed / p.contract, 1) end,
      'billed_stages', to_jsonb(p.billed_stages),
      'last_stage_billed', (select max(x) from unnest(p.billed_stages) x),
      'triggers_reached', jsonb_strip_nulls(jsonb_build_object('2', p.t2, '3', p.t3, '4', p.t4, '5', p.t5, '6', p.t6)),
      'due_not_invoiced', d.due,
      'next_stage', (select jsonb_build_object('stage', n, 'standard_pct', std[n], 'expected_amount', case when p.contract > 0 then round(p.contract * std[n] / 100, 2) end)
                     from generate_series(1, 6) n where not (n = any(p.billed_stages)) order by n limit 1),
      'draws', (select jsonb_agg(jsonb_build_object('stages', s.stg, 'inferred', nullif(s.inferred, false), 'label', coalesce(s.label, nullif(split_part(s.memo, E'\n', 1), '')), 'label_pct', s.label_pct,
                  'standard_pct', (select sum(std[x]) from unnest(s.stg) x where x <= 6),
                  'expected_amount', case when p.contract > 0 then round(p.contract * (select sum(std[x]) from unnest(s.stg) x where x <= 6) / 100, 2) end,
                  'invoice', s.doc_number, 'billed_on', s.txn_date, 'due', s.due_date, 'amount', s.total, 'balance', s.balance,
                  'paid_on', case when s.balance = 0 then s.last_payment end,
                  'days_open', case when s.balance <> 0 then current_date - coalesce(s.due_date, s.txn_date) end)
                order by s.txn_date, s.doc_number) from st s where s.job = p.job and s.stg is not null),
      'other_invoices', (select jsonb_agg(jsonb_build_object('invoice', s.doc_number, 'label', coalesce(s.label, nullif(split_part(s.memo, E'\n', 1), '')),
                  'billed_on', s.txn_date, 'amount', s.total, 'balance', s.balance) order by s.txn_date)
                from st s where s.job = p.job and s.stg is null)
    ) order by p.job), '[]')
  ) into res
  from per p left join due d on d.job = p.job
  where not coalesce(p_open_only, false) or p.open_balance <> 0 or d.due is not null;
  return res;
end $$;
revoke all on function ops.qbo_draws_core(text, boolean) from public, anon, authenticated;

create or replace function public.ops_qbo_draws(p_job text default null, p_open_only boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_finance();
begin
  return ops.qbo_draws_core(p_job, p_open_only);
end $$;
revoke all on function public.ops_qbo_draws(text, boolean) from public, anon;
grant execute on function public.ops_qbo_draws(text, boolean) to authenticated;
