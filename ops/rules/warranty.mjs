#!/usr/bin/env node
// =============================================================================
// warranty.mjs — warranty requests from the website form (Victor, 2026-11-02).
// Each 'warranty_request' e-mail (collectors/mail/collect_mail.py) becomes one ops.warranty_claims row per
// item, linked to the house by its address. Creating the Buildertrend Warranty claim and following it to
// "resolved" is done by collectors/buildertrend/warranty.mjs.
//   node rules/warranty.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, orgId } from './lib.mjs';

const org = await orgId();
// Street number + first word of the street name ("17146 SW 41 circle" ~ "17146 SW 41st Cir").
const key = (a) => { const m = /^\s*(\d+)\s+(?:(?:N|S|E|W|NE|NW|SE|SW)\s+)?(\w+)/i.exec(String(a || '')); return m ? `${m[1]} ${m[2].toLowerCase().replace(/(st|nd|rd|th)$/, '')}` : null; };
const jobs = (await sql(`select id, job_number, address from ops.jobs where org_id = ${q(org)}`)).map((j) => ({ ...j, k: key(j.address) }));

const mails = await sql(`select e.id, e.received_at, e.parsed from ops.inbound_emails e
  where e.org_id = ${q(org)} and e.category = 'warranty_request'
    and not exists (select 1 from ops.warranty_claims w where w.inbound_email_id = e.id)`);
for (const e of mails) {
  const p = e.parsed || {};
  const job = jobs.filter((j) => j.k && j.k === key(p.address));
  const jobId = job.length === 1 ? job[0].id : null;
  const items = p.items?.length ? p.items : [{ item: 1, category: null, location: null, description: null }];
  console.log(`${String(e.received_at).slice(0, 16)} ${p.homeowner || '—'} · ${p.address || '—'} → ${job.length === 1 ? job[0].job_number : job.length ? 'several houses match' : 'no house matched'} · ${items.length} item(s)`);
  if (DRY) continue;
  for (const it of items) {
    await sql(`insert into ops.warranty_claims (org_id, job_id, inbound_email_id, item_no, received_at, homeowner, phone, email, address, purchase_date, category, location, description)
      values (${q(org)}, ${q(jobId)}, ${q(e.id)}, ${Number(it.item) || 1}, ${q(e.received_at)}, ${q(p.homeowner)}, ${q(p.phone)}, ${q(p.email)}, ${q(p.address)},
        ${/^\d{4}-\d{2}-\d{2}$/.test(p.purchase_date || '') ? q(p.purchase_date) : 'null'}, ${q(it.category)}, ${q(it.location)}, ${q(it.description)})
      on conflict (inbound_email_id, item_no) do nothing`);
  }
  if (jobId) await sql(`update ops.inbound_emails set job_id = ${q(jobId)}, job_number = ${q(job[0].job_number)} where id = ${q(e.id)}`);
}
console.log(`warranty: ${mails.length} new request(s)${DRY ? ' · DRY RUN' : ''}`);
