-- =============================================================================
-- 0040 — Vendor invoices → Buildertrend bills (Victor, 2026-11-19). invoice@pkbhomes.com forwards to the bot
-- mailbox; each invoice file is read (Edge Function ops-invoice), split by job (the amount the invoice shows for
-- each address; invoice-wide fees proportionally) and checked (every address on a job, the sum = the total, no
-- duplicate). Problems go by e-mail to Camila, Cc Victor. Bills are created as drafts in Buildertrend.
-- =============================================================================
insert into storage.buckets (id, name, public) values ('ops-invoices', 'ops-invoices', false) on conflict (id) do nothing;

create table if not exists ops.vendor_invoices (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs(id),
  inbound_email_id uuid references ops.inbound_emails(id),
  file_path        text not null,            -- ops-invoices bucket
  file_name        text,
  received_at      timestamptz,
  email_from       text,
  email_subject    text,
  is_invoice       boolean,
  vendor           text,
  invoice_number   text,
  invoice_date     date,
  due_date         date,
  total            numeric(12,2),
  fees_total       numeric(12,2),
  extracted        jsonb,                    -- what ops-invoice returned
  status           text not null default 'new' check (status in ('new', 'not_invoice', 'needs_review', 'ready', 'creating', 'created', 'duplicate', 'error')),
  issues           text[] not null default '{}',
  question_sent_at timestamptz,
  answer           text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (inbound_email_id, file_path)
);
create index if not exists vendor_invoices_status on ops.vendor_invoices (status);
create index if not exists vendor_invoices_number on ops.vendor_invoices (lower(vendor), invoice_number);

create table if not exists ops.vendor_invoice_lines (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references ops.vendor_invoices(id) on delete cascade,
  label       text,
  address     text,
  job_id      uuid references ops.jobs(id),
  job_number  text,
  amount      numeric(12,2) not null,       -- what the invoice shows for the site
  fee_share   numeric(12,2) not null default 0,
  bill_amount numeric(12,2) not null,       -- amount + fee_share: the bill of this job
  bt_bill_id  bigint,
  bt_status   text,
  bt_error    text,
  created_at  timestamptz not null default now()
);
create index if not exists vendor_invoice_lines_invoice on ops.vendor_invoice_lines (invoice_id);
alter table ops.vendor_invoices enable row level security;
alter table ops.vendor_invoice_lines enable row level security;
