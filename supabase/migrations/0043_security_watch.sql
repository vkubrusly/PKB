-- =============================================================================
-- 0043 — Security watch (Victor, 2026-11-17).
-- 1. Hardening from the Supabase security advisor: create_org / is_org_member are not for
--    signed-out callers; set_updated_at gets a fixed search_path.
-- 2. ops.security_findings: what ops/rules/security_watch.mjs has seen (one row per finding key),
--    so each problem alerts once and the weekly report lists what is still open.
-- Idempotent.
-- =============================================================================
revoke execute on function public.create_org(text) from anon, public;
revoke execute on function public.is_org_member(uuid) from anon, public;
grant execute on function public.create_org(text) to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
alter function public.set_updated_at() set search_path = public;

create table if not exists ops.security_findings (
  key          text primary key,                 -- e.g. 'advisor:anon_security_definer_function_executable:public.x', 'new_user:<id>'
  severity     text not null check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  title        text not null,
  detail       text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  alerted_at   timestamptz,
  resolved_at  timestamptz                       -- set when the check no longer finds it
);
alter table ops.security_findings enable row level security;   -- read only through the service key / Management API
