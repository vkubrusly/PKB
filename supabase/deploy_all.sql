-- ==========================================================================
-- deploy_all.sql — cole TUDO isto no Supabase (Dashboard → SQL Editor → Run).
-- Aplica todo o schema + as 22 categorias WBS + o projeto-demo Sunny.
-- Idempotente: pode rodar de novo sem quebrar.
-- Gerado de supabase/migrations/*.sql + data/sunny_affordable/seed_sunny_affordable.sql
-- ==========================================================================

-- ===== 0001_extensions_enums.sql =====
-- =============================================================================
-- 0001_extensions_enums.sql
-- Extensions, shared enums, and the updated_at trigger helper.
-- =============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";      -- case-insensitive text (emails, codes)

-- ---------------------------------------------------------------------------
-- Enums (Parte 5 / ARCHITECTURE §4)
-- ---------------------------------------------------------------------------

-- Nível de especificação. 'any' = material aplicável a qualquer nível.
-- Ordem = tier crescente: affordable < essential < signature < luxury.
do $$ begin
  create type spec_level as enum ('affordable', 'essential', 'signature', 'luxury', 'any');
exception when duplicate_object then null; end $$;
-- Bancos criados antes do 0010 já têm o enum sem 'affordable': adiciona idempotente.
alter type spec_level add value if not exists 'affordable' before 'essential';

-- Origem do preço. Ordem reflete a confiabilidade crescente na calibração:
-- invoice (pago) > quote (cotado) > web > catalog > estimated.
do $$ begin
  create type price_source as enum ('catalog', 'quote', 'web', 'invoice', 'estimated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type water_source as enum ('municipal', 'well');
exception when duplicate_object then null; end $$;

-- Séptico convencional vs. redução de nitrogênio (BMAP) vs. esgoto municipal.
do $$ begin
  create type sewer_type as enum ('municipal', 'septic', 'septic_nitrogen');
exception when duplicate_object then null; end $$;

do $$ begin
  create type contract_type as enum ('fixed_price', 'cost_plus');
exception when duplicate_object then null; end $$;

do $$ begin
  create type estimate_status as enum ('draft', 'approved', 'superseded');
exception when duplicate_object then null; end $$;

-- Unidades comuns na construção residencial FL. Extensível.
-- ea=each, sf=square foot, lf=linear foot, cy=cubic yard, ls=lump sum,
-- hr=hour, gal=gallon, sq=roofing square (100 sf), ton=HVAC ton,
-- bid=preço fechado por bid (lump), mo=mês (aluguéis: banheiro químico, etc.).
-- 'bid' e 'mo' vieram do orçamento real da Sunny (Estimate Affordable).
do $$ begin
  create type unit_type as enum
    ('ea', 'sf', 'lf', 'cy', 'ls', 'hr', 'gal', 'sq', 'ton', 'bid', 'mo');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- updated_at trigger helper — reused by every business table.
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ===== 0002_orgs_wbs.sql =====
-- =============================================================================
-- 0002_orgs_wbs.sql
-- Multi-tenant orgs + membership, and the immutable WBS reference tree.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Organizations (multi-tenant boundary). Every business row carries org_id.
-- ---------------------------------------------------------------------------
create table if not exists orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create or replace trigger trg_orgs_updated
  before update on orgs
  for each row execute function set_updated_at();

-- Membership: maps Supabase auth.users → orgs, with a coarse role.
create table if not exists org_members (
  org_id     uuid not null references orgs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index if not exists idx_org_members_user on org_members(user_id);

-- Helper: is the current auth user a member of :org_id ?
-- Used by every RLS policy (migration 0007). SECURITY DEFINER so the policy
-- check can read org_members without recursing into its own RLS.
create or replace function is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from org_members m
    where m.org_id = target_org
      and m.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- WBS reference tree — the 22 immutable categories + named subcategories.
-- GLOBAL / read-only reference data (not org-scoped). Seeded in supabase/seed.
-- Numeração imutável: 'code' is the natural key (e.g. '3', '3.2', '3.2.1').
-- Leaf estimate/invoice lines reference this by code.
-- ---------------------------------------------------------------------------
create table if not exists wbs_nodes (
  code         text primary key,                 -- '1', '1.1', '3.2', ...
  parent_code  text references wbs_nodes(code),   -- null for the 22 top nodes
  name         text not null,
  depth        smallint not null,                 -- 1=category, 2=subcategory, ...
  sort_order   int not null,                      -- numeric ordering within parent
  is_leaf      boolean not null default false,    -- true → real budget lines land here
  created_at   timestamptz not null default now()
);

create index if not exists idx_wbs_parent on wbs_nodes(parent_code);

-- Guard: 'code' must be dotted-numeric so ordering/parsing stays predictable.
alter table wbs_nodes
  drop constraint if exists wbs_code_format;
alter table wbs_nodes
  add constraint wbs_code_format check (code ~ '^[0-9]+(\.[0-9]+)*$');

-- ===== 0003_catalog.sql =====
-- =============================================================================
-- 0003_catalog.sql
-- Suppliers, materials, price history, spec levels and level→material options.
-- The commercial heart: 3 scenarios (Essential/Signature/Luxury) are resolved
-- from spec_level_options × wbs_nodes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------
create table if not exists suppliers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null,
  contact_name text,
  email       citext,
  phone       text,
  website     text,
  notes       text,
  is_preferred boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_suppliers_org on suppliers(org_id);
create or replace trigger trg_suppliers_updated before update on suppliers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Materials — carries the spec_level, photo, brand/model, FL Product Approval.
-- ---------------------------------------------------------------------------
create table if not exists materials (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  wbs_code      text references wbs_nodes(code),   -- primary category this material serves
  spec_level    spec_level not null default 'any',
  name          text not null,
  brand         text,
  model         text,
  unit          unit_type not null default 'ea',
  specs         text,                              -- technical specs (free text)
  memorial      text,                              -- memorial descritivo snippet
  fl_approval   text,                              -- FL# — required for envelope products
  photo_path    text,                              -- Storage pointer (material-photos bucket)
  preferred_supplier_id uuid references suppliers(id) on delete set null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_materials_org on materials(org_id);
create index if not exists idx_materials_wbs on materials(wbs_code);
create index if not exists idx_materials_level on materials(spec_level);
create or replace trigger trg_materials_updated before update on materials
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Supplier quotes (header). Line detail can attach via material_prices.
-- ---------------------------------------------------------------------------
create table if not exists supplier_quotes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  supplier_id  uuid not null references suppliers(id) on delete cascade,
  quote_ref    text,
  quoted_at    date not null,
  valid_until  date,
  file_path    text,                               -- Storage pointer
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_quotes_org on supplier_quotes(org_id);
create index if not exists idx_quotes_supplier on supplier_quotes(supplier_id);
create or replace trigger trg_quotes_updated before update on supplier_quotes
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Material price history. §4.4: nunca inventar preço — cada preço tem origem.
-- Weighting by recency + source happens in the calibration engine (Fase 2).
-- ---------------------------------------------------------------------------
create table if not exists material_prices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  material_id  uuid not null references materials(id) on delete cascade,
  supplier_id  uuid references suppliers(id) on delete set null,
  quote_id     uuid references supplier_quotes(id) on delete set null,
  source       price_source not null,
  unit         unit_type not null,
  unit_price   numeric(14,4) not null check (unit_price >= 0),
  quoted_at    date not null,
  link         text,                               -- web source URL when source='web'
  county       text,                               -- optional regional context
  is_volatile  boolean not null default false,     -- lumber, copper, ... (§3.3)
  created_at   timestamptz not null default now()
);
create index if not exists idx_prices_material on material_prices(material_id, quoted_at desc);
create index if not exists idx_prices_org on material_prices(org_id);

-- ---------------------------------------------------------------------------
-- Spec levels — definition + target $/sf per (org, model, county).
-- Recalibrated automatically in Fase 2. base_model/county null = global default.
-- ---------------------------------------------------------------------------
create table if not exists spec_levels (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  level         spec_level not null check (level <> 'any'),
  base_model    text,                              -- null → applies to all models
  county        text,                              -- null → applies to all counties
  target_psf_low  numeric(10,2),
  target_psf_high numeric(10,2),
  description   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, level, base_model, county)
);
create index if not exists idx_spec_levels_org on spec_levels(org_id);
create or replace trigger trg_spec_levels_updated before update on spec_levels
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Spec level options: (WBS node × level) → default material.
-- This is what lets the system generate the 3 scenarios automatically (§1.3).
-- ---------------------------------------------------------------------------
create table if not exists spec_level_options (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  wbs_code      text not null references wbs_nodes(code),
  level         spec_level not null check (level <> 'any'),
  material_id   uuid not null references materials(id) on delete cascade,
  base_model    text,                              -- null → default for all models
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, wbs_code, level, base_model)
);
create index if not exists idx_slo_org on spec_level_options(org_id);
create index if not exists idx_slo_lookup on spec_level_options(wbs_code, level);
create or replace trigger trg_slo_updated before update on spec_level_options
  for each row execute function set_updated_at();

-- ===== 0004_projects_estimates.sql =====
-- =============================================================================
-- 0004_projects_estimates.sql
-- Projects, uploaded files, estimates (versioned) and their line items.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Projects (§3.5.1). County/wind/flood/water/sewer/contract/level + ARV.
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  name           text not null,
  base_model     text,                            -- free text for now (see ARCHITECTURE §5)
  county         text,
  address        text,
  market         text,                            -- aba = mercado/condado (Parte 2)
  living_area_sf numeric(12,2),
  total_area_sf  numeric(12,2),
  wind_speed_mph int,                             -- drives FL Product Approval validation
  flood_zone     text,                            -- FEMA zone (obrigatório na criação)
  water          water_source,
  sewer          sewer_type,
  contract       contract_type,
  initial_level  spec_level,
  arv            numeric(14,2),                   -- estimated sale value (CMA/ARV)
  program        jsonb,                           -- room program (counts) for multi-driver scaling
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_projects_org on projects(org_id);
alter table projects add column if not exists program jsonb;  -- idempotent for pre-0011 DBs
create or replace trigger trg_projects_updated before update on projects
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Project files — plans (PDF) and other attachments (Storage pointers).
-- ---------------------------------------------------------------------------
create table if not exists project_files (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  kind        text not null default 'plan' check (kind in ('plan', 'attachment', 'export')),
  file_path   text not null,                      -- Storage pointer (plantas bucket)
  file_name   text,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_project_files_project on project_files(project_id);

-- ---------------------------------------------------------------------------
-- Estimates — versioned. Approval freezes an immutable version (§3.5.5).
-- One project can hold many estimates (the 3 scenarios + revisions).
-- ---------------------------------------------------------------------------
create table if not exists estimates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  project_id    uuid not null references projects(id) on delete cascade,
  level         spec_level not null check (level <> 'any'),
  version       int not null default 1,
  status        estimate_status not null default 'draft',
  -- Configurable financials (§3.3): contingency (line 20) + admin fee (line 21).
  contingency_pct numeric(6,3) not null default 0,
  markup_pct      numeric(6,3) not null default 0,
  valid_until   date,                             -- orçamento vence (padrão 30 dias)
  approved_at   timestamptz,
  approved_by   uuid references auth.users(id) on delete set null,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, level, version)
);
create index if not exists idx_estimates_project on estimates(project_id);
create or replace trigger trg_estimates_updated before update on estimates
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Estimate line items. Total is derived (qty_effective × unit_cost) — kept as a
-- generated column so QTY × Unit Cost is always the source of truth (Parte 2).
-- qty_effective = qty × (1 + waste_factor).
-- ---------------------------------------------------------------------------
create table if not exists estimate_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  estimate_id   uuid not null references estimates(id) on delete cascade,
  wbs_code      text not null references wbs_nodes(code),  -- structural (is_leaf) parent node
  line_code     text,                             -- full PKB line code as shown (1.1.1, 2.2, ...)
  material_id   uuid references materials(id) on delete set null,
  supplier_id   uuid references suppliers(id) on delete set null,
  description   text,                             -- overrides material name when set
  qty           numeric(14,4) not null default 0 check (qty >= 0),
  unit          unit_type not null default 'ea',
  unit_cost     numeric(14,4) not null default 0 check (unit_cost >= 0),  -- initial base estimate
  actual_unit_cost numeric(14,4) check (actual_unit_cost is null or actual_unit_cost >= 0), -- real quoted price
  waste_factor  numeric(6,4) not null default 0 check (waste_factor >= 0), -- e.g. 0.10 = 10%
  price_source  price_source not null default 'estimated',
  price_link    text,
  needs_review  boolean not null default false,   -- ⚠️ flag_dúvida do Agente de Takeoff
  is_allowance  boolean not null default false,   -- item ainda não definido (§3.4)
  sort_order    int not null default 0,
  qty_effective numeric(16,6) generated always as (qty * (1 + waste_factor)) stored,
  line_total    numeric(18,4) generated always as (round((qty * (1 + waste_factor) * unit_cost)::numeric, 4)) stored,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_estimate_items_estimate on estimate_items(estimate_id);
create index if not exists idx_estimate_items_wbs on estimate_items(wbs_code);
alter table estimate_items add column if not exists actual_unit_cost numeric(14,4); -- idempotent (0012)

-- Accumulating price memory: real quotes / web / manual observations by category.
create table if not exists price_observations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  wbs_code          text references wbs_nodes(code),
  line_code         text,
  description       text,
  unit              unit_type not null default 'ea',
  unit_price        numeric(14,4) not null check (unit_price >= 0),
  county            text,
  source            text not null default 'real_quote',
  estimate_item_id  uuid references estimate_items(id) on delete set null,
  observed_at       date not null default current_date,
  created_at        timestamptz not null default now()
);
create index if not exists idx_price_obs_org on price_observations(org_id);
create index if not exists idx_price_obs_wbs on price_observations(org_id, wbs_code);

-- 1..N attachments (supplier quotes) per estimate line.
create table if not exists estimate_item_files (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  estimate_item_id  uuid not null references estimate_items(id) on delete cascade,
  file_path         text not null,
  file_name         text,
  supplier          text,                                -- which supplier the quote is from
  is_chosen         boolean not null default false,      -- the quote decided for this line
  created_at        timestamptz not null default now()
);
create index if not exists idx_eif_item on estimate_item_files(estimate_item_id);
alter table estimate_item_files add column if not exists supplier text;              -- idempotent (0013)
alter table estimate_item_files add column if not exists is_chosen boolean not null default false;
create or replace trigger trg_estimate_items_updated before update on estimate_items
  for each row execute function set_updated_at();

-- ===== 0005_invoices_costs.sql =====
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

-- ===== 0006_documents_exports.sql =====
-- =============================================================================
-- 0006_documents_exports.sql
-- Generated documents, change orders, draw schedules, Buildertrend map, RFQ.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Spec documents — generated memoriais/propostas (Storage pointers + metadata).
-- ---------------------------------------------------------------------------
create table if not exists spec_documents (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  project_id  uuid references projects(id) on delete cascade,
  estimate_id uuid references estimates(id) on delete set null,
  doc_type    text not null check (doc_type in (
                'memorial_client', 'memorial_internal',
                'proposta_comparativa', 'draw_schedule',
                'xlsx_pkb', 'buildertrend', 'resumo_executivo')),
  language    text not null default 'pt' check (language in ('pt', 'en')),
  file_path   text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_spec_docs_project on spec_documents(project_id);

-- ---------------------------------------------------------------------------
-- Change orders (§3.4). Post-contract deltas; original estimate stays baseline.
-- ---------------------------------------------------------------------------
create table if not exists change_orders (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  baseline_estimate_id uuid references estimates(id) on delete set null,
  co_number    int not null,
  description  text,
  delta_total  numeric(16,2) not null default 0,
  status       text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, co_number)
);
create index if not exists idx_change_orders_project on change_orders(project_id);
create or replace trigger trg_change_orders_updated before update on change_orders
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Draw schedules (§3.4). Auto-generated disbursement stages for construction loans.
-- ---------------------------------------------------------------------------
create table if not exists draw_schedules (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  estimate_id  uuid references estimates(id) on delete set null,
  stage        text not null,                     -- slab, lintel, dry-in, ...
  stage_order  int not null,
  pct          numeric(6,3),                      -- % of contract for this draw
  amount       numeric(16,2),
  created_at   timestamptz not null default now()
);
create index if not exists idx_draw_schedules_project on draw_schedules(project_id);

-- ---------------------------------------------------------------------------
-- Buildertrend cost-code map (§3.5.6). WBS PKB → BT Cost Code. Reusable.
-- ---------------------------------------------------------------------------
create table if not exists bt_costcode_map (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  wbs_code     text not null references wbs_nodes(code),
  bt_cost_code text not null,
  bt_description text,
  cost_type    text,                              -- BT importer column
  default_markup numeric(6,3),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, wbs_code)
);
create index if not exists idx_bt_map_org on bt_costcode_map(org_id);
create or replace trigger trg_bt_map_updated before update on bt_costcode_map
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RFQ requests (Fase 3) — automated e-mail RFQs and their status.
-- ---------------------------------------------------------------------------
create table if not exists rfq_requests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  project_id   uuid references projects(id) on delete set null,
  supplier_id  uuid references suppliers(id) on delete set null,
  wbs_code     text references wbs_nodes(code),
  status       text not null default 'draft' check (status in ('draft', 'sent', 'responded', 'closed')),
  sent_at      timestamptz,
  responded_at timestamptz,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_rfq_org on rfq_requests(org_id);
create or replace trigger trg_rfq_updated before update on rfq_requests
  for each row execute function set_updated_at();

-- ===== 0007_rls.sql =====
-- =============================================================================
-- 0007_rls.sql
-- Row-Level Security. Every business table is readable/writable only by members
-- of its org. wbs_nodes is global reference data: read-only to any authenticated
-- user, no writes via the API (seeded by migrations).
-- =============================================================================

-- Generic policy generator: for a table with an org_id column, allow all actions
-- to org members and nothing to anyone else.
do $$
declare
  t text;
  org_tables text[] := array[
    'orgs_self',          -- handled specially below
    'suppliers', 'materials', 'supplier_quotes', 'material_prices',
    'spec_levels', 'spec_level_options',
    'projects', 'project_files', 'estimates', 'estimate_items',
    'invoices', 'invoice_items', 'actual_costs', 'county_parameters',
    'spec_documents', 'change_orders', 'draw_schedules',
    'bt_costcode_map', 'rfq_requests',
    'price_observations', 'estimate_item_files'
  ];
begin
  foreach t in array org_tables loop
    if t = 'orgs_self' then
      continue;
    end if;
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists org_rw on %I;', t);
    execute format($f$
      create policy org_rw on %I
        for all
        using (is_org_member(org_id))
        with check (is_org_member(org_id));
    $f$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- orgs + org_members: members see their own org(s).
-- ---------------------------------------------------------------------------
alter table orgs enable row level security;
drop policy if exists org_member_select on orgs;
create policy org_member_select on orgs
  for select using (is_org_member(id));

alter table org_members enable row level security;
drop policy if exists members_self_select on org_members;
create policy members_self_select on org_members
  for select using (user_id = auth.uid() or is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- wbs_nodes: global reference data. Readable by anyone authenticated; writes
-- only via migrations/service role (RLS on with no INSERT/UPDATE/DELETE policy).
-- ---------------------------------------------------------------------------
alter table wbs_nodes enable row level security;
drop policy if exists wbs_read on wbs_nodes;
create policy wbs_read on wbs_nodes
  for select using (auth.role() = 'authenticated');

-- ===== 0008_rpc_org_bootstrap.sql =====
-- =============================================================================
-- 0008_rpc_org_bootstrap.sql
-- Onboarding RPCs. orgs/org_members have no INSERT policy (see 0007), so the
-- client cannot create a tenant directly. These SECURITY DEFINER functions are
-- the sanctioned path: they run as the definer but key every write off auth.uid().
-- =============================================================================

-- Create a new org and make the caller its owner. Returns the new org id.
create or replace function create_org(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'org name required';
  end if;

  insert into orgs (name) values (btrim(p_name)) returning id into new_id;
  insert into org_members (org_id, user_id, role) values (new_id, uid, 'owner');
  return new_id;
end;
$$;

grant execute on function create_org(text) to authenticated;

-- Dev helper: join an existing org by id as a member. Intended for local demos
-- (e.g. attach your login to the seeded demo org). In production, real invites
-- would replace this; kept minimal and still keyed off auth.uid().
create or replace function join_org(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from orgs where id = p_org_id) then
    raise exception 'org not found';
  end if;
  insert into org_members (org_id, user_id, role)
    values (p_org_id, uid, 'member')
  on conflict (org_id, user_id) do nothing;
end;
$$;

grant execute on function join_org(uuid) to authenticated;

-- ===== 0009_seed_wbs_reference.sql =====
-- =============================================================================
-- 0009_seed_wbs_reference.sql
-- WBS reference tree as a MIGRATION (ships to every environment via `db push`),
-- not just local seed. The 22 immutable categories + 13 named subcategories.
-- Idempotent. Keep in sync with Parte 2 da spec.
-- =============================================================================

insert into wbs_nodes (code, parent_code, name, depth, sort_order, is_leaf) values
  ('1',  null, 'Planning & Preconstruction',      1,  1, false),
  ('2',  null, 'Site Work',                       1,  2, true),
  ('3',  null, 'Shell Construction Structure',    1,  3, false),
  ('4',  null, 'M.P.E.G.',                        1,  4, false),
  ('5',  null, 'Insulation',                      1,  5, true),
  ('6',  null, 'Drywall',                         1,  6, true),
  ('7',  null, 'Interior Doors/Trims',            1,  7, true),
  ('8',  null, 'Paint',                           1,  8, true),
  ('9',  null, 'Cabinetry/Counter Top',           1,  9, true),
  ('10', null, 'Hardware',                        1, 10, true),
  ('11', null, 'Sewer/Water Treatment',           1, 11, true),
  ('12', null, 'Flooring',                        1, 12, true),
  ('13', null, 'Garage Door',                     1, 13, true),
  ('14', null, 'Appliances',                      1, 14, true),
  ('15', null, 'Final Grading',                   1, 15, true),
  ('16', null, 'Driveway',                        1, 16, true),
  ('17', null, 'Irrigation',                      1, 17, true),
  ('18', null, 'Landscaping',                     1, 18, true),
  ('19', null, 'Clean-Up',                        1, 19, true),
  ('20', null, 'Punch List/Contingency',          1, 20, true),
  ('21', null, 'Administration Fee',              1, 21, true),
  ('22', null, 'Upgrades',                        1, 22, true),
  ('1.1', '1', 'General Conditions',              2,  1, true),
  ('1.2', '1', 'Architect/Engineering',           2,  2, true),
  ('1.3', '1', 'Recurring Fixed Costs',           2,  3, true),
  ('3.1', '3', 'Slab',                            2,  1, true),
  ('3.2', '3', 'Wall',                            2,  2, true),
  ('3.3', '3', 'Framing',                         2,  3, true),
  ('3.4', '3', 'Windows/Ext Doors',               2,  4, true),
  ('3.5', '3', 'Stucco',                          2,  5, true),
  ('3.6', '3', 'Roofing',                         2,  6, true),
  ('3.7', '3', 'Soffit/Fascia',                   2,  7, true),
  ('4.1', '4', 'HVAC',                            2,  1, true),
  ('4.2', '4', 'Plumbing',                        2,  2, true),
  ('4.3', '4', 'Electrical',                      2,  3, true)
on conflict (code) do update
  set parent_code = excluded.parent_code,
      name        = excluded.name,
      depth       = excluded.depth,
      sort_order  = excluded.sort_order,
      is_leaf     = excluded.is_leaf;

-- ===== data/sunny_affordable/seed_sunny_affordable.sql (projeto-demo) =====
-- Generated by scripts/import_estimate.mjs from data/sunny_affordable
-- sum(qty*unit_cost) = 204641.9 vs expected 204641.9 => MATCH
begin;
insert into orgs (id, name) values ('11111111-1111-1111-1111-111111111111', 'PKB Homes (demo)')
  on conflict (id) do update set name = excluded.name;

insert into projects (id, org_id, name, base_model, county, address, market,
    living_area_sf, total_area_sf, wind_speed_mph, flood_zone, water, sewer, contract, initial_level, arv)
  values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Sunny — Marion Oaks', 'Sunny', 'Marion',
    null, 'Marion Oaks', 1820, 2344,
    130, 'X', 'municipal'::water_source,
    'septic'::sewer_type, null::contract_type,
    'essential'::spec_level, null)
  on conflict (id) do update set
    name=excluded.name, base_model=excluded.base_model, county=excluded.county, market=excluded.market,
    living_area_sf=excluded.living_area_sf, total_area_sf=excluded.total_area_sf,
    wind_speed_mph=excluded.wind_speed_mph, flood_zone=excluded.flood_zone, water=excluded.water,
    sewer=excluded.sewer, contract=excluded.contract, initial_level=excluded.initial_level, arv=excluded.arv;

insert into estimates (id, org_id, project_id, level, version, status, notes)
  values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'essential'::spec_level,
    1, 'draft'::estimate_status,
    'Imported PKB_Homes__Estimate_Affordable_27012026_2.pdf (2026-01-27).')
  on conflict (id) do update set level=excluded.level, status=excluded.status, notes=excluded.notes;

-- Replace this estimate's line items wholesale (idempotent re-import).
delete from estimate_items where estimate_id = '33333333-3333-3333-3333-333333333333';
insert into estimate_items (org_id, estimate_id, wbs_code, line_code, description, qty, unit, unit_cost, price_source, sort_order) values
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.1', 'Doc Box', 1, 'ea'::unit_type, 55, 'catalog'::price_source, 1),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.2', 'Silt Temporary Fencing material', 1, 'ea'::unit_type, 237.5, 'catalog'::price_source, 2),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.3', 'Silt Fence Installation', 1, 'ea'::unit_type, 237.5, 'catalog'::price_source, 3),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.4', 'Notice Of Commencement', 1, 'ea'::unit_type, 65, 'catalog'::price_source, 4),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.5', 'Impact Fees', 1, 'ea'::unit_type, 10300, 'catalog'::price_source, 5),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.6', 'Power Connection', 1, 'ea'::unit_type, 1000, 'catalog'::price_source, 6),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.7', 'INSPEÇÃO /Permits & Permitting Fees', 1, 'ea'::unit_type, 1300, 'catalog'::price_source, 7),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.8', 'Utilities - Water / energy', 1, 'ea'::unit_type, 550, 'catalog'::price_source, 8),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.9', 'Job Insurance - Builders Risk', 1, 'ea'::unit_type, 580, 'catalog'::price_source, 9),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.10', 'General Liability Insurance', 1, 'ea'::unit_type, 1050, 'catalog'::price_source, 10),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.11', 'Fee Permits Run /SOVERING', 1, 'ea'::unit_type, 500, 'catalog'::price_source, 11),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.1', '1.1.12', 'Water Connection', 1, 'ea'::unit_type, 2679, 'catalog'::price_source, 12),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.2', '1.2.1', 'Drawings - Design Site Plan - Civil Engineers', 1, 'sf'::unit_type, 1450, 'catalog'::price_source, 13),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.2', '1.2.2', 'Surveyors', 1, 'ea'::unit_type, 1500, 'catalog'::price_source, 14),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.3', '1.3.1', 'Portable Toilets', 5, 'mo'::unit_type, 106.5, 'catalog'::price_source, 15),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '1.3', '1.3.2', 'Dumpster', 1, 'ea'::unit_type, 1556, 'catalog'::price_source, 16),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '2', '2.1', 'Clearing Lot and Remove Debris', 1, 'bid'::unit_type, 3300, 'catalog'::price_source, 17),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '2', '2.2', 'Load of Fill Dirt', 10, 'ea'::unit_type, 255, 'catalog'::price_source, 18),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '2', '2.3', 'House Pad Preparation', 1, 'ea'::unit_type, 500, 'catalog'::price_source, 19),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.1', '3.1.1', 'Mono Slab as per plan (labor+mat foundation+concrete)', 1, 'sf'::unit_type, 14705.63, 'catalog'::price_source, 20),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.1', '3.1.2', 'Boom Pump', 1, 'ls'::unit_type, 900, 'catalog'::price_source, 21),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.1', '3.1.3', 'Geo Compaction test', 1, 'ls'::unit_type, 250, 'catalog'::price_source, 22),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.1', '3.1.4', 'Re-treated footers - pest control', 1, 'ls'::unit_type, 466, 'catalog'::price_source, 23),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.2', '3.2.1', 'Lintel/Block', 1, 'ls'::unit_type, 9700, 'catalog'::price_source, 24),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.2', '3.2.2', 'Fill Cells/lintels w/pump included - labor+equipment', 1, 'ls'::unit_type, 850, 'catalog'::price_source, 25),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.2', '3.2.3', 'Cement material', 1, 'ls'::unit_type, 2300, 'catalog'::price_source, 26),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.2', '3.2.4', 'Block labor', 1, 'ls'::unit_type, 4400, 'catalog'::price_source, 27),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.3', '3.3.1', 'Roof Trusses', 1, 'ls'::unit_type, 6300, 'catalog'::price_source, 28),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.3', '3.3.2', 'Framing/Roof', 1, 'ls'::unit_type, 5977.2, 'catalog'::price_source, 29),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.3', '3.3.3', 'Framing Materials', 1, 'ls'::unit_type, 5841.55, 'catalog'::price_source, 30),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.4', '3.4.1', 'Doors (2 exterior doors + sliding door)', 1, 'ls'::unit_type, 4170, 'catalog'::price_source, 31),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.4', '3.4.2', 'Windows (bundled)', 1, 'ls'::unit_type, 0, 'catalog'::price_source, 32),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.4', '3.4.3', 'Exterior doors and windows labor', 1, 'ls'::unit_type, 1500, 'catalog'::price_source, 33),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.4', '3.4.4', 'Installing sills on the windows', 1, 'ls'::unit_type, 125, 'catalog'::price_source, 34),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.5', '3.5.1', 'Stucco Material/Labor', 1, 'ls'::unit_type, 4300, 'catalog'::price_source, 35),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.6', '3.6.1', 'Shingle Install - Roofing Shingle', 1, 'ls'::unit_type, 7300, 'catalog'::price_source, 36),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '3.7', '3.7.1', 'Soffit/Fascia material and labor', 1, 'ls'::unit_type, 1300, 'catalog'::price_source, 37),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '4.1', '4.1.1', 'HVAC System', 1, 'bid'::unit_type, 8084, 'catalog'::price_source, 38),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '4.2', '4.2.1', 'Plumbing System', 1, 'bid'::unit_type, 8187, 'catalog'::price_source, 39),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '4.3', '4.3.1', 'Electrical System', 1, 'bid'::unit_type, 7800, 'catalog'::price_source, 40),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '5', '5.1', 'Insulation', 1, 'ls'::unit_type, 1725, 'catalog'::price_source, 41),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '6', '6.1', 'Drywall material', 1, 'ls'::unit_type, 8000, 'catalog'::price_source, 42),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '6', '6.2', 'Drywall finish/texture/move drywall inside - labor (bundled)', 1, 'ls'::unit_type, 0, 'catalog'::price_source, 43),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '7', '7.1', 'Doors / baseboard', 1, 'bid'::unit_type, 3463.02, 'catalog'::price_source, 44),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '7', '7.2', 'Trim material (bundled)', 1, 'ls'::unit_type, 0, 'catalog'::price_source, 45),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '7', '7.3', 'Trim / Doors / Baseboard labor', 1, 'ea'::unit_type, 1100, 'catalog'::price_source, 46),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '7', '7.4', 'Polo Satin Nickel Interior / exterior', 1, 'ls'::unit_type, 386, 'catalog'::price_source, 47),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '8', '8.1', 'Paint material', 1, 'ea'::unit_type, 4500, 'catalog'::price_source, 48),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '8', '8.2', 'Paint labor (bundled)', 1, 'ls'::unit_type, 0, 'catalog'::price_source, 49),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '9', '9.1', 'Cabinets', 1, 'ls'::unit_type, 5050, 'catalog'::price_source, 50),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '9', '9.2', 'Counter top / backsplash (bundled)', 1, 'ls'::unit_type, 0, 'catalog'::price_source, 51),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '10', '10.1', 'Wire Closet Shelves', 1, 'ls'::unit_type, 400, 'catalog'::price_source, 52),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '10', '10.2', 'Hardware set brushed nickel', 1, 'ls'::unit_type, 50, 'catalog'::price_source, 53),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '10', '10.3', 'Pendant Kitchen', 1, 'ls'::unit_type, 175, 'catalog'::price_source, 54),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '10', '10.4', 'Light bathroom', 1, 'ls'::unit_type, 180, 'catalog'::price_source, 55),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '10', '10.5', 'Outdoor light wall fixtures', 1, 'ls'::unit_type, 145, 'catalog'::price_source, 56),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '10', '10.6', 'Shower Mirror', 1, 'ls'::unit_type, 250, 'catalog'::price_source, 57),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '10', '10.7', 'Accessories Install', 1, 'ls'::unit_type, 250, 'catalog'::price_source, 58),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '11', '11.1', 'Septic Tank Contractor', 1, 'ea'::unit_type, 6500, 'catalog'::price_source, 59),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '12', '12.1', 'Vinyl floor material/labor', 1, 'ls'::unit_type, 4260, 'catalog'::price_source, 60),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '12', '12.2', 'Tiles - wall and floor - material', 1, 'ls'::unit_type, 1050, 'catalog'::price_source, 61),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '12', '12.3', 'Tiles - wall and floor - labor', 1, 'ls'::unit_type, 900, 'catalog'::price_source, 62),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '12', '12.4', 'Paver', 1, 'ls'::unit_type, 1300, 'catalog'::price_source, 63),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '12', '12.5', 'Epoxy garage', 1, 'ls'::unit_type, 450, 'catalog'::price_source, 64),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '13', '13.1', 'Garage Door and Opener System', 1, 'ea'::unit_type, 1950, 'catalog'::price_source, 65),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '14', '14.1', 'Microwave, dishwasher, refrigerator, etc.', 1, 'ls'::unit_type, 2750, 'catalog'::price_source, 66),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '15', '15.1', 'Final Grading Around The House', 1, 'ea'::unit_type, 400, 'catalog'::price_source, 67),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '16', '16.1', 'Driveway', 1, 'ea'::unit_type, 5047, 'catalog'::price_source, 68),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '17', '17.1', 'Irrigation System / Garden', 1, 'ea'::unit_type, 850, 'catalog'::price_source, 69),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '18', '18.1', 'Bahia Grass Sod Installed', 1, 'ea'::unit_type, 3312, 'catalog'::price_source, 70),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '19', '19.1', 'Final Cleaning Services', 1, 'bid'::unit_type, 350, 'catalog'::price_source, 71),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '20', '20.1', 'Punch List Miscellaneous Items', 1, 'bid'::unit_type, 450, 'catalog'::price_source, 72),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '21', '21.1', 'Administration Fee', 1, 'bid'::unit_type, 25000, 'catalog'::price_source, 73),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '22', '22.1', 'Box', 1, 'bid'::unit_type, 0, 'catalog'::price_source, 74),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '22', '22.2', 'Blinds', 2, 'bid'::unit_type, 0, 'catalog'::price_source, 75),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '22', '22.3', 'Mailbox', 3, 'bid'::unit_type, 0, 'catalog'::price_source, 76),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '22', '22.4', 'Washer', 4, 'bid'::unit_type, 0, 'catalog'::price_source, 77);
commit;


-- ===== 0014_bt_costcodes_variances.sql =====
-- =============================================================================
-- 0014_bt_costcodes_variances.sql
--
-- Replaces the legacy 22-category WBS reference tree with the updated
-- BuilderTrend cost-code taxonomy (11 categories / 91 leaf cost codes,
-- from BTCostCodes_20260901). Existing estimate lines are PRESERVED and
-- remapped to the matching NEW category — their description / qty / costs are
-- untouched; only the structural bucket (wbs_code) moves. A per-line cost code
-- (leaf) can then be assigned in the UI.
--
-- Also adds a global Variance-code catalog (8 categories / 37 codes) and lets
-- each estimate line carry a variance code + note (why actual != estimate).
--
-- Codes stay dotted-numeric ('NN' category, 'NN.NN.NN' leaf) so the
-- wbs_code_format guard and the split('.')[0] category logic keep working.
-- Idempotent: the one-time data remap is guarded by a sentinel so a re-run
-- never touches already-migrated rows (new categories '10'/'11' would
-- otherwise collide with the legacy Hardware/Sewer categories).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) New cost-code nodes. Inserted BEFORE the legacy tree is removed so
--    estimate_items never lose their FK target mid-migration.
-- ---------------------------------------------------------------------------

-- 1a) Categories (depth 1). NOTE: '10' and '11' intentionally overwrite the
--     legacy Hardware / Sewer categories (same code); all their old lines are
--     remapped away in step 2 before anything is deleted.
insert into wbs_nodes (code, parent_code, name, depth, sort_order, is_leaf) values
  ('01', null, 'Planning & Pre-construction', 1, 1, false),
  ('02', null, 'Demolition & Site Work', 1, 2, false),
  ('03', null, 'Estructure', 1, 3, false),
  ('04', null, 'M.P.E. System', 1, 4, false),
  ('05', null, 'Insulation & Drywall', 1, 5, false),
  ('06', null, 'Flooring', 1, 6, false),
  ('07', null, 'Interior finishes', 1, 7, false),
  ('08', null, 'Exterior finishes', 1, 8, false),
  ('09', null, 'Completion & Inspection', 1, 9, false),
  ('10', null, 'General Conditions', 1, 10, false),
  ('11', null, 'Upgrades', 1, 11, false)
on conflict (code) do update
  set parent_code = excluded.parent_code, name = excluded.name,
      depth = excluded.depth, sort_order = excluded.sort_order, is_leaf = excluded.is_leaf;

-- 1b) Leaf cost codes (depth 2, parent = its category). 'Lumber' arrived in the
--     source sheet sharing 03.30.02 with 'Framing'; the duplicate is stored as
--     03.30.03 so both survive as distinct codes.
insert into wbs_nodes (code, parent_code, name, depth, sort_order, is_leaf) values
  ('01.10.01', '01', 'Architect / Engineering', 2, 1, true),
  ('01.10.02', '01', 'Interior design', 2, 2, true),
  ('01.10.03', '01', 'Surveys', 2, 3, true),
  ('01.20.01', '01', 'Permit fees', 2, 4, true),
  ('01.20.02', '01', 'Impact fees', 2, 5, true),
  ('01.20.03', '01', 'Inspection fees', 2, 6, true),
  ('01.30.01', '01', 'Builders risk', 2, 7, true),
  ('01.30.02', '01', 'General liability insurance', 2, 8, true),
  ('01.40.01', '01', 'Power connection', 2, 9, true),
  ('01.40.02', '01', 'Water connection', 2, 10, true),
  ('01.50.01', '01', 'Septic system', 2, 11, true),
  ('02.10.01', '02', 'Demolition', 2, 12, true),
  ('02.10.02', '02', 'Lot clearing', 2, 13, true),
  ('02.20.01', '02', 'Excavation and backfill', 2, 14, true),
  ('02.30.01', '02', 'Rough grading', 2, 15, true),
  ('03.10.01', '03', 'Foundation - labor', 2, 16, true),
  ('03.10.02', '03', 'Foundation - material', 2, 17, true),
  ('03.10.03', '03', 'Compaction test', 2, 18, true),
  ('03.10.04', '03', 'Termite protection', 2, 19, true),
  ('03.20.01', '03', 'Block and lintel - labor', 2, 20, true),
  ('03.20.02', '03', 'Block and lintel - material', 2, 21, true),
  ('03.30.01', '03', 'Trusses', 2, 22, true),
  ('03.30.02', '03', 'Framing', 2, 23, true),
  ('03.30.03', '03', 'Lumber', 2, 24, true),
  ('03.40.01', '03', 'Housewrap - labor', 2, 25, true),
  ('03.40.02', '03', 'Housewrap - material', 2, 26, true),
  ('03.50.01', '03', 'Exterior doors and windows - labor', 2, 27, true),
  ('03.50.02', '03', 'Exterior doors and windows - material', 2, 28, true),
  ('03.60.01', '03', 'Roofing', 2, 29, true),
  ('04.10.01', '04', 'HVAC - labor', 2, 30, true),
  ('04.10.02', '04', 'HVAC - material', 2, 31, true),
  ('04.20.01', '04', 'Plumbing - labor', 2, 32, true),
  ('04.20.02', '04', 'Plumbing - material', 2, 33, true),
  ('04.30.01', '04', 'Electrical - labor', 2, 34, true),
  ('04.30.02', '04', 'Electrical - material', 2, 35, true),
  ('04.40.01', '04', 'Gas', 2, 36, true),
  ('05.10.01', '05', 'Insulation', 2, 37, true),
  ('05.20.01', '05', 'Drywall - labor', 2, 38, true),
  ('05.20.02', '05', 'Drywall - material', 2, 39, true),
  ('06.10.01', '06', 'Vinyl - labor', 2, 40, true),
  ('06.10.02', '06', 'Vinyl - material', 2, 41, true),
  ('06.20.01', '06', 'Ceramic tiles - labor', 2, 42, true),
  ('06.20.02', '06', 'Ceramic tiles - material', 2, 43, true),
  ('06.30.01', '06', 'Hardwood - labor', 2, 44, true),
  ('06.30.02', '06', 'Hardwood - material', 2, 45, true),
  ('06.40.01', '06', 'Garage floor coating', 2, 46, true),
  ('07.10.01', '07', 'Painting - labor', 2, 47, true),
  ('07.10.02', '07', 'Painting - material', 2, 48, true),
  ('07.20.01', '07', 'Interior trim - labor', 2, 49, true),
  ('07.20.03', '07', 'Interior doors - labor', 2, 50, true),
  ('07.20.04', '07', 'Interior doors - material', 2, 51, true),
  ('07.20.05', '07', 'Hardware - labor', 2, 52, true),
  ('07.20.06', '07', 'Hardware - material', 2, 53, true),
  ('07.20.07', '07', 'Stairs and Railings - labor', 2, 54, true),
  ('07.20.08', '07', 'Stairs and Railings - material', 2, 55, true),
  ('07.30.01', '07', 'Cabinets', 2, 56, true),
  ('07.30.02', '07', 'Countertops', 2, 57, true),
  ('07.30.03', '07', 'Closet shelves', 2, 58, true),
  ('07.40.01', '07', 'Light fixtures', 2, 59, true),
  ('07.40.02', '07', 'Plumbing trims', 2, 60, true),
  ('07.50.01', '07', 'Mirrors - labor', 2, 61, true),
  ('07.50.02', '07', 'Mirrors - material', 2, 62, true),
  ('07.50.03', '07', 'Bath accessories - labor', 2, 63, true),
  ('07.50.04', '07', 'Bath accessories - material', 2, 64, true),
  ('07.60.01', '07', 'Appliances - labor', 2, 65, true),
  ('07.60.02', '07', 'Appliances - material', 2, 66, true),
  ('08.10.01', '08', 'Stucco', 2, 67, true),
  ('08.10.02', '08', 'Exterior brick/stone', 2, 68, true),
  ('08.20.01', '08', 'Soffit and fascia', 2, 69, true),
  ('08.20.02', '08', 'Gutters and downspots', 2, 70, true),
  ('08.30.01', '08', 'Final grading', 2, 71, true),
  ('08.40.01', '08', 'Garage door', 2, 72, true),
  ('08.50.01', '08', 'Driveway', 2, 73, true),
  ('08.50.02', '08', 'Patios and walks', 2, 74, true),
  ('08.60.01', '08', 'Irrigation system', 2, 75, true),
  ('08.60.02', '08', 'Landscaping', 2, 76, true),
  ('08.70.01', '08', 'Fencing', 2, 77, true),
  ('08.80.01', '08', 'Mailbox and number', 2, 78, true),
  ('09.10.01', '09', 'Final clean up', 2, 79, true),
  ('09.20.01', '09', 'Punch list', 2, 80, true),
  ('10.10.01', '10', 'Site maintenance', 2, 81, true),
  ('10.20.01', '10', 'Construction utilities', 2, 82, true),
  ('10.20.02', '10', 'Portable toilets', 2, 83, true),
  ('10.20.03', '10', 'Dumpster', 2, 84, true),
  ('10.30.01', '10', 'Builder''s fee', 2, 85, true),
  ('11.10.01', '11', 'Shower glass', 2, 86, true),
  ('11.20.01', '11', 'Blinds', 2, 87, true),
  ('11.40.01', '11', 'Washer and dryer', 2, 88, true),
  ('11.50.01', '11', 'Summer kitchen', 2, 89, true),
  ('11.60.01', '11', 'Pool and deck', 2, 90, true),
  ('11.70.01', '11', 'Wine cooler', 2, 91, true)
on conflict (code) do update
  set parent_code = excluded.parent_code, name = excluded.name,
      depth = excluded.depth, sort_order = excluded.sort_order, is_leaf = excluded.is_leaf;

-- ---------------------------------------------------------------------------
-- 2) One-time data remap + removal of the legacy tree. Guarded by a sentinel
--    (legacy bare '3' node) so re-running is a no-op.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from wbs_nodes where code = '3') then
    -- Preserve every estimate line: repoint to the mapped NEW category, drop the
    -- stale dotted line_code so the cost-code cell shows the new code cleanly.
    update estimate_items
       set wbs_code  = case split_part(wbs_code, '.', 1)
      when '1'  then '01' when '2'  then '02' when '3'  then '03' when '4'  then '04'
      when '5'  then '05' when '6'  then '05' when '7'  then '07' when '8'  then '07'
      when '9'  then '07' when '10' then '07' when '11' then '04' when '12' then '06'
      when '13' then '08' when '14' then '07' when '15' then '08' when '16' then '08'
      when '17' then '08' when '18' then '08' when '19' then '09' when '20' then '09'
      when '21' then '10' when '22' then '11'
      else wbs_code end,
           line_code = null
     where split_part(wbs_code, '.', 1) in
           ('1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22');

    -- Repoint the price memory the same way (FK to wbs_nodes, no cascade).
    update price_observations
       set wbs_code = case split_part(wbs_code, '.', 1)
      when '1'  then '01' when '2'  then '02' when '3'  then '03' when '4'  then '04'
      when '5'  then '05' when '6'  then '05' when '7'  then '07' when '8'  then '07'
      when '9'  then '07' when '10' then '07' when '11' then '04' when '12' then '06'
      when '13' then '08' when '14' then '07' when '15' then '08' when '16' then '08'
      when '17' then '08' when '18' then '08' when '19' then '09' when '20' then '09'
      when '21' then '10' when '22' then '11'
      else wbs_code end
     where wbs_code is not null
       and split_part(wbs_code, '.', 1) in
           ('1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22');

    -- Repoint any BuilderTrend map rows (usually empty) before deleting nodes.
    update bt_costcode_map
       set wbs_code = case split_part(wbs_code, '.', 1)
      when '1'  then '01' when '2'  then '02' when '3'  then '03' when '4'  then '04'
      when '5'  then '05' when '6'  then '05' when '7'  then '07' when '8'  then '07'
      when '9'  then '07' when '10' then '07' when '11' then '04' when '12' then '06'
      when '13' then '08' when '14' then '07' when '15' then '08' when '16' then '08'
      when '17' then '08' when '18' then '08' when '19' then '09' when '20' then '09'
      when '21' then '10' when '22' then '11'
      else wbs_code end
     where split_part(wbs_code, '.', 1) in
           ('1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22');

    -- Remove the legacy nodes (categories '1'..'9','12'..'22' + subcats).
    -- '10' and '11' are kept: they are now the new General Conditions / Upgrades.
    delete from wbs_nodes where code in ('1','2','3','4','5','6','7','8','9','12','13','14','15','16','17','18','19','20','21','22','1.1','1.2','1.3','3.1','3.2','3.3','3.4','3.5','3.6','3.7','4.1','4.2','4.3');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Variance-code catalog (global reference, like wbs_nodes).
-- ---------------------------------------------------------------------------
create table if not exists variance_codes (
  code       text primary key,             -- '01','11','21',...  (BT variance code)
  name       text not null,                -- 'Price change'
  category   text not null,                -- '20 - 29 Purchasing'
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);

insert into variance_codes (code, name, category, sort_order) values
  ('01', 'Dimensioning Error', '0 - 9 Plans', 1),
  ('02', 'Unclear detail', '0 - 9 Plans', 2),
  ('03', 'Code violation', '0 - 9 Plans', 3),
  ('11', 'Omitted from estimate', '10 - 19 Estimating', 4),
  ('12', 'Data entry error (typo)', '10 - 19 Estimating', 5),
  ('13', 'Take-off error', '10 - 19 Estimating', 6),
  ('14', 'Missed in EPO review', '10 - 19 Estimating', 7),
  ('21', 'Price change', '20 - 29 Purchasing', 8),
  ('22', 'Vendor change', '20 - 29 Purchasing', 9),
  ('23', 'Omitted in SOW', '20 - 29 Purchasing', 10),
  ('24', 'Short-shipped', '20 - 29 Purchasing', 11),
  ('25', 'Wrong material shipped', '20 - 29 Purchasing', 12),
  ('26', 'Poor quality of material', '20 - 29 Purchasing', 13),
  ('27', 'Tax-rate difference', '20 - 29 Purchasing', 14),
  ('31', 'Wet weather', '30 - 39 Weather', 15),
  ('32', 'Freezing conditions', '30 - 39 Weather', 16),
  ('33', 'Wind/storm damage', '30 - 39 Weather', 17),
  ('34', 'Weather precaution', '30 - 39 Weather', 18),
  ('41', 'Unanticipated sub-surface', '40 - 49 Site Conditions', 19),
  ('42', 'Elevation varies from standard', '40 - 49 Site Conditions', 20),
  ('43', 'Special sites cleaning', '40 - 49 Site Conditions', 21),
  ('44', 'Streets not in', '40 - 49 Site Conditions', 22),
  ('45', 'Dirt needed for grade', '40 - 49 Site Conditions', 23),
  ('46', 'Dirt removal needed', '40 - 49 Site Conditions', 24),
  ('47', 'Code Official Mandated', '40 - 49 Site Conditions', 25),
  ('51', 'Error/damage by trade', '50 - 59 Trade Contractor/Vendor', 26),
  ('52', 'Incorrect use of material', '50 - 59 Trade Contractor/Vendor', 27),
  ('53', 'Failure to protect work', '50 - 59 Trade Contractor/Vendor', 28),
  ('54', 'Replace inferior work', '50 - 59 Trade Contractor/Vendor', 29),
  ('61', 'Superintendent error', '60 - 69 Field Supervision', 30),
  ('62', 'Management concession', '60 - 69 Field Supervision', 31),
  ('63', 'Theft', '60 - 69 Field Supervision', 32),
  ('64', 'Vandalism', '60 - 69 Field Supervision', 33),
  ('65', 'Transfer materials', '60 - 69 Field Supervision', 34),
  ('71', 'Sales concession', '70 - 79 Sales & Marketing', 35),
  ('72', 'Client change order', '70 - 79 Sales & Marketing', 36),
  ('73', 'Allowance change order', '70 - 79 Sales & Marketing', 37)
on conflict (code) do update
  set name = excluded.name, category = excluded.category, sort_order = excluded.sort_order;

alter table variance_codes enable row level security;
drop policy if exists variance_read on variance_codes;
create policy variance_read on variance_codes
  for select using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- 4) Let each estimate line carry a variance code + free note.
-- ---------------------------------------------------------------------------
alter table estimate_items add column if not exists variance_code text references variance_codes(code);
alter table estimate_items add column if not exists variance_note text;
