#!/usr/bin/env node
// =============================================================================
// bt_schedule.mjs — mark Buildertrend Schedule items complete from county evidence (Victor, 2026-10-19).
// Rules: config/bt_schedule_map.json (item title → passed inspection / permit issued / CO). For each job
// with a Buildertrend id, an item that the rules cover, that is not complete yet, and whose evidence exists
// is marked complete — the same call the Schedule page makes (POST /apix/v2/Schedules/mark-complete,
// {scheduleItemId, markComplete: true}); the item is re-read to confirm. Never un-marks, never changes
// dates, never touches items without a rule. Draw items: when the QuickBooks invoice for that stage exists. Each marking is recorded as an event (bt.schedule_complete).
// Writes only with OPS_BT_POST=true or --post; otherwise lists what it would mark.
//   BT_COOKIES_FILE=… node rules/bt_schedule.mjs [--post] [--job 0031] [--limit 1]
// =============================================================================
import { readFileSync } from 'node:fs';
import { sql } from '../scripts/sb.mjs';
import { usDate } from './lib.mjs';
import { openBuildertrend } from '../collectors/buildertrend/session.mjs';
import { noNotify } from '../collectors/buildertrend/no_notify.mjs';
import { pickShiftReason } from '../collectors/buildertrend/shift_reason.mjs';
const SHIFT_REASON = 'Data real (inspeção/fatura/Daily Log) – PKB Ops';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const POST = process.env.OPS_BT_POST === 'true' || process.argv.includes('--post');
const ONLY = arg('--job'), LIMIT = Number(arg('--limit') || 0);
// --jobs 0001,0002: several houses; --no-logs: dates only from inspections / CO / permit / invoices (not Daily Logs).
const JOBS = (arg('--jobs') || '').split(',').map((x) => x.trim()).filter(Boolean), NO_LOGS = process.argv.includes('--no-logs'), LAG = process.argv.includes('--lag');
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const MAP = JSON.parse(readFileSync(new URL('../config/bt_schedule_map.json', import.meta.url), 'utf8')).rules.map((r) => ({ ...r, itemRe: new RegExp(r.item, 'i'), inspRe: r.inspection ? new RegExp(r.inspection, 'i') : null }));

// Evidence per job: building permit issued, CO, passed inspections (type + date).
const rows = await sql(`select j.job_number, j.bt_job_id, j.co_at, c.issued_at, i.type, coalesce(i.actual_at, i.scheduled_at, i.requested_at) at, coalesce(i.actual_at, i.scheduled_at)::date::text exact
  from ops.jobs j join ops.permit_cases c on c.job_id = j.id and c.kind = 'building'
  left join ops.inspections i on i.permit_case_id = c.id and i.passed
  where j.bt_job_id is not null ${ONLY ? `and j.job_number = ${q(ONLY)}` : ''} ${JOBS.length ? `and j.job_number in (${JOBS.map(q).join(',')})` : ''}`);
const ev = {};
for (const r of rows) {
  const e = (ev[r.bt_job_id] ??= { job: r.job_number, issued: r.issued_at, co: r.co_at, passed: [] });
  if (r.type) e.passed.push({ type: r.type, at: r.at, exact: r.exact });
}
// Draws invoiced in QuickBooks (stages per job) — only when QuickBooks is connected.
const billed = {};
if (MAP.some((r) => r.evidence === 'draw_invoiced')) {
  const ok = (await sql(`select disconnected_at is null as ok from ops.qbo_connection where id = 1`).catch(() => []))[0]?.ok;
  if (ok) for (const h of (await sql(`select ops.qbo_draws_core() j`))[0].j.houses || [])
    billed[h.job] = Object.fromEntries((h.draws || []).flatMap((d) => d.stages.map((n) => [n, d])));
}
// Daily Logs: items the supervisors' logs say are done (rules/dailylog_done.mjs, config/bt_schedule_dailylog.json).
const { doneFromLogs, itemsFor } = await import('./dailylog_done.mjs');
const logDone = {};
{ const logs = await sql(`select l.job_number, l.log_date::text date, l.author by, l.title, l.notes from ops.daily_logs l where l.job_number is not null`);
  const byJob = {}; for (const l of logs) (byJob[l.job_number] ??= []).push(l);
  for (const [job, ls] of Object.entries(byJob)) logDone[job] = doneFromLogs(ls); }
// EXACT: the date the evidence itself proves (set by proof/fromLog): an inspection item → the day it was inspected;
// a draw → the invoice date; the permit/CO → their dates; a Daily Log → the log date. Work items proven only by a
// LATER inspection have no exact date (the work was done before it) → null.
let EXACT = null;
const fromLog = (e, title) => { for (const it of itemsFor(title)) { const d = logDone[e.job]?.get(it.item); if (d) { EXACT = d.exact || null; return `Daily Log ${usDate(d.date)}${d.by ? ` (${d.by})` : ''}: "${d.text}"`; } } return null; };
const jobIds = Object.keys(ev).map(Number);
if (!jobIds.length) { console.log('no jobs with a Buildertrend id and a building permit'); process.exit(0); }
const proof1 = (e, rule) => {
  EXACT = null;
  if (rule.evidence === 'permit_issued') { EXACT = e.issued ? String(e.issued).slice(0, 10) : null; return e.issued ? `permit issued ${usDate(e.issued)}` : null; }
  if (rule.evidence === 'co') { EXACT = e.co ? String(e.co).slice(0, 10) : null; return e.co ? `CO ${usDate(e.co)}` : null; }
  if (rule.evidence === 'same_inspection') {
    const n = (t) => String(t || '').replace(/^\s*\(tug\)\s*/i, '').split(/ - 1 ?&| - res|\(/i)[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const want = n(String(rule.title || '').replace(/^inspection - /i, ''));
    const p = want && e.passed.filter((x) => n(x.type) === want).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
    EXACT = p?.exact || null;
    return p ? `${p.type.replace(/ - 1 ?& ?2.*$/, '')} passed ${usDate(p.at)}` : null;
  }
  if (rule.evidence === 'draw_invoiced') { const d = billed[e.job]?.[rule.stage]; EXACT = d ? String(d.billed_on).slice(0, 10) : null; return d ? `QuickBooks invoice ${d.invoice || ''} billed ${usDate(d.billed_on)}`.replace('  ', ' ') : null; }
  // Match on the inspection name without the county's suffix (Marion: 'Rough Plumbing - 1 & 2 Residential Family').
  const base = (t) => String(t || '').replace(/\s+-\s+(1\s*&\s*2|res\b).*$/i, '').trim();
  const p = e.passed.filter((x) => rule.inspRe.test(base(x.type)) || rule.inspRe.test(x.type)).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  EXACT = p && (rule.exact || /^inspection - /i.test(String(rule.title || ''))) ? p.exact || null : null;
  return p ? `${p.type.replace(/ - 1 ?& ?2.*$/, '')} passed ${usDate(p.at)}` : null;
};

// An item may match several rules (e.g. 'HVAC - Trims': rough mechanical, then final mechanical): the first rule
// whose evidence exists wins (with its exact date).
const proof = (e, { title }) => { for (const r of MAP.filter((x) => x.itemRe.test(title))) { const w = proof1(e, { ...r, title }); if (w) return w; } EXACT = null; return null; };
const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('Buildertrend session expired — nothing marked'); await browser.close(); process.exit(0); }
// The page's own list call (and an /apix/ call for its headers).
let listReq = null, apixHeaders = null;
page.on('request', (r) => {
  if (!listReq && /\/api\/calendar\/CalendarList/i.test(r.url())) listReq = { url: r.url(), headers: r.headers(), body: r.postData() };
  if (!apixHeaders && /\/apix\//i.test(r.url())) apixHeaders = r.headers();
});
await page.goto(`https://buildertrend.net/app/Schedules/List?jobId=${jobIds[0]}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 90 && !listReq; i++) await page.waitForTimeout(500);
if (!listReq) { console.error('Schedule list call not seen — nothing marked'); await browser.close(); process.exit(1); }
const clean = (h) => Object.fromEntries(Object.entries(h || {}).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k)));
const headers = { ...clean(listReq.headers), 'content-type': 'application/json' };
const xHeaders = { ...clean(apixHeaders || listReq.headers), 'content-type': 'application/json' };

// Every item of the jobs: the list call month by month (it takes several jobs at once).
async function listItems(ids) {
  const items = new Map();
  for (let k = -14; k <= 8; k++) {
    const now = new Date(); const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1)).toISOString().slice(0, 10) + 'T00:00:00';
    const res = await page.request.post(listReq.url, { headers, data: JSON.stringify({ ...JSON.parse(listReq.body), startDate: d, selectedJobIds: ids, perDayLimit: 200 }) });
    const j = await res.json().catch(() => null);
    for (const it of j?.data?.calendarItems || []) items.set(String(it.id), it);
  }
  return [...items.values()];
}
// --undo "<title regex>" --since <ISO>: un-mark items THIS robot marked (events bt.schedule_complete), e.g. after a
// rule turned out wrong. Only items whose event matches; each is re-read to confirm, then its event is removed so a
// corrected rule can mark it again later.
// --dates: READ-ONLY report — for every COMPLETE item with an exact evidence date, compare it with the item's
// Start / End in Buildertrend and list the differences (nothing is changed).
if (process.argv.includes('--dates')) {
  const all = await listItems(jobIds);
  let ok = 0, diff = 0, noExact = 0;
  const lines = [];
  for (const it of all) {
    if (!it.completed) continue;
    const e = ev[it.jobId]; if (!e) continue;
    const title = String(it.title || '').trim();
    const rule = MAP.find((r) => r.itemRe.test(title));
    EXACT = null;
    let why = rule ? proof(e, { ...rule, title }) : null;
    if (!why || !EXACT) why = fromLog(e, title);
    if (!why || !EXACT) { noExact++; continue; }
    const st = String(it.startDate || '').slice(0, 10), en = String(it.endDate || '').slice(0, 10);
    if (st === EXACT) { ok++; continue; }
    diff++; lines.push(`DATE ${e.job} · ${title} (item ${it.id}) · Buildertrend start ${usDate(st)} end ${usDate(en)} → exact ${usDate(EXACT)} · ${why}`);
  }
  lines.sort().forEach((l) => console.log(l));
  console.log(`dates: ${ok} already on the exact date · ${diff} different · ${noExact} complete without an exact date`);
  await browser.close(); process.exit(0);
}
// --fix-dates [--job 0010] [--post]: put every COMPLETE item with an exact evidence date on that date, keeping the
// links (Victor, 11/19/26: "ir ajustando a cadeia com as datas certas"). Per job, the earliest item (current
// Start) that is off is changed first the way a person does it (open the item, Start Date, Save); Buildertrend
// then shifts the linked chain; the job is re-read and the next item off is fixed, until all match.
if (process.argv.includes('--fix-dates')) {
  await noNotify(page, (m) => console.log('  ' + m));
  const fmtBt = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  const exactFor = (e, it) => { const title = String(it.title || '').trim(); const rule = MAP.find((r) => r.itemRe.test(title)); EXACT = null;
    let why = rule ? proof(e, { ...rule, title }) : null; if ((!why || !EXACT) && !NO_LOGS) why = fromLog(e, title); return why && EXACT ? { date: EXACT, why } : null; };
  // Work days between two ISO dates (Mon–Fri), signed: b later than a → positive.
  const workdays = (a, b) => { const s = Math.sign(Date.parse(b) - Date.parse(a)); let n = 0; const d = new Date(a + 'T12:00:00Z'); const end = b;
    while (d.toISOString().slice(0, 10) !== end) { d.setUTCDate(d.getUTCDate() + s); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n += s; } return n; };
  // Move the item's Start to `date` by lowering the lag of EVERY predecessor link by the same number of work days
  // (an item can have several predecessors; the latest one holds it). If it does not land, the lags go back.
  const lagInputs = async () => { const out = []; for (let i = 0; i < 10; i++) { const l = page.locator(`input[name="predecessors.${i}.lag"]`); if (!(await l.count())) break; out.push(l); } return out; };
  async function saveItem() {
    await page.getByRole('button', { name: /^save$/i }).first().click({ timeout: 20000 }); await page.waitForTimeout(4000);
    if (await page.locator('text=Shift Reason').first().isVisible().catch(() => false)) {
      if (!(await pickShiftReason(page, SHIFT_REASON, (m) => console.log('  ' + m)))) throw new Error('could not select the Shift Reason');
      await page.getByRole('button', { name: /^save$/i }).first().click({ timeout: 20000 }); await page.waitForTimeout(5000);
    }
  }
  async function openItem(bt, id) {
    await page.goto(`https://buildertrend.net/app/Schedules/List/Schedule/${id}/${bt}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.locator('input[name="predecessors.0.lag"]').waitFor({ timeout: 45000 }); await page.waitForTimeout(1500);
  }
  async function setLags(values) { const ins = await lagInputs(); for (let i = 0; i < ins.length; i++) { await ins[i].click({ clickCount: 3 }); await ins[i].fill(String(values[i])); await ins[i].press('Tab'); await page.waitForTimeout(600); } }
  async function lagTo(bt, it, date) {
    let cur = String(it.startDate).slice(0, 10), orig = null, now = null;
    for (let k = 0; k < 3; k++) {
      await openItem(bt, it.id);
      now = await Promise.all((await lagInputs()).map(async (l) => Number(await l.inputValue() || 0)));
      orig ??= now;
      const d = workdays(date, cur), next = now.map((v) => v - d);
      if (next.some((v) => v < -999)) break;
      await setLags(next); await saveItem();
      const after = String((await listItems([bt])).find((y) => String(y.id) === String(it.id))?.startDate).slice(0, 10);
      if (after === date) return { lag: next.join('/') };
      if (after === cur) break;   // nothing moved: something else holds it
      cur = after;
    }
    if (orig) { await openItem(bt, it.id); await setLags(orig); await saveItem(); }   // put the links back as they were
    throw new Error(`Start stays ${cur} after lowering the lags (lags restored to ${orig?.join('/')})`);
  }
  // --undo-lag <itemId>:<add>,…: give back lag added by an earlier try on the FIRST predecessor link.
  const UNDO_LAG = (arg('--undo-lag') || '').split(',').filter(Boolean).map((x) => x.split(':').map(Number));
  if (UNDO_LAG.length && POST) {
    const all = await listItems(jobIds);
    for (const [id, add] of UNDO_LAG) {
      const it = all.find((y) => String(y.id) === String(id)); if (!it) { console.error(`UNDO-LAG item ${id} not found`); continue; }
      await openItem(it.jobId, id); const l = (await lagInputs())[0]; const v = Number(await l.inputValue() || 0);
      await setLags([v + add, ...(await Promise.all((await lagInputs()).slice(1).map(async (x) => Number(await x.inputValue() || 0))))]); await saveItem();
      await openItem(it.jobId, id); console.log(`UNDO-LAG ${String(it.title).trim()} (item ${id}): first link lag ${v} → ${Number(await (await lagInputs())[0].inputValue())}`);
    }
  }
  let changed = 0, failed = 0;
  for (const bt of jobIds) {
    const e = ev[bt]; if (!e) continue;
    if (LIMIT && changed >= LIMIT) break;
    const tried = new Set();
    for (let round = 0; round < 200; round++) {
      const items = (await listItems([bt])).filter((it) => it.completed).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || String(a.id).localeCompare(String(b.id)));
      const next = items.map((it) => ({ it, x: exactFor(e, it) })).find(({ it, x }) => x && String(it.startDate).slice(0, 10) !== x.date && !tried.has(String(it.id)));
      if (!next) break;
      const { it, x } = next; tried.add(String(it.id));
      const label = `${e.job} · ${String(it.title).trim()} (item ${it.id}) ${String(it.startDate).slice(0, 10)} → ${x.date} ← ${x.why}`;
      if (!POST) { console.log(`[dry run] date ${label}`); continue; }
      try {
        await page.goto(`https://buildertrend.net/app/Schedules/List/Schedule/${it.id}/${bt}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        const start = page.locator('#startDate'); await start.waitFor({ timeout: 45000 }); await page.waitForTimeout(1500);
        await start.click({ clickCount: 3 }); await start.fill(fmtBt(x.date)); await start.press('Tab'); await page.waitForTimeout(1500);
        await page.getByRole('button', { name: /^save$/i }).first().click({ timeout: 20000 }); await page.waitForTimeout(4000);
        if (await page.locator('text=Shift Reason').first().isVisible().catch(() => false)) {   // moving later: Buildertrend asks why
          if (!(await pickShiftReason(page, SHIFT_REASON, (m) => console.log('  ' + m)))) throw new Error('could not select the Shift Reason');
          await page.getByRole('button', { name: /^save$/i }).first().click({ timeout: 20000 }); await page.waitForTimeout(5000);
        }
        const after = (await listItems([bt])).find((y) => String(y.id) === String(it.id));
        if (String(after?.startDate).slice(0, 10) !== x.date) throw new Error(`Start is ${String(after?.startDate).slice(0, 10)} after saving`);
        await sql(`insert into ops.events (org_id, job_id, kind, source, occurred_at, payload, dedupe_key)
          select j.org_id, j.id, 'bt.schedule_date', 'rule', now(), ${q(JSON.stringify({ item: String(it.title).trim(), item_id: it.id, from: String(it.startDate).slice(0, 10), to: x.date, evidence: x.why }))}::jsonb, ${q(`bt.schedule_date:${it.id}:${x.date}`)}
          from ops.jobs j where j.job_number = ${q(e.job)} on conflict (org_id, dedupe_key) do nothing`);
        changed++; console.log(`DATED ${label}`);
        if (LIMIT && changed >= LIMIT) break;
      } catch (err) {
        // Victor 11/21/26: an INSPECTION held later by its predecessor (Finish-to-Start link) gets its exact date
        // through a negative lag on that link (only this item changes); a draw or any other item stays as it is.
        const isInspection = /^inspection - /i.test(String(it.title || '').trim());
        if (POST && LAG && isInspection && x.date < String(it.startDate).slice(0, 10)) {
          try { const r = await lagTo(bt, it, x.date); changed++; console.log(`DATED (lag ${r.lag}) ${label}`); await sql(`insert into ops.events (org_id, job_id, kind, source, occurred_at, payload, dedupe_key)
            select j.org_id, j.id, 'bt.schedule_date', 'rule', now(), ${q(JSON.stringify({ item: String(it.title).trim(), item_id: it.id, from: String(it.startDate).slice(0, 10), to: x.date, lag: r.lag, evidence: x.why }))}::jsonb, ${q(`bt.schedule_date:${it.id}:${x.date}`)}
            from ops.jobs j where j.job_number = ${q(e.job)} on conflict (org_id, dedupe_key) do nothing`); continue; }
          catch (e2) { console.error(`FAILED date (lag) ${label}: ${e2.message}`); }
        }
        failed++; console.error(`FAILED date ${label}: ${err.message}`);
      }
    }
  }
  console.log(`fix-dates: ${changed} changed · ${failed} failed${POST ? '' : ' · dry run (the chain moves after each real change, so the real run can differ)'}`);
  await browser.close(); process.exit(failed && !changed ? 1 : 0);
}
const UNDO = arg('--undo'), SINCE = arg('--since');
if (UNDO) {
  const evs = await sql(`select e.id, e.payload->>'item' item, (e.payload->>'item_id')::bigint item_id, j.job_number, j.bt_job_id from ops.events e join ops.jobs j on j.id = e.job_id
    where e.kind = 'bt.schedule_complete' and e.payload->>'item' ~* ${q(UNDO)} ${SINCE ? `and e.created_at >= ${q(SINCE)}::timestamptz` : ''} order by e.id`);
  console.log(`undo: ${evs.length} item(s) matching /${UNDO}/${SINCE ? ` since ${SINCE}` : ''}${POST ? '' : ' · DRY RUN'}`);
  let ok = 0, bad = 0;
  for (const ev of evs) {
    const label = `${ev.job_number} · ${ev.item} (item ${ev.item_id})`;
    if (!POST) { console.log(`[dry run] unmark ${label}`); continue; }
    try {
      let res = await page.request.post('https://buildertrend.net/apix/v2/Schedules/mark-complete', { headers: xHeaders, data: JSON.stringify({ scheduleItemId: Number(ev.item_id), markComplete: false }) });
      if (res.status() === 404 || res.status() === 405) res = await page.request.put('https://buildertrend.net/apix/v2/Schedules/mark-complete', { headers: xHeaders, data: JSON.stringify({ scheduleItemId: Number(ev.item_id), markComplete: false }) });
      if (!res.ok()) throw new Error(`HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
      const after = (await listItems([Number(ev.bt_job_id)])).find((x) => String(x.id) === String(ev.item_id));
      if (after?.completed) throw new Error('Buildertrend answered OK but the item is still complete');
      await sql(`delete from ops.events where id = ${Number(ev.id)}`);
      ok++; console.log(`UNMARKED ${label}`);
    } catch (err) { bad++; console.error(`FAILED unmark ${label}: ${err.message}`); }
  }
  console.log(`undo: ${ok} unmarked · ${bad} failed`);
  await browser.close(); process.exit(bad && !ok ? 1 : 0);
}
const items = await listItems(jobIds);
console.log(`${items.length} schedule items in ${jobIds.length} job(s)`);

const todo = [];
for (const it of items) {
  if (it.completed) continue;
  const e = ev[it.jobId]; if (!e) continue;
  const title = String(it.title || '').trim();
  const rule = MAP.find((r) => r.itemRe.test(title));
  const why = (rule && proof(e, { ...rule, title })) || fromLog(e, title); if (!why) continue; if (why) todo.push({ it, e, why });
}
if (!POST) {
  // Dry run: also show which open items no rule covers (to extend config/bt_schedule_map.json).
  const uncovered = {};
  for (const it of items) if (!it.completed && ev[it.jobId] && !MAP.some((r) => r.itemRe.test(String(it.title || '').trim())) && !itemsFor(it.title).length) { const t = String(it.title || '').trim(); uncovered[t] = (uncovered[t] || 0) + 1; }
  console.log('open items without a rule:', Object.entries(uncovered).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} (${n})`).join(' · '));
}
const list = LIMIT ? todo.slice(0, LIMIT) : todo;
console.log(`${todo.length} item(s) to mark complete${LIMIT ? ` (limited to ${list.length})` : ''}${POST ? '' : ' · DRY RUN (no change)'}`);

let done = 0, failed = 0;
for (const { it, e, why } of list) {
  const label = `${e.job} · ${String(it.title).trim()} (item ${it.id}) ← ${why}`;
  if (!POST) { console.log(`[dry run] ${label}`); continue; }
  try {
    let res = await page.request.post('https://buildertrend.net/apix/v2/Schedules/mark-complete', { headers: xHeaders, data: JSON.stringify({ scheduleItemId: Number(it.id), markComplete: true }) });
    if (res.status() === 404 || res.status() === 405) res = await page.request.put('https://buildertrend.net/apix/v2/Schedules/mark-complete', { headers: xHeaders, data: JSON.stringify({ scheduleItemId: Number(it.id), markComplete: true }) });
    if (!res.ok()) throw new Error(`HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
    // Confirm: re-read the job's items and check this one is complete now.
    const after = (await listItems([Number(it.jobId)])).find((x) => String(x.id) === String(it.id));
    if (!after?.completed) throw new Error('Buildertrend answered OK but the item is still not complete');
    await sql(`insert into ops.events (org_id, job_id, kind, source, occurred_at, payload, dedupe_key)
      select j.org_id, j.id, 'bt.schedule_complete', 'rule', now(), ${q(JSON.stringify({ item: String(it.title).trim(), item_id: it.id, evidence: why }))}::jsonb, ${q(`bt.schedule_complete:${it.id}`)}
      from ops.jobs j where j.job_number = ${q(e.job)} on conflict (org_id, dedupe_key) do nothing`);
    done++; console.log(`MARKED ${label}`);
  } catch (err) { failed++; console.error(`FAILED ${label}: ${err.message}`); }
}
console.log(`schedule: ${done} marked complete · ${failed} failed${POST ? '' : ' · dry run'}`);
await browser.close();
process.exit(failed && !done ? 1 : 0);
