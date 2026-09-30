// Write normalized comp rows (from Repliers or an MLS CSV) into kb.market_comps, then bring our
// own listings in kb.listings up to date from them (status, price, dates → kb.listing_history).
import { q, qn, sql } from './db.mjs';

const COLS = ['mls_number', 'status', 'address', 'city', 'county', 'zip', 'subdivision', 'property_type', 'beds', 'baths', 'sqft', 'lot_sf',
  'year_built', 'garage', 'pool', 'list_price', 'original_list_price', 'sold_price', 'listed_at', 'pending_at', 'sold_at', 'dom'];
const NUM = new Set(['beds', 'baths', 'sqft', 'lot_sf', 'year_built', 'garage', 'list_price', 'original_list_price', 'sold_price', 'dom']);
const val = (c, v) => (c === 'pool' ? (v == null ? 'null' : String(!!v)) : NUM.has(c) ? qn(v) : q(v));

export async function upsertComps(rows, source) {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await sql(`insert into kb.market_comps (${COLS.join(', ')}, source, raw) values
      ${chunk.map((r) => `(${COLS.map((c) => val(c, r[c])).join(', ')}, ${q(source)}, ${q(JSON.stringify(r.raw || {}))}::jsonb)`).join(',\n')}
      on conflict (mls_number) do update set
        ${COLS.filter((c) => !['mls_number', 'pending_at'].includes(c)).map((c) => `${c} = coalesce(excluded.${c}, kb.market_comps.${c})`).join(', ')},
        status = excluded.status, source = excluded.source, raw = excluded.raw, imported_at = now(),
        -- first time we see it under contract, when the source has no pending date
        pending_at = coalesce(excluded.pending_at, kb.market_comps.pending_at,
                              case when excluded.status = 'pending' and kb.market_comps.status = 'active' then current_date end)`);
  }
}

export async function syncOwnListings(mlsNumbers, source) {
  if (!mlsNumbers.length) return [];
  return sql(`with src as (select * from kb.market_comps where mls_number in (${mlsNumbers.map(q).join(',')})),
    upd as (update kb.listings l set status = s.status, list_price = coalesce(s.list_price, l.list_price),
              original_list_price = coalesce(l.original_list_price, s.original_list_price, s.list_price),
              pending_at = coalesce(s.pending_at, l.pending_at, case when s.status = 'pending' then current_date end),
              sold_at = coalesce(s.sold_at, l.sold_at), sold_price = coalesce(s.sold_price, l.sold_price),
              listed_at = coalesce(l.listed_at, s.listed_at), beds = coalesce(l.beds, s.beds), baths = coalesce(l.baths, s.baths),
              sqft = coalesce(l.sqft, s.sqft), lot_sf = coalesce(l.lot_sf, s.lot_sf), year_built = coalesce(l.year_built, s.year_built),
              zip = coalesce(l.zip, s.zip), city = coalesce(l.city, s.city), subdivision = coalesce(l.subdivision, s.subdivision), updated_at = now()
            from src s where s.mls_number = l.mls_number
              and (l.status is distinct from s.status or l.list_price is distinct from coalesce(s.list_price, l.list_price)
                   or l.sqft is null or l.zip is null)
            returning l.id, l.status, l.list_price, (select h.status from kb.listing_history h where h.listing_id = l.id order by h.changed_at desc limit 1) as last_status,
                      (select h.list_price from kb.listing_history h where h.listing_id = l.id order by h.changed_at desc limit 1) as last_price)
    insert into kb.listing_history (listing_id, status, list_price, source)
      select id, status, list_price, ${q(source)} from upd
      where last_status is distinct from status or last_price is distinct from list_price
    returning listing_id`);
}
