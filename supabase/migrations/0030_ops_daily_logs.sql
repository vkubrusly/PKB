-- =============================================================================
-- 0030 — Every Buildertrend Daily Log, with its author and time (change request #3).
-- Before this the system only kept the date of each job's last Daily Log
-- (from the notification e-mail), so it could not say who wrote which log.
-- Filled by collectors/buildertrend/daily_logs.mjs + scripts/load_daily_logs.mjs
-- (ops-daily, read-only on Buildertrend). Read by the portal's "Daily logs" report
-- and by the Ask assistant (board snapshot → daily_logs).
-- =============================================================================
create table if not exists ops.daily_logs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  job_id        uuid references ops.jobs(id) on delete set null,
  bt_log_id     bigint not null,
  bt_job_id     bigint,
  job_number    text,
  log_date      date,                 -- the date on the log (Florida)
  logged_at     timestamp,            -- when it was written, Florida local time
  author        text,                 -- Buildertrend name of who wrote it
  title         text,
  notes         text,
  notified      text[],               -- people notified, when Buildertrend lists them
  is_private    boolean,
  raw           jsonb,                -- the Buildertrend row, for fields not mapped yet
  collected_at  timestamptz not null default now(),
  unique (org_id, bt_log_id)
);
create index if not exists idx_ops_daily_logs_job on ops.daily_logs(job_id, logged_at desc);
create index if not exists idx_ops_daily_logs_date on ops.daily_logs(log_date desc);

alter table ops.daily_logs enable row level security;
drop policy if exists org_rw on ops.daily_logs;
create policy org_rw on ops.daily_logs for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant all on ops.daily_logs to authenticated, service_role;
