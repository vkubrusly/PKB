// MLS CSV export → normalized comp rows. Header names vary between MLS systems and saved
// exports (Stellar MLS Matrix, Flexmls, …), so each field accepts several aliases; compare
// case-insensitively, ignoring punctuation. Add aliases here when an export brings new ones.

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  const [head = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const ALIASES = {
  mls_number: ['ml number', 'mls number', 'mls #', 'mls', 'mls id', 'listing id', 'ml#', 'list number'],
  status: ['status', 'mls status', 'standard status', 'listing status'],
  address: ['address', 'full address', 'street address', 'property address', 'unparsed address'],
  street_number: ['street number', 'street #'],
  street_name: ['street name'],
  city: ['city', 'postal city'],
  county: ['county', 'county or parish'],
  zip: ['zip', 'zip code', 'postal code', 'zipcode'],
  subdivision: ['subdivision', 'subdivision name', 'legal subdivision name', 'community', 'complex/subdivision'],
  property_type: ['property style', 'property type', 'property sub type', 'type'],
  beds: ['beds', 'bedrooms', 'beds total', 'bedrooms total', 'br'],
  baths: ['baths', 'baths total', 'bathrooms total', 'total baths'],
  full_baths: ['full baths', 'baths full', 'bathrooms full'],
  half_baths: ['half baths', 'baths half', 'bathrooms half'],
  sqft: ['heated area', 'sqft heated', 'heated sqft', 'living area', 'sq ft heated', 'sqft', 'square footage', 'approx sqft'],
  lot_sf: ['lot size sqft', 'lot size square footage', 'lot sqft', 'lot size (sqft)'],
  lot_acres: ['lot size acres', 'total acreage', 'acres', 'lot acres'],
  year_built: ['year built', 'yr built'],
  garage: ['garage spaces', 'garage', 'garage/carport'],
  pool: ['pool', 'private pool', 'pool private yn', 'pool y/n'],
  list_price: ['list price', 'current price', 'price', 'asking price'],
  original_list_price: ['original list price', 'orig list price', 'original price'],
  sold_price: ['close price', 'sold price', 'sale price', 'closed price'],
  listed_at: ['list date', 'listing contract date', 'on market date', 'listing date'],
  pending_at: ['pending date', 'under contract date', 'contract date', 'purchase contract date'],
  sold_at: ['close date', 'sold date', 'closing date', 'closed date'],
  dom: ['cdom', 'dom', 'days on market', 'cumulative days on market', 'adom'],
};
const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9#]/g, '');
const INDEX = Object.fromEntries(Object.entries(ALIASES).flatMap(([f, as]) => as.map((a) => [key(a), f])));

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
export function date(v) {
  if (!v) return null;
  let m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}
export function status(v) {
  const s = String(v || '').toLowerCase();
  if (/coming/.test(s)) return 'coming_soon';
  if (/pend|under contract|\bauc\b|contingent|backup/.test(s)) return 'pending';
  if (/sold|closed/.test(s)) return 'sold';
  if (/withdrawn|cancel|off market|temp/.test(s)) return 'withdrawn';
  if (/expired/.test(s)) return 'expired';
  if (/active|new|price change|back on market/.test(s)) return 'active';
  return null;
}
const yes = (v) => (v == null || v === '' ? null : /^(y|yes|true|1|private|in ground|above ground)/i.test(String(v)) && !/^none/i.test(String(v)));

export function normalize(rec) {
  const r = {};
  for (const [h, v] of Object.entries(rec)) { const f = INDEX[key(h)]; if (f && r[f] == null && v !== '') r[f] = v; }
  const baths = num(r.baths) ?? (r.full_baths != null ? num(r.full_baths) + 0.5 * (num(r.half_baths) || 0) : null);
  const address = r.address || [r.street_number, r.street_name].filter(Boolean).join(' ') || null;
  const lot = num(r.lot_sf) ?? (num(r.lot_acres) != null ? Math.round(num(r.lot_acres) * 43560) : null);
  return {
    mls_number: r.mls_number || null, status: status(r.status), address, city: r.city || null, county: r.county || null,
    zip: r.zip ? String(r.zip).slice(0, 5) : null, subdivision: r.subdivision || null, property_type: r.property_type || null,
    beds: num(r.beds), baths, sqft: num(r.sqft), lot_sf: lot, year_built: num(r.year_built), garage: num(r.garage), pool: yes(r.pool),
    list_price: num(r.list_price), original_list_price: num(r.original_list_price), sold_price: num(r.sold_price),
    listed_at: date(r.listed_at), pending_at: date(r.pending_at), sold_at: date(r.sold_at), dom: num(r.dom),
  };
}
