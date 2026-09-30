#!/usr/bin/env node
// Fallback to the Repliers sync: import an MLS CSV export (active + pending + sold of the areas where we have listings) into
// kb.market_comps, and bring OUR listings up to date from the same file (status, price,
// pending/sold dates → kb.listing_history).
//
//   node collectors/mls/import_csv.mjs <file.csv> [...more]   # explicit files
//   node collectors/mls/import_csv.mjs --inbox                # every CSV in data/mls/inbox/ (then moved to done/)
//   add --dry-run to only print what would change
//
// Suggested saved search in the MLS (export as CSV, all columns of the default "full" layout):
// residential, the zips / subdivisions of our listings, status Active + Pending + Sold (last 180 days).
import { mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { normalize, parseCsv } from '../../lib/mls.mjs';
import { syncOwnListings, upsertComps } from '../../lib/comps.mjs';

const DRY = process.argv.includes('--dry-run');
const INBOX = new URL('../../data/mls/inbox/', import.meta.url).pathname;
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (process.argv.includes('--inbox')) {
  try { files.push(...readdirSync(INBOX).filter((f) => f.toLowerCase().endsWith('.csv')).map((f) => join(INBOX, f))); } catch { /* no inbox yet */ }
}
if (!files.length) { console.log('no CSV to import'); process.exit(0); }

for (const file of files) {
  const raw = parseCsv(readFileSync(file, 'utf8'));
  const rows = raw.map((r) => ({ ...normalize(r), raw: r })).filter((r) => r.mls_number && r.status);
  console.log(`${basename(file)}: ${raw.length} rows, ${rows.length} usable (${raw.length - rows.length} without MLS number/status)`);
  if (raw.length && !rows.length) console.log('  headers:', Object.keys(raw[0]).join(' | '));
  const byStatus = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
  console.log('  ', JSON.stringify(byStatus));
  if (DRY) { rows.slice(0, 5).forEach((r) => console.log('  ', r.mls_number, r.status, r.address, r.sqft, r.list_price, r.sold_price)); continue; }

  await upsertComps(rows, 'mls_csv');
  const changed = await syncOwnListings(rows.map((r) => r.mls_number), 'mls_import');
  console.log(`  ${rows.length} comps upserted · ${changed.length} of our listing(s) changed status/price`);
  if (file.startsWith(INBOX)) { mkdirSync(join(INBOX, 'done'), { recursive: true }); renameSync(file, join(INBOX, 'done', basename(file))); }
}
