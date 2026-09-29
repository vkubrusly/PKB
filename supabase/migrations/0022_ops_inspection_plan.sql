-- The inspections each permit requires, as the county portal lists them for that permit
-- (EnerGov: done + not-yet-requested required types; Accela lists every one up front).
-- {source, collected_at, required: [type…], optional: [type…]}; used by inspection_progress.
alter table ops.permit_cases add column if not exists inspection_plan jsonb;
