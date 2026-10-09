-- =============================================================================
-- 0033 — Accept / Dismiss buttons on the portal's Suggestions tab (Victor, 2026-10-09).
-- The partner's decision is stored with who and when; the weekly suggestions routine learns
-- from it (accepted / dismissed themes) and never reopens a decided suggestion.
-- =============================================================================
alter table ops.suggestions add column if not exists decided_by text;
alter table ops.suggestions add column if not exists decided_at timestamptz;

create or replace function public.ops_suggestion_decide(p_key text, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_partner(); r record;
begin
  if p_status not in ('accepted', 'dismissed', 'new') then raise exception 'status must be accepted, dismissed or new'; end if;
  update ops.suggestions set status = p_status, decided_by = case when p_status = 'new' then null else me->>'email' end,
         decided_at = case when p_status = 'new' then null else now() end, updated_at = now()
   where key = p_key and org_id = ops.org() and status <> 'done'
  returning key, status, decided_by, decided_at into r;
  if r.key is null then raise exception 'suggestion % not found (or already done)', p_key; end if;
  return to_jsonb(r);
end $$;
revoke all on function public.ops_suggestion_decide(text, text) from public, anon;
grant execute on function public.ops_suggestion_decide(text, text) to authenticated;
