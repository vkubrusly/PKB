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
