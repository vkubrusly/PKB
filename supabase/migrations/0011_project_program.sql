-- =============================================================================
-- 0011 — project "program" (deep analysis result).
--
-- The parametric engine can't scale by area alone: a 2nd kitchen or an extra
-- bathroom is a COUNT-driven cost, not an area-driven one. We store the room
-- program per project so the engine can scale each WBS category by its real
-- driver (kitchens, baths, openings, area, fixed). Filled by the AI plan
-- analysis and confirmed by the user before budgeting.
--
-- Shape (all optional): {
--   bedrooms, full_baths, half_baths, kitchens, laundries, garage_bays,
--   stories, doors, windows, has_inlaw
-- }
-- =============================================================================

alter table projects add column if not exists program jsonb;
