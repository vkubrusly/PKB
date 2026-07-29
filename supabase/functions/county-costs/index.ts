// =============================================================================
// county-costs — regional intelligence for an estimate. Given a Florida county
// and the project's water/sewer choice, returns the costs that DON'T come from
// a reference model and vary by location / system:
//   • impact fees (county-specific, by house size)
//   • building permit fee
//   • water system  — well (drill + pump) OR municipal tap/connection
//   • sewer system  — septic / nitrogen-reducing septic OR municipal tap
//
// These are merged into the generated estimate so switching a project to
// "well" or a different county actually changes the numbers.
//
// Body: { county, state?, water, sewer, level, living_sf, total_sf }
//   water: 'municipal' | 'well'      sewer: 'municipal' | 'septic' | 'septic_nitrogen'
// Env:  ANTHROPIC_API_KEY
// Deploy: supabase functions deploy county-costs
// =============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { cors, json, parseJson } from '../_shared/cors.ts';
import { aiErrorMessage, createJsonWithWeb } from '../_shared/ai.ts';

interface Result {
  county: string | null;
  impact_fees: number | null;      // total county impact fees for this house
  impact_breakdown: string | null; // short text: schools/roads/parks…
  building_permit: number | null;
  water: { description: string; cost: number } | null;
  sewer: { description: string; cost: number } | null;
  notes: string;
  confidence: 'high' | 'medium' | 'low';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada' }, 500);

    const b = await req.json();
    const county = (b.county || '').trim();
    if (!county) return json({ error: 'county é obrigatório' }, 400);
    const state = (b.state || 'FL').trim();
    const water = b.water || 'municipal';   // 'municipal' | 'well'
    const sewer = b.sewer || 'municipal';   // 'municipal' | 'septic' | 'septic_nitrogen'

    const anthropic = new Anthropic({ apiKey });
    const params = {
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text:
`You are a Florida residential permitting & site-costs expert. For a NEW single-family home give the
LOCATION- and SYSTEM-specific costs (USD) that don't come from a construction template.
When you have the web_search tool, SEARCH for this county's CURRENT impact fee schedule, building permit
fees, and typical well-drilling / septic install prices — impact fees change and vary a lot by county.

Project:
- County: ${county}, ${state}
- Living area: ${b.living_sf ?? '?'} sf, total constructed: ${b.total_sf ?? '?'} sf, spec level: ${b.level ?? 'essential'}
- Water source: ${water}
- Sewer: ${sewer}

Return, using your best current knowledge of THIS county (fees vary a lot by county):
- impact_fees: TOTAL county impact/mobility/school/park fees for a home this size (single number).
- impact_breakdown: one short line naming the main components.
- building_permit: typical building permit fee for this county & house size.
- water:
    * if water = "well": cost to DRILL a residential well + pump + pressure tank/hookup.
    * if water = "municipal": water tap / meter / connection (impact) fee.
  Give {description, cost}.
- sewer:
    * "septic": conventional septic system (tank + drainfield) installed.
    * "septic_nitrogen": nitrogen-reducing / advanced septic (higher — required in some FL areas/BMAP zones).
    * "municipal": sewer tap / connection fee.
  Give {description, cost}.
Use realistic ${state} numbers. If a county figure is uncertain, give a reasonable regional estimate and
lower the confidence; never return null for a cost that applies. Explain assumptions briefly in notes.

Respond with ONLY this JSON:
{"county": <str>, "impact_fees": <num>, "impact_breakdown": <str>, "building_permit": <num>,
 "water": {"description": <str>, "cost": <num>}, "sewer": {"description": <str>, "cost": <num>},
 "notes": <str>, "confidence": "high"|"medium"|"low"}`,
        }],
      }],
    };
    const { result, model, usedWeb } = await createJsonWithWeb<Result>(
      anthropic, params, (t) => parseJson<Result>(t), { maxUses: 4 },
    );
    return json({ result, model, used_web: usedWeb });
  } catch (e) {
    return json({ error: aiErrorMessage(e) }, 500);
  }
});
