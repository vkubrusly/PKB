-- Bot mailbox (every message read by the mail collector) and improvement suggestions.

create table if not exists ops.inbound_emails (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  message_id    text not null,                      -- RFC 822 Message-ID (dedupe)
  received_at   timestamptz,
  from_addr     text,
  from_name     text,
  to_addrs      text[] not null default '{}',
  cc_addrs      text[] not null default '{}',
  subject       text,
  body_text     text,                               -- plain text, trimmed
  category      text,                               -- bt_invoice | bt_invoice_paid | bt_daily_log | bt_bill | bt_other | county | designer | septic | surveyor | google | other
  job_number    text,                               -- when the subject names a job ("0048 - OC - …")
  job_id        uuid references ops.jobs(id) on delete set null,
  parsed        jsonb not null default '{}',        -- amount, actor, action, …
  created_at    timestamptz not null default now(),
  unique (org_id, message_id)
);
create index if not exists idx_ops_inbound_emails_job on ops.inbound_emails(job_id, received_at desc);
create index if not exists idx_ops_inbound_emails_cat on ops.inbound_emails(org_id, category, received_at desc);

create table if not exists ops.suggestions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  key           text not null,                      -- stable id so a suggestion is not duplicated
  area          text not null,                      -- permits | inspections | construction | finance | data | process
  title         text not null,
  detail        text,
  evidence      jsonb not null default '{}',
  impact        text check (impact in ('high', 'medium', 'low')),
  status        text not null default 'new' check (status in ('new', 'accepted', 'dismissed', 'done')),
  source        text not null default 'claude',     -- claude | rule | user
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, key)
);

do $$
declare t text;
begin
  foreach t in array array['inbound_emails', 'suggestions'] loop
    execute format('alter table ops.%I enable row level security;', t);
    execute format('drop policy if exists org_rw on ops.%I;', t);
    execute format('create policy org_rw on ops.%I for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));', t);
  end loop;
end $$;

grant all on ops.inbound_emails, ops.suggestions to authenticated, service_role;
