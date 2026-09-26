-- =============================================================================
-- 0016_ops_monitoring_stage.sql
-- Monitoring lifecycle of a building permit (decided 2026-09-26):
--   1. permit      — until the permit is issued: reviews, corrections, holds, fees
--   2. inspections — from issuance until the CO: inspections only
--   3. done        — CO received (or permit finaled/cancelled): stop collecting
-- The collector reads ops.monitoring_queue to know what to check each morning.
-- =============================================================================

alter table ops.jobs add column if not exists co_at date;   -- Certificate of Occupancy

create or replace view ops.monitoring_queue as
select
  c.id            as permit_case_id,
  c.org_id,
  c.job_id,
  j.job_number,
  j.address,
  c.portal,
  c.number,
  case
    when j.co_at is not null or j.status in ('completed', 'cancelled') or c.finaled_at is not null or c.ops_status in ('finaled', 'cancelled') then 'done'
    when c.issued_at is not null or c.ops_status = 'issued'                                         then 'inspections'
    else 'permit'
  end             as stage,
  c.last_collected_at
from ops.permit_cases c
join ops.jobs j on j.id = c.job_id
where c.kind = 'building' and c.number is not null;

grant select on ops.monitoring_queue to authenticated, service_role;
