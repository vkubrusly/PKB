-- =============================================================================
-- 0044 — Integration secrets typed in the portal, never in chat (Victor, 2026-11-17).
-- The admin types the QuickBooks credentials in PKB Ops → Users → Integrations; they go straight
-- into Supabase Vault. Nobody can read a value back through the portal: the status shows only
-- "set on <date> by <who>". Edge Functions read them with the project secret key
-- (ops_secret_get, service_role only). Only names on the list below can be written. Idempotent.
-- =============================================================================
create table if not exists ops.secret_audit (
  id       bigint generated always as identity primary key,
  name     text not null,
  set_by   text not null,
  set_at   timestamptz not null default now()
);
alter table ops.secret_audit enable row level security;

create or replace function ops.secret_names() returns text[]
language sql immutable as $$ select array['qbo_client_id', 'qbo_client_secret', 'qbo_webhook_verifier'] $$;

create or replace function public.ops_secret_set(p_name text, p_value text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := public.ops_me(); v text := btrim(coalesce(p_value, '')); sid uuid;
begin
  if me is null or me->>'role' <> 'admin' then raise exception 'only the admin can set integration secrets' using errcode = '42501'; end if;
  if not (p_name = any (ops.secret_names())) then raise exception 'unknown secret %', p_name; end if;
  if length(v) < 4 or length(v) > 500 then raise exception 'value must be 4–500 characters'; end if;
  select id into sid from vault.secrets where name = 'pkb_' || p_name;
  if sid is null then perform vault.create_secret(v, 'pkb_' || p_name, 'PKB Ops integration secret (set in the portal)');
  else perform vault.update_secret(sid, v); end if;
  insert into ops.secret_audit (name, set_by) values (p_name, me->>'email');
  return jsonb_build_object('name', p_name, 'set', true);
end $$;

create or replace function public.ops_secret_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := public.ops_me();
begin
  if me is null or me->>'role' <> 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('name', n, 'set', s.id is not null, 'at', coalesce(s.updated_at, s.created_at),
            'by', (select a.set_by from ops.secret_audit a where a.name = n order by a.set_at desc limit 1)) order by ord), '[]')
          from unnest(ops.secret_names()) with ordinality as x(n, ord) left join vault.secrets s on s.name = 'pkb_' || n);
end $$;

-- For Edge Functions (project secret key → service_role). Never granted to signed-in users.
create or replace function public.ops_secret_get(p_name text) returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'pkb_' || p_name and p_name = any (ops.secret_names()) limit 1
$$;

revoke all on function public.ops_secret_set(text, text), public.ops_secret_status(), public.ops_secret_get(text) from public, anon, authenticated;
grant execute on function public.ops_secret_set(text, text), public.ops_secret_status() to authenticated;
grant execute on function public.ops_secret_get(text) to service_role;
