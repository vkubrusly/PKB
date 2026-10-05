-- =============================================================================
-- 0029 — Gabriel Basso (gabriel@pkbhomes.com) joins as a partner: portal access
-- (budget.pkbhomes.com/ops/) and the weekly digest (Victor, 2026-10-05).
-- =============================================================================
insert into ops.portal_users (email, name, role) values ('gabriel@pkbhomes.com', 'Gabriel Basso', 'partner')
on conflict (email) do update set role = 'partner', name = excluded.name;
