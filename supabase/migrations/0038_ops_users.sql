-- =============================================================================
-- 0038 — Users tab for the admin (Victor, 2026-11-06): every portal user with access level, Buildertrend
-- name, whether a login exists / was confirmed and the last sign-in. Read-only; admin only.
-- =============================================================================
create or replace function public.ops_users() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_partner();
begin
  if me->>'role' <> 'admin' then raise exception 'PKB Ops: the users list is limited to the admin' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by case x.role when 'admin' then 0 when 'partner' then 1 when 'pm' then 2 else 3 end, x.name) from (
    select p.email, p.name, p.role, p.bt_name, p.created_at::date added,
           u.id is not null has_login, u.email_confirmed_at is not null confirmed,
           to_char(u.last_sign_in_at at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') last_sign_in
      from ops.portal_users p left join auth.users u on lower(u.email) = lower(p.email)) x), '[]'::jsonb);
end $$;
revoke all on function public.ops_users() from public, anon;
grant execute on function public.ops_users() to authenticated;
