-- =============================================================================
-- 0008_rpc_org_bootstrap.sql
-- Onboarding RPCs. orgs/org_members have no INSERT policy (see 0007), so the
-- client cannot create a tenant directly. These SECURITY DEFINER functions are
-- the sanctioned path: they run as the definer but key every write off auth.uid().
-- =============================================================================

-- Create a new org and make the caller its owner. Returns the new org id.
create or replace function create_org(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'org name required';
  end if;

  insert into orgs (name) values (btrim(p_name)) returning id into new_id;
  insert into org_members (org_id, user_id, role) values (new_id, uid, 'owner');
  return new_id;
end;
$$;

grant execute on function create_org(text) to authenticated;

-- Dev helper: join an existing org by id as a member. Intended for local demos
-- (e.g. attach your login to the seeded demo org). In production, real invites
-- would replace this; kept minimal and still keyed off auth.uid().
create or replace function join_org(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from orgs where id = p_org_id) then
    raise exception 'org not found';
  end if;
  insert into org_members (org_id, user_id, role)
    values (p_org_id, uid, 'member')
  on conflict (org_id, user_id) do nothing;
end;
$$;

grant execute on function join_org(uuid) to authenticated;
