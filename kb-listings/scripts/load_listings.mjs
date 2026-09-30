#!/usr/bin/env node
// Upsert listings from config/listings.json (or --file path) into kb.listings.
// A change of status or list price is recorded in kb.listing_history.
//   node scripts/load_listings.mjs [--file config/listings.json] [--dry-run]
import { readFileSync } from 'node:fs';
import { q, qa, qn, sql } from '../lib/db.mjs';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const DRY = process.argv.includes('--dry-run');
const file = arg('--file', new URL('../config/listings.json', import.meta.url).pathname);
const { listings = [] } = JSON.parse(readFileSync(file, 'utf8'));

const STATUS = ['coming_soon', 'active', 'pending', 'sold', 'withdrawn', 'expired'];
let n = 0;
for (const l of listings) {
  if (!l.address) throw new Error(`listing without address: ${JSON.stringify(l).slice(0, 80)}`);
  const status = l.status || 'active';
  if (!STATUS.includes(status)) throw new Error(`${l.address}: unknown status "${status}"`);
  const cur = (await sql(`select id, status, list_price from kb.listings
    where ${l.mls_number ? `mls_number = ${q(l.mls_number)} or ` : ''}lower(address) = lower(${q(l.address)}) limit 1`))[0];
  const v = {
    mls_number: q(l.mls_number), address: q(l.address), city: q(l.city), county: q(l.county), zip: q(l.zip),
    subdivision: q(l.subdivision), property_type: q(l.property_type), beds: qn(l.beds), baths: qn(l.baths), sqft: qn(l.sqft),
    lot_sf: qn(l.lot_sf), year_built: qn(l.year_built), list_price: qn(l.list_price),
    original_list_price: qn(l.original_list_price ?? (cur ? undefined : l.list_price)), status: q(status),
    listed_at: q(l.listed_at), pending_at: q(l.pending_at), sold_at: q(l.sold_at), sold_price: qn(l.sold_price),
    seller_name: q(l.seller_name), seller_emails: qa(l.seller_emails || []), seller_whatsapp: q(l.seller_whatsapp),
    report_channels: qa(l.report_channels || ['email']), report_lang: q(l.report_lang || 'pt'),
    market_filter: `${q(JSON.stringify(l.market_filter || {}))}::jsonb`, notes: q(l.notes),
  };
  const changed = !cur || cur.status !== status || Number(cur.list_price) !== Number(l.list_price);
  console.log(`${cur ? 'update' : 'insert'} ${l.mls_number || '-'} ${l.address} ${status} ${l.list_price ?? ''}${changed ? ' *' : ''}`);
  if (DRY) continue;
  const id = cur
    ? (await sql(`update kb.listings set ${Object.entries(v).filter(([k, x]) => !(k === 'original_list_price' && x === 'null')).map(([k, x]) => `${k} = ${x}`).join(', ')}, updated_at = now()
        where id = ${q(cur.id)} returning id`))[0].id
    : (await sql(`insert into kb.listings (${Object.keys(v).join(', ')}) values (${Object.values(v).join(', ')}) returning id`))[0].id;
  if (changed) await sql(`insert into kb.listing_history (listing_id, status, list_price, source) values (${q(id)}, ${q(status)}, ${qn(l.list_price)}, 'manual')`);
  n++;
}
console.log(`${n} listing(s) loaded${DRY ? ' (dry run)' : ''}`);
