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
import { aiErrorMessage, createJsonText } from '../_shared/ai.ts';

interface Extracted {
  name: string | null;
  base_model: string | null;
  county: string | null;
  market: string | null;
  living_area_sf: number | null;
  total_area_sf: number | null;
  garage_area_sf: number | null;
  lanai_area_sf: number | null;
  wind_speed_mph: number | null;
  flood_zone: string | null;
  // Program (deep analysis) — drives multi-factor cost scaling.
  bedrooms: number | null;
  full_baths: number | null;
  half_baths: number | null;
  kitchens: number | null;
  laundries: number | null;
  garage_bays: number | null;
  stories: number | null;
  doors: number | null;
  windows: number | null;
  has_inlaw: boolean | null;
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
    const { text } = await createJsonText(anthropic, {
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          {
            type: 'text',
            text:
`You are a senior estimator doing a DEEP READ of a Florida residential plan set before budgeting.
Read the title block, cover sheet, AREA CALCS, floor plan, and the DOOR SCHEDULE and WINDOW SCHEDULE
tables. Extract the project data AND the full room "program" — the counts that drive cost.

Rules:
- living_area_sf: heated/AC (living) area. total_area_sf: total constructed area (living + garage + porches/lanai + entry).
- garage_area_sf, lanai_area_sf: from the AREA CALCS table if present.
- bedrooms: count rooms labeled Bedroom/Master. full_baths: bathrooms with a shower/tub. half_baths: powder/half baths (toilet+sink only).
- kitchens: COUNT EVERY kitchen, including a second/in-law kitchen or kitchenette (look for a 2nd range/refrigerator/sink cluster, often near an "IN-LAW" suite). This matters a lot.
- laundries: count laundry rooms/closets. garage_bays: 1 for single, 2 for double, etc.
- stories: number of floors. has_inlaw: true if there is an in-law / guest suite (own bath and/or kitchenette).
- doors: TOTAL DOORS from the door schedule. windows: TOTAL WINDOWS from the window schedule.
- wind_speed_mph, flood_zone: only if a design-criteria/cover sheet states them. county/market: only if shown.
Never guess a number you can't see — use null and explain in "notes". Call out the kitchen and bath counts explicitly in "notes".

Respond with ONLY this JSON:
{"name": <str|null>, "base_model": <str|null>, "county": <str|null>, "market": <str|null>,
 "living_area_sf": <num|null>, "total_area_sf": <num|null>, "garage_area_sf": <num|null>, "lanai_area_sf": <num|null>,
 "wind_speed_mph": <num|null>, "flood_zone": <str|null>,
 "bedrooms": <num|null>, "full_baths": <num|null>, "half_baths": <num|null>, "kitchens": <num|null>,
 "laundries": <num|null>, "garage_bays": <num|null>, "stories": <num|null>,
 "doors": <num|null>, "windows": <num|null>, "has_inlaw": <bool|null>,
 "notes": <str>, "confidence": "high"|"medium"|"low"}`,
          },
        ],
      }],
    });

    const result = parseJson<Extracted>(text);
    return json({ result });
  } catch (e) {
    // Surface Anthropic API errors clearly (bad model, PDF too large/too many
    // pages, credits, rate limit) instead of a generic 500.
    return json({ error: aiErrorMessage(e) }, 500);
  }
});
