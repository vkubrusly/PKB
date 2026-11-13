-- =============================================================================
-- 0037 — Suggestions in Portuguese too, and a live list for the portal's reload button (Victor, 2026-11-03).
-- title_pt / detail_pt are written by the weekly suggestions routine next to the English text;
-- ops_suggestions() returns the current list to any portal member (the board snapshot only refreshes
-- each round).
-- =============================================================================
alter table ops.suggestions add column if not exists title_pt text;
alter table ops.suggestions add column if not exists detail_pt text;

create or replace function public.ops_suggestions() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_member();
begin
  return coalesce((select jsonb_agg(to_jsonb(s) order by case s.impact when 'high' then 0 when 'medium' then 1 else 2 end, s.created)
    from (select key, area, impact, title, detail, title_pt, detail_pt, evidence, status, decided_by, decided_at::date decided_at, created_at::date created
            from ops.suggestions where org_id = ops.org()) s), '[]'::jsonb);
end $$;
revoke all on function public.ops_suggestions() from public, anon;
grant execute on function public.ops_suggestions() to authenticated;
