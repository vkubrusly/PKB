// =============================================================================
// PKB Homes cost book — real, calibrated Central Florida costs (orçado vs
// realizado), provided by the company. Two uses:
//   • COUNTY_TABLE — deterministic regional fees (impact, permit, water, sewer,
//     wind) for counties we have data for → exact, instant, no AI guessing.
//   • PKB_COSTBOOK — the full knowledge base injected as grounding into the AI
//     estimate so it anchors to PKB's realized numbers, benchmarks and rules.
// Update these as the company's history grows.
// =============================================================================

export interface CountyRow {
  keys: string[];        // lowercase substrings that identify this region
  name: string;
  impact: number;        // county impact fees (owner cost, but tracked)
  permit: number;        // typical building permit
  water_muni: number;    // municipal water connection
  well: number;          // drill well + pump + tank
  septic: number;        // conventional septic
  septic_n: number;      // nitrogen-reducing septic
  sewer_muni: number;    // municipal sewer tap
  wind: number;          // design wind speed (mph)
}

// Ordered: put more specific matches first.
export const COUNTY_TABLE: CountyRow[] = [
  { keys: ['marion oaks', 'marion'], name: 'Marion Oaks (Marion Co)', impact: 10300, permit: 1600,
    water_muni: 2758, well: 10000, septic: 10500, septic_n: 10500, sewer_muni: 2000, wind: 140 },
  { keys: ['citrus springs', 'citrus'], name: 'Citrus Springs (Citrus Co)', impact: 18612, permit: 1600,
    water_muni: 2679, well: 10000, septic: 10500, septic_n: 10500, sewer_muni: 2000, wind: 150 },
  { keys: ['winter park'], name: 'Winter Park (Orange Co)', impact: 28750, permit: 3000,
    water_muni: 3000, well: 10000, septic: 6500, septic_n: 10500, sewer_muni: 2000, wind: 139 },
  { keys: ['orange', 'orlando'], name: 'Orange Co / Orlando', impact: 26000, permit: 2500,
    water_muni: 3000, well: 10000, septic: 6500, septic_n: 10500, sewer_muni: 2000, wind: 140 },
  { keys: ['tavares', 'lake'], name: 'Lake Co / Tavares', impact: 7000, permit: 1600,
    water_muni: 2800, well: 10000, septic: 6500, septic_n: 10500, sewer_muni: 2000, wind: 140 },
];

export function lookupCounty(county?: string, market?: string): CountyRow | null {
  const hay = `${county ?? ''} ${market ?? ''}`.toLowerCase();
  return COUNTY_TABLE.find((r) => r.keys.some((k) => hay.includes(k))) ?? null;
}

// Build a county-costs result from a known region + the user's water/sewer choice.
export function regionalFromRow(row: CountyRow, water: string, sewer: string) {
  const isWell = water === 'well';
  const w = { description: isWell ? 'Poço (perfuração + bomba + tanque de pressão)' : 'Conexão de água municipal', cost: isWell ? row.well : row.water_muni };
  let s: { description: string; cost: number };
  if (sewer === 'septic') s = { description: 'Sistema séptico convencional', cost: row.septic };
  else if (sewer === 'septic_nitrogen') s = { description: 'Séptico com redução de nitrogênio', cost: row.septic_n };
  else s = { description: 'Conexão de esgoto municipal', cost: row.sewer_muni };
  return {
    county: row.name,
    impact_fees: row.impact,
    impact_breakdown: 'PKB cost book (histórico calibrado Central FL)',
    building_permit: row.permit,
    water: w,
    sewer: s,
    notes: `Valores da base de custos PKB (Central FL, jun/2026). Wind ${row.wind} mph.`,
    confidence: 'high' as const,
  };
}

// Grounding text for the AI estimate — PKB's realized costs, benchmarks & rules.
export const PKB_COSTBOOK = `PKB HOMES COST BOOK (real, calibrated Central Florida — jun/2026). Anchor to THESE numbers.

BENCHMARKS ($/sf living, WITH builder fee):
- Essential (CMU 1-story, vinyl windows, LVP, stock cabinets): $110–$115/sf (Sunny 1,820sf=$202k; Maya 1,872sf=$206k)
- Essential 2-story: $115–$125/sf
- Signature (PGT impact windows black, LVP premium, semi-custom cabinets, Kohler): $200–$225/sf
- Luxury (EERO/VIKOS, hardwood, custom cabinets, premium master bath): $260–$340/sf
- Multifamily townhouse (wood frame 2-story, NFPA 13R sprinkler): $110/sf
- Duplex Essential: $111–$133/sf
Rule: smaller house = higher $/sf (fixed costs dilute less). ~1,900sf w/ in-law: $127–131/sf.

VALIDATED UNIT COSTS (use REALIZED as base; Sunny/Marion Oaks 2026, ~1,820sf living, 2 bath, 1 kitchen):
Permits&Inspections $1,593; Fee permits run $1,750; Power connection $1,312; Water connection $2,758;
Drawings/Civil eng $3,500; Surveyors $1,600; Dumpster $1,540; Clearing lot $3,300; Fill dirt $250/load;
Mono slab ~$6.05/sf ($13,770 for 2,275sf); Lintel&block $9,532; Fill cells $850; Block labor $4,500;
Roof trusses $6,300; Framing&roof labor $6,329; Framing material $5,191; Ext doors&sliding $2,216;
Windows (11 vinyl) $1,954; Windows/doors labor $1,419; Stucco $4,300; Shingle roofing $7,300;
Soffit/fascia $1,300; HVAC (1 system ~1,800sf) $8,156; Plumbing (2 bath) $8,036; Electrical $5,200;
Insulation $1,625; Drywall mat+labor $8,650; Doors&baseboard $4,303; Trim+doors labor $1,225;
Paint mat+labor $4,500; Cabinets+countertop+backsplash $5,050; Vinyl floor $4,260; Tiles $956 mat/$900 labor;
Paver $1,175; Epoxy garage $450; Garage door+opener $1,950; Appliances (basic kit) $2,826;
Final grading $600; Driveway $5,510; Irrigation $994; Landscaping/Bahia sod $5,500–6,000 min; Final cleaning $350.

BUILDER FEE (section 21 Administration):
- Essential up to ~$250k: FIXED $25,000.
- Premium/Luxury: 15–18% of construction cost.
- Multifamily: 15% of real cost.
- Fee does NOT apply to owner items (impact fees, utility connection fees, fire marshal fees) — those are Change Orders without fee.

PREMIUM MULTIPLIERS (Essential → Luxury): cabinets $5k→$68–123k; windows vinyl $2k→PGT impact black $35k→EERO $65k;
flooring LVP $4.9k→hardwood $22–38k; appliances $2,650→$12–25k; paint $4.5k→$15–28k; lighting $1.1k→$12k(Signature allowance)→$22–95k;
admin $25k→$90–135k.

SPECIFIC ADD-ONS:
- In-law suite (2nd full kitchen): +$10,555 (plumbing $2,500 + cabinets $4,500 + appliances w/ fridge $2,755 + trim $800).
- Additional half bath: +$800 plumbing. Additional full bath: +$3,500.
- 2-story premium: 2nd-floor I-joist $14–18k + stair + extra framing ≈ +12–15% structure.
- Wind 150 mph (vs 140): +5% block, +3% framing/straps.
- Duplex/TH party wall (1-hr fire): 5/8" Type X + acoustic insulation.
- Sprinkler NFPA 13R (multifamily): $5.50/sf — MANDATORY.
- Pool + deck: $72–90k (section 22). Summer kitchen: $5k basic / $8–22k premium.
- Smart home: pre-wire $2k / base $8–15k / full $40–60k.

GOLDEN RULES:
1) 22 standard sections; upgrades ALWAYS in section 22.
2) $/sf refers ONLY to physical construction — impact fees & utility fees are owner Change Orders without fee.
3) Punch list: 1.5–2% of construction cost on projects >$500k (not a $450 flat).
4) Smaller house = higher $/sf; tell the client.
5) Always present a range (base → full spec).`;
