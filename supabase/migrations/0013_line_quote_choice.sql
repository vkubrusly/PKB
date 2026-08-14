-- =============================================================================
-- 0013 — per-line supplier quotes: mark the chosen one + label the supplier.
--   is_chosen: the quote the team decided to use for that line (drives the
--              green/red "defined vs pending" indicator).
--   supplier : which supplier the quote came from (quotes arrive from several).
-- =============================================================================

alter table estimate_item_files add column if not exists is_chosen boolean not null default false;
alter table estimate_item_files add column if not exists supplier text;
