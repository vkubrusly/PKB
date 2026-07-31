// =============================================================================
// estimate-market — generate a full estimate for a house that has NO reference
// model, blending:
//   1) INTERNAL price history — the org's own estimate_items + material_prices,
//      aggregated into a "price book" (typical unit cost per line / category,
//      split by spec level where available);
//   2) the model's MARKET knowledge for lines with thin/no internal data,
//      adjusted to the project's level, size and Florida county.
//
// Every line comes back needs_review with an `origin` tag (internal | market |
// estimated) so the estimator sees where each number came from.
//
// Body: { org_id, project: { county, market, level, living_sf, total_sf, program } }
// Env:  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy: supabase functions deploy estimate-market
// =============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors, json } from '../_shared/cors.ts';
import { aiErrorMessage, createViaTool } from '../_shared/ai.ts';
import { PKB_COSTBOOK } from '../_shared/costbook.ts';

interface Line {
  line_code: string | null;
  wbs_code: string;
  description: string;
  qty: number;
  unit: string;
  unit_cost: number;
  origin: 'internal' | 'market' | 'estimated';
  note: string;
}
interface Result { lines: Line[]; notes: string; confidence: 'high' | 'medium' | 'low'; }

const RESULT_TOOL = {
  name: 'emit_estimate',
  description: 'Return the complete construction estimate as structured line items.',
  input_schema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line_code: { type: ['string', 'null'] },
            wbs_code: { type: 'string' },
            description: { type: 'string' },
            qty: { type: 'number' },
            unit: { type: 'string' },
            unit_cost: { type: 'number' },
            origin: { type: 'string', enum: ['internal', 'market', 'estimated'] },
            note: { type: 'string' },
          },
          required: ['wbs_code', 'description', 'qty', 'unit', 'unit_cost', 'origin'],
        },
      },
      notes: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['lines'],
  },
};

const round2 = (x: number) => Math.round(x * 100) / 100;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada' }, 500);

    const body = await req.json();
    const { org_id, project } = body;
    const research = typeof body.research === 'string' ? body.research.trim() : '';
    if (!org_id || !project) return json({ error: 'org_id e project são obrigatórios' }, 400);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ---- WBS line list (what to estimate) ----
    const { data: wbs } = await supabase.from('wbs_nodes')
      .select('code, name, is_leaf, depth').order('sort_order');
    const leaves = (wbs ?? []).filter((n) => n.is_leaf);

    // ---- Internal price book from prior estimates ----
    const { data: items } = await supabase.from('estimate_items')
      .select('line_code, wbs_code, unit, unit_cost, estimates(level)')
      .eq('org_id', org_id).limit(5000);
    type Agg = { sum: number; n: number; unit: string; byLevel: Record<string, { sum: number; n: number }> };
    const book = new Map<string, Agg>();
    for (const it of (items ?? []) as Record<string, unknown>[]) {
      const key = (it.line_code as string) || (it.wbs_code as string);
      if (!key) continue;
      const cost = Number(it.unit_cost) || 0;
      if (cost <= 0) continue;
      const lvl = ((it.estimates as { level?: string } | null)?.level) || 'any';
      const a = book.get(key) ?? { sum: 0, n: 0, unit: String(it.unit || 'ea'), byLevel: {} };
      a.sum += cost; a.n += 1;
      a.byLevel[lvl] = a.byLevel[lvl] ?? { sum: 0, n: 0 };
      a.byLevel[lvl].sum += cost; a.byLevel[lvl].n += 1;
      book.set(key, a);
    }

    // ---- Category price signals from material_prices ----
    const { data: mprices } = await supabase.from('material_prices')
      .select('unit, unit_price, county, source, materials(wbs_code)')
      .eq('org_id', org_id).order('quoted_at', { ascending: false }).limit(2000);
    const catPrice = new Map<string, { sum: number; n: number; unit: string }>();
    for (const p of (mprices ?? []) as Record<string, unknown>[]) {
      const code = (p.materials as { wbs_code?: string } | null)?.wbs_code;
      const price = Number(p.unit_price) || 0;
      if (!code || price <= 0) continue;
      const a = catPrice.get(code) ?? { sum: 0, n: 0, unit: String(p.unit || 'ea') };
      a.sum += price; a.n += 1; catPrice.set(code, a);
    }

    // ---- Compact price book text for the prompt ----
    const priceBook = [...book.entries()].map(([code, a]) => {
      const avg = round2(a.sum / a.n);
      const lvls = Object.entries(a.byLevel)
        .map(([l, v]) => `${l}:$${round2(v.sum / v.n)}`).join(' ');
      return `${code} ~$${avg}/${a.unit} (n=${a.n}${lvls ? `; ${lvls}` : ''})`;
    }).join('\n');
    const catBook = [...catPrice.entries()]
      .map(([code, a]) => `${code} ~$${round2(a.sum / a.n)}/${a.unit} (n=${a.n})`).join('\n');
    const lineList = leaves.map((n) => `${n.code} · ${n.name}`).join('\n');

    const pg = project.program ?? {};
    const projText =
`LEVEL: ${project.level ?? 'essential'}
COUNTY: ${project.county ?? '(unknown)'}   MARKET: ${project.market ?? '(unknown)'}
LIVING: ${project.living_sf ?? '?'} sf   TOTAL CONSTRUCTED: ${project.total_sf ?? '?'} sf
PROGRAM: ${pg.bedrooms ?? '?'} bed / ${pg.full_baths ?? '?'} full bath / ${pg.half_baths ?? 0} half / ${pg.kitchens ?? 1} kitchen(s) / ${pg.laundries ?? 1} laundry / garage ${pg.garage_bays ?? 2} bay(s) / ${pg.stories ?? 1} story / ${pg.doors ?? '?'} doors / ${pg.windows ?? '?'} windows${pg.has_inlaw ? ' / in-law suite' : ''}`;

    // Single generation call, NO web tool here (web research is a separate,
    // decoupled invocation — see the market-research function — so neither call
    // exceeds the Edge Function resource limit). `research` arrives pre-fetched.
    const anthropic = new Anthropic({ apiKey });
    const params = {
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          {
            // STATIC prefix — identical on every estimate → prompt-cached (saves
            // cost/latency). No interpolation may appear in this block.
            type: 'text',
            cache_control: { type: 'ephemeral' },
            text:
`You are the PKB Homes senior estimator. Build a COMPLETE construction estimate for a new home with no
reference model, anchored to the PKB COST BOOK below (HIGHEST PRIORITY — the company's real calibrated
Central-FL costs, benchmarks, builder-fee rules and add-ons; only deviate with a clear reason in the note).
Priority order: (1) PKB cost book, (2) the current web research provided, (3) the internal price book,
(4) your Florida market knowledge. Never leave a needed line unpriced. Apply the builder fee per the
cost-book rules (section 21).

For EACH line output: line_code (the WBS code), wbs_code (its parent leaf code), description, qty (derive
from areas/program — slab & framing by total sf, plumbing by baths, cabinetry/appliances by kitchens,
openings by doors+windows), unit, unit_cost, origin ("market" if from the live research, "internal" if from
the PKB cost book / internal history, "estimated" if a rough placeholder), and a short note on how you
derived it (e.g. "web: ABC Supply $X/sq" or "PKB realized +15% signature"). Call emit_estimate with the result.

PKB COST BOOK:
${PKB_COSTBOOK}`,
          },
          {
            // VARIABLE part — project, research, internal history, WBS list.
            type: 'text',
            text:
`CURRENT MARKET RESEARCH (live web, ${project.county ?? 'FL'}) — update cost-book numbers where fresher:
${research || '(web research unavailable this run — rely on the cost book + internal data)'}

INTERNAL PRICE BOOK ("code ~$avg/unit (n=samples; level:$avg …)"):
${priceBook || '(no internal estimate history yet)'}

INTERNAL MATERIAL PRICES by category:
${catBook || '(none)'}

TARGET PROJECT:
${projText}

Produce line items across these WBS categories (use these codes/names; add sub-lines with the same parent
code when useful):
${lineList}

Prices must reflect the ${project.level ?? 'essential'} level and ${project.county ?? 'the region'}.`,
          },
        ],
      }],
    };
    const { result, model } = await createViaTool<Result>(anthropic, params, RESULT_TOOL);
    return json({ result, model, used_web: research.length > 0, research: research.slice(0, 3000), internal_lines: book.size });
  } catch (e) {
    return json({ error: aiErrorMessage(e) }, 500);
  }
});
