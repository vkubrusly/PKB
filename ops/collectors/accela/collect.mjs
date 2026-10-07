#!/usr/bin/env node
// =============================================================================
// collect.mjs — read public permit data from an Accela Citizen Access (ACA)
// portal. Citrus County runs Accela; the output matches the EnerGov collector
// (data/portal/<county>/<PERMIT>.json with a normalized `permit` block) so
// build_seed.mjs loads both the same way.
//
// Usage:
//   node collectors/accela/collect.mjs --county citrus BLD2607-0748 [more...]
//   node collectors/accela/collect.mjs --county citrus --stage inspections BLD2601-0420
//
// No login is needed. The record page already carries, in its HTML:
//   Processing Status  every workflow task with its full history (due date,
//                      assignee, "Marked as <status> on <date> by <who>", comment)
//   Inspections        Upcoming (paged, 5 per page) and Completed lists
//   Conditions         document requirements / holds (paged)
//   Related Records    revisions (.RR / REV…) and extensions
// Paging is ASP.NET postbacks, so we click "Next >" and wait for the grid.
// =============================================================================

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPS_ROOT = join(HERE, '..', '..');

import { PORTALS } from './portals.mjs';
export { PORTALS };

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const county = (flag('--county') || 'citrus').toLowerCase();
const portal = PORTALS[county];
if (!portal) { console.error(`Unknown county "${county}". Known: ${Object.keys(PORTALS).join(', ')}`); process.exit(2); }
// --stage inspections skips nothing today (one page holds everything) but is accepted for collect_all.mjs.
const STAGE = flag('--stage') || 'permit';
const permits = args.filter((a, i) => !a.startsWith('--') && !['--county', '--stage', '--limit'].includes(args[i - 1]));
if (!permits.length) { console.error('Give at least one record number.'); process.exit(2); }
const OUT_DIR = join(OPS_ROOT, 'data', 'portal', county);
mkdirSync(OUT_DIR, { recursive: true });

// Tasks in Processing Status that are plan reviews (the rest is intake/issuance/inspection workflow).
const REVIEW_TASK = /review|swppp|preliminary inspection|affordable housing/i;
// Plan Review Verification is the intake clerk's mirror of the rounds (Revisions Received / Routing / Ready to Issue).
const NOT_REVIEW = /^(fee review|reviewer routing|private provider review|no plan review required|plan review verification|intake sufficiency review)$/i;
// A review status that sends the plans back to the applicant.
export const REVIEW_FAILED = /revisions? required|disapprov|denied|fail|incomplete|re-?submit|corrections?|rejected/i;

const EXEC = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--disable-quic'],
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.setDefaultTimeout(90000);

const iso = (s) => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
const tidy = (s) => (s || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

async function openRecord(number) {
  // Some agencies keep records under more than one module (North Port: Building and Planning).
  for (const module of portal.modules || [portal.module]) if (await openIn(module, number)) return true;
  return false;
}
async function openIn(module, number) {
  await page.goto(`${portal.base}/Cap/CapHome.aspx?module=${module}&TabName=${module}`, { waitUntil: 'domcontentloaded' });
  const box = page.locator('input[id$="txtGSPermitNumber"]').first();
  await box.waitFor();
  await box.fill(number);
  await Promise.all([page.waitForLoadState('load').catch(() => {}), page.locator('#ctl00_PlaceHolderMain_btnNewSearch').click()]);
  await page.waitForTimeout(4000);
  if (!/CapDetail/i.test(page.url())) {
    // More than one hit (e.g. the permit and its revisions): open the exact record.
    const link = page.getByRole('link', { name: number, exact: true }).first();
    if (!(await link.count())) return false;
    await Promise.all([page.waitForLoadState('load').catch(() => {}), link.click()]);
    await page.waitForTimeout(4000);
  }
  if (!/CapDetail/i.test(page.url())) return false;
  // The inspection lists load through a postback right after the page opens.
  await page.locator('#ctl00_PlaceHolderMain_InspectionList_lblInspectionUpcoming, #ctl00_PlaceHolderMain_InspectionList_gvListCompleted').first().waitFor({ timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return true;
}

// Rows of a paged grid: read the current page, click "Next >" until it is gone.
async function allPages(gridSel, readRows, maxPages = 12) {
  const rows = [];
  for (let n = 0; n < maxPages; n++) {
    const grid = page.locator(gridSel);
    if (!(await grid.count())) break;
    rows.push(...await grid.evaluate(readRows));
    const next = grid.locator('a', { hasText: /Next\s*>/ });
    if (!(await next.count())) break;
    // The tabs are hidden until opened, so trigger the postback link directly.
    const before = await grid.evaluate(g => g.textContent);
    await next.first().evaluate(a => a.click());
    await page.waitForFunction(([sel, b]) => { const g = document.querySelector(sel); return g && g.textContent !== b; }, [gridSel, before], { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  return rows;
}

// Processing Status: one entry per task, each with its history (oldest first as shown).
function readWorkflow() {
  const out = [];
  const rows = document.querySelectorAll('tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even');
  for (const tr of rows) {
    if (tr.id) continue; // the hidden history row of the previous task
    const cells = tr.querySelectorAll(':scope > td');
    if (cells.length < 2) continue;
    const name = cells[cells.length - 1].innerText.trim();
    if (!name || name.length > 80) continue;
    const icon = tr.querySelector('img[title]');
    const next = tr.nextElementSibling;
    const history = [];
    if (next && next.id) {
      for (const h of next.querySelectorAll('tr.ACA_TabRow_Bold, tr.ACA_TabRow_Italic')) {
        const line = h.innerText.replace(/\s+/g, ' ').trim();
        const cm = h.nextElementSibling && h.nextElementSibling.id ? h.nextElementSibling.querySelector('.ACA_Comments')?.closest('tr')?.querySelectorAll('td') : null;
        const comment = cm && cm.length ? cm[cm.length - 1].innerText.trim() : null;
        history.push({ line, comment });
      }
    }
    out.push({ task: name, state: icon ? icon.getAttribute('title') : null, history });
  }
  return out;
}

function parseHistory(line) {
  // "Due on 08/04/2026, assigned to Tiffany Johnson Marked as Approved on 07/31/2026 by Tiffany Johnson"
  const m = /Due on (\S+)\s*, assigned to (.*?)\s*Marked as (.*?) on (\S+) by (.*)$/i.exec(line);
  if (!m) {
    // Charlotte: "Marked as Rejected on 03/02/2026 by Christopher Bellitt" (no due date/assignee)
    const k = /Marked as (.*?) on (\S+) by (.*)$/i.exec(line);
    if (!k) return { raw: line };
    return { dueAt: null, assignedTo: k[3], status: k[1], completedAt: iso(k[2]), by: k[3] };
  }
  return { dueAt: iso(m[1]), assignedTo: m[2] === 'TBD' ? null : m[2], status: m[3] === 'TBD' ? null : m[3], completedAt: iso(m[4]), by: m[5] === 'TBD' ? null : m[5] };
}

function readInspectionRows(grid) {
  return [...grid.querySelectorAll('tr.InspectionListRow')].map(tr => {
    const td = tr.querySelector('td.ACA_Width45em') || tr.querySelector('td');
    const spans = [...td.querySelectorAll('span')].map(s => s.textContent.replace(/\s+/g, ' ').trim());
    const view = tr.querySelector('a[title="View Details"]');
    const details = view ? (/showInspectionPopupDialog\('([^']+)'/.exec(view.getAttribute('onclick') || '') || [])[1] || null : null;
    return { spans, text: spans.join('  ') || td.textContent.replace(/\s+/g, ' ').trim(), details };
  });
}

function parseInspection(r, completed) {
  // Upcoming: "TBD at TBD Pending" / "10/02/2026 at 8:00 AM Scheduled"  +  "149 EROSION (132304)"  +  "Inspector: unassigned"
  // Completed: "<status> on <date>"-style lines; the parser keeps the raw text so odd rows are still readable.
  const typeSpan = r.spans.find(s => /\(\d+\)\s*$/.test(s)) || '';
  const tm = /^(.*?)\s*\((\d+)\)\s*$/.exec(typeSpan);
  const head = r.spans[0] && r.spans[0] !== typeSpan ? r.spans[0] : r.text.split(typeSpan)[0];
  const date = iso(head) || iso(r.text);
  let status = head.replace(/\d{2}\/\d{2}\/\d{4}/g, '').replace(/\bTBD\b/g, '').replace(/\d{1,2}:\d{2}\s*(AM|PM)?/gi, '').replace(/\bat\b|\bon\b/g, '').replace(/\s+/g, ' ').trim();
  if (!status) status = completed ? (/(passed|approved|failed|disapproved|partial|cancel\w*|not ready|corrections?)/i.exec(r.text)?.[1] || null) : 'Pending';
  // "Result by: Steven Chmura on 01/23/2026 at 11:49 AM" / "Cancelled by: …" / "Inspector: unassigned"
  const insp = (/(?:Result|Rescheduled|Cancelled) by:\s*(.*?)\s+on\s+\d/.exec(r.text) || /Inspector:\s*(.*?)(?:\s{2,}|\s+Actions|$)/.exec(r.text))?.[1]?.trim();
  const code = tm ? /^(\d+)\s+/.exec(tm[1])?.[1] : null;
  const st = status || '';
  const failed = /fail|disapprov|partial|not ready|correction|denied/i.test(st);
  const passed = !failed && /pass|approv|complete|not required/i.test(st);
  return {
    number: tm ? tm[2] : null, code, type: tm ? tm[1].replace(/^\d+\s+/, '') : typeSpan || null, status: status || null,
    requestedAt: null, scheduledAt: completed ? null : date, actualAt: completed ? date : null,
    inspector: insp && !/unassigned/i.test(insp) ? insp : null,
    reinspection: /re-?insp/i.test(r.text), passed, failed, cancelled: /cancel/i.test(st), completed, raw: r.text, details: r.details,
  };
}

// The "View Details" popup is a plain page: result comments and the status history are in its HTML.
let detailsPage = null;
async function inspectionDetails(path) {
  detailsPage ||= await ctx.newPage();
  await detailsPage.goto(new URL(path, portal.base).href, { waitUntil: 'load' });
  return detailsPage.evaluate(() => {
    const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const comments = [...document.querySelectorAll('#ctl00_phPopup_Inspection_divResultComments tr')]
      .map(txt).filter(t => t && !/^Result Comments|^Showing \d|Related Inspection|No records found|^ID /.test(t));
    const history = [...document.querySelectorAll('#ctl00_phPopup_Inspection_StatusHistoryList_gdvInspectionStatusHistoryList tr')]
      .map(tr => [...tr.querySelectorAll('td')].map(txt)).filter(c => c.length >= 5 && !/^Showing/.test(c[0]))
      .map(c => ({ status: c[0], at: c[1], inspector: c[2], updatedAt: c[3], by: c[4], comments: c[5] || null }));
    return { comments: [...new Set(comments)].join('\n') || history.find(h => h.comments)?.comments || null, statusHistory: history };
  }).then(d => {
    const us = (s) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
    const sched = d.statusHistory.filter(h => /scheduled/i.test(h.status)).map(h => us(h.updatedAt)).filter(Boolean).sort();
    return { comments: d.comments, statusHistory: d.statusHistory, requestedAt: sched[0] || null, scheduledAt: us(d.statusHistory.find(h => /scheduled/i.test(h.status))?.at) };
  });
}

async function collectOne(number) {
  if (!(await openRecord(number))) return { permitNumber: number, found: false, error: 'record not found' };
  const url = page.url();
  const head = await page.evaluate(() => {
    const t = document.body.innerText;
    const g = (re) => (re.exec(t) || [])[1]?.trim() || null;
    return {
      number: g(/Record\s+([A-Z0-9.\-]+):/), type: document.querySelector('.span-permittype')?.innerText.trim() || null,
      status: g(/Record Status:\s*([^\n]+)/),
      address: document.querySelector('#tbl_worklocation, [id$="palWorkLocation"]')?.innerText.replace(/\s+/g, ' ').trim() || null,
      related: [...document.querySelectorAll('#tab-related_records tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim())).filter(r => r.length >= 3),
    };
  });

  const wf = (await page.evaluate(readWorkflow)).map(t => ({ ...t, history: t.history.map(h => ({ ...parseHistory(h.line), comments: h.comment || null })) }));

  // Rounds: every "Assign to Reviewers" in Reviewer Routing starts a review round.
  const routings = (wf.find(t => /^(reviewer routing|plans distribution)$/i.test(t.task))?.history || []).filter(h => h.completedAt).map(h => h.completedAt).sort();
  // A review belongs to the last routing strictly before its due date (the due date is set at routing).
  const roundOf = (d) => { let r = 1; routings.forEach((x, i) => { if (d && x < d) r = i + 1; }); return r; };
  const reviewItems = [];
  for (const t of wf) {
    if (!REVIEW_TASK.test(t.task) || NOT_REVIEW.test(t.task)) continue;
    const seen = {};
    for (const h of t.history) {
      if (!h.status && !h.dueAt) continue;
      // Stable id across runs: an open entry keeps its id when it is later marked Approved etc.
      const k = `${t.task}|${h.dueAt || ''}`; seen[k] = (seen[k] || 0) + 1;
      const round = roundOf(h.dueAt || h.completedAt);
      reviewItems.push({
        itemReviewId: `${k}|${seen[k]}`, submittalId: `round-${round}`, round,
        department: t.task, status: h.status || 'In Review', assignedTo: h.assignedTo, assignedToEmail: null,
        dueAt: h.dueAt, completedAt: h.status ? h.completedAt : null, comments: h.comments, by: h.by,
      });
    }
  }
  const submittals = (routings.length ? routings : [null]).map((d, i) => {
    const items = reviewItems.filter(r => r.round === i + 1);
    const open = items.some(r => !r.completedAt);
    const failedItems = items.filter(r => REVIEW_FAILED.test(r.status || ''));
    const done = items.filter(r => r.completedAt).map(r => r.completedAt).sort();
    return {
      submittalId: `round-${i + 1}`, version: i + 1, type: 'Plan Review',
      status: open ? 'In Review' : failedItems.length ? 'Revisions Required' : items.length ? 'Approved' : 'In Review',
      submittedAt: d, dueAt: items.map(r => r.dueAt).filter(Boolean).sort().pop() || null, completedAt: open ? null : done.pop() || null,
    };
  });

  const first = (task, re) => wf.find(t => re.test(t.task))?.history.filter(h => h.completedAt && (!task || task.test(h.status || ''))) || [];
  const issued = first(/^issued$/i, /^(permit issuance|permit issued|issuance)$/i)[0]?.completedAt || null;
  // Intake task: Citrus "Document Acceptance", Charlotte "Intake Sufficiency Review", North Port "Application Intake".
  const docs = wf.find(t => /^(document acceptance|intake sufficiency review|application intake)$/i.test(t.task))?.history.map(h => h.completedAt || h.dueAt).filter(Boolean).sort() || [];
  const mainRel = head.related.find(r => r[0] === number);
  const appliedAt = docs[0] || iso(mainRel?.[mainRel.length - 2] || mainRel?.[3]) || null;
  const finaled = wf.find(t => /^(closure|finaled|closed)$/i.test(t.task))?.history.find(h => h.completedAt && h.status && !/pending|tbd/i.test(h.status))?.completedAt || null;

  const upcoming = await allPages('#ctl00_PlaceHolderMain_InspectionList_gvListUpcoming', readInspectionRows);
  const completed = await allPages('#ctl00_PlaceHolderMain_InspectionList_gvListCompleted', readInspectionRows);
  const inspections = [...completed.map(r => parseInspection(r, true)), ...upcoming.map(r => parseInspection(r, false))].filter(i => i.number || i.type);

  // Inspector's result comments (and when it was requested) for inspections that did not pass.
  for (const i of inspections.filter(i => i.failed && i.details)) {
    try { Object.assign(i, await inspectionDetails(i.details)); } catch (e) { i.commentsError = e.message; }
  }

  const conditions = await allPages('[id$="capConditions_gdvGeneralConditionsList"]', (g) =>
    [...g.querySelectorAll('tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim()).filter(t => /\|\s*\w+\s*\|\s*\d{2}\/\d{2}\/\d{4}/.test(t)));
  const holds = conditions.map(t => {
    const m = /^(.*?)\s+(Applied|Complied|Met|Not Met|Condition Met|Resolved|Waived)?\s*\|\s*(\w+)\s*\|\s*(\d{2}\/\d{2}\/\d{4})/.exec(t.replace(/^(.*)\s(Applied|Complied|Met|Resolved|Waived)\s*\|/, '$1 $2 |')) || [];
    const body = (m[1] || t).replace(/^\w[\w ]*? - \d+ \w+(?:, \d+ \w+)* .*?Permit\s*/, '').trim();
    const title = body.split(/(?=Please provide)|“|"|(?=Per Section)/)[0].trim().slice(0, 120);
    return { name: title, type: m[3] || null, reason: null, comments: body, createdAt: iso(m[4]), active: !/complied|met|resolved|waived/i.test(m[2] || 'Applied') || /not met/i.test(m[2] || ''), status: m[2] || 'Applied' };
  });

  const subRecords = head.related.filter(r => r[0] && r[0] !== number && /^[A-Z]{2,5}\d/.test(r[0])).map(r => ({ number: r[0], type: r.slice(1).find(c => c && c !== r[0] && !/^\d{2}\/\d{2}\/\d{4}$|^view$/i.test(c)) || (/\.RR|^REV/.test(r[0]) ? 'Permit Revision' : null), status: null, date: iso(r.join(' ')) }));

  return {
    permitNumber: number, found: true, url,
    permit: {
      number, caseId: /capID1=([^&]+)&capID2=([^&]+)&capID3=([^&]+)/.exec(url)?.slice(1).join('-') || null, county,
      type: head.type, workclass: null, status: head.status, projectName: null, address: head.address, parcel: null,
      appliedAt, issuedAt: issued, expiresAt: null, finalizedAt: finaled, squareFeet: null, valuation: null, description: null,
      submittals, reviewItems, workflow: wf, inspections, holds, contacts: [], feeSummary: null, subRecords,
      collectedAt: new Date().toISOString(),
    },
  };
}

const summary = [];
for (const p of permits) {
  const t0 = Date.now();
  let res;
  try { res = await collectOne(p); } catch (e) { res = { permitNumber: p, found: false, error: e.message }; }
  const file = join(OUT_DIR, `${p.replace(/[^A-Za-z0-9-]/g, '_')}.json`);
  writeFileSync(file, JSON.stringify(res, null, 2));
  const s = res.found ? `${res.permit.status} · ${res.permit.submittals.length} rounds · ${res.permit.reviewItems.length} review items · ${res.permit.inspections.length} inspections · ${res.permit.holds.length} conditions` : `NOT FOUND (${res.error})`;
  console.log(`${p}: ${s} [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
  summary.push({ permit: p, found: res.found, status: res.permit?.status || null, file });
}
writeFileSync(join(OUT_DIR, '_index.json'), JSON.stringify({ county, stage: STAGE, collectedAt: new Date().toISOString(), permits: summary }, null, 2));
await browser.close();
