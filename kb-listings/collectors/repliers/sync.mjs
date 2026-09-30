#!/usr/bin/env node
// =============================================================================
// Repliers → our listings + the market around them. Runs daily.
//
//  1. OUR listings: every listing of our agents / office (REPLIERS_AGENTS, comma-separated
//     names or ids, and/or REPLIERS_OFFICE_ID / REPLIERS_BROKERAGE), active or off-market in
//     the last 120 days. New ones are added to kb.listings (seller data is filled in later,
//     config/listings.json); status and price changes go to kb.listing_history.
//  2. MARKET: for every zip where we have an active listing (or its market_filter zips/cities),
//     plus KB_MARKET_ZIPS: all active (incl. pending / under contract) and everything sold in
//     the last --days (180) → kb.market_comps. A comp seen under contract for the first time
//     gets pending_at = today when the MLS gives no date.
//
//   node collectors/repliers/sync.mjs [--days 180] [--only own|market] [--dry-run]
// Env: REPLIERS_API_KEY, KB_SUPABASE_*; optional REPLIERS_CLASS (residential), REPLIERS_BOARD_ID.
// =============================================================================
import { normalizeRepliers, searchListings } from '../../lib/repliers.mjs';
import { syncOwnListings, upsertComps } from '../../lib/comps.mjs';
import { q, qn, sql } from '../../lib/db.mjs';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const DRY = process.argv.includes('--dry-run');
const ONLY = arg('--only');
const DAYS = Number(arg('--days', 180));
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const ago = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const common = { type: 'sale', ...(process.env.REPLIERS_CLASS !== '' && { class: process.env.REPLIERS_CLASS || 'residential' }),
  ...(process.env.REPLIERS_BOARD_ID && { boardId: process.env.REPLIERS_BOARD_ID }) };
const summary = (rows) => JSON.stringify(rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {}));

async function save(rows, label) {
  const good = rows.filter((r) => r.mls_number && r.status);
  console.log(`${label}: ${good.length} listing(s) ${summary(good)}`);
  if (!DRY && good.length) await upsertComps(good, 'repliers');
  return good;
}

// 1. our listings
if (ONLY !== 'market') {
  const who = [...list(process.env.REPLIERS_AGENTS).map((agent) => ({ agent })),
    ...list(process.env.REPLIERS_OFFICE_ID).map((officeId) => ({ officeId })), ...list(process.env.REPLIERS_BROKERAGE).map((brokerage) => ({ brokerage }))];
  if (!who.length) console.log('own listings: set REPLIERS_AGENTS and/or REPLIERS_OFFICE_ID to discover them automatically');
  const seen = new Map();
  for (const w of who) {
    for (const p of [{ status: 'A' }, { status: 'U', minUnavailableDate: ago(120) }]) {
      for (const l of await searchListings({ ...common, ...w, ...p })) seen.set(l.mlsNumber, normalizeRepliers(l));
    }
  }
  const own = await save([...seen.values()], 'own listings');
  if (!DRY && own.length) {
    const known = new Set((await sql(`select mls_number from kb.listings where mls_number is not null`)).map((r) => r.mls_number));
    for (const r of own.filter((x) => !known.has(x.mls_number) && x.address && !['withdrawn', 'expired'].includes(x.status))) {
      await sql(`insert into kb.listings (mls_number, address, city, zip, subdivision, property_type, beds, baths, sqft, lot_sf, year_built, list_price, original_list_price, status, listed_at, pending_at, sold_at, sold_price)
        values (${q(r.mls_number)}, ${q(r.address)}, ${q(r.city)}, ${q(r.zip)}, ${q(r.subdivision)}, ${q(r.property_type)}, ${qn(r.beds)}, ${qn(r.baths)}, ${qn(r.sqft)}, ${qn(r.lot_sf)}, ${qn(r.year_built)},
                ${qn(r.list_price)}, ${qn(r.original_list_price ?? r.list_price)}, ${q(r.status)}, ${q(r.listed_at)}, ${q(r.pending_at)}, ${q(r.sold_at)}, ${qn(r.sold_price)})
        on conflict do nothing`);
      console.log(`  NEW listing ${r.mls_number} ${r.address} — add the seller in config/listings.json`);
    }
    const changed = await syncOwnListings(own.map((r) => r.mls_number), 'repliers');
    console.log(`  ${changed.length} status/price change(s) recorded`);
  }
}

// 2. the market around them
if (ONLY !== 'own') {
  const ls = await sql(`select zip, market_filter from kb.listings where status in ('coming_soon', 'active', 'pending')`);
  const zips = new Set(list(process.env.KB_MARKET_ZIPS));
  const cities = new Set();
  for (const l of ls) {
    const f = l.market_filter || {};
    (f.zips?.length ? f.zips : f.cities?.length ? [] : [l.zip]).filter(Boolean).forEach((z) => zips.add(String(z)));
    (f.cities || []).forEach((c) => cities.add(c));
  }
  for (const [kind, values] of [['zip', zips], ['city', cities]]) {
    for (const v of values) {
      const active = (await searchListings({ ...common, [kind]: v, status: 'A' })).map(normalizeRepliers);
      const sold = (await searchListings({ ...common, [kind]: v, status: 'U', lastStatus: 'Sld', minSoldDate: ago(DAYS) })).map(normalizeRepliers);
      const pend = (await searchListings({ ...common, [kind]: v, status: 'U', lastStatus: ['Sc', 'Sce'], minUnavailableDate: ago(60) })).map(normalizeRepliers);
      await save([...active, ...sold, ...pend], `market ${kind} ${v}`);
    }
  }
  if (!zips.size && !cities.size) console.log('market: no active listing / KB_MARKET_ZIPS — nothing to watch');
}
