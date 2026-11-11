-- =============================================================================
-- 0039 — Daily Logs of houses with no Buildertrend job wait as drafts until the job exists (Victor, 11/11:
-- 9370 N Jourden Dr / S057 lost its inspection logs after 3 days). They do not count as "queued", so they
-- don't start ops-bt-post every hour. The ones cancelled for that reason since 10/02 go back to draft.
-- =============================================================================
create or replace function ops.dispatch_bt_post_if_queued() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from ops.outbound_messages m left join ops.jobs j on j.id = m.job_id
              where m.status = 'draft' and (m.channel = 'bt_lead' or (m.channel = 'bt_daily_log' and j.bt_job_id is not null)))
     or exists (select 1 from ops.warranty_claims w join ops.jobs j on j.id = w.job_id
                where w.bt_claim_id is null and w.bt_attempts < 5 and j.bt_job_id is not null) then
    perform ops.dispatch_workflow('ops-bt-post.yml');
  end if;
end $$;
revoke all on function ops.dispatch_bt_post_if_queued() from public, anon, authenticated;

update ops.outbound_messages set status = 'draft', error = 'waiting: house has no Buildertrend job yet'
 where channel = 'bt_daily_log' and status = 'cancelled' and error = 'house has no Buildertrend job — not posted';
