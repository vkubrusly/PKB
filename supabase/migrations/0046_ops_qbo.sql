-- =============================================================================
-- 0046 — QuickBooks Online, read-only (Victor, 2026-11-17). Owners only (Finance permission, 0045).
--   connect   an owner clicks "Connect QuickBooks" (Finance tab) → Intuit consent → ops-qbo-callback
--             stores the tokens in Vault (pkb_qbo_access_token / pkb_qbo_refresh_token).
--   sync      Intuit webhook (ops-qbo-webhook, signature checked) → one CDC call for what changed
--             since the last sync; a daily CDC catches anything missed; first connection backfills.
--   read      the Finance tab reads ops_finance_overview() (owners only).
-- Edge Functions and the daily job use the *_svc functions (service_role only). Idempotent.
-- =============================================================================
create table if not exists ops.qbo_connection (
  id                  int primary key default 1 check (id = 1),
  environment         text not null check (environment in ('sandbox', 'production')),
  realm_id            text,
  company_name        text,
  connected_by        text,
  connected_at        timestamptz,
  access_expires_at   timestamptz,
  refresh_expires_at  timestamptz,
  backfilled_at       timestamptz,
  last_sync_at        timestamptz,        -- CDC "changed since" for the next run
  last_sync_error     text,
  last_webhook_at     timestamptz
);
create table if not exists ops.qbo_state (          -- OAuth state (CSRF), 15 minutes
  state       text primary key,
  email       text not null,
  environment text not null,
  created_at  timestamptz not null default now()
);
create table if not exists ops.qbo_records (
  entity          text not null,                     -- Invoice, Payment, Deposit, Bill, BillPayment, Customer, Vendor
  qbo_id          text not null,
  doc_number      text,
  party           text,                              -- customer or vendor name
  party_id        text,
  txn_date        date,
  due_date        date,
  total           numeric,
  balance         numeric,
  deleted         boolean not null default false,
  qbo_updated_at  timestamptz,
  data            jsonb not null,
  synced_at       timestamptz not null default now(),
  primary key (entity, qbo_id)
);
create index if not exists qbo_records_txn on ops.qbo_records (entity, txn_date desc);
create table if not exists ops.qbo_webhook_log (
  id           bigint generated always as identity primary key,
  received_at  timestamptz not null default now(),
  valid        boolean not null,
  realm_id     text,
  entities     jsonb
);
alter table ops.qbo_connection enable row level security;
alter table ops.qbo_state enable row level security;
alter table ops.qbo_records enable row level security;
alter table ops.qbo_webhook_log enable row level security;

-- ---------- service side (Edge Functions with the secret key, the daily job) ----------
create or replace function public.ops_qbo_state_new_svc(p_email text, p_env text) returns text
language plpgsql security definer set search_path = '' as $$
declare s text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  delete from ops.qbo_state where created_at < now() - interval '15 minutes';
  insert into ops.qbo_state (state, email, environment) values (s, p_email, p_env);
  return s;
end $$;

create or replace function public.ops_qbo_state_take_svc(p_state text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  delete from ops.qbo_state where state = p_state and created_at > now() - interval '15 minutes' returning email, environment into r;
  return case when r.email is null then null else jsonb_build_object('email', r.email, 'environment', r.environment) end;
end $$;

create or replace function public.ops_qbo_save_tokens_svc(p_access text, p_refresh text, p_access_exp timestamptz, p_refresh_exp timestamptz,
  p_realm text default null, p_env text default null, p_company text default null, p_email text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  select id into sid from vault.secrets where name = 'pkb_qbo_access_token';
  if sid is null then perform vault.create_secret(p_access, 'pkb_qbo_access_token', 'QuickBooks access token (1 h)'); else perform vault.update_secret(sid, p_access); end if;
  select id into sid from vault.secrets where name = 'pkb_qbo_refresh_token';
  if sid is null then perform vault.create_secret(p_refresh, 'pkb_qbo_refresh_token', 'QuickBooks refresh token'); else perform vault.update_secret(sid, p_refresh); end if;
  if p_realm is not null then   -- a new connection: start over
    delete from ops.qbo_connection;
    insert into ops.qbo_connection (environment, realm_id, company_name, connected_by, connected_at, access_expires_at, refresh_expires_at)
    values (p_env, p_realm, p_company, p_email, now(), p_access_exp, p_refresh_exp);
  else
    update ops.qbo_connection set access_expires_at = p_access_exp, refresh_expires_at = coalesce(p_refresh_exp, refresh_expires_at);
  end if;
end $$;

create or replace function public.ops_qbo_tokens_svc() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('environment', c.environment, 'realm_id', c.realm_id, 'access_expires_at', c.access_expires_at,
    'last_sync_at', c.last_sync_at, 'backfilled_at', c.backfilled_at,
    'access_token', (select decrypted_secret from vault.decrypted_secrets where name = 'pkb_qbo_access_token'),
    'refresh_token', (select decrypted_secret from vault.decrypted_secrets where name = 'pkb_qbo_refresh_token'),
    'client_id', (select decrypted_secret from vault.decrypted_secrets where name = 'pkb_qbo_client_id'),
    'client_secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pkb_qbo_client_secret'))
  from ops.qbo_connection c where c.id = 1
$$;

-- p_records: [{entity, qbo_id, doc_number, party, party_id, txn_date, due_date, total, balance, deleted, qbo_updated_at, data}]
create or replace function public.ops_qbo_upsert_svc(p_records jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into ops.qbo_records (entity, qbo_id, doc_number, party, party_id, txn_date, due_date, total, balance, deleted, qbo_updated_at, data, synced_at)
  select r->>'entity', r->>'qbo_id', r->>'doc_number', r->>'party', r->>'party_id', (r->>'txn_date')::date, (r->>'due_date')::date,
         (r->>'total')::numeric, (r->>'balance')::numeric, coalesce((r->>'deleted')::boolean, false), (r->>'qbo_updated_at')::timestamptz, coalesce(r->'data', '{}'), now()
    from jsonb_array_elements(coalesce(p_records, '[]')) r
  on conflict (entity, qbo_id) do update set doc_number = excluded.doc_number, party = excluded.party, party_id = excluded.party_id,
    txn_date = excluded.txn_date, due_date = excluded.due_date, total = excluded.total, balance = excluded.balance, deleted = excluded.deleted,
    qbo_updated_at = excluded.qbo_updated_at, data = excluded.data, synced_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.ops_qbo_synced_svc(p_since timestamptz, p_error text default null, p_backfilled boolean default false) returns void
language sql security definer set search_path = '' as $$
  update ops.qbo_connection set last_sync_at = coalesce(p_since, last_sync_at), last_sync_error = p_error,
    backfilled_at = case when p_backfilled then now() else backfilled_at end where id = 1
$$;

create or replace function public.ops_qbo_webhook_log_svc(p_valid boolean, p_realm text, p_entities jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into ops.qbo_webhook_log (valid, realm_id, entities) values (p_valid, p_realm, p_entities);
  update ops.qbo_connection set last_webhook_at = now() where id = 1 and p_valid;
$$;

revoke all on function public.ops_qbo_state_new_svc(text, text), public.ops_qbo_state_take_svc(text),
  public.ops_qbo_save_tokens_svc(text, text, timestamptz, timestamptz, text, text, text, text), public.ops_qbo_tokens_svc(),
  public.ops_qbo_upsert_svc(jsonb), public.ops_qbo_synced_svc(timestamptz, text, boolean), public.ops_qbo_webhook_log_svc(boolean, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ops_qbo_state_new_svc(text, text), public.ops_qbo_state_take_svc(text),
  public.ops_qbo_save_tokens_svc(text, text, timestamptz, timestamptz, text, text, text, text), public.ops_qbo_tokens_svc(),
  public.ops_qbo_upsert_svc(jsonb), public.ops_qbo_synced_svc(timestamptz, text, boolean), public.ops_qbo_webhook_log_svc(boolean, text, jsonb)
  to service_role;

-- ---------- owners (Finance tab) ----------
create or replace function public.ops_finance_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_finance(); today date := (now() at time zone 'America/New_York')::date;
begin
  return jsonb_build_object(
    'me', me,
    'connection', (select jsonb_build_object('environment', environment, 'company', company_name, 'connected_by', connected_by, 'connected_at', connected_at,
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
revoke all on function public.ops_finance_overview() from public, anon;
grant execute on function public.ops_finance_overview() to authenticated;
