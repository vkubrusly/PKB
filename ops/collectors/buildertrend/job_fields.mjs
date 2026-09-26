#!/usr/bin/env node
// =============================================================================
// job_fields.mjs — read every job's custom fields (Parcial ID, County, Model,
// Supervisor) and Permit/Lot from Buildertrend's Jobs List grid.
//   BT_COOKIES_FILE=... node collectors/buildertrend/job_fields.mjs
// Writes data/buildertrend/job_fields.json. Needs a role that can open the
// Jobs List (Buildertrend answers "You do not have access to this feature"
// otherwise).
// =============================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBuildertrend } from './session.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'buildertrend');
mkdirSync(OUT, { recursive: true });
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired — re-export the bot cookies'); process.exit(1); }

// Let the page issue its own grid request once, then replay it asking for the columns we need.
let captured = null, views = null, filters = null;
page.on('request', r => { if (/\/api\/Jobsites\/Grid/i.test(r.url()) && !captured) captured = { url: r.url(), headers: r.headers(), body: r.postData() }; });
page.on('response', async r => { if (/\/api\/GridViews\//i.test(r.url())) views = await r.json().catch(() => null); if (/\/api\/Filters\//i.test(r.url())) filters = await r.json().catch(() => null); });
await page.goto('https://buildertrend.net/app/Jobs/List', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 40 && !(captured && views); i++) await page.waitForTimeout(1000);
if (!captured || !views) { console.error('grid request not seen'); await browser.close(); process.exit(1); }

// Column ids by name from the grid view definition.
const cols = {};
const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.id != null && o.name && o.jsonKey) cols[o.name] = { id: String(o.id), key: String(o.jsonKey) }; Object.values(o).forEach(walk); } };
walk(views);
const want = ['Job Name', 'Street Address', 'Parcial ID', 'County', 'Model', 'Supervisor', 'Project Manager', 'Permit', 'Lot', 'Job Status'];
const body = JSON.parse(captured.body);
body.gridRequest.selectedColumns = [...new Set([...body.gridRequest.selectedColumns, ...want.filter(n => cols[n]).map(n => cols[n].id)])];
body.pagingData = { ...body.pagingData, pageSize: 500, lastRow: 500, totalRowsAllPages: 500 };
const res = await page.request.post(captured.url, { headers: { ...captured.headers, 'content-type': 'application/json' }, data: JSON.stringify(body) });
const json = await res.json().catch(() => null);
writeFileSync(join(OUT, 'job_fields_raw.json'), JSON.stringify({ cols, json }, null, 2));
if (!res.ok() || json?.message) { console.error('grid error:', res.status(), json?.message); await browser.close(); process.exit(1); }

// Rows: find the array of row objects in the response.
const findRows = (o) => { if (Array.isArray(o) && o.length && typeof o[0] === 'object') return o; if (o && typeof o === 'object') for (const v of Object.values(o)) { const r = findRows(v); if (r) return r; } return null; };
const rows = findRows(json) || [];
// Dropdown custom fields hold option ids; the filter definition carries the id → name lists.
const optionNames = {};
const collect = (o) => { if (Array.isArray(o)) o.forEach(collect); else if (o && typeof o === 'object') { if (o.options && typeof o.options === 'object' && !Array.isArray(o.options)) for (const [k, list] of Object.entries(o.options)) if (Array.isArray(list)) for (const it of list) if (it && it.id != null) (optionNames[k] ||= {})[it.id] = it.name; Object.values(o).forEach(collect); } };
collect(filters);
const allNames = Object.assign({}, ...Object.values(optionNames));
const cf = (row, label) => {
  const f = (row.customFields || []).find(x => x.label === label);
  if (!f || f.value == null || f.value === '') return null;
  const vals = Array.isArray(f.value) ? f.value : [f.value];
  const names = vals.map(v => (optionNames[String(f.customFieldId)] || {})[v] ?? (f.type === 4 ? (optionNames.users || {})[v] : undefined) ?? allNames[v] ?? v);
  const real = names.filter(n => n != null && !/^\s*--.*--\s*$|^unassigned$/i.test(String(n)));
  if (!real.length) return null;
  return real.length === 1 ? real[0] : real;
};
const parseList = (v) => { try { const a = JSON.parse(v); return Array.isArray(a) ? a : v; } catch { return v; } };
const jobs = rows.map(r => {
  let name = r.jobNameLink; if (typeof name === 'string') { try { name = JSON.parse(name); } catch {} } if (name && typeof name === 'object') name = name.title;
  return { jobId: r.jobId, name, street: r.street, city: r.city, zip: r.zip, parcel: cf(r, 'Parcial ID'), county: cf(r, 'County'), model: cf(r, 'Model'), supervisor: cf(r, 'Supervisor'), projectManagers: parseList(r.projectManager), permit: r.permit || null, lot: r.lot || null, owner: r.ownerDisplayName || null, status: r.status };
});
writeFileSync(join(OUT, 'job_fields.json'), JSON.stringify({ collectedAt: new Date().toISOString(), count: jobs.length, jobs }, null, 2));
console.log(`jobs: ${jobs.length} | with parcel: ${jobs.filter(j => j.parcel).length} | with supervisor: ${jobs.filter(j => j.supervisor).length} | with permit: ${jobs.filter(j => j.permit).length}`);
console.log(jobs.slice(0, 5).map(j => JSON.stringify(j)).join('\n'));
await browser.close();
