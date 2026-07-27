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
    'bt_costcode_map', 'rfq_requests'
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
