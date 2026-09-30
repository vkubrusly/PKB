// node --test tests/*.test.mjs — MLS CSV mapping, market math, product suggestions and the weekly report,
// on synthetic data (no database, no mail).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseCsv, status } from '../lib/mls.mjs';
import { productSuggestions, weekMarket } from '../lib/market.mjs';
import { buildMetrics, render } from '../lib/report.mjs';
import { classifyByRules } from '../lib/ai.mjs';

const CSV = `"ML Number","Status","Address","City","Zip Code","Subdivision","Beds","Full Baths","Half Baths","Heated Area","Lot Size SqFt","Year Built","Garage Spaces","Pool","List Price","Close Price","List Date","Pending Date","Close Date","CDOM"
"OM1","Sold","10 A St","Ocala","34471","Oak Run",3,2,0,"1,600",10000,2025,2,"No","$300,000","$295,000",08/01/2026,08/20/2026,09/22/2026,19
"OM2","Pending","12 B St","Ocala","34471","Oak Run",3,2,0,1550,9000,2026,2,"No",310000,,08/25/2026,09/23/2026,,29
"OM3","Active","14 C St, ""Unit 1""","Ocala","34471","Oak Run",4,2,1,2200,12000,2010,2,"Yes",420000,,09/01/2026,,,28
"OM4","Sold","16 D St","Ocala","34471","Oak Run",3,2,0,1700,10000,2026,2,"No",320000,318000,07/01/2026,07/15/2026,08/30/2026,14
"OM5","Sold","18 E St","Ocala","34471","Oak Run",3,2,0,1500,10000,2026,1,"No",290000,290000,06/01/2026,06/10/2026,07/20/2026,9
"OM6","Active Under Contract","20 F St","Ocala","34473","Other",3,2,0,1500,10000,2000,1,"No",250000,,09/01/2026,09/24/2026,,23
"",,"bad row"`;

test('MLS CSV maps aliases, quotes, money and dates', () => {
  const rows = parseCsv(CSV).map(normalize);
  assert.equal(rows.length, 7);
  const [a, , c] = rows;
  assert.deepEqual([a.mls_number, a.status, a.sqft, a.sold_price, a.sold_at, a.dom, a.baths, a.pool], ['OM1', 'sold', 1600, 295000, '2026-09-22', 19, 2, false]);
  assert.equal(c.address, '14 C St, "Unit 1"');
  assert.equal(c.baths, 2.5);
  assert.equal(c.pool, true);
  assert.equal(rows[5].status, 'pending');
  assert.equal(rows[6].mls_number, null);
  assert.equal(status('Temp Off Market'), 'withdrawn');
});

const comps = parseCsv(CSV).map(normalize).filter((r) => r.mls_number);
const listing = { id: 'L1', mls_number: 'OMX', address: '99 Z St, Ocala, FL 34471', zip: '34471', beds: 3, sqft: 1600, list_price: 329000,
  status: 'active', listed_at: '2026-09-01', market_filter: {}, report_lang: 'pt', seller_name: 'Ana Souza', seller_emails: ['a@x.com'], report_channels: ['email'] };

test('week market: pending and sold of the week, inside the area only', () => {
  const m = weekMarket(listing, comps, '2026-09-21', '2026-09-28');
  assert.equal(m.pending_week, 1);     // OM2 (OM6 is another zip)
  assert.equal(m.sold_week, 1);        // OM1
  assert.equal(m.active_now, 1);       // OM3
  assert.equal(m.similar_sold90, 3);   // OM1, OM4, OM5 (sold ≤ 90 days before, 1,200–2,000 sf)
  assert.equal(m.similar_median_ppsf, 187);
});

test('product suggestions pick the fastest configuration with enough sample', () => {
  const s = productSuggestions('ZIP 34471', comps.filter((c) => c.zip === '34471'), { today: new Date('2026-09-28'), minN: 3 });
  const plan = s.find((x) => x.kind === 'floor_plan');
  assert.match(plan.title, /3\/2/);
  assert.equal(plan.evidence.n, 4);
  assert.ok(s.find((x) => x.kind === 'size'));
  assert.deepEqual(productSuggestions('x', comps.slice(0, 1)), []);
});

test('weekly report: counts, feedback, market and both renderings', () => {
  const at = (d, h) => new Date(`${d}T${h}:00-04:00`).toISOString();
  const showings = [
    { listing_id: 'L1', status: 'completed', starts_at: at('2026-09-22', '14'), requested_at: at('2026-09-21', '09'), feedback_received_at: at('2026-09-23', '10'),
      feedback_text: 'Buyers loved it, writing an offer', feedback_interest: 'high', feedback_price_view: 'fair', offer_expected: true,
      feedback_summary: JSON.stringify({ pt: 'Compradores adoraram e devem fazer oferta.', en: 'Buyers loved it.' }) },
    { listing_id: 'L1', status: 'confirmed', starts_at: at('2026-09-27', '23'), requested_at: at('2026-09-25', '09') },      // Sunday 11 pm FL = still this week
    { listing_id: 'L1', status: 'cancelled', starts_at: at('2026-09-24', '10'), requested_at: at('2026-09-23', '09'), updated_at: at('2026-09-24', '08') },
    { listing_id: 'L1', status: 'completed', starts_at: at('2026-09-16', '10'), created_at: at('2026-09-15', '09') },
    { listing_id: 'L1', status: 'confirmed', starts_at: at('2026-09-28', '10'), requested_at: at('2026-09-27', '09') },      // next week
  ];
  const history = [{ listing_id: 'L1', status: 'active', list_price: 329000, changed_at: at('2026-09-25', '12') }];
  const m = buildMetrics(listing, showings, history, comps, '2026-09-21');
  assert.deepEqual([m.showings_week, m.showings_prev_week, m.showings_to_date, m.requests_week, m.cancelled_week, m.offers_expected],
    [2, 1, 3, 4, 1, 1]);   // 4 requests made this week, one of them for next week
  assert.equal(m.dom, 27);
  assert.equal(m.changes.length, 1);
  assert.equal(m.vs_similar_pct, 10);   // $206/sf vs $187/sf
  const r = render(listing, m, 'Semana boa.', '2026-09-21', { agent: 'Victor' });
  assert.match(r.subject, /99 Z St/);
  assert.match(r.html, /Compradores adoraram/);
  assert.match(r.html, /Olá, Ana!/);
  assert.match(r.wa, /Visitas \(showings\): \*2\*/);
  assert.doesNotMatch(r.html, /<script/);
  const en = render({ ...listing, report_lang: 'en' }, m, null, '2026-09-21');
  assert.match(en.html, /Buyer feedback/);
  assert.match(en.html, /Address/);
});

test('feedback rules without the API', () => {
  assert.equal(classifyByRules('They loved the house and are writing an offer').offer_expected, true);
  assert.equal(classifyByRules('Not interested, too small. Price is too high').interest, 'none');
  assert.equal(classifyByRules('Price is a little high').price_view, 'high');
  assert.equal(classifyByRules('No offer at this time').offer_expected, false);
});

test('Repliers listing → comp row', async () => {
  const { normalizeRepliers, repliersStatus } = await import('../lib/repliers.mjs');
  const r = normalizeRepliers({
    mlsNumber: 'OM700001', status: 'U', lastStatus: 'Sld', listPrice: '335000.00', originalPrice: '349000.00', soldPrice: '330000.00',
    listDate: '2026-07-01T00:00:00.000Z', soldDate: '2026-09-24T00:00:00.000Z', daysOnMarket: 41,
    address: { streetNumber: '123', streetDirectionPrefix: 'SW', streetName: '45th', streetSuffix: 'Pl', city: 'Ocala', state: 'FL', zip: '34471-1234', neighborhood: 'Oak Run' },
    details: { numBedrooms: 3, numBathrooms: 2, numBathroomsHalf: 1, sqft: '1650', yearBuilt: '2025', numGarageSpaces: 2, swimmingPool: 'None' },
    lot: { acres: '0.25' }, timestamps: { closedDate: '2026-09-24' },
  });
  assert.deepEqual([r.mls_number, r.status, r.address, r.zip, r.baths, r.sqft, r.lot_sf, r.pool, r.sold_at, r.sold_price, r.original_list_price, r.dom],
    ['OM700001', 'sold', '123 SW 45th Pl, Ocala, FL 34471-1234', '34471', 2.5, 1650, 10890, false, '2026-09-24', 330000, 349000, 41]);
  assert.equal(repliersStatus({ status: 'A', standardStatus: 'Active Under Contract' }), 'pending');
  assert.equal(repliersStatus({ status: 'A', lastStatus: 'New' }), 'active');
  assert.equal(repliersStatus({ status: 'U', lastStatus: 'Sc' }), 'pending');
  assert.equal(normalizeRepliers({ mlsNumber: 'X', status: 'U', lastStatus: 'Sc', timestamps: { unavailableDate: '2026-09-25T10:00:00Z' } }).pending_at, '2026-09-25');
  assert.equal(normalizeRepliers({ mlsNumber: 'Y', status: 'A', details: { sqft: '1500-1999' } }).sqft, 1749.5);
});
