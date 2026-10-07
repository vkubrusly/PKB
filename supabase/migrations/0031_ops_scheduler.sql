-- =============================================================================
-- 0031 — the clock moves from GitHub to Supabase (Victor, 2026-10-07).
-- GitHub's scheduler skips or delays our cron runs by hours (on 10/07 none of the 1, 3 and 5 PM
-- rounds started). pg_cron here asks GitHub to run each workflow at the right time
-- (workflow_dispatch, which GitHub starts at once):
--   ops-daily  — rounds at 4 AM, 9, 11 AM, 1, 3, 5 PM Florida time (13 min early)
--   ops-mail   — bot mailbox, hourly at :07
--   ops-bt-post — queued Buildertrend Daily Logs, hourly at :25
-- The GitHub token lives in Supabase Vault as 'github_actions_token' (fine-grained, repo
-- vkubrusly/PKB, Actions: read and write). Without it the jobs only log a notice.
-- The GitHub cron lines stay as a fallback; ops-daily's gate skips a scheduled run when a
-- dispatched one already started for the same slot.
-- =============================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists ops.dispatch_log (
  id         bigserial primary key,
  workflow   text not null,
  request_id bigint,
  note       text,
  created_at timestamptz not null default now()
);

-- Ask GitHub to run one workflow on the default branch.
create or replace function ops.dispatch_workflow(p_workflow text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare tok text; rid bigint;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'github_actions_token' limit 1;
  if tok is null then
    insert into ops.dispatch_log (workflow, note) values (p_workflow, 'no github_actions_token in Vault');
    return null;
  end if;
  select net.http_post(
    url := 'https://api.github.com/repos/vkubrusly/PKB/actions/workflows/' || p_workflow || '/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
                                  'X-GitHub-Api-Version', '2022-11-28', 'User-Agent', 'pkb-ops-scheduler'),
    body := jsonb_build_object('ref', 'claude/new-session-zkg2g6')
  ) into rid;
  insert into ops.dispatch_log (workflow, request_id) values (p_workflow, rid);
  return rid;
end $$;
revoke all on function ops.dispatch_workflow(text) from public, anon, authenticated;

-- Hourly at :47 UTC; dispatches the round only when the next Florida hour is a slot.
create or replace function ops.dispatch_round_if_slot() returns void
language plpgsql security definer set search_path = '' as $$
declare h int := extract(hour from (now() at time zone 'America/New_York') + interval '13 minutes');
begin
  if h in (4, 9, 11, 13, 15, 17) then perform ops.dispatch_workflow('ops-daily.yml'); end if;
end $$;
revoke all on function ops.dispatch_round_if_slot() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname in ('pkb-ops-round', 'pkb-ops-mail', 'pkb-ops-bt-post');
select cron.schedule('pkb-ops-round', '47 * * * *', 'select ops.dispatch_round_if_slot()');
select cron.schedule('pkb-ops-mail', '7 * * * *', $$select ops.dispatch_workflow('ops-mail.yml')$$);
select cron.schedule('pkb-ops-bt-post', '25 * * * *', $$select ops.dispatch_workflow('ops-bt-post.yml')$$);
