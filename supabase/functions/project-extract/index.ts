// =============================================================================
// project-extract — lê as plantas (PDF) e extrai os DADOS DO PROJETO para
// pré-preencher o "Novo orçamento" (áreas, modelo, condado, wind, flood zone…).
// Documento primeiro: o usuário sobe as plantas e a IA preenche a ficha.
//
// Body: { plan_path }   (arquivo no bucket "plantas")
// Env:  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy: supabase functions deploy project-extract
// =============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';
import { cors, json, parseJson } from '../_shared/cors.ts';

interface Extracted {
  name: string | null;
  base_model: string | null;
  county: string | null;
  market: string | null;
  living_area_sf: number | null;
  total_area_sf: number | null;
  wind_speed_mph: number | null;
  flood_zone: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  notes: string;
  confidence: 'high' | 'medium' | 'low';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada' }, 500);

    const { plan_path } = await req.json();
    if (!plan_path) return json({ error: 'plan_path é obrigatório' }, 400);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data: file, error: dlErr } = await supabase.storage.from('plantas').download(plan_path);
    if (dlErr || !file) return json({ error: `Falha ao baixar plantas: ${dlErr?.message}` }, 400);
    const buf = await file.arrayBuffer();
    if (buf.byteLength > 30 * 1024 * 1024) {
      return json({ error: `Plantas muito grandes (${(buf.byteLength / 1048576).toFixed(1)} MB). Limite ~30 MB.` }, 413);
    }
    const b64 = encodeBase64(buf); // fast native base64 (avoids CPU/memory limit → 546)

    const anthropic = new Anthropic({ apiKey });
    const resp = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          {
            type: 'text',
            text:
`This is a Florida residential plan set. Read the title block, cover sheet and floor plans and extract the PROJECT DATA.
- name / base_model: the model or house name in the title block.
- living_area_sf: heated/AC (living) area. total_area_sf: total under-roof area (living + garage + porches).
- wind_speed_mph and flood_zone: only if a design-criteria / cover sheet states them.
- county: only if shown. market: subdivision/community if shown.
- bedrooms / bathrooms: counts from the floor plan.
Never guess. Put null in any field you cannot read from the plans, and note uncertainties in "notes".

Respond with ONLY this JSON:
{"name": <str|null>, "base_model": <str|null>, "county": <str|null>, "market": <str|null>,
 "living_area_sf": <num|null>, "total_area_sf": <num|null>, "wind_speed_mph": <num|null>,
 "flood_zone": <str|null>, "bedrooms": <num|null>, "bathrooms": <num|null>,
 "notes": <str>, "confidence": "high"|"medium"|"low"}`,
          },
        ],
      }],
    });

    const text = resp.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    const result = parseJson<Extracted>(text);
    return json({ result });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
