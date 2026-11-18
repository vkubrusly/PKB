-- =============================================================================
-- 0048 — QuickBooks hardening for Intuit's production review (Victor, 2026-11-18).
--   errors       ops.qbo_errors: every failed call with Intuit's intuit_tid, endpoint, code, message
--   reconnect    invalid_grant / expired refresh token → needs_reconnect; owners are e-mailed
--                (security robot) and the Finance tab / /ops/quickbooks ask to reconnect
--   plan         features read from the company's Preferences (classes, locations, multicurrency,
--                projects); an entity the plan lacks is skipped with a warning, the sync goes on
--   version      minor_version per connection (default 75), changeable by an owner
--   sandbox      test switches (expired access token, broken refresh token) — sandbox only
-- Idempotent.
-- =============================================================================
alter table ops.qbo_connection add column if not exists minor_version text not null default '75';
alter table ops.qbo_connection add column if not exists needs_reconnect boolean not null default false;
alter table ops.qbo_connection add column if not exists needs_reconnect_reason text;
alter table ops.qbo_connection add column if not exists needs_reconnect_at timestamptz;
alter table ops.qbo_connection add column if not exists owners_alerted_at timestamptz;
alter table ops.qbo_connection add column if not exists features jsonb;
alter table ops.qbo_connection add column if not exists features_checked_at timestamptz;
alter table ops.qbo_connection add column if not exists warnings jsonb;

create table if not exists ops.qbo_errors (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  kind        text not null,          -- auth, invalid_grant, auth_config, validation, plan, throttle, server, minorversion, network, other
  status      int,
  intuit_tid  text,
  endpoint    text,
  code        text,
  message     text,
  detail      jsonb
);
alter table ops.qbo_errors enable row level security;
create index if not exists qbo_errors_at on ops.qbo_errors (at desc);

-- new connection: keep the chosen minor version, clear reconnect state
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
    delete from ops.qbo_connection;
    insert into ops.qbo_connection (environment, realm_id, company_name, connected_by, connected_at, access_expires_at, refresh_expires_at, minor_version)
    values (p_env, p_realm, p_company, p_email, now(), p_access_exp, p_refresh_exp, coalesce(mv, '75'));
  else
    update ops.qbo_connection set access_expires_at = p_access_exp, refresh_expires_at = coalesce(p_refresh_exp, refresh_expires_at),
      needs_reconnect = false, needs_reconnect_reason = null, needs_reconnect_at = null, owners_alerted_at = null where id = 1;
  end if;
end $$;

create or replace function public.ops_qbo_tokens_svc() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('environment', c.environment, 'realm_id', c.realm_id, 'access_expires_at', c.access_expires_at,
    'last_sync_at', c.last_sync_at, 'backfilled_at', c.backfilled_at, 'minor_version', c.minor_version,
    'needs_reconnect', c.needs_reconnect, 'features', c.features, 'features_checked_at', c.features_checked_at,
    'access_token', (select decrypted_secret from vault.decrypted_secrets where name = 'pkb_qbo_access_token'),
    'refresh_token', (select decrypted_secret from vault.decrypted_secrets where name = 'pkb_qbo_refresh_token'),
    'client_id', (select decrypted_secret from vault.decrypted_secrets where name = 'pkb_qbo_client_id'),
    'client_secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pkb_qbo_client_secret'))
  from ops.qbo_connection c where c.id = 1
$$;

drop function if exists public.ops_qbo_synced_svc(timestamptz, text, boolean);
create or replace function public.ops_qbo_synced_svc(p_since timestamptz, p_error text default null, p_backfilled boolean default false, p_warnings jsonb default null) returns void
language sql security definer set search_path = '' as $$
  update ops.qbo_connection set last_sync_at = coalesce(p_since, last_sync_at), last_sync_error = p_error,
    backfilled_at = case when p_backfilled then now() else backfilled_at end,
    warnings = case when p_error is null then p_warnings else warnings end where id = 1
$$;

create or replace function public.ops_qbo_error_svc(p_kind text, p_status int, p_tid text, p_endpoint text, p_code text, p_message text, p_detail jsonb default null) returns void
language sql security definer set search_path = '' as $$
  insert into ops.qbo_errors (kind, status, intuit_tid, endpoint, code, message, detail)
  values (coalesce(p_kind, 'other'), p_status, p_tid, left(p_endpoint, 300), left(p_code, 60), left(p_message, 1000), p_detail);
  delete from ops.qbo_errors where at < now() - interval '180 days';
$$;

create or replace function public.ops_qbo_needs_reconnect_svc(p_reason text) returns void
language sql security definer set search_path = '' as $$
  update ops.qbo_connection set needs_reconnect = true, needs_reconnect_reason = left(p_reason, 300),
    needs_reconnect_at = coalesce(needs_reconnect_at, now()) where id = 1
$$;

create or replace function public.ops_qbo_features_svc(p_features jsonb) returns void
language sql security definer set search_path = '' as $$
  update ops.qbo_connection set features = p_features, features_checked_at = now() where id = 1
$$;

-- Sandbox-only test switches (Intuit review / the test script). Never touch a production connection.
create or replace function public.ops_qbo_test_svc(p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare env text; sid uuid;
begin
  select environment into env from ops.qbo_connection where id = 1 and realm_id is not null;
  if env is distinct from 'sandbox' then raise exception 'test switches work only on a sandbox connection'; end if;
  if p_action = 'expire_access' then          -- token past its time: the next sync refreshes before calling
    update ops.qbo_connection set access_expires_at = now() - interval '1 minute' where id = 1;
  elsif p_action = 'revoke_access' then       -- token looks valid but Intuit rejects it: 401 → refresh → retry
    select id into sid from vault.secrets where name = 'pkb_qbo_access_token';
    perform vault.update_secret(sid, 'invalid-access-token-for-test');
    update ops.qbo_connection set access_expires_at = now() + interval '50 minutes' where id = 1;
  elsif p_action = 'break_refresh' then       -- refresh token Intuit does not know: invalid_grant → needs reconnect
    select id into sid from vault.secrets where name = 'pkb_qbo_refresh_token';
    perform vault.update_secret(sid, 'invalid-refresh-token-for-test');
    update ops.qbo_connection set access_expires_at = now() - interval '1 minute' where id = 1;
  else raise exception 'unknown test %', p_action; end if;
  return jsonb_build_object('test', p_action, 'ok', true);
end $$;

revoke all on function public.ops_qbo_save_tokens_svc(text, text, timestamptz, timestamptz, text, text, text, text), public.ops_qbo_tokens_svc(),
  public.ops_qbo_synced_svc(timestamptz, text, boolean, jsonb), public.ops_qbo_error_svc(text, int, text, text, text, text, jsonb),
  public.ops_qbo_needs_reconnect_svc(text), public.ops_qbo_features_svc(jsonb), public.ops_qbo_test_svc(text) from public, anon, authenticated;
grant execute on function public.ops_qbo_save_tokens_svc(text, text, timestamptz, timestamptz, text, text, text, text), public.ops_qbo_tokens_svc(),
  public.ops_qbo_synced_svc(timestamptz, text, boolean, jsonb), public.ops_qbo_error_svc(text, int, text, text, text, text, jsonb),
  public.ops_qbo_needs_reconnect_svc(text), public.ops_qbo_features_svc(jsonb), public.ops_qbo_test_svc(text) to service_role;

-- owners: the minor version (Intuit retires old ones)
create or replace function public.ops_qbo_set_minor_version(p_version text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_finance();
begin
  if p_version !~ '^[0-9]{1,3}$' then raise exception 'minor version must be a number, e.g. 75'; end if;
  update ops.qbo_connection set minor_version = p_version where id = 1;
  return jsonb_build_object('minor_version', p_version);
end $$;
revoke all on function public.ops_qbo_set_minor_version(text) from public, anon;
grant execute on function public.ops_qbo_set_minor_version(text) to authenticated;

create or replace function public.ops_finance_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_finance(); today date := (now() at time zone 'America/New_York')::date;
begin
  return jsonb_build_object(
    'me', me,
    'support', 'victor@pkbhomes.com',
    'connection', (select jsonb_build_object('environment', environment, 'company', company_name, 'connected_by', connected_by, 'connected_at', connected_at,
        'connected', realm_id is not null, 'disconnected_at', disconnected_at, 'disconnected_by', disconnected_by,
        'needs_reconnect', needs_reconnect, 'needs_reconnect_reason', needs_reconnect_reason, 'needs_reconnect_at', needs_reconnect_at,
        'minor_version', minor_version, 'features', features, 'warnings', warnings,
        'last_sync_at', last_sync_at, 'last_sync_error', last_sync_error, 'last_webhook_at', last_webhook_at, 'backfilled_at', backfilled_at,
        'refresh_expires_at', refresh_expires_at) from ops.qbo_connection where id = 1),
    'errors', (select coalesce(jsonb_agg(e order by e.at desc), '[]') from (select at, kind, status, intuit_tid, endpoint, code, message
        from ops.qbo_errors order by at desc limit 15) e),
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

-- Supabase advisor (found by the security robot, 11/18): fixed search_path on 0044's helper.
alter function ops.secret_names() set search_path = '';
