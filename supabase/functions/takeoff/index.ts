// =============================================================================
// takeoff — Supabase Edge Function (Deno).
//
// AI plan take-off (§3.5.2 / Agente de Takeoff). Downloads a project's plans
// (PDF) from Storage, sends them to the Claude API, and returns quantity lines
// mapped to the 22-category PKB WBS. Every line is flagged needs_review — it is
// an AI estimate to be checked, never a final price (§4.4).
//
// Requires these environment variables (supabase secrets set ...):
//   ANTHROPIC_API_KEY           — Claude API key
//   SUPABASE_URL                — injected by the platform
//   SUPABASE_SERVICE_ROLE_KEY   — to read the plans bucket
//
// Deploy:  supabase functions deploy takeoff
// =============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors, json } from '../_shared/cors.ts';

const WBS = `
1 Planning & Preconstruction (1.1 General Conditions, 1.2 Architect/Engineering, 1.3 Recurring Fixed Costs)
2 Site Work · 3 Shell Construction Structure (3.1 Slab, 3.2 Wall, 3.3 Framing, 3.4 Windows/Ext Doors,
  3.5 Stucco, 3.6 Roofing, 3.7 Soffit/Fascia) · 4 M.P.E.G. (4.1 HVAC, 4.2 Plumbing, 4.3 Electrical)
5 Insulation · 6 Drywall · 7 Interior Doors/Trims · 8 Paint · 9 Cabinetry/Counter Top · 10 Hardware
11 Sewer/Water Treatment · 12 Flooring · 13 Garage Door · 14 Appliances · 15 Final Grading · 16 Driveway
17 Irrigation · 18 Landscaping · 19 Clean-Up · 20 Punch List/Contingency · 21 Administration Fee · 22 Upgrades
`.trim();

// Strict tool the model must call — guarantees a parseable takeoff.
const EMIT_TOOL = {
  name: 'emit_takeoff',
  description: 'Return the material take-off, one row per WBS line item.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            wbs_code: { type: 'string', description: 'Structural WBS node, e.g. "3.1", "6", "12"' },
            line_code: { type: 'string', description: 'Full line code within the category, e.g. "3.1.1"' },
            description: { type: 'string', description: 'Material / service description' },
            qty: { type: 'number', description: 'Measured quantity from the plans' },
            unit: { type: 'string', enum: ['ea', 'sf', 'lf', 'cy', 'ls', 'hr', 'gal', 'sq', 'ton', 'bid', 'mo'] },
            unit_cost: { type: 'number', description: 'Estimated unit cost in USD, or 0 if unknown' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['wbs_code', 'line_code', 'description', 'qty', 'unit', 'unit_cost', 'confidence'],
        },
      },
    },
    required: ['lines'],
  },
} as const;

const SYSTEM = `You are a senior residential construction estimator in Florida doing a quantity take-off from a plan set.
Map every measurable quantity to the PKB WBS below. Use the structural node in "wbs_code" (e.g. 3.1, 6, 12) and a
sequential "line_code" within the category (e.g. 3.1.1). Measure quantities from the drawings; never invent a value —
if a quantity cannot be read from the plans, set confidence "low" and explain in the description. Prefer sf/lf/cy/ea
units that match how the trade is bought. Set unit_cost to your best FL estimate, or 0 when you are not sure.
Do not price allowances or fees you cannot derive from the plans.

WBS (numeração imutável):
${WBS}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { plan_path, target } = await req.json();
    if (!plan_path) return json({ error: 'plan_path é obrigatório' }, 400);

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada' }, 500);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Download the plans from Storage and base64-encode for the document block.
    const { data: file, error: dlErr } = await supabase.storage.from('plantas').download(plan_path);
    if (dlErr || !file) return json({ error: `Falha ao baixar plantas: ${dlErr?.message}` }, 400);
    const b64 = base64(new Uint8Array(await file.arrayBuffer()));

    const areaHint = target?.living_sf
      ? `The project is ~${target.living_sf} sf living / ${target.total_sf} sf total — sanity-check totals against this.`
      : '';

    const anthropic = new Anthropic({ apiKey });
    const resp = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      tools: [EMIT_TOOL],
      tool_choice: { type: 'tool', name: 'emit_takeoff' },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: `Do the full material take-off for this plan set. ${areaHint}` },
        ],
      }],
    });

    const call = resp.content.find((b) => b.type === 'tool_use');
    if (!call || call.type !== 'tool_use') return json({ error: 'A IA não retornou o take-off.' }, 502);

    const raw = (call.input as { lines: RawLine[] }).lines ?? [];
    const lines = raw.map((l, i) => {
      const qty = Number(l.qty) || 0;
      const unit_cost = Number(l.unit_cost) || 0;
      return {
        line_code: l.line_code || null,
        wbs_code: l.wbs_code,
        description: l.description,
        qty, unit: l.unit, unit_cost,
        basis: 'ai' as const,
        factor: 1,
        line_total: Math.round(qty * unit_cost * 100) / 100,
        needs_review: true,
        price_source: 'estimated' as const,
        confidence: l.confidence,
        sort_order: i + 1,
      };
    });

    return json({ lines });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

interface RawLine {
  wbs_code: string; line_code: string; description: string;
  qty: number; unit: string; unit_cost: number; confidence: string;
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
