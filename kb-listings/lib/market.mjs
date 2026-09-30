// Market math over kb.market_comps rows — pure functions, shared by the weekly report and the
// product-suggestion analysis.

export const median = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
export const ppsf = (c) => {
  const price = c.status === 'sold' ? c.sold_price ?? c.list_price : c.list_price;
  return price && c.sqft ? Number(price) / Number(c.sqft) : null;
};
const day = (d) => (d ? String(d).slice(0, 10) : null);
const inRange = (d, from, to) => !!d && day(d) >= from && day(d) < to;

// Which comps belong to a listing's market: its market_filter, or its own zip.
export function inMarket(listing, c) {
  const f = listing.market_filter || {};
  const list = (k) => (f[k] || []).map((s) => String(s).toLowerCase());
  if (list('subdivisions').length) return list('subdivisions').includes(String(c.subdivision || '').toLowerCase());
  if (list('zips').length) return list('zips').includes(String(c.zip || ''));
  if (list('cities').length) return list('cities').includes(String(c.city || '').toLowerCase());
  return !!listing.zip && String(c.zip || '') === String(listing.zip);
}
export const areaLabel = (l) => {
  const f = l.market_filter || {};
  return (f.subdivisions?.length && f.subdivisions.join(', ')) || (f.zips?.length && `ZIP ${f.zips.join(', ')}`)
    || (f.cities?.length && f.cities.join(', ')) || (l.zip ? `ZIP ${l.zip}` : l.city || '—');
};

// "Similar" = same area, heated sqft within ±25 % and beds within ±1 of the listing.
export const similar = (l, c) => (!l.sqft || !c.sqft || Math.abs(c.sqft - l.sqft) / l.sqft <= 0.25) && (!l.beds || !c.beds || Math.abs(c.beds - l.beds) <= 1);

export function weekMarket(listing, comps, from, to) {
  const area = comps.filter((c) => inMarket(listing, c) && c.mls_number !== listing.mls_number);
  const pending = area.filter((c) => inRange(c.pending_at, from, to) && ['pending', 'sold'].includes(c.status));
  const sold = area.filter((c) => c.status === 'sold' && inRange(c.sold_at, from, to));
  const active = area.filter((c) => c.status === 'active');
  const sold90 = area.filter((c) => c.status === 'sold' && c.sold_at && (new Date(to) - new Date(c.sold_at)) / 864e5 <= 90);
  const comp = sold90.filter((c) => similar(listing, c));
  const row = (c) => ({ address: c.address, status: c.status, beds: c.beds, baths: c.baths, sqft: c.sqft,
    price: c.status === 'sold' ? c.sold_price ?? c.list_price : c.list_price, ppsf: ppsf(c) && Math.round(ppsf(c)), dom: c.dom });
  return {
    area: areaLabel(listing),
    pending_week: pending.length, sold_week: sold.length, active_now: active.length,
    pending_list: pending.slice(0, 8).map(row), sold_list: sold.slice(0, 8).map(row),
    active_median_ppsf: round(median(active.map(ppsf))),
    sold90_count: sold90.length, sold90_median_ppsf: round(median(sold90.map(ppsf))), sold90_median_dom: round(median(sold90.map((c) => c.dom))),
    similar_sold90: comp.length, similar_median_ppsf: round(median(comp.map(ppsf))), similar_median_price: round(median(comp.map((c) => c.sold_price))),
    // months of inventory: active ÷ average monthly sales over 90 days
    months_of_inventory: sold90.length ? Math.round((active.length / (sold90.length / 3)) * 10) / 10 : null,
  };
}
const round = (x) => (x == null ? null : Math.round(x));

// ---------- product suggestions ----------
export const SIZE_BUCKETS = [[0, 1200], [1200, 1500], [1500, 1800], [1800, 2100], [2100, 2500], [2500, 3000], [3000, 1e9]];
export const sizeBucket = (sf) => {
  const b = SIZE_BUCKETS.find(([a, z]) => sf >= a && sf < z);
  return b ? (b[1] >= 1e9 ? `${b[0]}+ sf` : `${b[0]}–${b[1]} sf`) : null;
};
const config = (c) => (c.beds ? `${c.beds}/${c.baths ?? '?'}` : null);

// Groups of recently sold/pending homes compared on speed (DOM), volume and $/sf. `absorbed`
// = sold + pending in the window; sell-through = absorbed ÷ (absorbed + active of that group).
export function groupStats(rows, keyFn, activeRows) {
  const g = new Map();
  for (const c of rows) { const k = keyFn(c); if (!k) continue; (g.get(k) || g.set(k, []).get(k)).push(c); }
  const act = new Map();
  for (const c of activeRows) { const k = keyFn(c); if (k) act.set(k, (act.get(k) || 0) + 1); }
  return [...g.entries()].map(([key, cs]) => ({
    key, n: cs.length, active: act.get(key) || 0,
    sell_through: Math.round((cs.length / (cs.length + (act.get(key) || 0))) * 100),
    median_dom: round(median(cs.map((c) => c.dom))),
    median_price: round(median(cs.map((c) => c.sold_price ?? c.list_price))),
    median_ppsf: round(median(cs.map(ppsf))),
    median_sqft: round(median(cs.map((c) => c.sqft))),
    share: Math.round((cs.length / rows.length) * 100),
  }));
}

// Best group: enough sample, then fastest (DOM) with volume as the tie-breaker.
const best = (groups, minN) => groups.filter((x) => x.n >= minN).sort((a, b) => (a.median_dom ?? 999) - (b.median_dom ?? 999) || b.n - a.n)[0];
const fmt = (n) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);

export function productSuggestions(areaName, comps, { days = 180, today = new Date(), minN = 3 } = {}) {
  const since = new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);
  const absorbed = comps.filter((c) => (c.status === 'sold' && day(c.sold_at) >= since) || (c.status === 'pending' && (day(c.pending_at) || since) >= since));
  const active = comps.filter((c) => c.status === 'active');
  if (absorbed.length < minN) return [];
  const out = [];
  const add = (kind, g, title, detail, extra = {}) => g && out.push({ key: `${areaName}|${kind}`, area: areaName, kind, title, detail, evidence: { ...g, days, sample: absorbed.length, ...extra } });

  const byCfg = groupStats(absorbed, config, active);
  const cfg = best(byCfg, minN);
  add('floor_plan', cfg, `Planta ${cfg?.key} é a que gira mais rápido em ${areaName}`,
    cfg && `${cfg.n} vendidas/pending em ${days} dias (${cfg.share}% do mercado), DOM mediano ${cfg.median_dom ?? '—'} dias, ${cfg.median_ppsf ? `${fmt(cfg.median_ppsf)}/sf` : ''}, preço mediano ${fmt(cfg.median_price)}; sell-through ${cfg.sell_through}% (${cfg.active} ativas concorrendo).`,
    { all: byCfg.sort((a, b) => b.n - a.n).slice(0, 6) });

  const bySize = groupStats(absorbed.filter((c) => c.sqft), (c) => sizeBucket(Number(c.sqft)), active.filter((c) => c.sqft));
  const size = best(bySize, minN);
  add('size', size, `Faixa de ${size?.key} tem a melhor absorção`,
    size && `${size.n} negócios, DOM mediano ${size.median_dom ?? '—'} dias, ${fmt(size.median_ppsf)}/sf, preço mediano ${fmt(size.median_price)}.`,
    { all: bySize.sort((a, b) => a.key.localeCompare(b.key)) });

  const band = (c) => { const p = c.sold_price ?? c.list_price; return p ? `${fmt(Math.floor(p / 50000) * 50000)}–${fmt(Math.floor(p / 50000) * 50000 + 50000)}` : null; };
  const byBand = groupStats(absorbed, band, active);
  const pb = byBand.filter((x) => x.n >= minN).sort((a, b) => b.n - a.n || (a.median_dom ?? 999) - (b.median_dom ?? 999))[0];
  add('price_band', pb, `Faixa de preço mais líquida: ${pb?.key}`,
    pb && `${pb.n} negócios (${pb.share}%), DOM mediano ${pb.median_dom ?? '—'} dias, ${pb.active} ativas hoje na mesma faixa (sell-through ${pb.sell_through}%).`);

  const year = today.getFullYear();
  const isNew = (c) => c.year_built && c.year_built >= year - 2;
  const nc = absorbed.filter(isNew), resale = absorbed.filter((c) => !isNew(c));
  if (nc.length >= minN && resale.length >= minN) {
    const n = { n: nc.length, median_ppsf: round(median(nc.map(ppsf))), median_dom: round(median(nc.map((c) => c.dom))) };
    const r = { n: resale.length, median_ppsf: round(median(resale.map(ppsf))), median_dom: round(median(resale.map((c) => c.dom))) };
    const prem = n.median_ppsf && r.median_ppsf ? Math.round((n.median_ppsf / r.median_ppsf - 1) * 100) : null;
    add('new_construction', n, `Construção nova: ${fmt(n.median_ppsf)}/sf${prem != null ? ` (${prem >= 0 ? '+' : ''}${prem}% vs. usado)` : ''}`,
      `Nova (≥${year - 2}): ${n.n} negócios, DOM ${n.median_dom ?? '—'} d · Usado: ${r.n} negócios, ${fmt(r.median_ppsf)}/sf, DOM ${r.median_dom ?? '—'} d.`, { resale: r });
  }
  for (const [feat, has] of [['pool', (c) => c.pool === true], ['garage_2', (c) => (c.garage ?? 0) >= 2]]) {
    const w = absorbed.filter(has), wo = absorbed.filter((c) => !has(c) && (feat !== 'pool' || c.pool === false));
    if (w.length >= minN && wo.length >= minN) {
      const a = round(median(w.map(ppsf))), b = round(median(wo.map(ppsf)));
      if (a && b) add(`feature_${feat}`, { n: w.length, median_ppsf: a, median_dom: round(median(w.map((c) => c.dom))) },
        `${feat === 'pool' ? 'Piscina' : 'Garagem 2+ carros'}: ${a >= b ? '+' : ''}${Math.round((a / b - 1) * 100)}% no $/sf`,
        `Com: ${w.length} negócios a ${fmt(a)}/sf · Sem: ${wo.length} a ${fmt(b)}/sf.`, { without: { n: wo.length, median_ppsf: b } });
    }
  }
  return out;
}
