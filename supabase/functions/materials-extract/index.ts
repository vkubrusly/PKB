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

import { cors, json } from '../_shared/cors.ts';
import { aiErrorMessage, createViaTool, FILES_BETA, uploadPdf } from '../_shared/ai.ts';

const MATERIALS_TOOL = {
  name: 'emit_materials',
  description: 'Return every material line item read from the supplier quote.',
  input_schema: {
    type: 'object',
    properties: {
      supplier: { type: ['string', 'null'] },
      materials: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            brand: { type: ['string', 'null'] },
            model: { type: ['string', 'null'] },
            unit: { type: ['string', 'null'] },
            wbs_code: { type: ['string', 'null'] },
            spec_level: { type: 'string', enum: ['affordable', 'essential', 'signature', 'luxury', 'any'] },
            fl_approval: { type: ['string', 'null'] },
            unit_price: { type: ['number', 'null'] },
            specs: { type: ['string', 'null'] },
          },
          required: ['name', 'spec_level'],
        },
      },
      notes: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['materials', 'notes', 'confidence'],
  },
};

interface MaterialRow {
  name: string;
  brand: string | null;
  model: string | null;
  unit: string | null;        // ea, sf, lf, cy, ls, hr, gal, sq, ton, bid, mo
  wbs_code: string | null;    // best BT cost code, e.g. "04.20.02", "06.10.02", "07.30.01"
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
    if (buf.byteLength > 100 * 1024 * 1024) {
      return json({ error: `PDF muito grande (${(buf.byteLength / 1048576).toFixed(1)} MB). Limite ~100 MB.` }, 413);
    }
    const fileId = await uploadPdf(apiKey, buf, plan_path.split('/').pop() ?? 'cotacao.pdf');

    const anthropic = new Anthropic({ apiKey });
    const { result } = await createViaTool<Extracted>(anthropic, {
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file', file_id: fileId } },
          {
            type: 'text',
            text:
`You are a senior estimator reading a SUPPLIER QUOTE / materials budget for a Florida home build.
Extract EVERY line item as a material for the company catalog.

For each item determine:
- name: the material (e.g. "Kohler Highline toilet", "5/8\\" drywall", "R-30 blown insulation").
- brand, model: manufacturer and model/SKU if shown, else null.
- unit: one of ea, sf, lf, cy, ls, hr, gal, sq, ton, bid, mo (best match; default ea).
- wbs_code: the BuilderTrend cost code it belongs to, as a dotted code like "04.20.02" (plumbing material),
  "06.10.02" (vinyl flooring), "07.30.01" (cabinets), "07.30.02" (countertops), "03.60.01" (roofing),
  "05.10.01" (insulation), "07.10.02" (paint material), "07.60.02" (appliances),
  "03.50.02" (exterior doors/windows material), "07.20.04" (interior doors). If you only know the category,
  use its 2-digit code ("04" M.P.E., "06" flooring, "07" interior finishes). Use your best single code; null if unsure.
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
    }, MATERIALS_TOOL, FILES_BETA);

    return json({ result });
  } catch (e) {
    return json({ error: aiErrorMessage(e) }, 500);
  }
});
