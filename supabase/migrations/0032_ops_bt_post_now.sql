-- =============================================================================
-- 0032 — Daily Logs from the field channel (and the Ask) go to Buildertrend right away
-- (Victor, 2026-10-09). Until now they waited for the hourly ops-bt-post run (up to an hour;
-- 35 min on 10/08). When such a draft appears, ask GitHub to run ops-bt-post now (it posts every
-- draft queued, so several confirmations close together share one run). The hourly run stays as
-- the fallback. Rule drafts from the rounds are left out: the round posts them itself.
-- =============================================================================
create or replace function ops.bt_post_now() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'draft' and (tg_op = 'INSERT' or old.status is distinct from 'draft') and (new.channel = 'bt_lead' or (new.channel = 'bt_daily_log' and new.rule in ('FIELD', 'ASK')))
     and not exists (select 1 from ops.dispatch_log where workflow = 'ops-bt-post.yml' and created_at > now() - interval '45 seconds') then
    perform ops.dispatch_workflow('ops-bt-post.yml');
  end if;
  return new;
end $$;
revoke all on function ops.bt_post_now() from public, anon, authenticated;

drop trigger if exists bt_post_now on ops.outbound_messages;
create trigger bt_post_now after insert or update of status on ops.outbound_messages
  for each row execute function ops.bt_post_now();
