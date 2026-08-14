-- =============================================================================
-- 0012 — real (quoted) prices, price memory, and per-line attachments.
--
-- • estimate_items.actual_unit_cost: the REAL negotiated/quoted unit cost, kept
--   ALONGSIDE unit_cost (the initial base estimate). Base is never overwritten.
-- • price_observations: an accumulating memory of prices (real quotes, web,
--   manual) by WBS/category + county, so new estimates learn from real numbers.
-- • estimate_item_files: 1..N attachments (supplier quotes/PDFs) per line,
--   stored in the existing "plantas" bucket.
-- =============================================================================

alter table estimate_items
  add column if not exists actual_unit_cost numeric(14,4) check (actual_unit_cost is null or actual_unit_cost >= 0);

create table if not exists price_observations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  wbs_code          text references wbs_nodes(code),
  line_code         text,
  description       text,
  unit              unit_type not null default 'ea',
  unit_price        numeric(14,4) not null check (unit_price >= 0),
  county            text,
  source            text not null default 'real_quote',   -- real_quote | web | manual | estimate
  estimate_item_id  uuid references estimate_items(id) on delete set null,
  observed_at       date not null default current_date,
  created_at        timestamptz not null default now()
);
create index if not exists idx_price_obs_org on price_observations(org_id);
create index if not exists idx_price_obs_wbs on price_observations(org_id, wbs_code);

create table if not exists estimate_item_files (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  estimate_item_id  uuid not null references estimate_items(id) on delete cascade,
  file_path         text not null,               -- Storage pointer (plantas bucket)
  file_name         text,
  created_at        timestamptz not null default now()
);
create index if not exists idx_eif_item on estimate_item_files(estimate_item_id);

alter table price_observations enable row level security;
drop policy if exists org_rw on price_observations;
create policy org_rw on price_observations for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

alter table estimate_item_files enable row level security;
drop policy if exists org_rw on estimate_item_files;
create policy org_rw on estimate_item_files for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));
