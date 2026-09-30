// Repliers MLS API (https://api.repliers.io, header REPLIERS-API-KEY): search + normalize a
// listing into the same comp row the CSV importer produces (lib/mls.mjs).
const BASE = process.env.REPLIERS_BASE_URL || 'https://api.repliers.io';

const num = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const r = String(v).replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?/); // "1500-1999" → midpoint
  return r ? (r[2] ? (Number(r[1]) + Number(r[2])) / 2 : Number(r[1])) : null;
};
const day = (v) => (v ? String(v).slice(0, 10) : null);
const yes = (v) => (v == null || v === '' ? null : typeof v === 'boolean' ? v : !/^(no|none|n|false|0)\b/i.test(String(v).trim()));

const STANDARD = { active: 'active', 'active under contract': 'pending', pending: 'pending', closed: 'sold', 'coming soon': 'coming_soon',
  expired: 'expired', withdrawn: 'withdrawn', canceled: 'withdrawn', cancelled: 'withdrawn', hold: 'withdrawn' };
const LAST = { Sld: 'sold', Sc: 'pending', Sce: 'pending', Exp: 'expired', Ter: 'withdrawn', Sus: 'withdrawn', Dft: 'withdrawn' };

export function repliersStatus(l) {
  const std = STANDARD[String(l.standardStatus || '').toLowerCase()];
  if (std) return std;
  if (LAST[l.lastStatus]) return LAST[l.lastStatus];
  return l.status === 'A' ? 'active' : l.status === 'U' ? 'withdrawn' : null;
}

export function normalizeRepliers(l) {
  const a = l.address || {}, d = l.details || {}, lot = l.lot || {}, ts = l.timestamps || {};
  const street = [a.streetNumber, a.streetDirectionPrefix, a.streetName, a.streetSuffix, a.streetDirection].filter(Boolean).join(' ');
  const address = [street + (a.unitNumber ? ` #${a.unitNumber}` : ''), a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter((x) => x && x.trim()).join(', ') || null;
  const status = repliersStatus(l);
  const baths = num(d.numBathroomsTotal) ?? (num(d.numBathrooms) != null ? num(d.numBathrooms) + 0.5 * (num(d.numBathroomsHalf) || 0) : null);
  const lotSf = num(lot.acres) ? Math.round(num(lot.acres) * 43560)
    : num(lot.size) && /acre/i.test(lot.measurement || '') ? Math.round(num(lot.size) * 43560)
      : num(lot.squareFeet) ?? (num(lot.size) && num(lot.size) > 500 ? num(lot.size) : num(lot.width) && num(lot.depth) ? num(lot.width) * num(lot.depth) : null);
  return {
    mls_number: l.mlsNumber || null, status, address, city: a.city || null, county: a.county || null, zip: a.zip ? String(a.zip).slice(0, 5) : null,
    subdivision: a.neighborhood || a.subdivision || null, property_type: d.propertyType || d.style || null,
    beds: num(d.numBedrooms) != null ? num(d.numBedrooms) + (num(d.numBedroomsPlus) || 0) : null, baths,
    sqft: num(d.sqft), lot_sf: lotSf, year_built: num(d.yearBuilt),
    garage: num(d.numGarageSpaces) ?? num(d.garage), pool: yes(d.swimmingPool),
    list_price: num(l.listPrice), original_list_price: num(l.originalPrice), sold_price: num(l.soldPrice),
    listed_at: day(l.listDate), sold_at: status === 'sold' ? day(l.soldDate || ts.closedDate) : null,
    pending_at: ['Sc', 'Sce'].includes(l.lastStatus) ? day(ts.unavailableDate) : null,
    dom: num(l.daysOnMarket),
  };
}

// GET /listings, following pages. params: object; array values become repeated keys.
export async function searchListings(params, { maxPages = 50 } = {}) {
  const key = process.env.REPLIERS_API_KEY;
  if (!key) throw new Error('REPLIERS_API_KEY not set');
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ resultsPerPage: 100, ...params, pageNum: page })) {
      for (const x of [].concat(v)) if (x != null && x !== '') qs.append(k, String(x));
    }
    const res = await fetch(`${BASE}/listings?${qs}`, { headers: { 'REPLIERS-API-KEY': key, Accept: 'application/json' } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); page--; continue; }
    if (!res.ok) throw new Error(`Repliers ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    out.push(...(body.listings || []));
    if (!body.numPages || page >= body.numPages) break;
  }
  return out;
}
