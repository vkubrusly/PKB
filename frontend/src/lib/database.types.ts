// Hand-written types mirroring supabase/migrations. Keep in sync with the schema
// (or regenerate later with `supabase gen types typescript`).

export type SpecLevel = 'affordable' | 'essential' | 'signature' | 'luxury' | 'any';
export type PriceSource = 'catalog' | 'quote' | 'web' | 'invoice' | 'estimated';
export type WaterSource = 'municipal' | 'well';
export type SewerType = 'municipal' | 'septic' | 'septic_nitrogen';
export type ContractType = 'fixed_price' | 'cost_plus';
export type EstimateStatus = 'draft' | 'approved' | 'superseded';
export type Unit =
  | 'ea' | 'sf' | 'lf' | 'cy' | 'ls' | 'hr' | 'gal' | 'sq' | 'ton' | 'bid' | 'mo';

export interface Org { id: string; name: string; created_at: string; }

export interface WbsNode {
  code: string;
  parent_code: string | null;
  name: string;
  depth: number;
  sort_order: number;
  is_leaf: boolean;
}

export interface Supplier {
  id: string;
  org_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
  is_preferred: boolean;
  created_at: string;
  updated_at: string;
}

export interface Material {
  id: string;
  org_id: string;
  wbs_code: string | null;
  spec_level: SpecLevel;
  name: string;
  brand: string | null;
  model: string | null;
  unit: Unit;
  specs: string | null;
  memorial: string | null;
  fl_approval: string | null;
  photo_path: string | null;
  preferred_supplier_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SpecLevelRow {
  id: string;
  org_id: string;
  level: Exclude<SpecLevel, 'any'>;
  base_model: string | null;
  county: string | null;
  target_psf_low: number | null;
  target_psf_high: number | null;
  description: string | null;
}

// Room program (counts) from the deep plan analysis — drives multi-factor scaling.
export interface Program {
  bedrooms: number;
  full_baths: number;
  half_baths: number;
  kitchens: number;
  laundries: number;
  garage_bays: number;
  stories: number;
  doors: number;
  windows: number;
  has_inlaw: boolean;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  base_model: string | null;
  county: string | null;
  address: string | null;
  market: string | null;
  living_area_sf: number | null;
  total_area_sf: number | null;
  wind_speed_mph: number | null;
  flood_zone: string | null;
  water: WaterSource | null;
  sewer: SewerType | null;
  contract: ContractType | null;
  initial_level: SpecLevel | null;
  arv: number | null;
  program: Program | null;
  created_at: string;
  updated_at: string;
}

export interface Estimate {
  id: string;
  org_id: string;
  project_id: string;
  level: Exclude<SpecLevel, 'any'>;
  version: number;
  status: EstimateStatus;
  contingency_pct: number;
  markup_pct: number;
  valid_until: string | null;
  notes: string | null;
  created_at: string;
}

export interface EstimateItem {
  id: string;
  org_id: string;
  estimate_id: string;
  wbs_code: string;
  line_code: string | null;
  material_id: string | null;
  supplier_id: string | null;
  description: string | null;
  qty: number;
  unit: Unit;
  unit_cost: number;               // initial base estimate
  actual_unit_cost: number | null; // real quoted/negotiated price
  waste_factor: number;
  price_source: PriceSource;
  needs_review: boolean;
  is_allowance: boolean;
  sort_order: number;
  qty_effective: number;
  line_total: number;
}

export interface EstimateItemFile {
  id: string;
  org_id: string;
  estimate_item_id: string;
  file_path: string;
  file_name: string | null;
  supplier: string | null;
  is_chosen: boolean;
  created_at: string;
}
