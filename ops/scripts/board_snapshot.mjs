#!/usr/bin/env node
// =============================================================================
// board_snapshot.mjs — builds the PKB Ops portal data (budget.pkbhomes.com/ops/) and stores it
// in ops.snapshots (kind 'board'): one row per job, the per-job file (permits with the full
// review history, inspections, holds, pauses, inspection progress, construction clock, photos,
// invoices) and the chart aggregates. Runs at the end of every ops-daily round.
// Duplicate "S###" jobs (created by the first unattended run) are folded into the original job.
//   node scripts/board_snapshot.mjs [--out board.json] [--no-store]
// =============================================================================
import { sql } from './sb.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { clock, summarize } from '../analysis/construction_clock.mjs';
import { progressAll } from '../analysis/inspection_progress.mjs';

const prog = await progressAll();
const d = (x) => (x ? String(x).slice(0, 10) : null);
const short = (s) => (s || '').replace(/ - 1 ?& ?2 Res(idential)? Fam(ily)?/i, '').replace(/1&2 Res Fam/i, '').replace(/ \((Permits|Building Permits|Permit & Plan|Permits & 911 Plans)\)/, '').replace(/ Department Review$/, '').trim();
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const mail = await sql(`select job_number, category, received_at, subject, parsed from ops.inbound_emails where job_number is not null order by received_at desc`);
const [jobs, contacts, pauses, cases, subs, revs, insps, holds] = await Promise.all([
  sql(`select id, org_id, latitude, longitude, job_number, company, status, address, parcel, county, model, owner_name, signed_at, second_draw_at, turtle_state, note, co_at, bt_job_id, photos_last_at, photos_last_by, photos_last_folder, photos_last_daily_log, photos_count from ops.jobs`),
  sql(`select job_id, role, name from ops.job_contacts`),
  sql(`select job_id, reason, started_at, ended_at, note from ops.job_pauses`),
  sql(`select c.id, c.job_id, c.kind, c.portal, c.number, c.portal_status, c.ops_status, c.ball_with, c.tracked_by, c.requested_at, c.applied_at, c.issued_at, c.finaled_at, mq.stage from ops.permit_cases c left join ops.monitoring_queue mq on mq.permit_case_id=c.id`),
  sql(`select permit_case_id, round, type, status, submitted_at, due_at, completed_at from ops.submittals order by round`),
  sql(`select permit_case_id, round, department, status, failed, reviewer, due_at, completed_at, comments from ops.review_items order by round, department`),
  sql(`select permit_case_id, number, type, status, passed, failed, coalesce(actual_at, scheduled_at, requested_at) at, inspector, comments from ops.inspections order by 4`),
  sql(`select permit_case_id, name, type, blocking, active, created_at, comments from ops.holds`),
]);

// --- fold duplicate S jobs into their originals (same parcel or address)
const byKey = new Map();
for (const j of jobs.filter((j) => !/^S/.test(j.job_number))) { if (j.parcel) byKey.set('p' + j.parcel, j); byKey.set('a' + norm(j.address), j); }
const canon = new Map(); // job id -> canonical job
for (const j of jobs) canon.set(j.id, /^S/.test(j.job_number) ? (byKey.get('p' + j.parcel) || byKey.get('a' + norm(j.address)) || j) : j);
const keep = jobs.filter((j) => canon.get(j.id) === j);

const BTF = new URL('../data/buildertrend/job_fields.json', import.meta.url);
const btf = existsSync(BTF) ? JSON.parse(readFileSync(BTF, 'utf8')) : { jobs: [] };
const BT = new Map((btf.jobs || btf).map((r) => [String(r.jobId), r]));
const J = new Map(keep.map((j) => [j.id, {
  bt: BT.get(String(j.bt_job_id)) || null,
  job_number: j.job_number, company: j.company, status: j.status, address: j.address, parcel: j.parcel, county: j.county, model: j.model,
  owner: j.owner_name, signed_at: d(j.signed_at), second_draw_at: d(j.second_draw_at), turtle_state: j.turtle_state, note: j.note, co_at: d(j.co_at),
  supervisor: null, pms: [], pauses: [], permits: [],
}]));
for (const c of contacts) { const x = J.get(canon.get(c.job_id)?.id); if (!x) continue; if (c.role === 'supervisor') x.supervisor = c.name; else if (c.role === 'pm') x.pms.push(c.name); }
const seenPause = new Set();
for (const p of pauses) {
  const x = J.get(canon.get(p.job_id)?.id); if (!x) continue;
  const k = x.job_number + p.reason + (p.ended_at ? 'e' : 'o'); if (seenPause.has(k)) continue; seenPause.add(k);
  x.pauses.push({ reason: p.reason, since: d(p.started_at), ended: d(p.ended_at), note: p.note });
}
const C = new Map();
for (const c of cases) {
  const x = J.get(canon.get(c.job_id)?.id); if (!x) continue;
  const pc = { kind: c.kind, portal: c.portal, number: c.number, portal_status: c.portal_status, ops_status: c.ops_status, stage: c.stage, ball_with: c.ball_with, tracked_by: c.tracked_by,
    requested_at: d(c.requested_at), applied_at: d(c.applied_at), issued_at: d(c.issued_at), finaled_at: d(c.finaled_at), rounds: [], inspections: [], holds: [] };
  x.permits.push(pc); C.set(c.id, pc);
}
for (const s of subs) { const pc = C.get(s.permit_case_id); if (pc) pc.rounds.push({ round: s.round, type: s.type, status: s.status, submitted_at: d(s.submitted_at), due_at: d(s.due_at), completed_at: d(s.completed_at), reviews: [] }); }
for (const r of revs) {
  const pc = C.get(r.permit_case_id); if (!pc) continue;
  let rd = pc.rounds.find((x) => x.round === r.round);
  if (!rd) { rd = { round: r.round, reviews: [] }; pc.rounds.push(rd); }
  rd.reviews.push({ department: short(r.department), status: r.status, failed: r.failed, reviewer: r.reviewer, due_at: d(r.due_at), completed_at: d(r.completed_at), comments: r.comments || null });
}
for (const pc of C.values()) pc.rounds.sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
for (const i of insps) { const pc = C.get(i.permit_case_id); if (pc) pc.inspections.push({ type: short(i.type), status: i.status, passed: i.passed, failed: i.failed, at: d(i.at), inspector: i.inspector, comments: i.comments || undefined }); }
for (const h of holds) { const pc = C.get(h.permit_case_id); if (pc) pc.holds.push({ name: h.name, type: h.type, blocking: h.blocking, active: h.active, since: d(h.created_at), comments: h.comments }); }

// --- row summary per job (building permit drives the stage)
const rows = [];
const files = {};
for (const [xid, x] of J) {
  // drop placeholder septic cases copied from a duplicate S job
  if (x.permits.filter((p) => p.kind === 'septic').length > 1) x.permits = x.permits.filter((p) => !(p.kind === 'septic' && /^SEPTIC-S/.test(p.number || '')));
  x.permits.sort((a, b) => (a.kind === 'building' ? -1 : 1) - (b.kind === 'building' ? -1 : 1) || String(a.applied_at).localeCompare(String(b.applied_at)));
  const b = x.permits.find((p) => p.kind === 'building');
  const p = prog.jobs[x.job_number];
  if (p?.supported) x.progress = p;
  const fails = b ? b.inspections.filter((i) => i.failed) : [];
  const passed = b ? b.inspections.filter((i) => i.passed).sort((a, c) => String(c.at).localeCompare(String(a.at))) : [];
  const lastRound = b?.rounds.at(-1);
  const openCorr = lastRound?.reviews.filter((r) => r.failed) || [];
  // 2nd invoice paid: earliest Buildertrend "paid" e-mail for the 2nd Installment of this job.
  const paid2 = mail.filter((m) => m.job_number === x.job_number && m.category === 'bt_invoice_paid' && /2nd\s+installment/i.test(m.parsed?.title || '')).map((m) => d(m.received_at)).sort()[0] || null;
  const ck = b ? clock({ second_invoice_paid_at: paid2, status: x.status, bt_closed: x.bt ? x.bt.status !== 1 : false, bt_actual_start: x.bt?.actualStart, bt_actual_completion: x.bt?.actualCompletion, issued_at: b.issued_at, co_at: x.co_at, second_draw_at: x.second_draw_at, pauses: x.pauses, inspections: b.inspections }) : { phase: 'no_permit' };
  x.clock = ck;
  x.mail = mail.filter((m) => m.job_number === x.job_number && m.category.startsWith('bt_invoice')).filter((m, i, a) => a.findIndex((o) => (o.parsed?.invoice_id || o.parsed?.title) === (m.parsed?.invoice_id || m.parsed?.title)) === i).slice(0, 12).map((m) => ({ at: d(m.received_at), paid: m.category === 'bt_invoice_paid', title: m.parsed?.title, amount: m.parsed?.invoice_amount ?? m.parsed?.amount, status: m.parsed?.status }));
  const pj = jobs.filter((o) => canon.get(o.id)?.id === xid && o.photos_last_at).sort((m, n) => String(n.photos_last_at).localeCompare(String(m.photos_last_at)))[0];
  const ts = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : null);
  x.photos = pj ? { last_upload: ts(pj.photos_last_at), by: pj.photos_last_by, folder: pj.photos_last_folder, daily_log: ts(pj.photos_last_daily_log), total_site_photos: pj.photos_count } : null;
  rows.push({
    photos_last_at: x.photos?.last_upload?.slice(0, 10) || null, photos_last_by: x.photos?.by || null, photos_total: x.photos?.total_site_photos ?? null,
    last_daily_log: d(mail.find((m) => m.job_number === x.job_number && m.category === 'bt_daily_log')?.received_at),
    clock_phase: ck.phase, build_start: ck.start || null, build_start_src: ck.startSource || null, build_days: ck.buildDays ?? null,
    finished_at: ck.finishedAt || null, finish_src: ck.finishSource || null, days_awaiting_co: ck.daysAwaitingCO ?? null,
    wait_to_start: ck.waitToStart ?? null, waiting_days: ck.waitingDays ?? null, wait_excuse: ck.excuse || null,
    job_number: x.job_number, company: x.company, address: x.address, county: x.county, model: x.model, status: x.status, supervisor: x.supervisor, signed_at: x.signed_at,
    turtle: x.turtle_state !== 'none' ? x.turtle_state : null, pause: x.pauses.find((q) => !q.ended)?.reason || null,
    permit: b?.number || null, portal: b?.portal || null, stage: b?.stage || 'pre', ops_status: b?.ops_status || null,
    applied_at: b?.applied_at || null, issued_at: b?.issued_at || null, rounds: b?.rounds.length || 0,
    failed_depts_last_round: openCorr.map((r) => r.department), last_round_at: lastRound?.completed_at || lastRound?.submitted_at || null,
    reviews_collected: !!b?.rounds.some((r) => r.reviews.length),
    active_holds: b ? b.holds.filter((h) => h.active && h.blocking).length : 0,
    inspections: b?.inspections.length || 0, failed_inspections: fails.length,
    last_passed: passed[0] ? `${passed[0].type} (${passed[0].at})` : null,
    insp_progress: p?.supported ? `${p.passed}/${p.required}` : null, insp_pct: p?.supported ? p.percent : null,
    insp_next: p?.supported ? p.next : null, insp_failed_open: p?.supported ? p.failedOpen.map((f) => f.name) : [],
    ready_for_finals_est: p?.supported ? p.readyForFinalsEstimate : null,
  });
  files[x.job_number] = x;
}
rows.sort((a, b) => a.job_number.localeCompare(b.job_number));

// --- aggregates
const pkb = rows.filter((r) => r.company === 'PKB');
const month = (s) => s?.slice(0, 7);
const count = (arr, f) => arr.reduce((m, r) => { const k = f(r); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
const signed = count(pkb, (r) => (r.signed_at >= '2025-10' ? month(r.signed_at) : null));
const FAIL_SINCE = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
const recentFails = [];
for (const x of Object.values(files)) for (const pc of x.permits) for (const i of pc.inspections) if (i.failed && i.at >= FAIL_SINCE) recentFails.push({ job_number: x.job_number, address: x.address, type: i.type, status: i.status, at: i.at, inspector: i.inspector, comments: i.comments || null });
recentFails.sort((a, b) => b.at.localeCompare(a.at));
const agg = {
  dept: await sql(`select department, count(*)::int reviews, count(*) filter (where failed)::int failures, count(distinct permit_case_id) filter (where failed)::int permits from ops.review_items group by 1 having count(*) filter (where failed) > 0 order by 3 desc limit 7`),
  insp: await sql(`select type, count(*)::int total, count(*) filter (where failed)::int failed from ops.inspections where status !~* 'cancel|scheduled|pending' group by 1 having count(*) >= 3 order by 3 desc, 2 desc limit 8`),
  cycle: await sql(`select j.county, count(*)::int n, percentile_cont(0.5) within group (order by c.issued_at - c.applied_at)::int median_days from ops.permit_cases c join ops.jobs j on j.id=c.job_id where c.kind='building' and c.issued_at >= c.applied_at group by 1 order by 2 desc`),
  rounds: (await sql(`with s as (select permit_case_id, completed_at, submitted_at, lead(submitted_at) over (partition by permit_case_id order by round) nx from ops.submittals) select coalesce(sum(completed_at - submitted_at) filter (where completed_at is not null),0)::int county_days, coalesce(sum(nx - completed_at) filter (where nx is not null and completed_at is not null),0)::int resubmit_days from s`))[0],
  monthly: await sql(`select to_char(issued_at,'YYYY-MM') m, count(*)::int n from ops.permit_cases where kind='building' and issued_at >= '2025-10-01' group by 1 order by 1`),
  signed: Object.entries(signed).sort().map(([m, n]) => ({ m, n })),
  requests: await sql(`select to_char(received_at,'YYYY-MM') m, count(*)::int n from ops.inbound_emails where category = 'work_request' group by 1 order by 1`),
  workRequests: (await sql(`select received_at::date d, parsed from ops.inbound_emails where category = 'work_request' order by received_at desc limit 20`)).map((r) => ({ at: d(r.d), ...r.parsed })),
  suggestions: await sql(`select key, area, impact, title, detail, evidence, status, created_at::date created from ops.suggestions order by case impact when 'high' then 0 when 'medium' then 1 else 2 end, created_at`),
  inbox: await sql(`select category, count(*)::int n, max(received_at)::date last from ops.inbound_emails group by 1 order by 2 desc`),
};
agg.dept = agg.dept.map((r) => ({ ...r, department: short(r.department) }));
agg.insp = agg.insp.map((r) => ({ ...r, type: short(r.type) }));

const geo = JSON.parse(readFileSync(new URL('../config/job_geo.json', import.meta.url), 'utf8'));
const LL = new Map(keep.filter((j) => j.latitude != null).map((j) => [j.job_number, [j.latitude, j.longitude]]));
for (const r of rows) r.ll = LL.get(r.job_number) || geo[r.job_number]?.ll || null;
agg.clock = summarize(rows.filter((r) => r.company === 'PKB' && r.clock_phase !== 'no_permit').map((r) => files[r.job_number].clock));
// People the Ask assistant may address (e-mail, Buildertrend name, role).
const CT = JSON.parse(readFileSync(new URL('../config/contacts.json', import.meta.url), 'utf8'));
const I = CT.internal, dirMap = new Map();
const addP = (p, role) => { if (!p?.name) return; const k = (p.email || p.name).toLowerCase(); const o = dirMap.get(k); if (o) { o.role += `, ${role}`; o.bt_name ||= p.bt_name || null; o.email ||= p.email || null; } else dirMap.set(k, { name: p.name, email: p.email || null, bt_name: p.bt_name || null, role }); };
for (const p of I.partners || []) addP(p, p.role === 'admin' ? 'partner (admin)' : 'partner');
addP(I.director, 'director'); addP(I.permits_owner, 'permits (Guilherme)'); addP(I.contractor_of_record, 'contractor of record');
for (const p of I.supervisors || []) addP(p, 'supervisor');
for (const p of I.project_managers || []) addP(p, 'project manager');
for (const [k, d] of Object.entries(CT.designers || {})) for (const p of d.people || []) addP(p, `${d.company || k} (${d.role || 'designer'})`);
for (const [k, v] of Object.entries(CT.vendors || {})) { if (v.people?.length) for (const p of v.people) addP(p, `${v.company || k} (${v.role || 'vendor'})`); else for (const e of v.to || []) addP({ name: v.company || k, email: e }, v.role || 'vendor'); }
agg.directory = [...dirMap.values()];
const out = { asOf: new Date().toISOString().slice(0, 10), builtAt: new Date().toISOString(), jobs: rows, fails: recentFails.slice(0, 14), ...agg, files };
const json = JSON.stringify(out);
const o = process.argv.indexOf('--out');
if (o > 0) writeFileSync(process.argv[o + 1], json);
if (!process.argv.includes('--no-store')) {
  const org = keep[0]?.org_id;
  const tag = '$snap' + Math.random().toString(36).slice(2, 8) + '$';
  await sql(`insert into ops.snapshots (org_id, kind, data) values ('${org}', 'board', ${tag}${json}${tag}::jsonb)`);
  await sql(`delete from ops.snapshots where kind = 'board' and created_at < now() - interval '14 days'`);
}
console.log(`board snapshot: ${rows.length} jobs · ${pkb.length} PKB · ${(json.length / 1024).toFixed(0)} KB${process.argv.includes('--no-store') ? ' · not stored' : ' · stored'}`);
