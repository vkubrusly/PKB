// =============================================================================
// price-search — Agente de Preços (Sprint 4, §4.1 "busca web").
//
// Given a material, uses the Claude API with the web_search + web_fetch server
// tools to find a CURRENT price at a (preferably Florida) supplier, returning
// price + unit + supplier + link + photo + date. Writes a material_prices row
// with source='web' (§4.4: nunca inventar preço — sempre com fonte e data).
//
// Body: { material_id }  (or { name, brand, model, wbs_code, county } directly)
// Env:  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy: supabase functions deploy price-search
// =============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors, json, parseJson } from '../_shared/cors.ts';

interface PriceResult {
  unit_price: number;
  unit: string;
  supplier_name: string;
  product_name: string;
  link: string;
  photo_url: string | null;
  quoted_at: string;
  is_volatile: boolean;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada' }, 500);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const input = await req.json();
    let mat = input;
    if (input.material_id) {
      const { data, error } = await supabase.from('materials').select('*').eq('id', input.material_id).single();
      if (error || !data) return json({ error: `Material não encontrado: ${error?.message}` }, 404);
      mat = data;
    }

    const today = new Date().toISOString().slice(0, 10);
    const query = [mat.brand, mat.model, mat.name].filter(Boolean).join(' ');
    const region = mat.county ? `${mat.county} County, Florida` : 'Florida';

    const anthropic = new Anthropic({ apiKey });
    const resp = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4000,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 },
      ],
      messages: [{
        role: 'user',
        content:
`You are a construction estimator sourcing materials in ${region}. Find the CURRENT retail/contractor price for:

  ${query || mat.name}

Prefer a real supplier that serves Florida (Home Depot, Lowe's, Ferguson, local FL distributors). Use web_search and
web_fetch to confirm the price on the supplier's own page. Report the price per the unit the trade buys it in (sf, ea, lf…).
If it is a volatile commodity (lumber, copper), set is_volatile true.

Never invent a price. If you cannot confirm one from a real page, set confidence "low" and explain in notes.

Respond with ONLY this JSON (today is ${today}):
{"unit_price": <number>, "unit": "<ea|sf|lf|cy|ls|gal|sq|ton>", "supplier_name": "<name>", "product_name": "<exact product>",
 "link": "<product URL>", "photo_url": "<image URL or null>", "quoted_at": "${today}", "is_volatile": <bool>,
 "confidence": "<high|medium|low>", "notes": "<source + any caveat>"}`,
      }],
    });

    const text = resp.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    const result = parseJson<PriceResult>(text);

    // Persist as a web-sourced price (only when we have a material row + org).
    if (mat.id && mat.org_id && Number(result.unit_price) > 0) {
      await supabase.from('material_prices').insert({
        org_id: mat.org_id,
        material_id: mat.id,
        source: 'web',
        unit: result.unit,
        unit_price: result.unit_price,
        quoted_at: result.quoted_at || today,
        link: result.link,
        county: mat.county ?? null,
        is_volatile: !!result.is_volatile,
      });
    }

    return json({ result });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
