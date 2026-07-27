-- =============================================================================
-- seed.sql — reference data loaded by `supabase db reset`.
-- Currently: the WBS reference tree (Parte 2 da spec — numeração imutável).
--
-- Spec levels ($/sf targets) and the catalog are org-scoped and created per
-- tenant at onboarding, so they are NOT seeded globally here. A commented
-- example block at the end shows the shape for local development.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- WBS — 22 top categories + named subcategories.
-- is_leaf = true where budget lines attach directly (no seeded children).
-- Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------
insert into wbs_nodes (code, parent_code, name, depth, sort_order, is_leaf) values
  -- ===== Categories (depth 1) =====
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

  -- ===== 1 Planning & Preconstruction =====
  ('1.1', '1', 'General Conditions',              2,  1, true),
  ('1.2', '1', 'Architect/Engineering',           2,  2, true),
  ('1.3', '1', 'Recurring Fixed Costs',           2,  3, true),

  -- ===== 3 Shell Construction Structure =====
  ('3.1', '3', 'Slab',                            2,  1, true),
  ('3.2', '3', 'Wall',                            2,  2, true),
  ('3.3', '3', 'Framing',                         2,  3, true),
  ('3.4', '3', 'Windows/Ext Doors',               2,  4, true),
  ('3.5', '3', 'Stucco',                          2,  5, true),
  ('3.6', '3', 'Roofing',                         2,  6, true),
  ('3.7', '3', 'Soffit/Fascia',                   2,  7, true),

  -- ===== 4 M.P.E.G. =====
  ('4.1', '4', 'HVAC',                            2,  1, true),
  ('4.2', '4', 'Plumbing',                        2,  2, true),
  ('4.3', '4', 'Electrical',                      2,  3, true)
on conflict (code) do update
  set parent_code = excluded.parent_code,
      name        = excluded.name,
      depth       = excluded.depth,
      sort_order  = excluded.sort_order,
      is_leaf     = excluded.is_leaf;

-- ---------------------------------------------------------------------------
-- Local-dev example (commented). Uncomment and set a real org_id to seed the
-- three PKB spec levels with their target $/sf bands (Tabela §1.2).
-- ---------------------------------------------------------------------------
-- insert into spec_levels (org_id, level, target_psf_low, target_psf_high, description) values
--   ('<ORG_UUID>', 'essential', 165, 180, 'Entrada / investidor / aluguel'),
--   ('<ORG_UUID>', 'signature', 200, 225, 'Padrão PKB / cliente final'),
--   ('<ORG_UUID>', 'luxury',    245, 280, 'Alto padrão / custom')
-- on conflict (org_id, level, base_model, county) do nothing;
