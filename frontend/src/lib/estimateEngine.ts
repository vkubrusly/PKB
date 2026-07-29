// Parametric (model-based) estimate generation — MULTI-DRIVER.
//
// A reference model is scaled to a new house line-by-line, each WBS category by
// its real COST DRIVER, not by area alone:
//   • area (living/total sf): slab, framing, roof, drywall, paint, flooring…
//   • kitchen (count):        cabinetry, counter tops, appliances
//   • bath (count):           plumbing fixtures
//   • opening (doors+windows):exterior/interior doors & windows
//   • garage (bays):          garage door
//   • fixed (per house):      permits, impact fees, driveway, septic, landscaping
//
// This is what lets a house with a 2nd kitchen / extra bath cost more than the
// reference even when its area is nearly the same. Every line is needs_review.

import type { EstimateItem, Program, Unit } from './database.types';

export type Driver = 'fixed' | 'living' | 'total' | 'kitchen' | 'bath' | 'bedroom' | 'opening' | 'garage';

export interface Areas { living_sf: number; total_sf: number; }

export interface RefLine {
  line_code: string | null;
  wbs_code: string;
  description: string;
  qty: number;
  unit: Unit;
  unit_cost: number;
}

export interface GeneratedLine extends RefLine {
  basis: Driver;
  factor: number;
  line_total: number;
  needs_review: boolean;
  price_source: 'estimated';
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// Default driver per top-level WBS category (1–22).
export const DRIVER_BY_CATEGORY: Record<string, Driver> = {
  '1': 'fixed',    // Planning & Preconstruction (permits, impact fees)
  '2': 'total',    // Site Work
  '3': 'total',    // Shell Construction (slab, wall, framing, stucco, roof, soffit)
  '4': 'living',   // M.P.E.G. (HVAC, plumbing, electrical)
  '5': 'living',   // Insulation
  '6': 'living',   // Drywall
  '7': 'opening',  // Interior Doors / Trims
  '8': 'living',   // Paint
  '9': 'kitchen',  // Cabinetry / Counter Top
  '10': 'living',  // Hardware
  '11': 'fixed',   // Sewer / Water Treatment
  '12': 'living',  // Flooring
  '13': 'garage',  // Garage Door
  '14': 'kitchen', // Appliances
  '15': 'total',   // Final Grading
  '16': 'fixed',   // Driveway
  '17': 'fixed',   // Irrigation
  '18': 'fixed',   // Landscaping
  '19': 'living',  // Clean-Up
  '20': 'fixed',   // Punch List / Contingency
  '21': 'fixed',   // Administration Fee
  '22': 'fixed',   // Upgrades
};

// Sub-category overrides (matched by code prefix; most specific wins).
export const DRIVER_BY_LINE: Record<string, Driver> = {
  '3.4': 'opening', // Windows & Exterior Doors
  '4.2': 'bath',    // Plumbing (fixtures scale with bathrooms/kitchens)
};

export function resolveDriver(lineCode: string | null, wbsCode: string): Driver {
  const code = (lineCode || wbsCode || '').trim();
  let best: Driver | undefined;
  let bestLen = -1;
  for (const [k, v] of Object.entries(DRIVER_BY_LINE)) {
    if ((code === k || code.startsWith(k + '.')) && k.length > bestLen) { best = v; bestLen = k.length; }
  }
  if (best) return best;
  return DRIVER_BY_CATEGORY[code.split('.')[0]] ?? 'fixed';
}

function baths(p: Program | null): number {
  return p ? p.full_baths + 0.5 * (p.half_baths || 0) : 0;
}

// Numeric value of a driver for a given house (area + program). 0 = unknown.
function driverValue(d: Driver, a: Areas, p: Program | null): number {
  switch (d) {
    case 'living': return a.living_sf;
    case 'total': return a.total_sf;
    case 'kitchen': return p?.kitchens ?? 0;
    case 'bath': return baths(p);
    case 'bedroom': return p?.bedrooms ?? 0;
    case 'opening': return p ? (p.doors || 0) + (p.windows || 0) : 0;
    case 'garage': return p?.garage_bays ?? 0;
    case 'fixed': return 1;
  }
}

// Scale ratio for a driver. Count drivers fall back to the total-area ratio when
// either program lacks that count, so a missing program never zeroes a line.
export function driverRatio(
  d: Driver, refA: Areas, refP: Program | null, tgtA: Areas, tgtP: Program | null,
): number {
  if (d === 'fixed') return 1;
  const areaRatio = refA.total_sf ? tgtA.total_sf / refA.total_sf : 1;
  if (d === 'living') return refA.living_sf ? tgtA.living_sf / refA.living_sf : 1;
  if (d === 'total') return areaRatio;
  const rv = driverValue(d, refA, refP);
  const tv = driverValue(d, tgtA, tgtP);
  if (rv > 0 && tv > 0) return tv / rv;
  return areaRatio; // program incomplete → behave like area scaling
}

export function generateFromProgram(
  refItems: RefLine[], refA: Areas, refP: Program | null,
  tgtA: Areas, tgtP: Program | null,
  driverOverride?: Record<string, Driver>,
): { lines: GeneratedLine[]; total: number } {
  const lines = refItems.map((it) => {
    const driver = (it.line_code && driverOverride?.[it.line_code]) || resolveDriver(it.line_code, it.wbs_code);
    const factor = driverRatio(driver, refA, refP, tgtA, tgtP);
    const unit_cost = round2(it.unit_cost * factor);
    return {
      ...it, basis: driver, factor: round2(factor), unit_cost,
      line_total: round2(it.qty * unit_cost),
      needs_review: true, price_source: 'estimated' as const,
    };
  });
  const total = round2(lines.reduce((s, l) => s + l.line_total, 0));
  return { lines, total };
}

// Turn DB estimate_items (of a reference estimate) into RefLine[] for the engine.
export function toRefLines(items: EstimateItem[]): RefLine[] {
  return items.map((it) => ({
    line_code: it.line_code,
    wbs_code: it.wbs_code,
    description: it.description ?? it.wbs_code,
    qty: Number(it.qty),
    unit: it.unit,
    unit_cost: Number(it.unit_cost),
  }));
}

// A blank program (all zeros) — used when a project hasn't been analyzed yet.
export const EMPTY_PROGRAM: Program = {
  bedrooms: 0, full_baths: 0, half_baths: 0, kitchens: 0, laundries: 0,
  garage_bays: 0, stories: 1, doors: 0, windows: 0, has_inlaw: false,
};
