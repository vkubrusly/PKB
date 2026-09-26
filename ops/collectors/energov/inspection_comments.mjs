// Inspector comments for EnerGov inspections (the "Checklist" tab of an inspection).
//
// Public JSON endpoint, no login and no browser needed — only the tenant headers the
// Civic Access site sends:
//   POST {base}/api/energov/entity/checklist/search
//   {PageNumber, PageSize, SortField:"NAME", IsSortedInAscendingOrder, ModuleId:7, EntityId:<InspectionId>}
// Each row: CheckListItem, Description, Passed, Comments, Order, IsNA.
// Marion writes the corrections as "General Comments" (e.g. "9/24/26\n1. NOT READY: FBC 110.5 …").
//
//   node collectors/energov/inspection_comments.mjs marion <InspectionId> [...]

export const TENANTS = {
  marion: { base: 'https://selfservice.marionfl.org/energov_prod/selfservice', tenantname: 'Marion County EnerGov_Prod', tenanturl: 'home' },
  winterpark: { base: 'https://selfservice.cityofwinterpark.org/energov_prod/selfservice', tenantname: 'City of Winter Park Permitting Self Service Portal', tenanturl: 'Home' },
};

const headers = (t) => ({ 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', tenantid: '1', tenantname: t.tenantname, 'tyler-tenanturl': t.tenanturl, 'tyler-tenant-culture': 'en-US' });

// Every inspection already requested on a permit (CaseId), newest county data, no browser.
export async function fetchInspections(portal, caseId) {
  const t = TENANTS[portal];
  const res = await fetch(`${t.base}/api/energov/entity/inspections/search/search`, {
    method: 'POST', headers: headers(t),
    body: JSON.stringify({ PageNumber: 1, PageSize: 200, SortField: '', IsSortedInAscendingOrder: true, ModuleId: 1, EntityId: caseId, IsExistingInspection: true, IsOptionalInspection: false, IsFailed: false }),
  });
  const body = await res.json();
  if (!body.Success) throw new Error(`inspections ${caseId}: ${body.ErrorMessage || res.status}`);
  return body.Result || [];
}

export async function fetchChecklist(portal, inspectionId) {
  const t = TENANTS[portal];
  if (!t) throw new Error(`unknown EnerGov portal ${portal}`);
  const res = await fetch(`${t.base}/api/energov/entity/checklist/search`, {
    method: 'POST',
    headers: headers(t),
    body: JSON.stringify({ PageNumber: 1, PageSize: 100, SortField: 'NAME', IsSortedInAscendingOrder: true, ModuleId: 7, EntityId: inspectionId }),
  });
  const body = await res.json();
  if (!body.Success) throw new Error(`checklist ${inspectionId}: ${body.ErrorMessage || res.status}`);
  return (body.Result || [])
    .sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0))
    .map((r) => ({ item: r.CheckListItem, passed: r.IsNA ? null : !!r.Passed, comments: (r.Comments || '').trim() || null }));
}

// One text block for the inspection: comments of the items that did not pass
// (or of every item when none is marked failed), newest county formatting kept.
export function commentsText(checklist) {
  const failed = checklist.filter((c) => c.passed === false && c.comments);
  const use = failed.length ? failed : checklist.filter((c) => c.comments);
  return use.map((c) => (c.item && c.item !== 'General Comments' ? `${c.item}: ${c.comments}` : c.comments)).join('\n\n') || null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [portal, ...ids] = process.argv.slice(2);
  for (const id of ids) console.log(id, JSON.stringify(await fetchChecklist(portal, id), null, 1));
}
