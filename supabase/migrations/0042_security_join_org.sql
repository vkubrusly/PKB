-- =============================================================================
-- 0042 — Security (Victor, 2026-11-17): join_org accepted any org id, so any signed-in user who
-- learned PKB's org id could make themselves a member and read / change its data. Only the
-- public demo org can be joined this way; members of a real org are added by its owner
-- (budget app "team" function / PKB Ops Users). Public sign-up was also turned off
-- (auth config, not SQL). Idempotent.
-- =============================================================================
create or replace function public.join_org(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
uid uuid := auth.uid();
begin
if uid is null then
raise exception 'not authenticated';
end if;
if p_org_id is distinct from '11111111-1111-1111-1111-111111111111'::uuid then
raise exception 'joining an organization needs an invitation from its owner';
end if;
if not exists (select 1 from orgs where id = p_org_id) then
raise exception 'org not found';
end if;
insert into org_members (org_id, user_id, role)
values (p_org_id, uid, 'member')
on conflict (org_id, user_id) do nothing;
end;
$function$;
revoke all on function public.join_org(uuid) from public, anon;
grant execute on function public.join_org(uuid) to authenticated;
