-- =============================================================================
-- 0050 — Fixes from the first production connection (Prime Kubrusly Basso Home LLC, 11/18 20:15 UTC):
-- 1. The first load stopped with "ON CONFLICT DO UPDATE command cannot affect row a second time":
--    QuickBooks paged queries can return the same object twice; the upsert now keeps one row per
--    (entity, id) in each batch (the most recently updated).
-- 2. Records did not say which company they came from, so the sandbox test company's 133 rows sat
--    next to the real data. qbo_records.realm_id; connecting a company removes any other company's rows.
-- Idempotent.
-- =============================================================================
alter table ops.qbo_records add column if not exists realm_id text;

create or replace function public.ops_qbo_upsert_svc(p_records jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int; realm text := (select realm_id from ops.qbo_connection where id = 1);
begin
  insert into ops.qbo_records (entity, qbo_id, doc_number, party, party_id, txn_date, due_date, total, balance, deleted, qbo_updated_at, data, synced_at, realm_id)
  select distinct on (r->>'entity', r->>'qbo_id')
         r->>'entity', r->>'qbo_id', r->>'doc_number', r->>'party', r->>'party_id', (r->>'txn_date')::date, (r->>'due_date')::date,
         (r->>'total')::numeric, (r->>'balance')::numeric, coalesce((r->>'deleted')::boolean, false), (r->>'qbo_updated_at')::timestamptz, coalesce(r->'data', '{}'), now(), realm
    from jsonb_array_elements(coalesce(p_records, '[]')) r
   order by r->>'entity', r->>'qbo_id', (r->>'qbo_updated_at')::timestamptz desc nulls last
  on conflict (entity, qbo_id) do update set doc_number = excluded.doc_number, party = excluded.party, party_id = excluded.party_id,
    txn_date = excluded.txn_date, due_date = excluded.due_date, total = excluded.total, balance = excluded.balance, deleted = excluded.deleted,
    qbo_updated_at = excluded.qbo_updated_at, data = excluded.data, synced_at = now(), realm_id = excluded.realm_id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.ops_qbo_save_tokens_svc(p_access text, p_refresh text, p_access_exp timestamptz, p_refresh_exp timestamptz,
  p_realm text default null, p_env text default null, p_company text default null, p_email text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare sid uuid; mv text;
begin
  select id into sid from vault.secrets where name = 'pkb_qbo_access_token';
  if sid is null then perform vault.create_secret(p_access, 'pkb_qbo_access_token', 'QuickBooks access token (1 h)'); else perform vault.update_secret(sid, p_access); end if;
  select id into sid from vault.secrets where name = 'pkb_qbo_refresh_token';
  if sid is null then perform vault.create_secret(p_refresh, 'pkb_qbo_refresh_token', 'QuickBooks refresh token'); else perform vault.update_secret(sid, p_refresh); end if;
  if p_realm is not null then
    select minor_version into mv from ops.qbo_connection where id = 1;
    delete from ops.qbo_connection where id = 1;   -- WHERE required: PostgREST runs with pg_safeupdate
    delete from ops.qbo_records where realm_id is distinct from p_realm;   -- another company's data never mixes in
    insert into ops.qbo_connection (environment, realm_id, company_name, connected_by, connected_at, access_expires_at, refresh_expires_at, minor_version)
    values (p_env, p_realm, p_company, p_email, now(), p_access_exp, p_refresh_exp, coalesce(mv, '75'));
  else
    update ops.qbo_connection set access_expires_at = p_access_exp, refresh_expires_at = coalesce(p_refresh_exp, refresh_expires_at),
      needs_reconnect = false, needs_reconnect_reason = null, needs_reconnect_at = null, owners_alerted_at = null where id = 1;
  end if;
end $$;
