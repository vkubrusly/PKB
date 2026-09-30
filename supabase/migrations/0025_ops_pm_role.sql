-- =============================================================================
-- 0025 — role 'pm' (project manager): the partner portal (budget.pkbhomes.com/ops/) + the
-- field channel. Carlos Basilio (carlos@pkbhomes.com) is the first one (Victor, 2026-09-30).
-- =============================================================================
alter table ops.portal_users drop constraint if exists portal_users_role_check;
alter table ops.portal_users add constraint portal_users_role_check check (role in ('admin', 'partner', 'pm', 'field'));

create or replace function ops.require_partner() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := public.ops_me();
begin
  if me is null or me->>'role' not in ('admin', 'partner', 'pm') then raise exception 'PKB Ops: access is limited to the partners and project managers' using errcode = '42501'; end if;
  return me;
end $$;

-- partners and PMs see everyone's field reports
create or replace function public.ops_field_reports(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x.updated_at desc), '[]') from (
    select r.id, r.author_email, r.channel, r.status, r.draft, r.messages, r.created_at, r.updated_at, r.confirmed_at, j.job_number, j.address,
      (select m.status from ops.outbound_messages m where m.id = r.outbound_id) daily_log_status
    from ops.field_reports r left join ops.jobs j on j.id = r.job_id, lateral (select ops.require_member() me) k
    where r.author_email = k.me->>'email' or k.me->>'role' in ('admin', 'partner', 'pm')
    order by r.updated_at desc limit least(greatest(p_limit, 1), 100)) x
$$;

update ops.portal_users set role = 'pm' where email = 'carlos@pkbhomes.com';
