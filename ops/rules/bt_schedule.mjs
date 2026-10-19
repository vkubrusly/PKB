#!/usr/bin/env node
// =============================================================================
// bt_schedule.mjs — mark Buildertrend Schedule items complete from county evidence (Victor, 2026-10-19).
// Rules: config/bt_schedule_map.json (item title → passed inspection / permit issued / CO). For each job
// with a Buildertrend id, an item that the rules cover, that is not complete yet, and whose evidence exists
// is marked complete — the same call the Schedule page makes (POST /apix/v2/Schedules/mark-complete,
// {scheduleItemId, markComplete: true}); the item is re-read to confirm. Never un-marks, never changes
// dates, never touches items without a rule. Each marking is recorded as an event (bt.schedule_complete).
// Writes only with OPS_BT_POST=true or --post; otherwise lists what it would mark.
//   BT_COOKIES_FILE=… node rules/bt_schedule.mjs [--post] [--job 0031] [--limit 1]
// =============================================================================
import { readFileSync } from 'node:fs';
import { sql } from '../scripts/sb.mjs';
import { openBuildertrend } from '../collectors/buildertrend/session.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const POST = process.env.OPS_BT_POST === 'true' || process.argv.includes('--post');
const ONLY = arg('--job'), LIMIT = Number(arg('--limit') || 0);
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const MAP = JSON.parse(readFileSync(new URL('../config/bt_schedule_map.json', import.meta.url), 'utf8')).rules.map((r) => ({ ...r, itemRe: new RegExp(r.item, 'i'), inspRe: r.inspection ? new RegExp(r.inspection, 'i') : null }));

// Evidence per job: building permit issued, CO, passed inspections (type + date).
const rows = await sql(`select j.job_number, j.bt_job_id, j.co_at, c.issued_at, i.type, coalesce(i.actual_at, i.scheduled_at) at
  from ops.jobs j join ops.permit_cases c on c.job_id = j.id and c.kind = 'building'
  left join ops.inspections i on i.permit_case_id = c.id and i.passed
  where j.bt_job_id is not null ${ONLY ? `and j.job_number = ${q(ONLY)}` : ''}`);
const ev = {};
for (const r of rows) {
  const e = (ev[r.bt_job_id] ??= { job: r.job_number, issued: r.issued_at, co: r.co_at, passed: [] });
  if (r.type) e.passed.push({ type: r.type, at: r.at });
}
const jobIds = Object.keys(ev).map(Number);
if (!jobIds.length) { console.log('no jobs with a Buildertrend id and a building permit'); process.exit(0); }
const proof = (e, rule) => {
  if (rule.evidence === 'permit_issued') return e.issued ? `permit issued ${String(e.issued).slice(0, 10)}` : null;
  if (rule.evidence === 'co') return e.co ? `CO ${String(e.co).slice(0, 10)}` : null;
  const p = e.passed.filter((x) => rule.inspRe.test(x.type)).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  return p ? `${p.type.replace(/ - 1 ?& ?2.*$/, '')} passed ${String(p.at || '').slice(0, 10)}` : null;
};

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
const items = await listItems(jobIds);
console.log(`${items.length} schedule items in ${jobIds.length} job(s)`);

const todo = [];
for (const it of items) {
  if (it.completed) continue;
  const e = ev[it.jobId]; if (!e) continue;
  const rule = MAP.find((r) => r.itemRe.test(String(it.title || '').trim())); if (!rule) continue;
  const why = proof(e, rule); if (why) todo.push({ it, e, why });
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
