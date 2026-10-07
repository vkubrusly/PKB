#!/usr/bin/env node
// =============================================================================
// discover.mjs — find the building permit of houses that have none in the system yet.
// The permit number used to come only from the spreadsheet or Buildertrend's "Permit #";
// when nobody fills it in, a house stays "pre-permit" after the county issues the permit
// (0067, Victor 2026-10-07). Each round, every EnerGov house (Marion, Winter Park) with a
// parcel and no building permit is searched on the county portal by parcel; a new-
// construction permit found there is added to ops.permit_cases, and the same round collects it.
//   node collectors/energov/discover.mjs [--dry-run]
// Read-only on the portal; writes only new ops.permit_cases rows.
// =============================================================================
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { sql } from '../../scripts/sb.mjs';
import { PORTALS } from './portals.mjs';

const DRY = process.argv.includes('--dry-run');
const q = (v) => v == null || v === '' ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
// County of the job → EnerGov portal (Winter Park houses are filed under Orange).
const PORTAL_OF_COUNTY = { Marion: 'marion', Orange: 'winterpark' };
// Only the house's own building permit, not 911 address records, site reviews, sub-permits…
const NEW_HOUSE = /new construction|single family|residential.*new|new.*residential/i;

const jobs = await sql(`select j.id, j.org_id, j.job_number, j.parcel, j.county, j.model from ops.jobs j
  where j.parcel is not null and j.county in (${Object.keys(PORTAL_OF_COUNTY).map(q).join(',')})
    and j.co_at is null and j.status not in ('completed', 'cancelled')
    and not exists (select 1 from ops.permit_cases c where c.job_id = j.id and c.kind = 'building' and c.number is not null)
  order by j.job_number`);
console.log(`houses without a building permit: ${jobs.length}`);
if (!jobs.length) process.exit(0);

const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'],
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();

let found = 0;
for (const j of jobs) {
  const county = PORTAL_OF_COUNTY[j.county], portal = PORTALS[county];
  let res = null;
  page.removeAllListeners('response');
  page.on('response', async (r) => { if (r.url().includes('/api/energov/search/search')) { try { res = await r.json(); } catch {} } });
  try {
    // A fresh load per search: the portal's search page does not re-run on a changed hash.
    await page.goto('about:blank');
    await page.goto(`${portal.base}/#/search?m=1&fm=1&ps=10&pn=1&em=true&st=${encodeURIComponent(j.parcel)}`, { waitUntil: 'networkidle', timeout: 120000 });
    for (let i = 0; i < 20 && !res; i++) await page.waitForTimeout(1000);
  } catch (e) { console.log(`${j.job_number}: search failed (${e.message.slice(0, 80)})`); continue; }
  const hits = (res?.Result?.EntityResults || []).filter((e) => portal.permitPattern.test(e.CaseNumber || '') && NEW_HOUSE.test(e.CaseType || '')
    && String(e.MainParcel || '').replace(/\D/g, '') === String(j.parcel).replace(/\D/g, '') && !/void|withdrawn|cancel/i.test(e.CaseStatus || ''));
  if (!hits.length) { console.log(`${j.job_number}: no permit yet (parcel ${j.parcel})`); continue; }
  // The newest one if the county shows more than one (e.g. a voided earlier application).
  const hit = hits.sort((a, b) => String(b.ApplyDate || '').localeCompare(String(a.ApplyDate || '')))[0];
  found++;
  console.log(`${j.job_number}: found ${hit.CaseNumber} — ${hit.CaseStatus}${hit.IssueDate ? ', issued ' + hit.IssueDate.slice(0, 10) : ''}`);
  if (DRY) continue;
  // 'in_review' so this round runs the full collection (reviews, fees…); the portal data then sets
  // the real status and the issue date, and the usual rules (permit issued, R9…) follow.
  await sql(`insert into ops.permit_cases (org_id, job_id, kind, portal, number, applied_at, tracked_by, ops_status)
    values (${q(j.org_id)}, ${q(j.id)}, 'building', ${q('energov:' + county)}, ${q(hit.CaseNumber)}, ${q(hit.ApplyDate ? hit.ApplyDate.slice(0, 10) : null)}, ${q(j.model === 'Custom' ? 'pkb' : 'designer')}, 'in_review')
    on conflict (org_id, portal, number) where number is not null do nothing`);
}
await browser.close();
console.log(`permits found: ${found}`);
