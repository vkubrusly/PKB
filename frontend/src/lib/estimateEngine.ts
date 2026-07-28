// Parametric (model-based) estimate generation — mirrors scripts/estimate_engine.mjs.
// Scales a reference model's line costs to new areas. Every generated line is
// flagged needs_review: it is an estimate, not a measured takeoff (§4.4).

import type { EstimateItem, Unit } from './database.types';

export type Basis = 'fixed' | 'living' | 'total';

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
  basis: Basis;
  factor: number;
  line_total: number;
  needs_review: boolean;
  price_source: 'estimated';
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function scaleFactor(basis: Basis, ref: Areas, target: Areas): number {
  if (basis === 'living') return ref.living_sf ? target.living_sf / ref.living_sf : 1;
  if (basis === 'total') return ref.total_sf ? target.total_sf / ref.total_sf : 1;
  return 1;
}

export function generateEstimate(
  refItems: RefLine[], basisByLine: Record<string, Basis>, ref: Areas, target: Areas,
): { lines: GeneratedLine[]; total: number } {
  const lines = refItems.map((it) => {
    const basis = (it.line_code && basisByLine[it.line_code]) || 'fixed';
    const factor = scaleFactor(basis, ref, target);
    const unit_cost = round2(it.unit_cost * factor);
    return {
      ...it, basis, factor: round2(factor), unit_cost,
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

// Default per-line scaling basis for the Sunny reference model (data/sunny_affordable/
// quantity_model.json). Engineering defaults, editable later per model. Unlisted → fixed.
export const SUNNY_BASIS: Record<string, Basis> = {
  '1.1.9': 'living', '1.1.10': 'living', '1.3.2': 'total',
  '2.2': 'total', '2.3': 'total',
  '3.1.1': 'total', '3.1.2': 'total', '3.1.4': 'total',
  '3.2.1': 'total', '3.2.2': 'total', '3.2.3': 'total', '3.2.4': 'total',
  '3.3.1': 'total', '3.3.2': 'total', '3.3.3': 'total',
  '3.4.1': 'living', '3.4.2': 'living', '3.4.3': 'living', '3.4.4': 'living',
  '3.5.1': 'total', '3.6.1': 'total', '3.7.1': 'total',
  '4.1.1': 'living', '4.2.1': 'living', '4.3.1': 'living',
  '5.1': 'living', '6.1': 'living', '6.2': 'living',
  '7.1': 'living', '7.2': 'living', '7.3': 'living', '7.4': 'living',
  '8.1': 'living', '8.2': 'living',
  '12.1': 'living', '12.2': 'living', '12.3': 'living',
  '15.1': 'total', '19.1': 'living',
};
