#!/usr/bin/env node
// =============================================================================
// collect.mjs — read public permit data from a Tyler EnerGov "Citizen Self
// Service" (CSS) portal, the software Marion County (and several other Florida
// counties) use.
//
// Usage:
//   node collectors/energov/collect.mjs --county marion BLDR-26-05-13402 [more...]
//   node collectors/energov/collect.mjs --county marion --from-csv data/permits/permits_control_2026-09-25.csv
//
// No login is needed: the portal's public search + permit page expose status,
// submittal rounds, per-department review items (with the reviewer's full
// comments), inspections, holds, contacts and fees. Attachments/e-reviews are
// contact-only and are not collected.
//
// How it works: we drive the real portal in a headless browser and capture the
// JSON the portal's own UI requests. That keeps us on the same code path as a
// human visitor (no reverse-engineering of request payloads) and survives
// cosmetic UI changes.
//
// Output: one JSON per permit in data/portal/<county>/<PERMIT>.json, raw API
// payloads under `raw` plus a normalized `permit` block the rest of PKB Ops
// consumes (see normalize()).
// =============================================================================

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPS_ROOT = join(HERE, '..', '..');

// One entry per county portal. `base` is the CSS app root (the part before "#/").
export const PORTALS = {
  marion: {
    base: 'https://selfservice.marionfl.org/energov_prod/selfservice',
    permitPattern: /^(BLDR|BLDC|BLD|CONTRACTOR)-?\d{2}-\d{2}-\d+$|^\d{10}$/i,
  },
  // City of Winter Park (inside Orange County; the spreadsheet files these under "Orange").
  winterpark: {
    base: 'https://selfservice.cityofwinterpark.org/energov_prod/selfservice',
    permitPattern: /^[A-Z]{2,4}-\d{4}-\d+$/i,
  },
};

// ---- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; }
const county = (flag('--county') || 'marion').toLowerCase();
const portal = PORTALS[county];
if (!portal) { console.error(`unknown county "${county}" (known: ${Object.keys(PORTALS).join(', ')})`); process.exit(2); }
const fromCsv = flag('--from-csv');
const limit = Number(flag('--limit') || 0);
// --stage permit|inspections (see ops.monitoring_queue). Default: full collection.
const STAGE = flag('--stage') || 'permit';
const positional = args.filter((a, i) => !a.startsWith('--') && !['--county', '--from-csv', '--limit', '--stage'].includes(args[i - 1]));

let permits = positional;
if (fromCsv) permits = permits.concat(permitsFromCsv(fromCsv, county));
permits = [...new Set(permits.map(p => p.trim()).filter(Boolean))];
if (limit) permits = permits.slice(0, limit);
if (!permits.length) { console.error('no permit numbers given'); process.exit(2); }

const OUT_DIR = join(OPS_ROOT, 'data', 'portal', county);
mkdirSync(OUT_DIR, { recursive: true });

// ---- CSV helper: pull "Permit N" for rows of this county --------------------
function permitsFromCsv(path, countyName) {
  const text = readFileSync(path, 'utf8');
  const rows = parseCsv(text);
  const header = rows[0].map(h => h.trim());
  const iCounty = header.indexOf('County');
  const iPermit = header.indexOf('Permit N');
  return rows.slice(1)
    .filter(r => (r[iCounty] || '').trim().toLowerCase() === countyName)
    .map(r => (r[iPermit] || '').trim())
    .filter(p => p && p !== '-' );
}
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---- Browser ----------------------------------------------------------------
// Chromium path: Playwright's own install, or the pre-installed one in the
// Claude cloud container. Proxy/cert flags are only needed behind the
// container's TLS-inspecting egress proxy; harmless elsewhere.
const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'],
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

// Capture every EnerGov API response the UI triggers, keyed by route.
let captured = [];
page.on('response', async (r) => {
  const u = r.url();
  if (!u.includes('/api/energov/')) return;
  let body = null;
  try { body = await r.json(); } catch { return; }
  captured.push({ route: u.replace(portal.base, '').split('?')[0], url: u, status: r.status(), post: r.request().postData(), body });
});
const settle = async (ms = 2500) => { await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(ms); };
const clickTab = async (name) => {
  const t = page.getByText(name, { exact: true }).first();
  if (await t.count()) { await t.click({ timeout: 10000 }).catch(() => {}); await settle(); }
};

async function collectOne(permitNumber) {
  captured = [];
  // 1) public search by keyword → CaseId
  const url = `${portal.base}/#/search?m=1&fm=1&ps=10&pn=1&em=true&st=${encodeURIComponent(permitNumber)}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  for (let i = 0; i < 20 && !captured.some(c => c.route === '/api/energov/search/search'); i++) await page.waitForTimeout(1000);
  await settle(1500);
  const search = captured.find(c => c.route === '/api/energov/search/search');
  if (process.env.DEBUG) console.error('captured after search:', captured.map(c => c.route));
  const hit = search?.body?.Result?.EntityResults?.find(e => (e.CaseNumber || '').toUpperCase() === permitNumber.toUpperCase())
    || search?.body?.Result?.EntityResults?.[0];
  if (!hit) return { permitNumber, found: false, error: search?.body?.ErrorMessage || 'no search result' };

  // 2) permit page + the tabs whose data we want
  captured = [];
  await page.goto(`${portal.base}/#/permit/${hit.CaseId}`, { waitUntil: 'networkidle', timeout: 120000 });
  await settle(4000);
  // Stage 'inspections' (permit already issued): only what changes until the CO.
  const tabs = STAGE === 'inspections' ? ['Inspections', 'Holds', 'Sub-Records'] : ['Reviews', 'Inspections', 'Holds', 'Contacts', 'Fees', 'Sub-Records'];
  for (const tab of tabs) {
    await clickTab(tab);
    // Grids page at 10 rows; switch every "Results per page" selector on the tab to 100.
    const sizers = page.locator('select:visible').filter({ has: page.locator('option', { hasText: /^100$/ }) });
    for (let i = 0; i < Math.min(await sizers.count(), 4); i++) {
      await sizers.nth(i).selectOption({ label: '100' }, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }
  }

  const raw = {};
  for (const c of captured) {
    const key = c.route.replace(/\/[0-9a-f-]{36}/g, '/:id').replace(/\/\d+$/, '/:n');
    if (!c.body || c.body.Success === false) continue;
    (raw[key] ||= []).push(c.body);
  }
  return { permitNumber, found: true, caseId: hit.CaseId, searchHit: hit, raw, permit: normalize(hit, raw) };
}

// ---- Normalization: the shape PKB Ops stores ---------------------------------
function normalize(hit, raw) {
  const last = (k) => { const a = raw[k]; return a ? a[a.length - 1] : null; };
  const detail = last('/api/energov/permits/permitdetail')?.Result || {};
  const submittals = (last('/api/energov/entity/submittals/search')?.Result || []).map(s => ({
    submittalId: s.SubmittalId, version: s.VersionNumber, type: s.SubmittalTypeName, status: s.SubmittalStatusName,
    submittedAt: day(s.SubmittalDateSubmitted), dueAt: day(s.SubmittalDueDate), completedAt: day(s.SubmittalCompleteDate),
  })).sort((a, b) => (a.submittedAt || '').localeCompare(b.submittedAt || '') || a.version - b.version)
    // EnerGov restarts VersionNumber per workflow step, so we number rounds ourselves.
    .map((s, i) => ({ ...s, round: i + 1 }));
  const versionOf = Object.fromEntries(submittals.map(s => [s.submittalId, s.round]));
  const reviewItems = [];
  for (const b of raw['/api/energov/entity/submittals/itemreviews/search/items'] || []) {
    for (const i of b.Result || []) {
      if (reviewItems.some(r => r.itemReviewId === i.ItemReviewId)) continue;
      reviewItems.push({
        itemReviewId: i.ItemReviewId, submittalId: i.SubmittalId, round: versionOf[i.SubmittalId] ?? null,
        department: i.TypeName, status: i.StatusName, assignedTo: (i.AssignedTo || '').trim() || null, assignedToEmail: i.AssignedToEmail || null,
        dueAt: day(i.DueDate), completedAt: day(i.CompletedDate), comments: (i.Comments || '').trim() || null,
        corrections: i.Corrections || [], recommendations: i.Recommendations || [],
      });
    }
  }
  reviewItems.sort((a, b) => (a.round - b.round) || a.department.localeCompare(b.department));
  const workflow = (last('/api/energov/workflow/summary/activities/:n/:id')?.Result || []).map(a => ({
    name: a.FriendlyName || a.Name, type: a.ActivityTypeName, status: a.Status, completedAt: a.CompletedOn ? a.CompletedOn.slice(0, 10) : null, scheduledStart: day(a.ScheduledStartDate),
  }));
  const inspections = [];
  for (const b of raw['/api/energov/entity/inspections/search/search'] || []) {
    for (const i of b.Result || []) {
      const num = i.InspectionNumber || i.CaseNumber; if (!num || inspections.some(x => x.number === num)) continue;
      inspections.push({ number: num, type: i.InspectionType, description: i.InspectionTypeDescription || null, status: i.InspectionStatus || i.StatusName,
        requestedAt: day(i.RequestedDate), scheduledAt: day(i.ScheduledStartDate), actualAt: day(i.ActualDate), inspector: i.PrimaryInspector || null,
        reinspection: !!i.Reinspection, passed: !!i.IsSuccessFlag, failed: !!i.IsFailureFlag, cancelled: !!i.IsCancelledFlag });
    }
  }
  const holds = (last('/api/energov/entity/holds/search')?.Result || []).map(h => ({ name: h.Name, type: h.HoldType, reason: h.HoldReason, comments: h.Comments, createdAt: h.CreateDate?.slice(0, 10), active: !!h.Active, status: h.HoldStatus }));
  const contacts = [];
  for (const b of raw['/api/energov/entity/contacts/search/search'] || []) for (const c of b.Result || []) {
    const row = { type: c.ContactTypeName, company: c.GlobalEntityName || null, name: [c.FirstName, c.LastName].filter(Boolean).join(' ') || null, billing: !!c.IsBilling };
    if (!contacts.some(x => JSON.stringify(x) === JSON.stringify(row))) contacts.push(row);
  }
  const feeSummary = last('/api/energov/entity/fees/search/summary')?.Result || null;
  const subRecords = [];
  for (const b of raw['/api/energov/entity/permits/search/search'] || []) for (const s of b.Result || []) {
    const row = { number: s.RecordNumber, type: s.RecordType, status: s.RecordStatus };
    if (row.number && !subRecords.some(x => x.number === row.number)) subRecords.push(row);
  }
  return {
    number: hit.CaseNumber, caseId: hit.CaseId, county: county,
    type: hit.CaseType, workclass: hit.CaseWorkclass, status: hit.CaseStatus, projectName: hit.ProjectName,
    address: hit.AddressDisplay, parcel: hit.MainParcel,
    appliedAt: day(hit.ApplyDate), issuedAt: day(hit.IssueDate), expiresAt: day(hit.ExpireDate), finalizedAt: day(hit.FinalDate),
    squareFeet: detail.SquareFeet ?? null, valuation: detail.Valuation ?? null, description: detail.Description ?? hit.Description ?? null,
    submittals, reviewItems, workflow, inspections, holds, contacts, feeSummary, subRecords,
    collectedAt: new Date().toISOString(),
  };
}
function day(v) { return v ? String(v).slice(0, 10) : null; }

// ---- Run ----------------------------------------------------------------------
const summary = [];
for (const p of permits) {
  const t0 = Date.now();
  let res;
  try { res = await collectOne(p); } catch (e) { res = { permitNumber: p, found: false, error: e.message }; }
  const file = join(OUT_DIR, `${p.replace(/[^A-Za-z0-9-]/g, '_')}.json`);
  writeFileSync(file, JSON.stringify(res, null, 2));
  const s = res.found ? `${res.permit.status} · ${res.permit.submittals.length} submittals · ${res.permit.reviewItems.length} review items · ${res.permit.inspections.length} inspections · ${res.permit.holds.length} holds` : `NOT FOUND (${res.error})`;
  console.log(`${p}: ${s} [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
  summary.push({ permit: p, found: res.found, status: res.permit?.status || null, file });
}
writeFileSync(join(OUT_DIR, '_index.json'), JSON.stringify({ county, collectedAt: new Date().toISOString(), permits: summary }, null, 2));
await browser.close();
