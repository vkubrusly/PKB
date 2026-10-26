-- =============================================================================
-- 0034 — ops-bt-post only when something is queued (Victor, 2026-10-26: cut GitHub Actions minutes).
-- The hourly :25 dispatch used to start the workflow every hour (and GitHub's own cron started it a
-- second time); the job then found nothing to post most hours, but each start is billed. Now pg_cron
-- dispatches it only when a Buildertrend Daily Log or Lead Opportunity is waiting as a draft. The
-- immediate path (trigger bt_post_now, 0032) and the daily rounds' own posting step are unchanged.
-- GitHub's cron line for ops-bt-post is removed in the same change.
-- =============================================================================
create or replace function ops.dispatch_bt_post_if_queued() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from ops.outbound_messages where channel in ('bt_daily_log', 'bt_lead') and status = 'draft') then
    perform ops.dispatch_workflow('ops-bt-post.yml');
  end if;
end $$;
revoke all on function ops.dispatch_bt_post_if_queued() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname = 'pkb-ops-bt-post';
select cron.schedule('pkb-ops-bt-post', '25 * * * *', 'select ops.dispatch_bt_post_if_queued()');
