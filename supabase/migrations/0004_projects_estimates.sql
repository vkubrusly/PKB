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
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_projects_org on projects(org_id);
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
  unit_cost     numeric(14,4) not null default 0 check (unit_cost >= 0),
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
create or replace trigger trg_estimate_items_updated before update on estimate_items
  for each row execute function set_updated_at();
