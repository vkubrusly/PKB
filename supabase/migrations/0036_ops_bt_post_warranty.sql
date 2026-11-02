-- =============================================================================
-- 0036 — ops-bt-post also when a warranty request item still needs its Buildertrend claim
-- (rules/bt_warranty.mjs; Victor, 2026-11-02). Checked at :25 like the drafts (0034).
-- =============================================================================
create or replace function ops.dispatch_bt_post_if_queued() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from ops.outbound_messages where channel in ('bt_daily_log', 'bt_lead') and status = 'draft')
     or exists (select 1 from ops.warranty_claims w join ops.jobs j on j.id = w.job_id
                where w.bt_claim_id is null and w.bt_attempts < 5 and j.bt_job_id is not null) then
    perform ops.dispatch_workflow('ops-bt-post.yml');
  end if;
end $$;
revoke all on function ops.dispatch_bt_post_if_queued() from public, anon, authenticated;
