// =============================================================================
// product-detail — Agente de Detalhamento de Produto (Sprint 4).
//
// Given a material, uses the Claude API (with optional web_search to ground the
// specs on a real product page) to generate a memorial descritivo + technical
// specs + suggested brand/model + FL Product Approval guidance. Updates the
// material row (never overwrites fields the user already filled).
//
// Body: { material_id, language? }   language: 'pt' (default) | 'en'
// Env:  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy: supabase functions deploy product-detail
// =============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors, json, parseJson } from '../_shared/cors.ts';

interface DetailResult {
  memorial: string;
  specs: string;
  brand: string | null;
  model: string | null;
  fl_note: string | null;
  photo_url: string | null;
  is_envelope: boolean;
}

// WBS codes whose products are part of the building envelope → need FL Product Approval.
const ENVELOPE = new Set(['3.4', '3.5', '3.6', '3.7']); // windows/ext doors, stucco, roofing, soffit/fascia

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada' }, 500);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { material_id, language = 'pt' } = await req.json();
    if (!material_id) return json({ error: 'material_id é obrigatório' }, 400);

    const { data: mat, error } = await supabase.from('materials').select('*').eq('id', material_id).single();
    if (error || !mat) return json({ error: `Material não encontrado: ${error?.message}` }, 404);

    const isEnvelope = mat.wbs_code && ENVELOPE.has(String(mat.wbs_code));
    const lang = language === 'en' ? 'English' : 'Portuguese (Brazil)';
    const query = [mat.brand, mat.model, mat.name].filter(Boolean).join(' ');

    const anthropic = new Anthropic({ apiKey });
    const resp = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 3000,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      messages: [{
        role: 'user',
        content:
`You are documenting a construction material for a Florida homebuilder's memorial descritivo.

Material: ${query || mat.name}${mat.spec_level && mat.spec_level !== 'any' ? ` (spec level: ${mat.spec_level})` : ''}
Category (WBS): ${mat.wbs_code ?? 'n/a'}

Use web_search to ground the specs on a real product when a brand/model is given; otherwise describe a representative
product appropriate to the spec level. Write the "memorial" in ${lang}, client-facing and concrete (finish, dimensions,
performance) — no prices. Keep "specs" as a compact technical line.
${isEnvelope ? 'This is a building-envelope product for Florida: in "fl_note", state that it REQUIRES a valid Florida Product Approval (FL#) matched to the site wind speed, and how to verify it.' : ''}

Respond with ONLY this JSON:
{"memorial": "<paragraph>", "specs": "<one line>", "brand": "<brand or null>", "model": "<model or null>",
 "fl_note": ${isEnvelope ? '"<FL Product Approval guidance>"' : 'null'}, "photo_url": "<image URL or null>", "is_envelope": ${isEnvelope}}`,
      }],
    });

    const text = resp.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    const d = parseJson<DetailResult>(text);

    // Update, preserving anything the user already filled.
    const patch: Record<string, unknown> = { memorial: d.memorial, specs: d.specs };
    if (d.brand && !mat.brand) patch.brand = d.brand;
    if (d.model && !mat.model) patch.model = d.model;
    await supabase.from('materials').update(patch).eq('id', material_id);

    return json({ result: d });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
