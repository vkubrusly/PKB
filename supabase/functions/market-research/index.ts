// =============================================================================
// market-research — a SINGLE web-search turn that returns current Central-FL
// construction prices for a county/level as prose findings. Kept separate from
// estimate-market so the heavy web call and the JSON generation each stay well
// under the Edge Function resource limit (two calls that together would 546).
//
// Body: { county, level, total_sf }
// Env:  ANTHROPIC_API_KEY
// Deploy: supabase functions deploy market-research
// =============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { cors, json } from '../_shared/cors.ts';
import { aiErrorMessage, createWithFallback, extractText } from '../_shared/ai.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada' }, 500);

    const b = await req.json();
    const county = (b.county || 'Central Florida').toString().trim();
    const level = (b.level || 'essential').toString().trim();
    const totalSf = b.total_sf || 2000;

    const anthropic = new Anthropic({ apiKey });
    const { resp, model, usedWeb } = await createWithFallback(anthropic, {
      max_tokens: 1600,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text:
`Use web_search to find CURRENT (this month) residential construction prices in ${county}, FL, for a
${level}-level single-family home (~${totalSf} sf). Find current unit prices for the volatile / high-value
items: concrete & slab, framing lumber, roof trusses, shingles, impact & vinyl windows, HVAC, plumbing,
electrical, drywall, cabinets & countertops, LVP / tile flooring, appliances, well drilling, septic
(conventional & nitrogen-reducing), driveway / pavers, sod / landscaping. Also find this county's current
impact fees and building permit fee.
Return a concise bulleted list, one item per line: "item — $price per unit — source (site name)".
Flag volatile items (lumber, steel, concrete). Keep it under ~40 lines.`,
        }],
      }],
    }, { webSearch: true, maxUses: 5 });

    const research = extractText(resp).trim();
    return json({ research, model, used_web: usedWeb && research.length > 0 });
  } catch (e) {
    return json({ error: aiErrorMessage(e) }, 500);
  }
});
