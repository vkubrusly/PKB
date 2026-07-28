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
