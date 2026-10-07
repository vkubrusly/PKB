#!/usr/bin/env node
// =============================================================================
// discover_permits.mjs — find the building permit of houses that have none in the system yet.
// The permit number used to come only from the spreadsheet or Buildertrend's "Permit #"; when
// nobody fills it in, a house stays "pre-permit" after the county issues it (0067, Victor
// 2026-10-07). Each round, every house with no building permit number is looked up on its
// county portal:
//   Marion, Winter Park (EnerGov)          by parcel, then by street address
//   Citrus, Charlotte, North Port (Accela)  by street number + street name
// A new-house permit is accepted only when the applicant / contractor on it is ours — Prime
// Kubrusly Basso Home LLC or Cristiano Pedrosa (our GC, CGC1540657). It is added to
// ops.permit_cases ('in_review', so the same round runs the full collection and the portal data
// sets the real status and dates). Buildertrend's "Permit #" is then filled by
// collectors/buildertrend/job_permit.mjs (jobs whose Permit # is still empty there).
//   node scripts/discover_permits.mjs [--dry-run] [job_number ...]
// Read-only on the portals.
// =============================================================================
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { sql } from './sb.mjs';
import { PORTALS as ENERGOV } from '../collectors/energov/portals.mjs';
import { PORTALS as ACCELA } from '../collectors/accela/portals.mjs';

const DRY = process.argv.includes('--dry-run');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const q = (v) => v == null || v === '' ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
// Our company or our GC on the permit (applicant, contractor or licensed professional).
const OURS = /prime\s+kubrusly|kubrusly\s*(&|and)?\s*basso|cristiano\s+(machado\s+)?pedrosa|CGC\s*1540657/i;
// Only the house's own building permit, not 911 address records, site reviews, trade permits…
const NEW_HOUSE = /new construction|single family|^residential$|residential.*new|new.*residential|sfr/i;
const DEAD = /void|withdrawn|cancel|expired|denied|closed/i;

// County (and city) of the job → portal.
function portalOf(j) {
  if (j.county === 'Marion') return ['energov', 'marion'];
  if (j.county === 'Orange' && /winter park/i.test(j.address || '')) return ['energov', 'winterpark'];
  if (j.county === 'Citrus') return ['accela', 'citrus'];
  if (j.county === 'Charlotte') return ['accela', 'charlotte'];
  if (/north port/i.test(j.address || '')) return ['accela', 'northport'];
  return null;
}
// "3042 W Hamlet Pl, Citrus Springs, FL" → { no: '3042', name: 'Hamlet' }
function streetParts(address) {
  const street = String(address || '').split(',')[0].trim();
  const m = street.match(/^(\d+)\s+(.*)$/);
  if (!m) return null;
  const words = m[2].split(/\s+/).filter((w) => !/^(N|S|E|W|NE|NW|SE|SW)$/i.test(w));
  const SUFFIX = /^(st|street|ave|avenue|rd|road|dr|drive|pl|place|ct|court|ln|lane|loop|cir|circle|blvd|way|ter|terrace|trl|trail|pkwy|path|pass|pt|run|sq|hwy)\.?$/i;
  while (words.length > 1 && SUFFIX.test(words[words.length - 1])) words.pop();
  return { no: m[1], name: words.join(' ').replace(/(\d+)(st|nd|rd|th)$/i, '$1$2') };
}

const jobs = (await sql(`select j.id, j.org_id, j.job_number, j.parcel, j.county, j.address, j.model from ops.jobs j
  where j.co_at is null and j.status not in ('completed', 'cancelled')
    and not exists (select 1 from ops.permit_cases c where c.job_id = j.id and c.kind = 'building' and c.number is not null)
  order by j.job_number`)).filter((j) => !only.length || only.includes(j.job_number));
console.log(`houses without a building permit: ${jobs.length}`);
if (!jobs.length) process.exit(0);

const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'],
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();

// ---- EnerGov: the portal's own search API, captured from its UI ----
async function energovSearch(base, term) {
  let res = null;
  const on = async (r) => { if (r.url().includes('/api/energov/search/search')) { try { res = await r.json(); } catch {} } };
  page.on('response', on);
  try {
    await page.goto('about:blank');   // a fresh load per search: the search page does not re-run on a changed hash
    await page.goto(`${base}/#/search?m=1&fm=1&ps=10&pn=1&em=true&st=${encodeURIComponent(term)}`, { waitUntil: 'networkidle', timeout: 120000 });
    for (let i = 0; i < 20 && !res; i++) await page.waitForTimeout(1000);
  } finally { page.off('response', on); }
  return res?.Result?.EntityResults || [];
}
async function energovContacts(base, caseId) {
  let res = null;
  const on = async (r) => { if (r.url().includes('/api/energov/entity/contacts/search')) { try { res = await r.json(); } catch {} } };
  page.on('response', on);
  try {
    await page.goto(`${base}/#/permit/${caseId}`, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(2000);
    await page.getByText('Contacts', { exact: true }).first().click({ timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 15 && !res; i++) await page.waitForTimeout(1000);
  } finally { page.off('response', on); }
  return (res?.Result || []).map((c) => `${c.ContactTypeName}: ${c.FirstName || ''} ${c.LastName || ''} ${c.GlobalEntityName || c.CompanyName || ''}`.trim());
}
async function energov(county, j) {
  const portal = ENERGOV[county];
  const sp = streetParts(j.address);
  const sameHouse = (e) => (j.parcel && String(e.MainParcel || '').replace(/\W/g, '') === String(j.parcel).replace(/\W/g, ''))
    || (sp && new RegExp(`^${sp.no}\\b`).test(e.AddressDisplay || '') && (e.AddressDisplay || '').toUpperCase().includes(sp.name.toUpperCase()));
  let hits = [];
  for (const term of [j.parcel, sp && `${sp.no} ${sp.name}`].filter(Boolean)) {
    hits = (await energovSearch(portal.base, term)).filter((e) => portal.permitPattern.test(e.CaseNumber || '') && NEW_HOUSE.test(e.CaseType || '') && !DEAD.test(e.CaseStatus || '') && sameHouse(e));
    if (hits.length) break;
  }
  hits.sort((a, b) => String(b.ApplyDate || '').localeCompare(String(a.ApplyDate || '')));
  const out = [];
  for (const h of hits.slice(0, 2)) out.push({ number: h.CaseNumber, status: h.CaseStatus, applied: h.ApplyDate?.slice(0, 10) || null, issued: h.IssueDate?.slice(0, 10) || null, people: await energovContacts(portal.base, h.CaseId) });
  return out;
}

// ---- Accela: General Search by street number + name, then the record page ----
async function accela(county, j) {
  const portal = ACCELA[county];
  const sp = streetParts(j.address);
  if (!sp) return [];
  const rows = [];
  for (const module of portal.modules || [portal.module]) {
    await page.goto(`${portal.base}/Cap/CapHome.aspx?module=${module}&TabName=${module}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.locator('input[id$="txtGSNumber_ChildControl0"]').first().fill(sp.no);
    await page.locator('input[id$="txtGSStreetName"]').first().fill(sp.name);
    await Promise.all([page.waitForLoadState('load').catch(() => {}), page.locator('#ctl00_PlaceHolderMain_btnNewSearch').click()]);
    await page.waitForTimeout(5000);
    if (/CapDetail/i.test(page.url())) {   // a single hit opens the record directly
      const t = await page.locator('body').innerText();
      const num = (t.match(/Record\s+([A-Z]{2,5}[\d-]+[\w-]*)/) || [])[1];
      if (num) rows.push({ date: '', number: num, type: (t.match(/Record Type:?\s*\n?\s*([^\n]+)/i) || [])[1] || 'Residential', address: `${sp.no} ${sp.name}`, status: '' });
    } else {
      rows.push(...await page.$$eval('table[id$="gdvPermitList"] tr, tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()))
        .filter((c) => c.length >= 5 && /^\d{2}\/\d{2}\/\d{4}$/.test(c[0] || c[1] || ''))
        // Columns: Date · Record Number · Record Type · Address · Action · Status · Expiration
        .map((c) => { const o = /^\d{2}\//.test(c[0]) ? 0 : 1; return { date: c[o], number: c[o + 1], type: c[o + 2], address: c[o + 3], status: c[o + 5] || '' }; })));
    }
    if (rows.length) break;
  }
  const iso = (d) => { const m = String(d).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[1]}-${m[2]}` : ''; };
  const hits = rows.filter((r) => NEW_HOUSE.test(r.type || '') && !DEAD.test(r.status || '') && !/\.RR|REV/i.test(r.number || '') && new RegExp(`^${sp.no}\\b`).test((r.address || '').trim()))
    .sort((a, b) => iso(b.date).localeCompare(iso(a.date)));
  const out = [];
  for (const h of hits.slice(0, 2)) {
    // Record page: "Applicant" and "Licensed Professional" blocks.
    await page.goto(`${portal.base}/Cap/CapHome.aspx?module=${portal.module}&TabName=${portal.module}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.locator('input[id$="txtGSPermitNumber"]').first().fill(h.number);
    await Promise.all([page.waitForLoadState('load').catch(() => {}), page.locator('#ctl00_PlaceHolderMain_btnNewSearch').click()]);
    await page.waitForTimeout(4000);
    if (!/CapDetail/i.test(page.url())) {
      const link = page.getByRole('link', { name: h.number, exact: true }).first();
      if (await link.count()) { await Promise.all([page.waitForLoadState('load').catch(() => {}), link.click()]); await page.waitForTimeout(4000); }
    }
    const t = /CapDetail/i.test(page.url()) ? await page.locator('body').innerText() : '';
    const block = (k) => { const i = t.indexOf(k); return i < 0 ? '' : t.slice(i, i + 300).replace(/\s+/g, ' '); };
    out.push({ number: h.number, status: h.status, applied: iso(h.date) || null, issued: null, people: [block('Applicant:'), block('Licensed Professional:')].filter(Boolean) });
  }
  return out;
}

let added = 0, foreign = 0;
for (const j of jobs) {
  const pt = portalOf(j);
  if (!pt) { console.log(`${j.job_number}: no portal search for ${j.county} (${j.address})`); continue; }
  const [kind, county] = pt;
  let found = [];
  try { found = kind === 'energov' ? await energov(county, j) : await accela(county, j); }
  catch (e) { console.log(`${j.job_number}: ${county} search failed (${e.message.slice(0, 100)})`); continue; }
  if (!found.length) { console.log(`${j.job_number}: no permit yet on ${county}`); continue; }
  const mine = found.find((f) => f.people.some((p) => OURS.test(p)));
  if (!mine) {
    foreign++;
    console.log(`${j.job_number}: ${found.map((f) => f.number).join(', ')} on ${county} — applicant is not Prime / Cristiano (${found[0].people.join(' · ').slice(0, 160) || 'no contacts shown'}); not added`);
    continue;
  }
  added++;
  console.log(`${j.job_number}: ${mine.number}${mine.status ? ' — ' + mine.status : ''}${mine.issued ? ', issued ' + mine.issued : ''} (${mine.people.find((p) => OURS.test(p)).slice(0, 90)})`);
  if (DRY) continue;
  await sql(`insert into ops.permit_cases (org_id, job_id, kind, portal, number, applied_at, tracked_by, ops_status)
    values (${q(j.org_id)}, ${q(j.id)}, 'building', ${q(kind + ':' + county)}, ${q(mine.number)}, ${q(mine.applied)}, ${q(j.model === 'Custom' ? 'pkb' : 'designer')}, 'in_review')
    on conflict (org_id, portal, number) where number is not null do nothing`);
}
await browser.close();
console.log(`permits added: ${added}${foreign ? ` · found but not ours: ${foreign}` : ''}`);
