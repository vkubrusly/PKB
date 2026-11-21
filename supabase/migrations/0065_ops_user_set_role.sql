-- =============================================================================
-- 0065 — Users tab: the admin changes a user's access level (Victor, 11/21/26). Admin only; the admin cannot
-- change their own level (no lock-out) and there is always at least one admin.
-- =============================================================================
create or replace function public.ops_user_set_role(p_email text, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := public.ops_me(); cur text;
begin
  if me is null or me->>'role' <> 'admin' then raise exception 'only the admin can change access levels' using errcode = '42501'; end if;
  if p_role not in ('admin', 'partner', 'pm', 'field') then raise exception 'unknown access level %', p_role; end if;
  if lower(p_email) = lower(me->>'email') then raise exception 'you cannot change your own access level'; end if;
  select role into cur from ops.portal_users where lower(email) = lower(p_email);
  if cur is null then raise exception 'unknown user %', p_email; end if;
  if cur = 'admin' and p_role <> 'admin' and (select count(*) from ops.portal_users where role = 'admin') <= 1 then
    raise exception 'there must be at least one admin';
  end if;
  update ops.portal_users set role = p_role where lower(email) = lower(p_email);
  return jsonb_build_object('email', p_email, 'role', p_role, 'was', cur);
end $$;
revoke all on function public.ops_user_set_role(text, text) from public, anon;
grant execute on function public.ops_user_set_role(text, text) to authenticated;
