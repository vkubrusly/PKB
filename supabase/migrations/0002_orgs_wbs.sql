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
