-- =============================================================================
-- 0051 — QuickBooks data for the Ask assistant (owners only).
-- public.ops_qbo_query: read-only search over ops.qbo_records for the owners (ops.require_finance). The Ask
-- function calls it with the asking user's own login, so a partner without Finance gets 42501, never data.
-- Filters: entity, free text (vendor/customer, doc number, line descriptions, items, accounts), job number
-- (matches "0028 - …" in the party or in any line's customer/project), open balance only, date range.
-- Returns totals over ALL matches (not just the rows shown) and, with a job filter, the amounts of the lines
-- charged to that job (a bill can be split across jobs) grouped by entity and by item / cost code.
-- =============================================================================

create or replace function public.ops_qbo_query(p_entity text default null, p_text text default null, p_job text default null,
  p_open boolean default false, p_from date default null, p_to date default null, p_limit int default 60)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me jsonb := ops.require_finance();
  lim int := least(greatest(coalesce(p_limit, 60), 1), 200);
  jre text := case when nullif(trim(coalesce(p_job, '')), '') is null then null
                   else '(^|[^0-9])0*' || coalesce(nullif(ltrim(regexp_replace(p_job, '[^0-9A-Za-z]', '', 'g'), '0'), ''), '0') || ' - ' end;
  txt text := nullif(trim(coalesce(p_text, '')), '');
  res jsonb;
begin
  with m as (
    select r.* from ops.qbo_records r
    where not r.deleted
      and (p_entity is null or lower(r.entity) = lower(p_entity))
      and (txt is null or r.party ilike '%' || txt || '%' or r.doc_number ilike '%' || txt || '%' or r.data::text ilike '%' || txt || '%')
      and (jre is null or coalesce(r.party, '') ~* jre or r.data::text ~* jre)
      and (not coalesce(p_open, false) or coalesce(r.balance, 0) <> 0)
      and (p_from is null or r.txn_date >= p_from)
      and (p_to is null or r.txn_date <= p_to)
  ), lines as (
    select m.entity, m.qbo_id, l.value as l,
      coalesce(l.value #>> '{ItemBasedExpenseLineDetail,CustomerRef,name}', l.value #>> '{AccountBasedExpenseLineDetail,CustomerRef,name}',
               l.value #>> '{DepositLineDetail,Entity,name}', case when m.entity in ('Invoice', 'Payment') then m.party end) as job,
      coalesce(l.value #>> '{ItemBasedExpenseLineDetail,ItemRef,name}', l.value #>> '{AccountBasedExpenseLineDetail,AccountRef,name}',
               l.value #>> '{SalesItemLineDetail,ItemRef,name}', l.value #>> '{DepositLineDetail,AccountRef,name}') as item
    from m, jsonb_array_elements(case when jsonb_typeof(m.data -> 'Line') = 'array' then m.data -> 'Line' else '[]' end) l
    where coalesce(l.value ->> 'DetailType', '') <> 'SubTotalLineDetail'
  ), jl as (select * from lines where jre is not null and coalesce(job, '') ~* jre),
  shown as (select * from m order by m.txn_date desc nulls last, m.qbo_id desc limit lim)
  select jsonb_build_object(
    'matches', (select count(*) from m),
    'by_entity', coalesce((select jsonb_object_agg(entity, x) from (select entity, jsonb_build_object('count', count(*), 'total', sum(total), 'open_balance', sum(balance)) x from m group by entity) e), '{}'),
    'job_lines', case when jre is null then null else jsonb_build_object(
      'by_entity', coalesce((select jsonb_object_agg(entity, s) from (select entity, sum((l ->> 'Amount')::numeric) s from jl group by entity) e), '{}'),
      'by_item', coalesce((select jsonb_agg(jsonb_build_object('entity', entity, 'item', item, 'amount', s, 'lines', n) order by s desc) from (select entity, item, sum((l ->> 'Amount')::numeric) s, count(*) n from jl group by entity, item) i), '[]')) end,
    'shown', (select count(*) from shown),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'entity', s.entity, 'id', s.qbo_id, 'doc', s.doc_number, 'party', s.party, 'date', s.txn_date, 'due', s.due_date,
        'total', s.total, 'balance', s.balance,
        'memo', nullif(left(coalesce(s.data ->> 'PrivateNote', s.data ->> 'Memo', ''), 200), ''),
        'account', coalesce(s.data #>> '{DepositToAccountRef,name}', s.data #>> '{CheckPayment,BankAccountRef,name}', s.data #>> '{CreditCardPayment,CCAccountRef,name}',
                            s.data #>> '{APAccountRef,name}'),
        'linked', (select jsonb_agg(distinct (t ->> 'TxnType') || ' ' || (t ->> 'TxnId')) from jsonb_array_elements(case when jsonb_typeof(s.data -> 'Line') = 'array' then s.data -> 'Line' else '[]' end) l2,
                     jsonb_array_elements(case when jsonb_typeof(l2.value -> 'LinkedTxn') = 'array' then l2.value -> 'LinkedTxn' else '[]' end) t),
        'lines', (select jsonb_agg(jsonb_build_object('amount', (x.l ->> 'Amount')::numeric, 'desc', left(regexp_replace(x.l ->> 'Description', '\s+', ' ', 'g'), 160), 'item', x.item, 'job', x.job))
                  from lines x where x.entity = s.entity and x.qbo_id = s.qbo_id))
      order by s.txn_date desc nulls last, s.qbo_id desc) from shown s), '[]'),
    'synced', (select jsonb_build_object('company', company_name, 'environment', environment, 'last_sync_at', last_sync_at, 'connected', disconnected_at is null)
               from ops.qbo_connection where id = 1)
  ) into res;
  return res;
end $$;

revoke all on function public.ops_qbo_query(text, text, text, boolean, date, date, int) from public, anon;
grant execute on function public.ops_qbo_query(text, text, text, boolean, date, date, int) to authenticated;
