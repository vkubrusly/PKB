#!/usr/bin/env node
// =============================================================================
// vendor_invoices.mjs — vendor invoices sent to invoice@pkbhomes.com (forwarded to the bot mailbox) → one
// Buildertrend bill per job (Victor, 2026-11-19).
//   1. Each file of a 'vendor_invoice' e-mail (collect_mail.py stores them in Storage) becomes an
//      ops.vendor_invoices row; the Edge Function ops-invoice reads it (vendor, number, dates, total, the amount
//      of each site / address, invoice-wide fees). Signatures, W-9s, photos… come back as not an invoice.
//   2. Split: each job gets exactly the amount the invoice shows for its address; invoice-wide fees are split
//      proportionally to those amounts, in cents, so the bills add up to the total exactly.
//   3. Checks: every address on one job (with a Buildertrend job), the sum = the invoice total, not already
//      received (same vendor + number). Anything that does not close → 'needs_review' and an e-mail to Camila,
//      Cc Victor, with the file attached; they answer by e-mail. Otherwise 'ready' for rules/bt_bills.mjs.
// Writes nothing to Buildertrend.
//   node rules/vendor_invoices.mjs [--dry-run]
//   node rules/vendor_invoices.mjs --file invoice.pdf      (read and split a local file, print it, store nothing)
// =============================================================================
import { readFileSync } from 'node:fs';
import { sql, q, DRY, orgId, usDate } from './lib.mjs';
import { serviceKey, downloadObject } from '../scripts/sb.mjs';
import { sendEmail } from '../notify/email.mjs';

// Cost code of a vendor's bills: config/vendor_bills.json, else the one given in an earlier answer for this vendor.
const INVOICE_WORDS = /invoice|\binv[\s#-]?\d|\bbill\b|payment request|fatura|statement/i;
const BILLS_CFG = JSON.parse(readFileSync(new URL('../config/vendor_bills.json', import.meta.url), 'utf8'));
export async function vendorCostCode(org, vendor) {
  const c = BILLS_CFG.cost_codes[String(vendor || '').toLowerCase()];
  if (c) return c;
  const r = await sql(`select cost_code from ops.vendor_invoices where org_id = ${q(org)} and lower(vendor) = lower(${q(vendor)}) and cost_code is not null order by answered_at desc nulls last limit 1`);
  return r[0]?.cost_code || null;
}

const REF = process.env.SUPABASE_PROJECT_REF || 'fvjknahpmihueyeasgbx';
const BUCKET = 'ops-invoices';
const REVIEW_TO = ['camila@pkbhomes.com'], REVIEW_CC = ['victor@pkbhomes.com'];   // Victor, 11/19
const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const cents = (n) => Math.round(Number(n) * 100);
const MEDIA = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const mediaOf = (name) => MEDIA[String(name).toLowerCase().split('.').pop()] || null;

// House number + first word of the street ("6265 SW 155th St Rd" ~ "6265 SW 155th St").
const addrKey = (a) => { const m = /^\s*(\d+)\s+(?:(?:N|S|E|W|NE|NW|SE|SW)\.?\s+)?(\w+)/i.exec(String(a || '')); return m ? `${m[1]} ${m[2].toLowerCase().replace(/(st|nd|rd|th)$/, '')}` : null; };

// Keys a site is known by: its parcel (digits), house number + street word, the address as written.
const digits = (x) => String(x || '').replace(/\D/g, '');
const parcelOf = (s) => { const d = digits(s?.parcel || (/\b\d{2,5}[A-Z]?(?:-[0-9A-Z]{2,5}){2,5}\b/i.exec(`${s?.address || ''} ${s?.label || ''}`) || [])[0]); return d.length >= 8 ? d : null; };
export const siteKeys = (s) => [parcelOf(s), addrKey(s?.address), String(s?.address || '').trim().toLowerCase() || null].filter(Boolean);

// What the team taught (Victor, 11/23/26: "vai levando para o aprendizado para não ter que perguntar novamente").
async function loadLearned(vendor) {
  const [map, btJobs, lessons] = await Promise.all([
    sql(`select addr_key, job_number, bt_job_id, general from ops.invoice_address_map`),
    sql(`select bt_job_id, name, job_number, street, parcel from ops.bt_jobs`).catch(() => []),
    sql(`select vendor, lesson from ops.invoice_lessons where active order by created_at`),
  ]);
  const v = String(vendor || '').toLowerCase();
  return { map, btJobs, lessons: lessons.filter((l) => !v || !l.vendor || v.includes(l.vendor.toLowerCase().split(/\s+/)[0])).map((l) => (l.vendor ? `${l.vendor}: ${l.lesson}` : l.lesson)) };
}
// Remember where a line went (an answer, or Victor in chat): next time that address/lot needs no question.
async function remember(line, { job_number = null, bt_job_id = null, general = false }, source) {
  const keys = siteKeys(line).filter((k) => k !== String(line.address || '').trim().toLowerCase() || !addrKey(line.address));
  for (const k of keys) await sql(`insert into ops.invoice_address_map (addr_key, address, job_number, bt_job_id, general, source)
    values (${q(k)}, ${q(line.address)}, ${q(job_number)}, ${bt_job_id ?? 'null'}, ${general}, ${q(source)})
    on conflict (addr_key) do update set job_number = excluded.job_number, bt_job_id = excluded.bt_job_id, general = excluded.general, source = excluded.source, created_at = now()`);
}

async function readInvoice(buf, fileName, extra = {}) {
  const media = mediaOf(fileName);
  if (!media) return { error: `arquivo .${String(fileName).split('.').pop()} ainda não é lido automaticamente` };
  const key = await serviceKey();
  const r = await fetch(`https://${REF}.supabase.co/functions/v1/ops-invoice`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}`, apikey: key },
    body: JSON.stringify({ file_base64: buf.toString('base64'), media_type: media, file_name: fileName, ...extra }),
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return r.ok ? j : { error: j.error || `HTTP ${r.status}` };
}

// Split by job and check. jobs: [{id, job_number, address, parcel, bt_job_id}]; learned: loadLearned().
// A site is placed, in order, by: what the team said before for that address/lot → house number + street in the
// houses → parcel in the houses → parcel / street of any Buildertrend job (a lot not yet in the houses list).
export function allocate(x, jobs, learned = {}) {
  const issues = [];
  const byKey = new Map(), byParcel = new Map(), btByParcel = new Map(), btByKey = new Map();
  const push = (m, k, v) => { if (k) (m.get(k) || m.set(k, []).get(k)).push(v); };
  for (const j of jobs) { push(byKey, addrKey(j.address), j); const d = digits(j.parcel); if (d.length >= 8) push(byParcel, d, j); }
  for (const b of learned.btJobs || []) { const d = digits(b.parcel); if (d.length >= 8) push(btByParcel, d, b); push(btByKey, addrKey(b.street), b); }
  const fromBt = (b) => { const j = jobs.find((y) => String(y.bt_job_id) === String(b.bt_job_id)); return { id: j?.id || null, job_number: j?.job_number || b.job_number || null, bt_job_id: b.bt_job_id }; };
  const one = (hits) => { const withBt = hits.filter((j) => j.bt_job_id); return withBt.length === 1 ? withBt[0] : hits.length === 1 ? hits[0] : null; };
  const lines = (x.sites || []).map((s) => {
    const base = { label: s.label, address: s.address || (s.parcel ? `parcel ${s.parcel}` : null), parcel: s.parcel || null, amount: Number(s.amount), job_id: null, job_number: null, bt_job_id: null, general: false, matched_by: null };
    const keys = siteKeys(s);
    const m = (learned.map || []).find((r) => keys.includes(r.addr_key));
    if (m?.general) return { ...base, general: true, matched_by: 'aprendido (geral)' };
    if (m) {
      const j = jobs.find((y) => y.job_number === m.job_number);
      const bt = m.bt_job_id || j?.bt_job_id;
      if (bt) return { ...base, job_id: j?.id || null, job_number: m.job_number || j?.job_number || null, bt_job_id: bt, matched_by: 'aprendido' };
    }
    const hits = byKey.get(addrKey(s.address)) || [];
    let pick = one(hits), by = 'endereço';
    const par = parcelOf(s);
    if (!pick && par) { pick = one(byParcel.get(par) || []); by = 'parcel'; }
    if (!pick && par && (btByParcel.get(par) || []).length === 1) { pick = fromBt(btByParcel.get(par)[0]); by = 'parcel (Buildertrend)'; }
    if (!pick && !hits.length && (btByKey.get(addrKey(s.address)) || []).length === 1) { pick = fromBt(btByKey.get(addrKey(s.address))[0]); by = 'endereço (Buildertrend)'; }
    if (!pick) issues.push(hits.length > 1 ? `${s.address || s.label}: corresponde a mais de uma obra (${hits.map((h) => h.job_number).join(', ')})` : `${base.address || s.label}: nenhuma obra no sistema nem no Buildertrend com este endereço${par ? ' / parcel' : ''}`);
    else if (!pick.bt_job_id) issues.push(`${s.address}: a obra ${pick.job_number} não tem job no Buildertrend`);
    return { ...base, job_id: pick?.id || null, job_number: pick?.job_number || null, bt_job_id: pick?.bt_job_id || null, matched_by: pick ? by : null };
  });
  // Invoice-wide fees: proportional to each site's amount, in cents, the remainder to the largest shares.
  const fees = (x.invoice_fees || []).reduce((t, f) => t + cents(f.amount), 0);
  const base = lines.reduce((t, l) => t + cents(l.amount), 0);
  if (fees && base) {
    const exact = lines.map((l) => (fees * cents(l.amount)) / base);
    const floor = exact.map(Math.floor); let rest = fees - floor.reduce((a, b) => a + b, 0);
    exact.map((e, i) => [e - floor[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest > 0) { floor[i]++; rest--; } });
    lines.forEach((l, i) => { l.fee_share = floor[i] / 100; });
  } else lines.forEach((l) => { l.fee_share = 0; });
  lines.forEach((l) => { l.bill_amount = (cents(l.amount) + cents(l.fee_share)) / 100; });
  if (!lines.length) issues.push('nenhuma obra / endereço encontrado na invoice');
  if (x.total == null) issues.push('total da invoice não encontrado');
  else {
    const sum = lines.reduce((t, l) => t + cents(l.bill_amount), 0);
    if (sum !== cents(x.total)) issues.push(`a soma das obras dá ${money(sum / 100)}, mas o total da invoice é ${money(x.total)}${fees && !base ? ' (taxas sem obra para dividir)' : ''}`);
  }
  if (!x.vendor) issues.push('fornecedor (Pay to) não encontrado');
  if (!x.invoice_number) issues.push('número da invoice não encontrado');
  if (x.notes) issues.push(`observação da leitura: ${x.notes}`);
  return { lines, issues, fees: fees / 100 };
}

if (process.argv[1]?.endsWith('vendor_invoices.mjs')) await main();

async function main() {
const jobs = await sql(`select id, job_number, address, parcel, bt_job_id from ops.jobs`);
const learnedAll = await loadLearned(null);

// Local test: read and split a file, store nothing.
const fi = process.argv.indexOf('--file');
if (fi > 0) {
  const f = process.argv[fi + 1];
  const x = await readInvoice(readFileSync(f), f.split('/').pop(), { lessons: learnedAll.lessons });
  if (x.error) { console.error(x.error); process.exit(1); }
  const a = allocate(x, jobs, learnedAll);
  console.log(`${x.is_invoice ? 'INVOICE' : 'NOT AN INVOICE'} · ${x.vendor} #${x.invoice_number} · ${x.invoice_date} → due ${x.due_date} · total ${money(x.total)} · fees ${money(a.fees)}`);
  for (const l of a.lines) console.log(`  ${(l.job_number || '????').padEnd(5)} ${money(l.bill_amount).padStart(10)}  (site ${money(l.amount)} + fee ${money(l.fee_share)})  ${l.label || ''} ${l.address || ''}`);
  console.log(a.issues.length ? `PENDÊNCIAS:\n- ${a.issues.join('\n- ')}` : 'checks: OK — ready to create the bills');
  process.exit(0);
}

const org = await orgId();
// 1. New files of vendor-invoice e-mails → rows.
const mails = await sql(`select e.id, e.received_at, e.from_addr, e.subject, e.parsed from ops.inbound_emails e
  where e.org_id = ${q(org)} and e.category = 'vendor_invoice' and e.received_at > now() - interval '60 days'`);
for (const m of mails) {
  const files = m.parsed?.files || [];
  if (!files.length) {
    if (DRY) { console.log(`[dry run] e-mail without a file: ${m.subject}`); continue; }
    const subj = String(m.subject || '').replace(/^\s*(fw|fwd|re)\s*:\s*/gi, '');
    const num = (/invoice\s*(?:#|no\.?|number)?\s*([A-Z]{0,4}[-#]?\d[\w-]*)/i.exec(subj) || [])[1] || null;
    const ven = ((/\bfrom\s+(.+?)\s*$/i.exec(subj) || [])[1] || '').trim() || null;
    const looks = INVOICE_WORDS.test(subj);
    await sql(`insert into ops.vendor_invoices (org_id, inbound_email_id, file_path, file_name, received_at, email_from, email_subject, status, is_invoice, vendor, invoice_number, issues)
      values (${q(org)}, ${q(m.id)}, '(no file)', null, ${q(m.received_at)}, ${q(m.from_addr)}, ${q(m.subject)}, ${q(looks ? 'needs_review' : 'not_invoice')}, ${looks ? 'true' : 'false'}, ${q(ven)}, ${q(num)},
        array[${q(`o e-mail não tem arquivo de invoice${(m.parsed?.links || []).length ? `; links no e-mail: ${m.parsed.links.slice(0, 5).join(' ')}` : ''}`)}])
      on conflict (inbound_email_id, file_path) do nothing`);
    continue;
  }
  for (const f of files) if (!DRY) await sql(`insert into ops.vendor_invoices (org_id, inbound_email_id, file_path, file_name, received_at, email_from, email_subject)
    values (${q(org)}, ${q(m.id)}, ${q(f.path)}, ${q(f.name)}, ${q(m.received_at)}, ${q(m.from_addr)}, ${q(m.subject)}) on conflict (inbound_email_id, file_path) do nothing`);
}

// 2–3. Read, split and check the new ones.
const todo = await sql(`select * from ops.vendor_invoices where org_id = ${q(org)} and status = 'new' order by received_at limit 20`);
for (const v of todo) {
  const tag = `${v.file_name} (${v.email_from})`;
  try {
    const x = await readInvoice(await downloadObject(BUCKET, v.file_path), v.file_name, { email_subject: v.email_subject, email_from: v.email_from, lessons: learnedAll.lessons });
    if (x.error) {
      const looks = INVOICE_WORDS.test(`${v.file_name || ''} ${v.email_subject || ''}`) && !/\.(txt|log)$/i.test(v.file_name || '');
      console.log(`${looks ? 'REVIEW' : 'not an invoice (unread type)'} ${tag}: ${x.error}`);
      if (!DRY) await sql(`update ops.vendor_invoices set status = ${q(looks ? 'needs_review' : 'not_invoice')}, is_invoice = ${looks ? 'null' : 'false'}, issues = array[${q(x.error)}], updated_at = now() where id = ${q(v.id)}`);
      continue;
    }
    if (!x.is_invoice) {
      console.log(`not an invoice: ${tag}`);
      if (!DRY) await sql(`update ops.vendor_invoices set status = 'not_invoice', is_invoice = false, extracted = ${q(JSON.stringify(x))}::jsonb, updated_at = now() where id = ${q(v.id)}`);
      continue;
    }
    const a = allocate(x, jobs, learnedAll);
    // a one-house invoice goes in through Buildertrend's bulk upload, which suggests the cost codes (Camila, 11/21/26)
    // no cost-code question: Buildertrend picks the cost code (bulk upload), Victor 11/23/26
    const dup = (await sql(`select id from ops.vendor_invoices where org_id = ${q(org)} and id <> ${q(v.id)} and lower(vendor) = lower(${q(x.vendor)})
      and invoice_number = ${q(x.invoice_number)} and status in ('ready', 'creating', 'created', 'needs_review')`)).length > 0;
    const status = dup ? 'duplicate' : a.issues.length ? 'needs_review' : 'ready';
    if (dup) a.issues.unshift(`a invoice ${x.vendor} #${x.invoice_number} já foi recebida antes`);
    console.log(`${status.toUpperCase()} ${x.vendor} #${x.invoice_number} ${money(x.total)} → ${a.lines.length} house(s)${a.issues.length ? ` · ${a.issues.join(' | ')}` : ''}`);
    if (DRY) continue;
    await sql(`update ops.vendor_invoices set is_invoice = true, vendor = ${q(x.vendor)}, invoice_number = ${q(x.invoice_number)},
        invoice_date = ${/^\d{4}-\d{2}-\d{2}$/.test(x.invoice_date || '') ? q(x.invoice_date) : 'null'}, due_date = ${/^\d{4}-\d{2}-\d{2}$/.test(x.due_date || '') ? q(x.due_date) : 'null'},
        total = ${x.total ?? 'null'}, fees_total = ${a.fees}, extracted = ${q(JSON.stringify(x))}::jsonb, status = ${q(status)},
        issues = ${a.issues.length ? `array[${a.issues.map(q).join(',')}]` : `'{}'`}, updated_at = now() where id = ${q(v.id)};
      delete from ops.vendor_invoice_lines where invoice_id = ${q(v.id)};
      ${a.lines.map((l) => `insert into ops.vendor_invoice_lines (invoice_id, label, address, job_id, job_number, bt_job_id, general, amount, fee_share, bill_amount)
        values (${q(v.id)}, ${q(l.label)}, ${q(l.address)}, ${q(l.job_id)}, ${q(l.job_number)}, ${l.bt_job_id ?? 'null'}, ${!!l.general}, ${l.amount}, ${l.fee_share}, ${l.bill_amount});`).join('\n')}`);
  } catch (e) {
    console.error(`ERROR ${tag}: ${e.message}`);
    if (!DRY) await sql(`update ops.vendor_invoices set status = 'error', issues = array[${q(e.message.slice(0, 500))}], updated_at = now() where id = ${q(v.id)}`);
  }
}

// 3b. Answers from Camila / Victor (category 'invoice_answer', subject "Re: Invoice para revisar — … #<n> …"):
// read by ops-invoice (mode answer) and applied. An address assigned to a job, a line left out, "pode criar" →
// ready (the bills follow); "não lançar" / already entered → ignored; unclear → stays, nothing done. When lines
// are still without a job after the answer, the question goes out again with what is left.
const answers = await sql(`select e.id, e.message_id, e.received_at, e.from_addr, e.subject, e.body_text, e.parsed from ops.inbound_emails e
  where e.org_id = ${q(org)} and e.category = 'invoice_answer' and e.received_at > now() - interval '30 days'
    and not exists (select 1 from ops.vendor_invoices v where v.answer_email_id = e.id) order by e.received_at`);
for (const e of answers) {
  const open = await sql(`select v.*, coalesce((select json_agg(l order by l.job_number) from ops.vendor_invoice_lines l where l.invoice_id = v.id), '[]') lines
    from ops.vendor_invoices v where v.org_id = ${q(org)} and v.question_sent_at is not null and v.question_sent_at < ${q(e.received_at)}
      and v.status in ('needs_review', 'duplicate', 'error') order by v.question_sent_at desc`);
  // An answer written in the portal (Finance → Vendor invoices) names its invoice; an e-mail answer is matched by
  // the number in its subject.
  const viaPortal = e.parsed?.via === 'portal';
  const v = viaPortal
    ? (await sql(`select v.*, coalesce((select json_agg(l order by l.job_number) from ops.vendor_invoice_lines l where l.invoice_id = v.id), '[]') lines
        from ops.vendor_invoices v where v.id = ${q(e.parsed.invoice_id)}`))[0]
    : open.find((x) => x.invoice_number && String(e.subject || '').includes(`#${x.invoice_number}`));
  if (!v) { console.log(`answer not matched to an open invoice: ${e.subject}`); continue; }
  const key = await serviceKey();
  const r = await fetch(`https://${REF}.supabase.co/functions/v1/ops-invoice`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}`, apikey: key },
    body: JSON.stringify({ mode: 'answer', answer_text: e.body_text || '', answer_by: e.from_addr, lessons: (await loadLearned(v.vendor)).lessons, jobs: [...jobs.filter((j) => j.bt_job_id).map((j) => ({ job_number: j.job_number, address: j.address, parcel: j.parcel })),
      ...learnedAll.btJobs.filter((b) => b.job_number && !jobs.some((j) => j.job_number === b.job_number)).map((b) => ({ job_number: b.job_number, address: b.street || b.name, parcel: b.parcel }))],
      invoice: { vendor: v.vendor, invoice_number: v.invoice_number, total: v.total, issues: v.issues, lines: v.lines.map((l) => ({ address: l.address, label: l.label, job_number: l.job_number, amount: l.bill_amount })) } }),
  });
  const a = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || a.error) { console.error(`answer ${e.subject}: ${a.error || r.status}`); continue; }
  console.log(`ANSWER ${v.vendor} #${v.invoice_number} (${e.from_addr}): ${a.decision} — ${a.summary}`);
  if (DRY) continue;
  const stmts = [`update ops.vendor_invoices set answer_email_id = ${q(e.id)}, answered_at = now(), answer = ${q(`${e.from_addr}: ${a.summary}`)},
    cost_code = coalesce(${q(a.cost_code || null)}, cost_code), updated_at = now() where id = ${q(v.id)}`];
  // Same line: same house number + street word, or (an answer that names only the number, "a 6320") the same
  // house number when one line has it.
  const num = (x) => (/^\s*(\d+)/.exec(String(x || '')) || [])[1];
  const pk = (z) => parcelOf({ address: z });
  const same = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase() || (pk(x) && pk(x) === pk(y)) || (addrKey(x) && addrKey(x) === addrKey(y)) || (num(y) && num(x) === num(y) && v.lines.filter((l) => num(l.address) === num(y)).length === 1);
  for (const s of a.assignments || []) {
    const jn = String(s.job_number).padStart(4, '0');
    const b = learnedAll.btJobs.filter((x) => x.job_number === jn);
    const j = jobs.find((x) => x.job_number === jn && x.bt_job_id) || (b.length === 1 ? { id: null, job_number: jn, bt_job_id: b[0].bt_job_id } : null);
    const l = v.lines.find((x) => same(x.address, s.line_address));
    if (j && l) {
      stmts.push(`update ops.vendor_invoice_lines set job_id = ${q(j.id)}, job_number = ${q(j.job_number)}, bt_job_id = ${j.bt_job_id}, general = false, excluded = false where id = ${q(l.id)}`);
      if (!DRY) await remember(l, { job_number: j.job_number, bt_job_id: j.bt_job_id }, `${e.from_addr} ${usDate(e.received_at)} (${v.vendor} #${v.invoice_number})`);
    }
  }
  for (const ad of a.no_job || []) {
    const l = v.lines.find((x) => same(x.address, ad));
    if (!l) continue;
    stmts.push(`update ops.vendor_invoice_lines set general = true, job_id = null, job_number = null, bt_job_id = null, excluded = false where id = ${q(l.id)}`);
    if (!DRY) await remember(l, { general: true }, `${e.from_addr} ${usDate(e.received_at)} (${v.vendor} #${v.invoice_number})`);
  }
  for (const ls of a.lessons || []) {
    const vend = ls.vendor_only ? v.vendor : null;
    if (!DRY && ls.lesson) await sql(`insert into ops.invoice_lessons (vendor, lesson, source)
      select ${q(vend)}, ${q(ls.lesson)}, ${q(`${e.from_addr} ${usDate(e.received_at)}`)}
      where not exists (select 1 from ops.invoice_lessons where lower(lesson) = lower(${q(ls.lesson)}))`);
    console.log(`  learned${vend ? ` (${vend})` : ''}: ${ls.lesson}`);
  }
  for (const ad of a.exclude || []) { const l = v.lines.find((x) => same(x.address, ad)); if (l) stmts.push(`update ops.vendor_invoice_lines set excluded = true where id = ${q(l.id)}`); }
  // "pode criar" also retries the lines whose bill failed before
  if (a.decision === 'create') stmts.push(`update ops.vendor_invoice_lines set bt_status = null, bt_error = null where invoice_id = ${q(v.id)} and bt_status = 'error'`);
  await sql(stmts.join(';\n'));
  let next;
  if (a.fetch_link && (!v.file_path || v.file_path === '(no file)')) {
    await sql(`update ops.vendor_invoices set fetch_requested_at = now(), fetch_error = null where id = ${q(v.id)}; select ops.dispatch_workflow('ops-bt-post.yml')`);
    next = 'Vou abrir o link do e-mail, baixar o PDF da invoice e ler de novo; o resultado aparece em alguns minutos.';
  } else if (a.decision === 'ignore' || a.decision === 'duplicate') { await sql(`update ops.vendor_invoices set status = 'ignored' where id = ${q(v.id)}`); next = 'Não vou lançar esta invoice.'; }
  else if (a.decision !== 'create') next = 'Fico aguardando — quando quiser que eu crie as bills, responda "pode criar".';
  else {
    const left = await sql(`select address, bill_amount from ops.vendor_invoice_lines where invoice_id = ${q(v.id)} and not excluded and not general and job_id is null and bt_job_id is null`);
    if (left.length) {
      await sql(`update ops.vendor_invoices set status = 'needs_review', question_sent_at = null,
        issues = array[${left.map((l) => q(`${l.address}: ainda sem obra (${money(l.bill_amount)}) — diga a obra ou "tira essa"`)).join(',')}] where id = ${q(v.id)}`);
      next = `Ainda falta a obra de ${left.length} endereço(s); mando outro e-mail com o que ficou.`;
    } else if (false) {   // cost code: Buildertrend picks it (Victor 11/23/26) — never asked any more
      await sql(`update ops.vendor_invoices set status = 'needs_review', question_sent_at = null,
        issues = array[${q(`fornecedor ${v.vendor} ainda não tem cost code definido — qual cost code usar nas bills?`)}] where id = ${q(v.id)}`);
      next = `Ainda falta o cost code do fornecedor ${v.vendor}; mando outro e-mail perguntando.`;
    } else {
      await sql(`update ops.vendor_invoices set status = 'ready', issues = '{}' where id = ${q(v.id)}`);
      next = 'Vou criar as bills em draft no Buildertrend, com a invoice anexada, nos próximos minutos.';
    }
  }
  if (viaPortal) {
    await sql(`update ops.vendor_invoices set answer = ${q(`${e.from_addr} (portal): ${a.summary} → ${next}`)}, updated_at = now() where id = ${q(v.id)}`);
    console.log(`portal answer applied: ${next}`);
    continue;
  }
  // Confirmation in the same thread (Victor, 11/21/26: Camila writes to the bot and gets an answer).
  const first = String(e.from_addr || '').split('@')[0].replace(/^./, (c) => c.toUpperCase());
  const text = `${first},\n\nEntendi: ${a.summary}\n${next}\n\n— PKB Ops (resposta automática)`;
  let res;
  try { res = await sendEmail({ to: [e.from_addr], cc: e.from_addr === REVIEW_CC[0] ? [] : REVIEW_CC, subject: /^re:/i.test(e.subject || '') ? e.subject : `Re: ${e.subject}`, text, alwaysCc: false, inReplyTo: e.message_id }); } catch (err) { res = { error: err.message }; }
  const st = res.error ? 'failed' : res.dryRun ? 'draft' : 'sent';
  await sql(`insert into ops.outbound_messages (org_id, channel, rule, to_addresses, cc_addresses, subject, body, status, error, external_id, sent_at)
      values (${q(org)}, 'email', 'R-INVOICE-OK', array[${q(e.from_addr)}]::text[], array[${(res.cc || REVIEW_CC).map(q).join(',')}]::text[], ${q(`Re: ${e.subject}`)}, ${q(text)}, ${q(st)}, ${q(res.error || null)}, ${q(res.id || null)}, ${st === 'sent' ? 'now()' : 'null'})`);
  console.log(`${st.toUpperCase()} confirmation → ${e.from_addr}: ${next}`);
}

// 4. One e-mail per invoice that needs a person (Camila, Cc Victor), with the file attached.
const ask = await sql(`select v.*, coalesce((select json_agg(l order by l.job_number) from ops.vendor_invoice_lines l where l.invoice_id = v.id), '[]') lines
  from ops.vendor_invoices v where v.org_id = ${q(org)} and v.status in ('needs_review', 'duplicate', 'error') and v.question_sent_at is null
    and (v.bt_checked_at is not null or (v.is_invoice is not true and v.status <> 'not_invoice')) order by v.received_at`);   // looked up in Buildertrend first (rules/bt_bill_check.mjs)
for (const v of ask) {
  const subject = `Invoice para revisar — ${v.vendor || v.email_from || 'fornecedor?'}${v.invoice_number ? ` #${v.invoice_number}` : ''}${v.total != null ? ` · ${money(v.total)}` : ''}`;
  const text = `Camila,

Não criei as bills desta invoice no Buildertrend porque algo precisa ser conferido:

${(v.issues || []).map((i) => `- ${i}`).join('\n')}

E-mail recebido: ${v.email_subject || '—'} (de ${v.email_from || '—'}, ${v.received_at ? usDate(v.received_at) : '—'})
Arquivo: ${v.file_name || '(sem arquivo)'}
${v.lines.length ? `\nComo a invoice ficou dividida por obra:\n${v.lines.map((l) => `  ${l.job_number || '????'}  ${money(l.bill_amount)}  ${l.address || l.label || ''}`).join('\n')}\n` : ''}
Responda este e-mail dizendo o que fazer (por exemplo, a obra certa de um endereço, ou "pode criar"). Eu leio a resposta e sigo.

— PKB Ops (e-mail automático)`;
  if (DRY) { console.log(`[dry run] question → ${REVIEW_TO.join(', ')}: ${subject}`); continue; }
  let attachments = [];
  if (v.file_path && v.file_path !== '(no file)') { try { attachments = [{ filename: v.file_name, content: await downloadObject(BUCKET, v.file_path) }]; } catch {} }
  let res;
  try { res = await sendEmail({ to: REVIEW_TO, cc: REVIEW_CC, subject, text, attachments, alwaysCc: false }); } catch (e) { res = { error: e.message }; }
  const status = res.error ? 'failed' : res.dryRun ? 'draft' : 'sent';
  console.log(`${status.toUpperCase()} question ${subject}`);
  await sql(`insert into ops.outbound_messages (org_id, channel, rule, to_addresses, cc_addresses, subject, body, status, error, external_id, sent_at)
      values (${q(org)}, 'email', 'R-INVOICE', array[${REVIEW_TO.map(q).join(',')}]::text[], array[${(res.cc || REVIEW_CC).map(q).join(',')}]::text[], ${q(subject)}, ${q(text)}, ${q(status)}, ${q(res.error || null)}, ${q(res.id || null)}, ${status === 'sent' ? 'now()' : 'null'});
    ${status === 'sent' ? `update ops.vendor_invoices set question_sent_at = now() where id = ${q(v.id)};` : ''}`);
}
console.log(`vendor invoices: ${todo.length} read · ${ask.length} sent for review${DRY ? ' · DRY RUN' : ''}`);
}
