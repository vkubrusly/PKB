-- =============================================================================
-- 0010 — add the "affordable" spec level as the entry tier.
--
-- Tiers become: affordable < essential < signature < luxury (+ 'any' for
-- catalog items that fit any level). "affordable" is the value-line / basic
-- product (e.g. the Sunny Marion Oaks model).
--
-- NOTE: ALTER TYPE ... ADD VALUE runs outside a transaction and the new value
-- cannot be used in the same statement batch — run this migration on its own.
-- =============================================================================

alter type spec_level add value if not exists 'affordable' before 'essential';
