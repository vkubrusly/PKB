#!/usr/bin/env node
// Fill ops.inspections.comments with the inspector's checklist comments for every
// inspection that did not pass, on EnerGov portals (Marion, Winter Park). Public API, no browser.
//   node scripts/backfill_inspection_comments.mjs [--dry-run]
import { sql } from './sb.mjs';
import { fetchInspections, fetchChecklist, commentsText } from '../collectors/energov/inspection_comments.mjs';

const DRY = process.argv.includes('--dry-run');
const q = (s) => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const cases = await sql(`select c.id, c.portal, c.portal_case_id, c.number from ops.permit_cases c
  where c.portal in ('energov:marion','energov:winterpark') and c.portal_case_id is not null`);
let n = 0, found = 0;
for (const c of cases) {
  const portal = c.portal.split(':')[1];
  let list;
  try { list = await fetchInspections(portal, c.portal_case_id); } catch (e) { console.error(c.number, e.message); continue; }
  const updates = [];
  for (const i of list.filter((i) => /disapprov|fail|partial|correction/i.test(i.InspectionStatus || ''))) {
    n++;
    let text = null;
    try { text = commentsText(await fetchChecklist(portal, i.InspectionId)); } catch { /* e.g. OCE site reviews live in another module */ }
    if (!text) continue;
    found++;
    updates.push(`update ops.inspections set comments = ${q(text)} where permit_case_id = ${q(c.id)} and number = ${q(i.InspectionNumber)};`);
  }
  if (updates.length && !DRY) await sql(updates.join('\n'));
  console.log(`${c.number}: ${updates.length} failed inspection(s) with comments`);
}
console.log(`done: ${found}/${n} failed inspections have inspector comments${DRY ? ' (dry run)' : ''}`);
