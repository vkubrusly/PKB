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
import { cors, json, parseJson } from '../_shared/cors.ts';
import { aiErrorMessage, createWithFallback } from '../_shared/ai.ts';

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

const round2 = (x: number) => Math.round(x * 100) / 100;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada' }, 500);

    const { org_id, project } = await req.json();
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

    const anthropic = new Anthropic({ apiKey });
    const { resp, model } = await createWithFallback(anthropic, {
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text:
`You are a senior Florida residential estimator. Build a COMPLETE construction estimate for a new home
that has no reference model, using two sources:

(A) INTERNAL PRICE BOOK — this company's OWN historical unit costs by line/category (anchor to these
    when a line has data; adjust for the target spec level and size). Format: "code ~$avg/unit (n=samples; level:$avg …)".
${priceBook || '(no internal estimate history yet)'}

(B) INTERNAL MATERIAL PRICES by category:
${catBook || '(none)'}

For any line without internal data, use realistic CURRENT Florida market pricing from your own knowledge,
adjusted to the county and spec level. Never leave a needed line unpriced.

TARGET PROJECT:
${projText}

Produce line items across these WBS categories (use these codes/names; you may add sub-lines with the
same parent code when useful):
${lineList}

For EACH line output: line_code (the WBS code), wbs_code (its parent leaf code from the list),
description, qty (derive from the areas/program — e.g. slab & framing by total sf, plumbing by baths,
cabinetry/appliances by kitchens, openings by doors+windows), unit, unit_cost, and:
- origin: "internal" if anchored to the internal price book, "market" if from Florida market knowledge,
  "estimated" if a rough placeholder.
- note: one short line on how you derived it (e.g. "internal avg adjusted +15% for signature level").
Prices must reflect the ${project.level ?? 'essential'} level and ${project.county ?? 'the region'}.

Respond with ONLY this JSON:
{"lines": [{"line_code": <str>, "wbs_code": <str>, "description": <str>, "qty": <num>, "unit": <str>,
  "unit_cost": <num>, "origin": "internal"|"market"|"estimated", "note": <str>}],
 "notes": <str>, "confidence": "high"|"medium"|"low"}`,
        }],
      }],
    });

    const text = resp.content.filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text).join('\n');
    const result = parseJson<Result>(text);
    return json({ result, model, internal_lines: book.size });
  } catch (e) {
    return json({ error: aiErrorMessage(e) }, 500);
  }
});
