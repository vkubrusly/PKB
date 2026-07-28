#!/usr/bin/env node
// =============================================================================
// estimate_engine.mjs — parametric (model-based) estimate generation.
//
// Given a REFERENCE model's line items + a per-line scaling basis, produce a
// new estimate for target areas by scaling each line:
//   basis 'fixed'  → cost carries over unchanged
//   basis 'living' → cost × (targetLiving / refLiving)
//   basis 'total'  → cost × (targetTotal  / refTotal)
//
// This answers "estimativa de custo" instantly for a repeat model. Every
// generated line is flagged needs_review (§4.4) — it is an estimate, not a
// measured takeoff. Material COUNTS (drywall sf, block count) require the
// AI plan-takeoff path or PKB consumption factors; this engine scales cost.
//
// The frontend mirrors this logic in src/lib/estimateEngine.ts — keep in sync.
// =============================================================================

const round2 = (x) => Math.round(x * 100) / 100;

// factor for a basis given ref/target areas
export function scaleFactor(basis, ref, target) {
  if (basis === 'living') return ref.living_sf ? target.living_sf / ref.living_sf : 1;
  if (basis === 'total') return ref.total_sf ? target.total_sf / ref.total_sf : 1;
  return 1; // 'fixed' or unknown
}

// refItems: [{ line_code, wbs_code, item_name, qty, unit, unit_cost }]
// basisByLine: { [line_code]: 'fixed'|'living'|'total' }
// ref/target: { living_sf, total_sf }
export function generateEstimate({ refItems, basisByLine, ref, target }) {
  const lines = refItems.map((it) => {
    const basis = basisByLine[it.line_code] ?? 'fixed';
    const factor = scaleFactor(basis, ref, target);
    const unit_cost = round2(it.unit_cost * factor);
    return {
      line_code: it.line_code,
      wbs_code: it.wbs_code,
      description: it.item_name,
      qty: it.qty,
      unit: it.unit,
      unit_cost,
      basis,
      factor: round2(factor),
      line_total: round2(it.qty * unit_cost),
      needs_review: true,
      price_source: 'estimated',
    };
  });
  const total = round2(lines.reduce((s, l) => s + l.line_total, 0));
  return { lines, total };
}

// ---- CLI: node estimate_engine.mjs <folder> <living> <total> ----------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const folder = process.argv[2];
  const targetLiving = Number(process.argv[3]);
  const targetTotal = Number(process.argv[4]);
  if (!folder || !targetLiving || !targetTotal) {
    console.error('usage: node scripts/estimate_engine.mjs <folder> <living_sf> <total_sf>');
    process.exit(2);
  }
  function parseCsv(t){const r=[];let row=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}else if(c==='"')q=true;else if(c===','){row.push(f);f='';}else if(c==='\n'){row.push(f);r.push(row);row=[];f='';}else if(c==='\r'){}else f+=c;}if(f.length||row.length){row.push(f);r.push(row);}return r.filter(x=>x.length>1);}
  const csv = parseCsv(readFileSync(join(folder, 'estimate.csv'), 'utf8'));
  const h = csv[0].map((s) => s.trim());
  const ix = Object.fromEntries(h.map((c, i) => [c, i]));
  const refItems = csv.slice(1).map((r) => ({
    line_code: r[ix.line_code].trim(), wbs_code: r[ix.wbs_code].trim(),
    item_name: r[ix.item_name].trim(), qty: Number(r[ix.qty]),
    unit: r[ix.unit].trim(), unit_cost: Number(r[ix.unit_cost]),
  }));
  const qm = JSON.parse(readFileSync(join(folder, 'quantity_model.json'), 'utf8'));
  const out = generateEstimate({
    refItems, basisByLine: qm.basis_by_line, ref: qm.reference,
    target: { living_sf: targetLiving, total_sf: targetTotal },
  });
  console.log(JSON.stringify({ target: { targetLiving, targetTotal }, total: out.total, lines: out.lines.length }, null, 2));
}
