-- =============================================================================
-- 0035 — Warranty claims (Victor, 2026-11-02): homeowner requests from the website warranty form
-- (e-mail category 'warranty_request'), one row per item, linked to the house, to the Buildertrend
-- Warranty claim created for it, and followed until Buildertrend shows it resolved.
-- =============================================================================
create table if not exists ops.warranty_claims (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id),
  job_id           uuid references ops.jobs(id),
  inbound_email_id uuid references ops.inbound_emails(id),
  item_no          int not null default 1,
  received_at      timestamptz not null,
  homeowner        text,
  phone            text,
  email            text,
  address          text,
  purchase_date    date,
  category         text,          -- form category: ELECTRICAL, DOORS, PLUMBING…
  location         text,          -- BEDROOM, EXTERIOR…
  description      text,
  status           text not null default 'open' check (status in ('open', 'scheduled', 'resolved', 'closed')),
  bt_claim_id      bigint,        -- Buildertrend Warranty claim id
  bt_status        text,          -- status as Buildertrend shows it
  bt_error         text,
  bt_attempts      int not null default 0,
  bt_created_at    timestamptz,
  scheduled_at     timestamptz,
  resolved_at      timestamptz,
  last_synced_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (inbound_email_id, item_no)
);
create index if not exists warranty_claims_job on ops.warranty_claims (job_id);
create index if not exists warranty_claims_status on ops.warranty_claims (status);
alter table ops.warranty_claims enable row level security;
