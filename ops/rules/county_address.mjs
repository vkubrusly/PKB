#!/usr/bin/env node
// =============================================================================
// county_address.mjs — houses whose address has no house number yet ("TBD SW 165th Pl…") get the address the
// county assigned to their parcel (Victor, 11/20/26). Marion: the county's public GIS, Parcels layer, SITUS_1
// (gis.marionfl.org). The street comes from the county; city / state / ZIP stay as they were. A parcel without a
// situs yet is left alone and checked again on the next run. The daily seed keeps a numbered address (it does not
// put "TBD" back).
//   node rules/county_address.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, orgId } from './lib.mjs';

const MARION = 'https://gis.marionfl.org/public/rest/services/General/Parcels/MapServer/0/query';
// "3471 SW 130TH LANE RD" → "3471 SW 130th Lane Rd"
const street = (s) => String(s).trim().split(/\s+/).map((w) => (/^(N|S|E|W|NE|NW|SE|SW)$/i.test(w) ? w.toUpperCase() : /^\d+(ST|ND|RD|TH)$/i.test(w) ? w.toLowerCase() : /^\d+$/.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(' ');

const org = await orgId();
const jobs = await sql(`select id, job_number, address, parcel, county from ops.jobs where org_id = ${q(org)}
  and address !~ '^\\s*\\d' and coalesce(parcel, '') <> '' and county = 'Marion'`);
if (!jobs.length) { console.log('county_address: no house without a number'); process.exit(0); }
const parcels = [...new Set(jobs.map((j) => j.parcel.trim()))];
const qs = new URLSearchParams({ where: `PARCEL in (${parcels.map((p) => `'${p.replace(/'/g, '')}'`).join(',')})`, outFields: 'PARCEL,SITUS_1', returnGeometry: 'false', f: 'json' });
const r = await fetch(`${MARION}?${qs}`);
const d = await r.json().catch(() => ({}));
if (!r.ok || d.error) { console.error(`Marion GIS: ${d.error?.message || r.status}`); process.exit(1); }
const situs = Object.fromEntries((d.features || []).map((f) => [f.attributes.PARCEL, String(f.attributes.SITUS_1 || '').trim()]));
// Two houses on one parcel: the county address cannot tell which one — leave both and say so.
const perParcel = jobs.reduce((m, j) => ((m[j.parcel] = (m[j.parcel] || 0) + 1), m), {});
let fixed = 0;
for (const j of jobs) {
  const s = situs[j.parcel.trim()];
  if (perParcel[j.parcel] > 1) { console.log(`${j.job_number}: parcel ${j.parcel} is on ${perParcel[j.parcel]} houses — not changed`); continue; }
  if (!s || !/^\d/.test(s)) { console.log(`${j.job_number}: parcel ${j.parcel} has no county address yet`); continue; }
  const tail = String(j.address).split(',').slice(1).join(',').trim();
  const addr = `${street(s)}${tail ? `, ${tail}` : ''}`;
  console.log(`${j.job_number}: "${j.address}" → "${addr}" (parcel ${j.parcel})`);
  if (DRY) continue;
  await sql(`update ops.jobs set address = ${q(addr)}, updated_at = now() where id = ${q(j.id)}`);
  fixed++;
}
console.log(`county_address: ${fixed} updated${DRY ? ' · DRY RUN' : ''}`);
