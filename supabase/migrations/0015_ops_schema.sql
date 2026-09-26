-- =============================================================================
-- 0015_ops_schema.sql
-- PKB Ops: permits, inspections, events, rules and outbound messages.
-- Lives in its own schema `ops`; reuses public.orgs (tenant) and public.projects
-- (a job links to its estimate project when one exists). See ops/ARCHITECTURE.md.
-- =============================================================================

create schema if not exists ops;

-- ---------------------------------------------------------------------------
-- Jobs: one house/build. The Buildertrend job number ("0034") is the key the
-- spreadsheet, Buildertrend and the portals are matched on.
-- ---------------------------------------------------------------------------
create table if not exists ops.jobs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  job_number       text not null,                    -- "0034" (Buildertrend / spreadsheet #)
  bt_job_id        bigint,                           -- Buildertrend jobId
  bt_job_name      text,                             -- "0034 - OC - SunnyF - 4730 SW 142nd Pl Rd"
  project_id       uuid references public.projects(id) on delete set null,
  company          text not null default 'PKB' check (company in ('PKB', 'Prime')),
  address          text,
  parcel           text,
  county           text,                             -- Marion | Citrus | Orange | Winter Park | ...
  model            text,
  owner_name       text,
  water            text check (water in ('county', 'well')),
  sewer            text check (sewer in ('septic', 'public')),
  contract_value   numeric(14,2),
  signed_at        date,
  first_draw_at    date,
  second_draw_at   date,
  status           text not null default 'starting'
                   check (status in ('starting', 'licensing', 'construction', 'completed', 'stand_by', 'cancelled')),
  turtle_state     text not null default 'none'
                   check (turtle_state in ('none', 'survey_requested', 'relocation_pending', 'cleared')),
  turtle_survey_requested_at date,
  turtle_cleared_at date,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, job_number)
);
create or replace trigger trg_ops_jobs_updated before update on ops.jobs
  for each row execute function public.set_updated_at();

-- Pauses are subtracted from every KPI clock (ARCHITECTURE §3.1).
create table if not exists ops.job_pauses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  job_id      uuid not null references ops.jobs(id) on delete cascade,
  reason      text not null check (reason in ('owner_deferred_start', 'awaiting_1st_draw', 'awaiting_impact_fees',
                                              'awaiting_warranty_deed', 'turtle', 'other')),
  started_at  date not null,
  ended_at    date,
  note        text,
  created_at  timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index if not exists idx_ops_job_pauses_job on ops.job_pauses(job_id);

-- Designers, vendors and team per job (who gets which e-mail).
create table if not exists ops.job_contacts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  job_id      uuid not null references ops.jobs(id) on delete cascade,
  role        text not null,                          -- designer | septic | surveyor | supervisor | pm | ...
  name        text,
  email       text,
  phone       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ops_job_contacts_job on ops.job_contacts(job_id);

-- ---------------------------------------------------------------------------
-- Permit cases: one per job and process type.
-- ---------------------------------------------------------------------------
create table if not exists ops.permit_cases (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs(id) on delete cascade,
  job_id             uuid not null references ops.jobs(id) on delete cascade,
  kind               text not null check (kind in ('building', 'septic', 'civic_assoc', 'impact_fees', 'noc', 'survey', 'sub_permit', 'other')),
  portal             text,                            -- energov:marion | energov:winterpark | accela:citrus | fasttrack:orange
  portal_case_id     text,                            -- EnerGov CaseId / Accela capID
  number             text,                            -- BLDR-26-05-13402
  portal_status      text,                            -- as the portal shows it
  ops_status         text not null default 'not_started'
                     check (ops_status in ('not_started', 'requested', 'in_review', 'corrections', 'approved', 'fees_due', 'issued', 'finaled', 'cancelled')),
  ball_with          text check (ball_with in ('county', 'sovereign', 'surveyor', 'shady', 'fdep', 'pkb', 'owner', 'blocked')),
  tracked_by         text not null default 'designer' check (tracked_by in ('designer', 'pkb')),
  requested_at       date,
  applied_at         date,
  issued_at          date,
  expires_at         date,
  finaled_at         date,
  valuation          numeric(14,2),
  square_feet        numeric(12,2),
  fee_total          numeric(12,2),
  fee_unpaid         numeric(12,2),
  last_collected_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists uq_ops_permit_cases_number on ops.permit_cases(org_id, portal, number) where number is not null;
create index if not exists idx_ops_permit_cases_job on ops.permit_cases(job_id);
create or replace trigger trg_ops_permit_cases_updated before update on ops.permit_cases
  for each row execute function public.set_updated_at();

-- Review rounds (EnerGov submittals / Accela .RRnn revisions), numbered by date.
create table if not exists ops.submittals (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  permit_case_id   uuid not null references ops.permit_cases(id) on delete cascade,
  portal_id        text,
  round            int not null,
  type             text,
  status           text,
  submitted_at     date,
  due_at           date,
  completed_at     date,
  unique (permit_case_id, round)
);

create table if not exists ops.review_items (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  permit_case_id   uuid not null references ops.permit_cases(id) on delete cascade,
  submittal_id     uuid references ops.submittals(id) on delete cascade,
  portal_id        text,                              -- ItemReviewId / Accela task id
  round            int,
  department       text not null,
  status           text,
  failed           boolean not null default false,
  reviewer         text,
  reviewer_email   text,
  due_at           date,
  completed_at     date,
  comments         text,
  cause_tags       text[] not null default '{}',      -- AI: energy_calc, truss, digital_seal, site_plan, ...
  unique (permit_case_id, portal_id)
);
create index if not exists idx_ops_review_items_case on ops.review_items(permit_case_id);

create table if not exists ops.inspections (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  permit_case_id   uuid not null references ops.permit_cases(id) on delete cascade,
  number           text not null,
  type             text,
  status           text,
  passed           boolean not null default false,
  failed           boolean not null default false,
  reinspection     boolean not null default false,
  requested_at     date,
  scheduled_at     date,
  actual_at        date,
  inspector        text,
  comments         text,
  cause_tags       text[] not null default '{}',
  unique (permit_case_id, number)
);
create index if not exists idx_ops_inspections_case on ops.inspections(permit_case_id);

create table if not exists ops.holds (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  permit_case_id   uuid not null references ops.permit_cases(id) on delete cascade,
  portal_id        text,
  name             text,
  type             text,
  blocking         boolean not null default false,    -- "Stop Action" vs "Alert Message Only"
  reason           text,
  comments         text,
  created_at       date,
  active           boolean not null default true,
  unique (permit_case_id, portal_id)
);

-- ---------------------------------------------------------------------------
-- Events: the immutable timeline. Everything the collectors observe lands here
-- first; rules read from here. dedupe_key makes every collector idempotent.
-- ---------------------------------------------------------------------------
create table if not exists ops.events (
  id               bigint generated always as identity primary key,
  org_id           uuid not null references public.orgs(id) on delete cascade,
  job_id           uuid references ops.jobs(id) on delete cascade,
  permit_case_id   uuid references ops.permit_cases(id) on delete cascade,
  kind             text not null,                     -- review_item.failed, inspection.passed, invoice.paid, ...
  source           text not null check (source in ('energov', 'accela', 'fasttrack', 'email', 'buildertrend', 'user', 'rule', 'import')),
  occurred_at      timestamptz not null,
  payload          jsonb not null default '{}',
  dedupe_key       text not null,
  processed_at     timestamptz,                       -- set by the rules engine
  created_at       timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create index if not exists idx_ops_events_unprocessed on ops.events(org_id, created_at) where processed_at is null;
create index if not exists idx_ops_events_job on ops.events(job_id, occurred_at desc);

-- Follow-ups and to-dos created by rules (48 h designer follow-up, reschedule, ...).
create table if not exists ops.tasks (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  job_id           uuid references ops.jobs(id) on delete cascade,
  permit_case_id   uuid references ops.permit_cases(id) on delete cascade,
  kind             text not null,
  due_at           timestamptz not null,
  status           text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  assignee         text,
  attempts         int not null default 0,
  payload          jsonb not null default '{}',
  created_by_event bigint references ops.events(id) on delete set null,
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);
create index if not exists idx_ops_tasks_open on ops.tasks(org_id, due_at) where status = 'open';

-- Every e-mail / WhatsApp / Daily Log the system sends (or drafts).
create table if not exists ops.outbound_messages (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  job_id           uuid references ops.jobs(id) on delete set null,
  channel          text not null check (channel in ('email', 'whatsapp', 'bt_daily_log')),
  rule             text,                              -- R0, R1, ...
  to_addresses     text[] not null default '{}',
  cc_addresses     text[] not null default '{}',
  subject          text,
  body             text,
  status           text not null default 'draft' check (status in ('draft', 'approved', 'sent', 'failed', 'cancelled')),
  error            text,
  external_id      text,                              -- SMTP Message-ID / WhatsApp id / Buildertrend dailyLogId
  in_reply_to_event bigint references ops.events(id) on delete set null,
  approved_by      uuid references auth.users(id) on delete set null,
  sent_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists idx_ops_outbound_job on ops.outbound_messages(job_id, created_at desc);

create table if not exists ops.vendor_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  job_id           uuid not null references ops.jobs(id) on delete cascade,
  type             text not null,                     -- survey | stakeout | septic_design | noc | power | water | dumpster ...
  vendor           text,
  trigger_event    bigint references ops.events(id) on delete set null,
  sent_at          timestamptz,
  done_at          timestamptz,
  note             text,
  created_at       timestamptz not null default now()
);

create table if not exists ops.collector_runs (
  id               bigint generated always as identity primary key,
  org_id           uuid references public.orgs(id) on delete cascade,
  connector        text not null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  items            int,
  new_events       int,
  errors           jsonb not null default '[]'
);

create table if not exists ops.rules (
  org_id           uuid not null references public.orgs(id) on delete cascade,
  code             text not null,                     -- R0 ... R10
  description      text,
  mode             text not null default 'auto' check (mode in ('auto', 'draft', 'off')),
  config           jsonb not null default '{}',
  primary key (org_id, code)
);

-- ---------------------------------------------------------------------------
-- RLS: same model as the estimator — org members read/write their org's rows.
-- The workers use the service role and bypass RLS.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['jobs', 'job_pauses', 'job_contacts', 'permit_cases', 'submittals', 'review_items',
                           'inspections', 'holds', 'events', 'tasks', 'outbound_messages', 'vendor_requests',
                           'collector_runs', 'rules'] loop
    execute format('alter table ops.%I enable row level security;', t);
    execute format('drop policy if exists org_rw on ops.%I;', t);
    execute format('create policy org_rw on ops.%I for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));', t);
  end loop;
end $$;

grant usage on schema ops to authenticated, service_role;
grant all on all tables in schema ops to authenticated, service_role;
grant all on all sequences in schema ops to authenticated, service_role;
