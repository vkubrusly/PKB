-- =============================================================================
-- 0005_invoices_costs.sql
-- Fase 2 — Agente de Invoices, custos reais (calibração) e parâmetros por condado.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Invoices (§4.2). project_id is OPTIONAL: an unlinked invoice still feeds the
-- price/supplier history, just not the project reconciliation.
-- ---------------------------------------------------------------------------
create table if not exists invoices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  project_id   uuid references projects(id) on delete set null,   -- OPCIONAL
  supplier_id  uuid references suppliers(id) on delete set null,
  supplier_name_raw text,                         -- as extracted, before supplier match
  invoice_number text,
  invoice_date date,
  total        numeric(16,2),
  file_path    text,                              -- Storage pointer (invoices bucket)
  parsed_by_ai boolean not null default false,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_invoices_org on invoices(org_id);
create index if not exists idx_invoices_project on invoices(project_id);
create or replace trigger trg_invoices_updated before update on invoices
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Invoice line items. Each line maps to a WBS node (suggested → confirmed) and
-- links to a catalog material (proposed when missing). Highest calibration weight.
-- ---------------------------------------------------------------------------
create table if not exists invoice_items (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  invoice_id     uuid not null references invoices(id) on delete cascade,
  wbs_code       text references wbs_nodes(code),  -- sugerido/confirmado
  wbs_confirmed  boolean not null default false,
  material_id    uuid references materials(id) on delete set null,
  description    text not null,
  qty            numeric(14,4),
  unit           unit_type,
  unit_cost      numeric(14,4),
  total          numeric(16,2),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_invoice_items_invoice on invoice_items(invoice_id);
create index if not exists idx_invoice_items_wbs on invoice_items(wbs_code);
create or replace trigger trg_invoice_items_updated before update on invoice_items
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Actual costs — consolidated real cost per (WBS, model, county) for calibration.
-- Fed from invoice_items + external job-costing exports (Buildertrend/QuickBooks).
-- ---------------------------------------------------------------------------
create table if not exists actual_costs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  project_id   uuid references projects(id) on delete set null,
  wbs_code     text not null references wbs_nodes(code),
  base_model   text,
  county       text,
  qty          numeric(14,4),
  unit         unit_type,
  unit_cost    numeric(14,4),
  total        numeric(16,2),
  source       text,                              -- 'invoice' | 'buildertrend' | 'quickbooks' | 'csv'
  incurred_at  date,
  created_at   timestamptz not null default now()
);
create index if not exists idx_actual_costs_key on actual_costs(wbs_code, base_model, county);
create index if not exists idx_actual_costs_org on actual_costs(org_id);

-- ---------------------------------------------------------------------------
-- County parameters (§3.2). Fees + requirements per county, with source + date.
-- Stored as jsonb so fee categories can evolve without migrations.
-- ---------------------------------------------------------------------------
create table if not exists county_parameters (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  county        text not null,
  state         text not null default 'FL',
  impact_fees   jsonb not null default '{}'::jsonb,  -- {school, road, parks, ...}
  permit_fees   jsonb not null default '{}'::jsonb,
  connection_fees jsonb not null default '{}'::jsonb, -- water/sewer/power by utility
  requirements  jsonb not null default '{}'::jsonb,   -- septic/BMAP, soil test, etc.
  avg_permit_days int,
  source_link   text,
  verified_at   date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, county, state)
);
create index if not exists idx_county_params_org on county_parameters(org_id);
create or replace trigger trg_county_params_updated before update on county_parameters
  for each row execute function set_updated_at();
