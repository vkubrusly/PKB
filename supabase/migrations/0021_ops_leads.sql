-- Website work requests (bot mailbox, category work_request) followed until the
-- contract exists: rules/lead_followup.mjs asks the permits owner 24 h after the
-- request and every 48 h after that, until he answers (reply to the follow-up) or
-- the job shows up in ops.jobs (spreadsheet or Buildertrend) with the same parcel/address.
create table if not exists ops.leads (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id) on delete cascade,
  ref              text not null,                       -- short code used in the e-mail subject, e.g. L-0928-1612
  inbound_email_id uuid references ops.inbound_emails(id) on delete set null,
  received_at      timestamptz not null,
  client           text,
  company          text,
  phone            text,
  email            text,
  address          text,
  city             text,
  parcel           text,
  county           text,
  model            text,
  price            text,
  agent            text,
  status           text not null default 'open' check (status in ('open', 'answered', 'matched', 'closed')),
  followups        integer not null default 0,
  last_followup_at timestamptz,
  answered_at      timestamptz,
  answer           text,
  matched_job_id   uuid references ops.jobs(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (org_id, ref)
);
create unique index if not exists idx_ops_leads_email on ops.leads(inbound_email_id);
alter table ops.leads enable row level security;
drop policy if exists org_rw on ops.leads;
create policy org_rw on ops.leads for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant all on ops.leads to authenticated, service_role;
