-- =============================================================================
-- 0045 — Finance access (Victor, 2026-11-17): the Finance tab and the QuickBooks data are for the
-- owners only, a permission separate from the role. Owners: Victor, Daniela, Gabriel, Cristiano,
-- Guilherme, Thiago. Thiago signs in with thiagodeataide@gmail.com (he had no login with the old
-- address). The admin switches the permission per person in Users. Idempotent.
-- =============================================================================
alter table ops.portal_users add column if not exists finance boolean not null default false;

update ops.portal_users set email = 'thiagodeataide@gmail.com'
 where lower(email) = 'thiago@wra-usa.com'
   and not exists (select 1 from ops.portal_users where lower(email) = 'thiagodeataide@gmail.com');
update ops.portal_users set finance = true
 where lower(email) in ('victor@pkbhomes.com', 'daniela@pkbhomes.com', 'gabriel@pkbhomes.com', 'cristiano@pkbhomes.com',
                        'guilherme@pkbhomes.com', 'thiagodeataide@gmail.com');

create or replace function public.ops_me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('email', p.email, 'name', p.name, 'role', p.role, 'bt_name', p.bt_name, 'finance', p.finance)
  from ops.portal_users p join auth.users u on lower(u.email) = lower(p.email)
  where u.id = auth.uid() and u.email_confirmed_at is not null
$$;

-- Every finance RPC starts with this: signed in, in PKB Ops, and with the Finance permission.
create or replace function ops.require_finance() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := public.ops_me();
begin
  if me is null or coalesce((me->>'finance')::boolean, false) is not true then
    raise exception 'PKB Ops Finance is limited to the owners' using errcode = '42501';
  end if;
  return me;
end $$;
revoke all on function ops.require_finance() from public, anon, authenticated;

create or replace function public.ops_users() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_partner();
begin
  if me->>'role' <> 'admin' then raise exception 'PKB Ops: the users list is limited to the admin' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by case x.role when 'admin' then 0 when 'partner' then 1 when 'pm' then 2 else 3 end, x.name) from (
    select p.email, p.name, p.role, p.bt_name, p.finance, p.created_at::date added,
           u.id is not null has_login, u.email_confirmed_at is not null confirmed,
           to_char(u.last_sign_in_at at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') last_sign_in
      from ops.portal_users p left join auth.users u on lower(u.email) = lower(p.email)) x), '[]'::jsonb);
end $$;

create or replace function public.ops_user_set_finance(p_email text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := public.ops_me(); n int;
begin
  if me is null or me->>'role' <> 'admin' then raise exception 'only the admin can change Finance access' using errcode = '42501'; end if;
  update ops.portal_users set finance = coalesce(p_on, false) where lower(email) = lower(p_email);
  get diagnostics n = row_count;
  if n = 0 then raise exception 'unknown user %', p_email; end if;
  return jsonb_build_object('email', p_email, 'finance', coalesce(p_on, false));
end $$;
revoke all on function public.ops_user_set_finance(text, boolean) from public, anon;
grant execute on function public.ops_user_set_finance(text, boolean) to authenticated;
