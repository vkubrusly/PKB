#!/usr/bin/env node
// =============================================================================
// bt_warranty.mjs — Buildertrend Warranty claims for ops.warranty_claims (Victor, 2026-11-02: "pode sim").
// 1. Create: each item without a Buildertrend claim, on a house with a Buildertrend job, becomes one claim
//    (POST /api/Warranty?jobId=…, the call the "New claim" form makes) — title "<Category> — <Location>",
//    the homeowner's text as description, name/phone/e-mail in the internal comments, class "Needs
//    Inspection", priority High when the text says the house lost power / sparks / smoke / gas / a pipe
//    leak or flood, Medium otherwise. Up to 5 attempts; the error is kept on the row.
// 2. Follow: every claim's status from the job's Warranty list (POST /api/Warranty/Grid, a read). A class
//    "(closed)" = resolved (Service Completed / Meets Warranty Standards) or closed (Non-Warranty).
// Writes only with OPS_BT_POST=true or --post; otherwise lists what it would create. Never edits or
// deletes a claim.
//   BT_COOKIES_FILE=… node rules/bt_warranty.mjs [--post]
// =============================================================================
import { sql, q, orgId } from './lib.mjs';
import { openBuildertrend } from '../collectors/buildertrend/session.mjs';

const POST = process.env.OPS_BT_POST === 'true' || process.argv.includes('--post');
const org = await orgId();
const todo = await sql(`select w.*, j.job_number, j.bt_job_id from ops.warranty_claims w join ops.jobs j on j.id = w.job_id
  where w.org_id = ${q(org)} and w.bt_claim_id is null and w.bt_attempts < 5 and j.bt_job_id is not null order by w.received_at, w.item_no`);
const open = await sql(`select w.id, w.bt_claim_id, w.status, w.resolved_at, j.bt_job_id, j.job_number from ops.warranty_claims w join ops.jobs j on j.id = w.job_id
  where w.org_id = ${q(org)} and w.bt_claim_id is not null and w.status not in ('resolved', 'closed')`);
if (!todo.length && !open.length) { console.log('warranty: nothing to create or follow'); process.exit(0); }

// Website form category → Buildertrend Warranty category (names as Buildertrend lists them).
const CATEGORY = [[/electric/i, 'Electrical'], [/plumb|water heater|toilet|faucet/i, 'Plumbing'], [/hvac|a\/c|\bac\b|air cond|heat/i, 'HVAC'],
  [/roof/i, 'Roofing'], [/window/i, 'Windows'], [/floor|tile/i, 'Flooring'], [/paint/i, 'Painting'], [/drywall/i, 'Drywall'],
  [/cabinet/i, 'Cabinets'], [/counter/i, 'Countertops'], [/applian/i, 'Appliances'], [/light/i, 'Lighting'], [/concrete|driveway/i, 'Concrete'],
  [/foundation/i, 'Foundation'], [/landscap|sod|irrigation/i, 'Landscaping'], [/trim/i, 'Trim'], [/siding/i, 'Siding'], [/framing/i, 'Framing']];
const URGENT = /no (electric|power)|without (electric|power)|short(ed)? out|spark|smoke|burn|gas (smell|leak)|pipe leak|leaking pipe|flood/i;
const cap = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const opt = (field, name) => (field?.value || []).find((o) => o.name === name);

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('Buildertrend session expired — nothing done'); await browser.close(); process.exit(0); }
let hdr = null;
page.on('request', (r) => { if (!hdr && /buildertrend\.net\/api\//.test(r.url())) hdr = r.headers(); });
await page.goto('https://buildertrend.net/app/Warranties', { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 60 && !hdr; i++) await page.waitForTimeout(500);
const headers = { ...Object.fromEntries(Object.entries(hdr || {}).filter(([k]) => !/^(content-length|cookie|host|:)/i.test(k))), 'content-type': 'application/json' };
const api = async (method, url, body) => {
  const res = await page.request.fetch(`https://buildertrend.net${url}`, { method, headers, data: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { ok: res.ok() && json?.success !== false, status: res.status(), json, text };
};
const grid = async (jobId) => (await api('POST', '/api/Warranty/Grid', { gridRequest: { hasFooter: true }, pagingData: { pageNumber: 1, pageSize: 200 }, filters: '{}', jobIds: [Number(jobId)] })).json?.data?.data || [];
const rowId = (r) => Number(r.id ?? r.warrantyId ?? r.warrantyLink?.id ?? r.warrantyLink?.warrantyId) || null;
const rowTitle = (r) => String(r.warrantyLink?.title ?? r.warrantyLink?.text ?? r.warrantyLink ?? r.title ?? '');

let created = 0, failed = 0;
for (const w of todo) {
  const title = `${cap(w.category) || 'Warranty'}${w.location ? ` — ${cap(w.location)}` : ''}`.slice(0, 50);
  const label = `${w.job_number} · ${title} (${w.homeowner || '—'})`;
  try {
    // Already there (an earlier attempt that answered with an error but created it)? Same title on the job.
    const dup = (await grid(w.bt_job_id)).find((r) => rowTitle(r).trim() === title);
    if (dup && rowId(dup)) {
      await sql(`update ops.warranty_claims set bt_claim_id = ${rowId(dup)}, bt_created_at = coalesce(bt_created_at, now()), bt_error = null, updated_at = now() where id = ${q(w.id)}`);
      console.log(`FOUND ${label} → claim ${rowId(dup)}`); continue;
    }
    const def = (await api('GET', `/api/Warranty/DefaultInfo?jobId=${w.bt_job_id}`)).json?.data;
    if (!def) throw new Error('DefaultInfo not available');
    const catName = (CATEGORY.find(([re]) => re.test(w.category || '')) || [null, 'Other'])[1];
    const category = opt(def.category, catName) || opt(def.category, 'Other');
    const priority = opt(def.priority, URGENT.test(w.description || '') ? 'High' : 'Medium');
    const classification = opt(def.classification, 'Needs Inspection');
    const comments = [`Warranty request from the website form, received ${new Date(w.received_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}.`,
      `Homeowner: ${w.homeowner || '—'} · phone ${w.phone || '—'}${w.email ? ` · ${w.email}` : ''}`, `Address: ${w.address || '—'}`,
      w.purchase_date ? `Purchase date: ${new Date(w.purchase_date + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC' })}` : null,
      `Item ${w.item_no}: ${w.category || '—'} — ${w.location || '—'}`, '(created by PKB Ops)'].filter(Boolean).join('\n');
    const body = { jobId: Number(w.bt_job_id), title, priority: priority?.id ?? 1, category: category?.id ?? -1, classification: classification?.id ?? 70,
      problemDescription: String(w.description || '').slice(0, 4000), internalComments: comments.slice(0, 4000), showOwner: true,
      completedByDate: null, followUpDate: null, addedCost: 0, claimId: '', customFields: [], warrantyServices: [] };
    if (!POST) { console.log(`[dry run] ${label} · ${catName} · ${priority?.name} · ${classification?.name}`); continue; }
    const res = await api('POST', `/api/Warranty?jobId=${w.bt_job_id}`, body);
    console.log(`create ${label}: HTTP ${res.status} ${res.text.slice(0, 600)}`);
    let id = Number(res.json?.data?.id ?? res.json?.data?.warrantyId ?? res.json?.data) || null;
    // Confirm by reading the job's list back.
    const back = (await grid(w.bt_job_id)).find((r) => (id && rowId(r) === id) || rowTitle(r).trim() === title);
    if (!back) throw new Error(res.ok ? 'Buildertrend answered OK but the claim is not in the job\'s Warranty list' : `HTTP ${res.status} ${res.json?.message || res.text.slice(0, 200)}`);
    id = id || rowId(back);
    await sql(`update ops.warranty_claims set bt_claim_id = ${id ?? 'null'}, bt_status = ${q(back.claimStatus || null)}, bt_created_at = now(), bt_error = null, bt_attempts = bt_attempts + 1, last_synced_at = now(), updated_at = now() where id = ${q(w.id)}`);
    await sql(`insert into ops.events (org_id, job_id, kind, source, occurred_at, payload, dedupe_key)
      values (${q(org)}, ${q(w.job_id)}, 'bt.warranty_created', 'rule', now(), ${q(JSON.stringify({ claim_id: id, title, item: w.item_no, homeowner: w.homeowner }))}::jsonb, ${q(`bt.warranty_created:${w.id}`)})
      on conflict (org_id, dedupe_key) do nothing`);
    created++; console.log(`CREATED ${label} → claim ${id}`);
  } catch (e) {
    failed++; console.error(`FAILED ${label}: ${e.message}`);
    if (POST) await sql(`update ops.warranty_claims set bt_error = ${q(e.message.slice(0, 500))}, bt_attempts = bt_attempts + 1, updated_at = now() where id = ${q(w.id)}`);
  }
}

// Follow every open claim: status / class from the job's Warranty list.
let resolved = 0;
const byJob = Object.groupBy(await sql(`select w.id, w.bt_claim_id, w.status, j.bt_job_id from ops.warranty_claims w join ops.jobs j on j.id = w.job_id
  where w.org_id = ${q(org)} and w.bt_claim_id is not null and w.status not in ('resolved', 'closed')`), (w) => w.bt_job_id);
for (const [jobId, claims] of Object.entries(byJob)) {
  const rows = await grid(jobId);
  for (const w of claims) {
    const r = rows.find((x) => rowId(x) === Number(w.bt_claim_id));
    if (!r) continue;
    const cls = String(r.class ?? r.classification ?? ''), st = String(r.claimStatus ?? '');
    const status = /non-warranty/i.test(cls) ? 'closed' : /\(closed\)|service completed|meets warranty/i.test(cls) ? 'resolved'
      : (Array.isArray(r.warrantyScheduleList) ? r.warrantyScheduleList.length : r.warrantyScheduleList) ? 'scheduled' : 'open';
    if (status === 'resolved' || status === 'closed') resolved++;
    await sql(`update ops.warranty_claims set bt_status = ${q([st, cls].filter(Boolean).join(' · ') || null)}, status = ${q(status)},
      scheduled_at = case when ${q(status)} = 'scheduled' then coalesce(scheduled_at, now()) else scheduled_at end,
      resolved_at = case when ${q(status)} in ('resolved', 'closed') then coalesce(resolved_at, now()) else resolved_at end,
      last_synced_at = now(), updated_at = now() where id = ${q(w.id)}`);
  }
}
console.log(`warranty: ${created} created · ${failed} failed · ${resolved} resolved/closed now${POST ? '' : ' · dry run'}`);
await browser.close();
process.exit(failed && !created ? 1 : 0);
