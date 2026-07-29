// =============================================================================
// materials-extract — reads a supplier QUOTE / materials budget (PDF) and
// returns a structured list of materials. For each item the AI infers the
// TYPE (WBS category) and the SPEC LEVEL it represents (affordable / essential
// / signature / luxury) — or "any" when the item is a commodity that serves
// every level (concrete, rebar, generic lumber, fasteners…).
//
// Document-first: the user uploads a quote PDF, the AI reads it, and the user
// reviews the parsed rows before bulk-inserting into the materials catalog.
//
// Body: { plan_path }   (PDF in the "plantas" bucket)
// Env:  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy: supabase functions deploy materials-extract
// =============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';
import { cors, json, parseJson } from '../_shared/cors.ts';
import { aiErrorMessage, createJsonText } from '../_shared/ai.ts';

interface MaterialRow {
  name: string;
  brand: string | null;
  model: string | null;
  unit: string | null;        // ea, sf, lf, cy, ls, hr, gal, sq, ton, bid, mo
  wbs_code: string | null;    // best WBS category, e.g. "4.2", "12", "9"
  spec_level: 'affordable' | 'essential' | 'signature' | 'luxury' | 'any';
  fl_approval: string | null; // FL# if shown
  unit_price: number | null;  // quoted price if present (reference only)
  specs: string | null;       // short description / spec
}
interface Extracted {
  supplier: string | null;
  materials: MaterialRow[];
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
    if (dlErr || !file) return json({ error: `Falha ao baixar o PDF: ${dlErr?.message}` }, 400);
    const buf = await file.arrayBuffer();
    if (buf.byteLength > 30 * 1024 * 1024) {
      return json({ error: `PDF muito grande (${(buf.byteLength / 1048576).toFixed(1)} MB). Limite ~30 MB.` }, 413);
    }
    const b64 = encodeBase64(buf);

    const anthropic = new Anthropic({ apiKey });
    const { text } = await createJsonText(anthropic, {
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          {
            type: 'text',
            text:
`You are a senior estimator reading a SUPPLIER QUOTE / materials budget for a Florida home build.
Extract EVERY line item as a material for the company catalog.

For each item determine:
- name: the material (e.g. "Kohler Highline toilet", "5/8\\" drywall", "R-30 blown insulation").
- brand, model: manufacturer and model/SKU if shown, else null.
- unit: one of ea, sf, lf, cy, ls, hr, gal, sq, ton, bid, mo (best match; default ea).
- wbs_code: the construction category it belongs to, as a number like "4.2" (plumbing), "12" (flooring),
  "9" (cabinetry/countertops), "3.6" (roofing), "5" (insulation), "8" (paint), "14" (appliances),
  "3.4" (windows/exterior doors), "7" (interior doors/trim). Use your best single code; null if unsure.
- fl_approval: Florida Product Approval "FL#" if present (required for envelope products), else null.
- unit_price: the quoted unit price as a number if the quote shows one, else null.
- specs: a short spec/description (size, rating, finish).
- spec_level: which build tier this item represents, judged by its QUALITY/PRICE tier:
    * affordable = builder-grade / lowest cost
    * essential  = standard mid-grade
    * signature  = upgraded / premium brand
    * luxury     = high-end / designer
    * any        = COMMODITY that serves ALL levels regardless of tier (concrete, rebar, generic
                   framing lumber, fasteners, house wrap, sand, fill). Use "any" when the item is
                   not tier-specific. When a quote is explicitly labeled for one tier, use that tier.
Judge the tier from brand/finish/price, not guesswork — when genuinely unclear use "any" and say so in notes.

Respond with ONLY this JSON:
{"supplier": <str|null>,
 "materials": [{"name": <str>, "brand": <str|null>, "model": <str|null>, "unit": <str|null>,
   "wbs_code": <str|null>, "spec_level": "affordable"|"essential"|"signature"|"luxury"|"any",
   "fl_approval": <str|null>, "unit_price": <num|null>, "specs": <str|null>}],
 "notes": <str>, "confidence": "high"|"medium"|"low"}`,
          },
        ],
      }],
    });

    const result = parseJson<Extracted>(text);
    return json({ result });
  } catch (e) {
    return json({ error: aiErrorMessage(e) }, 500);
  }
});
