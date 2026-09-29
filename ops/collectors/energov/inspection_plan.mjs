#!/usr/bin/env node
// =============================================================================
// inspection_plan.mjs — the inspections each EnerGov permit requires, straight from
// the county portal (public JSON, no browser):
//   existing   IsExistingInspection:true   → every inspection already requested
//   required   IsExistingInspection:false, IsOptionalInspection:false → required, not yet requested
//   optional   IsExistingInspection:false, IsOptionalInspection:true  → optional types
// Stores ops.permit_cases.inspection_plan = {source, collected_at, required, optional}
// where required = existing ∪ not-yet-requested required types.
//   node collectors/energov/inspection_plan.mjs [--all]   (default: issued permits still monitored)
// =============================================================================
import { sql } from '../../scripts/sb.mjs';
import { TENANTS } from './inspection_comments.mjs';

const PORTALS = { 'energov:marion': 'marion', 'energov:winterpark': 'winterpark' };
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const headers = (t) => ({ 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', tenantid: '1', tenantname: t.tenantname, 'tyler-tenanturl': t.tenanturl, 'tyler-tenant-culture': 'en-US' });

async function search(t, caseId, existing, optional) {
  const res = await fetch(`${t.base}/api/energov/entity/inspections/search/search`, {
    method: 'POST', headers: headers(t),
    body: JSON.stringify({ PageNumber: 1, PageSize: 200, SortField: '', IsSortedInAscendingOrder: true, ModuleId: 1, EntityId: caseId, IsExistingInspection: existing, IsOptionalInspection: optional, IsFailed: false }),
  });
  const body = await res.json();
  if (!body.Success) throw new Error(body.ErrorMessage || `HTTP ${res.status}`);
  return [...new Set((body.Result || []).map((r) => (r.InspectionType || r.InspectionTypeName || '').trim()).filter(Boolean))];
}

const all = process.argv.includes('--all');
const cases = await sql(`select c.id, c.portal, c.number, c.portal_case_id from ops.permit_cases c
  left join ops.monitoring_queue q on q.permit_case_id = c.id
  where c.portal in (${Object.keys(PORTALS).map(q).join(',')}) and c.kind = 'building' and c.portal_case_id is not null
    and c.issued_at is not null ${all ? '' : "and coalesce(q.stage, 'inspections') <> 'done'"}`);
let ok = 0;
for (const c of cases) {
  const t = TENANTS[PORTALS[c.portal]];
  try {
    const [existing, remaining, optional] = await Promise.all([search(t, c.portal_case_id, true, false), search(t, c.portal_case_id, false, false), search(t, c.portal_case_id, false, true)]);
    const plan = { source: c.portal, collected_at: new Date().toISOString(), required: [...new Set([...existing, ...remaining])], optional: optional.filter((o) => !existing.includes(o) && !remaining.includes(o)) };
    await sql(`update ops.permit_cases set inspection_plan = ${q(JSON.stringify(plan))}::jsonb where id = ${q(c.id)}`);
    ok++;
  } catch (e) { console.error(`${c.number}: ${e.message}`); }
}
console.log(`inspection plans: ${ok}/${cases.length} EnerGov permits`);
