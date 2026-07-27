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
