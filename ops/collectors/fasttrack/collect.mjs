#!/usr/bin/env node
// =============================================================================
// collect.mjs — Orange County Fast Track (fasttrack.ocfl.net). The public search is behind a
// CAPTCHA (not bypassed), so this reads the contractor's own "My Permits" area with PKB's two
// Fast Track logins (config/fasttrack_accounts.json): each permit is read from whichever login
// lists it. Output matches the EnerGov/Accela collectors (data/portal/orange/<PERMIT>.json with
// a normalized `permit` block) so build_seed.mjs loads it the same way.
//
//   ORANGE_PORTAL_USER/_PASS [ORANGE_PORTAL_USER_2/_PASS_2] node collectors/fasttrack/collect.mjs --county orange B26013237 [more...]
//
// The permit detail page carries everything but the reviewers' comments:
//   permitDetails2            apply / issue / expire dates and status
//   PROCESSES AND REPORTS     review per department (status, schedule, due, review end), the
//                             inspection history ("Scheduled Inspections") and CO/completion holds
//   documents                 every "Electronic Plan Review Deficiency Comments" report is a review
//                             round that came back with corrections (its date = the round's end)
//   FEE INFORMATION           fee amounts and balances
// The comments themselves are a PDF report (f_ViewPDFReport); not read yet. The page only lists
// the current row per department, so earlier rounds keep the rows stored on earlier runs.
// =============================================================================
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const B = 'https://fasttrack.ocfl.net/OnlineServices';
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const county = (flag('--county') || 'orange').toLowerCase();
const STAGE = flag('--stage') || 'permit'; // accepted for collect_all.mjs; one page holds everything
const permits = args.filter((a, i) => !a.startsWith('--') && !['--county', '--stage', '--limit'].includes(args[i - 1]));
const accounts = [['1', process.env.ORANGE_PORTAL_USER, process.env.ORANGE_PORTAL_PASS], ['2', process.env.ORANGE_PORTAL_USER_2, process.env.ORANGE_PORTAL_PASS_2]].filter(([, u, p]) => u && p);
const OUT_DIR = join(OPS_ROOT, 'data', 'portal', county);

const iso = (s) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(String(s || '')); if (!m) return null; const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; };
const money = (s) => { const n = Number(String(s || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && /\d/.test(String(s || '')) ? n : null; };
export const REVIEW_FAILED = /deficienc|revisions? required|disapprov|denied|fail|incomplete|re-?submit|rejected/i;

const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);

async function login(page, user, pass) {
  await page.goto(`${B}/login.aspx`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2000);
  await page.locator('#email').fill(user);
  await page.locator('#password').fill(pass);
  await Promise.all([page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}), page.locator('#btnLogin').click()]);
  await page.waitForTimeout(4000);
  if (/login\.aspx/i.test(page.url())) throw new Error('login refused (still on the login page)');
}

async function myPermits(page) {
  await page.goto(`${B}/MyPermits.aspx`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // Permit links are ASP.NET postbacks: href "javascript:WebForm_DoPostBackWithOptions(...$lnkPermit...)".
  await page.waitForSelector('a[href*="lnkPermit"]', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page.$$eval('a[href*="lnkPermit"]', (els) => els.map((e) => (e.innerText || '').trim()).filter(Boolean));
}

// Raw page facts, read in the browser: tables as rows of cell texts, and the body text.
function readDetail() {
  const cells = (tr) => [...tr.cells].map((c) => c.innerText.replace(/\s+/g, ' ').trim());
  const tableBy = (re) => [...document.querySelectorAll('table')].find((t) => re.test((t.rows[0]?.innerText || '').replace(/\s+/g, ' ')));
  const rows = (t) => (t ? [...t.rows].slice(1).map(cells) : []);
  return {
    head: rows(document.querySelector('#permitDetails2')),
    processes: rows(tableBy(/^\s*PROCESS STATUS SCHEDULE DT/)),
    fees: rows(tableBy(/^\s*FEE DESCRIPTION FEE AMOUNT BALANCE/)),
    people: rows(tableBy(/^\s*TYPE NAME ADDRESS/)),
    // Report links: f_ViewPDFReport('<folder RSN>', '<report>.RPT') → PDFViewer.aspx (a PDF).
    reports: [...document.querySelectorAll('a[onclick*="f_ViewPDFReport"]')].map((a) => { const m = /f_ViewPDFReport\('(\d+)',\s*'([^']+)'\)/.exec(a.getAttribute('onclick') || ''); return m ? { label: a.innerText.trim(), rsn: m[1], report: m[2] } : null; }).filter(Boolean),
    text: document.body.innerText,
  };
}

async function openPermit(page, number) {
  await myPermits(page);
  const link = page.locator('a[href*="lnkPermit"]', { hasText: number }).first();
  if (!(await link.count())) return null;
  await Promise.all([page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}), link.click()]);
  await page.waitForSelector('#permitDetails2', { timeout: 60000 });
  await page.waitForTimeout(1500);
  const raw = await page.evaluate(readDetail);
  // Plan review comments (only when the portal links them: "(No Deficiencies Found)" is plain text)
  // and the inspection history (inspector's notes), read from the PDF the portal serves.
  raw.reportTexts = {};
  for (const r of raw.reports.filter((x) => /PLANREVIEWCOMMENTS|INSPECTION HISTORY/i.test(x.report))) {
    try { raw.reportTexts[r.report] = await reportText(page, r.rsn, r.report); } catch (e) { raw.reportTexts[r.report] = { error: e.message }; }
  }
  return raw;
}

const PDF_URL = 'https://fasttrack.ocfl.net/OCServices/PDFViewer.aspx';
async function reportText(page, rsn, report) {
  const res = await page.context().request.get(`${PDF_URL}?txtFolderRSN=${rsn}&txtPDFReport=${encodeURIComponent(report)}`, { timeout: 90000 });
  const type = res.headers()['content-type'] || '';
  if (!res.ok() || !/pdf/i.test(type)) return { error: `HTTP ${res.status()} ${type}` };
  return { text: await pdfText(await res.body()) };
}

// Plain text of a PDF, one line per text row (pdf.js, no native dependencies).
export async function pdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const items = (await (await doc.getPage(i)).getTextContent()).items.filter((t) => t.str !== undefined);
    const lines = [];
    for (const t of items) {
      const y = Math.round(t.transform[5]), x = t.transform[4];
      let l = lines.find((z) => Math.abs(z.y - y) <= 2);
      if (!l) lines.push((l = { y, parts: [] }));
      l.parts.push({ x, s: t.str });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) out.push(l.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim());
  }
  await doc.destroy();
  return out.filter(Boolean).join('\n');
}

// The part of the comments report that belongs to one department: from a line naming it (e.g. "Building
// Review (RES)" → "Building") to the next department heading; the whole report when no heading matches.
const DEPT_WORDS = ['Building', 'Zoning', 'Dev Eng', 'Health', 'EPD', 'Concurrency', 'Fire', 'Utilities', 'Impact Fee', 'Environmental', 'Engineering', 'Stormwater', 'Traffic'];
export function commentsFor(text, department) {
  const key = DEPT_WORDS.find((w) => department.toLowerCase().startsWith(w.toLowerCase())) || department.split(/\s|\(/)[0];
  const lines = text.split('\n');
  const isHead = (l, w) => new RegExp(`^${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.{0,40}(review|division|section)?$`, 'i').test(l.trim());
  const start = lines.findIndex((l) => isHead(l, key));
  if (start < 0) return text.slice(0, 8000);
  let end = lines.findIndex((l, i) => i > start && DEPT_WORDS.some((w) => w !== key && isHead(l, w)));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').slice(0, 8000);
}

export function parseDetail(number, raw, account) {
  // permitDetails2: PERMIT# | APPLY DATE | NAME | STATUS | ISSUE DATE | EXPIRE DATE, then TYPE/SUB TYPE/WORK TYPE, ADDRESS/PARCEL, DESCRIPTION.
  const main = raw.head.find((r) => r[0] === number) || [];
  const typeRow = raw.head.find((r, i) => i > 0 && raw.head[i - 1]?.[0] === 'TYPE') || [];
  const addrRow = raw.head.find((r, i) => i > 0 && raw.head[i - 1]?.[0] === 'ADDRESS') || [];
  // PROCESSES: group header rows (one non-empty cell) then PROCESS | STATUS | SCHEDULE DT | DUE DT | REVIEW END DT.
  let group = null; const proc = [];
  for (const r of raw.processes) {
    const filled = r.filter(Boolean);
    if (filled.length === 1 && r.length <= 2) { group = filled[0]; continue; }
    if (filled.length === 1 && !iso(filled[0]) && r.slice(1).every((c) => !c)) { group = filled[0]; continue; }
    if (!r[0]) continue;
    proc.push({ group, name: r[0], status: r[1] || null, scheduledAt: iso(r[2]), dueAt: iso(r[3]), endAt: iso(r[4]) });
  }
  // Rounds that came back with corrections: the deficiency-comment reports in the documents list.
  const lines = raw.text.split('\n').map((s) => s.trim());
  const reports = [...new Set(lines.flatMap((l, i) => (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(l) && /Electronic Plan Review Deficiency Comments/i.test(lines[i + 1] || '') ? [iso(l)] : [])))].sort();
  // Every document row: date line, description, doc type (e.g. "Files failed verification - Report.pdf" = an
  // upload the county's intake rejected; the applicant has to upload again).
  const documents = lines.flatMap((l, i) => (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(l) && /\.pdf$/i.test(lines[i + 1] || '') ? [{ date: iso(l), description: lines[i + 1], docType: lines[i + 2] || null }] : []));
  const lastReport = reports[reports.length - 1] || null;
  const rejectedAfter = documents.filter((d) => /files failed verification/i.test(d.description) && lastReport && d.date > lastReport).map((d) => d.date).sort();
  const reviews = proc.filter((p) => /^review$/i.test(p.group || ''));
  // Round of a review row: the first deficiency report on or after its end date; rows still open
  // (or that ended after the last report) belong to the round after the last report.
  const roundOf = (r) => { const d = r.endAt; const i = d ? reports.findIndex((x) => x >= d) : -1; return i >= 0 ? i + 1 : reports.length + 1; };
  const reviewItems = reviews.map((r) => {
    const round = roundOf(r);
    return { itemReviewId: `${r.name}|${r.scheduledAt || ''}`, submittalId: `round-${round}`, round, department: r.name, status: r.status, assignedTo: null, assignedToEmail: null, scheduledAt: r.scheduledAt, dueAt: r.dueAt, completedAt: r.endAt, comments: null };
  });
  let lastRound = Math.max(reports.length, ...reviewItems.map((r) => r.round), 0);
  // Corrections sent back but rejected at intake ("Files failed verification" after the last deficiency
  // report) and no new review yet: an extra round so the permit shows the upload was refused.
  const pendingRejected = rejectedAfter.length && lastRound === reports.length;
  if (pendingRejected) lastRound += 1;
  const submittals = Array.from({ length: lastRound }, (_, i) => {
    const round = i + 1, items = reviewItems.filter((r) => r.round === round);
    if (pendingRejected && round === lastRound) return { submittalId: `round-${round}`, version: round, type: 'Plan Review', status: 'Files Failed Verification', submittedAt: null, dueAt: null, completedAt: rejectedAfter[rejectedAfter.length - 1] };
    const report = reports[i] || null, open = items.some((r) => !r.completedAt);
    const failed = !!report || items.some((r) => REVIEW_FAILED.test(r.status || ''));
    return {
      submittalId: `round-${round}`, version: round, type: 'Plan Review',
      status: open ? 'In Review' : failed ? 'Revisions Required' : items.length ? 'Approved' : 'In Review',
      submittedAt: items.map((r) => r.scheduledAt).filter(Boolean).sort()[0] || null,
      dueAt: items.map((r) => r.dueAt).filter(Boolean).sort().pop() || null,
      completedAt: open ? null : report || items.map((r) => r.completedAt).filter(Boolean).sort().pop() || null,
    };
  });
  // Reviewer comments: the plan review comments report covers the latest review; its text goes on the
  // failed items of the latest round that came back with corrections (split per department below when found).
  const comments = raw.reportTexts && Object.entries(raw.reportTexts).find(([k]) => /PLANREVIEWCOMMENTS/i.test(k))?.[1];
  if (comments?.text) {
    const failedRound = Math.max(0, ...reviewItems.filter((r) => REVIEW_FAILED.test(r.status || '')).map((r) => r.round));
    for (const r of reviewItems.filter((x) => x.round === failedRound && REVIEW_FAILED.test(x.status || ''))) r.comments = commentsFor(comments.text, r.department);
  }
  // Inspections: "Scheduled Inspections" rows, e.g. "110 Footing | Failed | 07/20/26 | 07/20/26 | 07/20/26".
  const seen = {};
  const inspections = proc.filter((p) => /scheduled inspections/i.test(p.group || '')).map((p) => {
    const at = p.endAt || p.scheduledAt; const k = `${p.name}|${at || ''}`; seen[k] = (seen[k] || 0) + 1;
    return { number: `${k}|${seen[k]}`, type: p.name, status: p.status, passed: /^(passed|approved)/i.test(p.status || ''), failed: /fail|disapprov|partial/i.test(p.status || ''), reinspection: false, requestedAt: null, scheduledAt: p.scheduledAt, actualAt: /^(passed|approved|failed|disapproved|partial)/i.test(p.status || '') ? at : null, inspector: null, comments: null };
  });
  const holds = proc.filter((p) => /holds/i.test(p.group || '')).map((p) => ({ name: p.name, type: 'Completion Hold', reason: null, comments: null, createdAt: p.scheduledAt || p.endAt, active: !/released|cleared|satisfied|complete/i.test(p.status || ''), status: p.status }));
  const total = raw.fees.find((r) => /^total/i.test(r[0] || ''));
  const issuance = proc.find((p) => /final issuance review/i.test(p.name) && p.endAt);
  return {
    number, caseId: null, county, account, type: typeRow[0] || null, workclass: typeRow[2] || null,
    status: main[3] || null, projectName: main[2] || null, address: addrRow[0] || null, parcel: addrRow[1] || null,
    appliedAt: iso(main[1]), issuedAt: iso(main[4]) || (/^issued/i.test(main[3] || '') ? issuance?.endAt || null : null), expiresAt: iso(main[5]),
    finalizedAt: /^(final|closed|complete)/i.test(main[3] || '') ? iso(main[5]) : null,
    squareFeet: null, valuation: null, description: null,
    submittals, reviewItems, workflow: proc, inspections, holds,
    contacts: raw.people.filter((r) => r[0]).map((r) => ({ type: r[0], name: r[1], address: r[2] })),
    feeSummary: total ? { TotalFee: money(total[1]), TotalUnpaidFee: money(total[2]) } : null,
    fees: raw.fees.filter((r) => r[0] && !/^total/i.test(r[0])).map((r) => ({ description: r[0], amount: money(r[1]), balance: money(r[2]) })),
    deficiencyReports: reports, documents, intakeRejectedAt: rejectedAfter, subRecords: [],
    reportTexts: raw.reportTexts || {},
    collectedAt: new Date().toISOString(),
  };
}

async function main() {
if (!permits.length) { console.error('Give at least one permit number.'); process.exit(2); }
if (!accounts.length) { console.error('ORANGE_PORTAL_USER / ORANGE_PORTAL_PASS not set'); process.exit(2); }
mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
const results = {};
for (const [n, user, pass] of accounts) {
  const todo = permits.filter((p) => !results[p]?.found);
  if (!todo.length) break;
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);
  try {
    await login(page, user, pass);
    const listed = await myPermits(page);
    console.log(`login ${n}: ${listed.length} permit(s) on My Permits`);
    for (const p of todo.filter((x) => listed.includes(x))) {
      const t0 = Date.now();
      try {
        const raw = await openPermit(page, p);
        results[p] = raw ? { permitNumber: p, found: true, url: page.url(), permit: parseDetail(p, raw, n) } : { permitNumber: p, found: false, error: 'not linked on My Permits' };
      } catch (e) { results[p] = { permitNumber: p, found: false, error: e.message }; }
      const r = results[p];
      console.log(`${p} (login ${n}): ${r.found ? `${r.permit.status} · ${r.permit.submittals.length} rounds · ${r.permit.reviewItems.length} review items · ${r.permit.inspections.length} inspections · ${r.permit.holds.length} holds` : `FAILED (${r.error})`} [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
    }
  } catch (e) { console.log(`login ${n}: ${e.message}`); }
  await ctx.close();
}
await browser.close();

const summary = [];
for (const p of permits) {
  const res = results[p] || { permitNumber: p, found: false, error: 'not on My Permits of any Fast Track login (last 6 months only; older permits need My Permit Search)' };
  if (!results[p]) console.log(`${p}: NOT FOUND (${res.error})`);
  const file = join(OUT_DIR, `${p.replace(/[^A-Za-z0-9-]/g, '_')}.json`);
  writeFileSync(file, JSON.stringify(res, null, 2));
  summary.push({ permit: p, found: res.found, status: res.permit?.status || null, file });
}
writeFileSync(join(OUT_DIR, '_index.json'), JSON.stringify({ county, stage: STAGE, collectedAt: new Date().toISOString(), permits: summary }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
