// Claude for the two judgment calls in the system: reading a buyer agent's feedback, and writing
// the short "what this week means" paragraph of the seller report. Without ANTHROPIC_API_KEY
// both fall back to simple rules, so the pipeline never depends on the API being configured.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const MODEL = process.env.KB_AI_MODEL || 'claude-opus-5-5';
export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;
let client = null;
const ai = () => (client ||= new Anthropic());

const Feedback = z.object({
  interest: z.enum(['high', 'medium', 'low', 'none']),
  price_view: z.enum(['below', 'fair', 'high', 'unknown']),
  offer_expected: z.boolean(),
  summary_pt: z.string(),
  summary_en: z.string(),
});

// Keyword fallback: good enough to sort the report, never to replace reading the text.
export function classifyByRules(text) {
  const t = String(text || '').toLowerCase();
  const offer = /\b(offer|writing|submit(ting)? an? offer|proposta)\b/.test(t) && !/\bno offer|not (be )?(making|writing)/.test(t);
  const interest = offer || /very interested|loved|love it|second showing|come back|2nd showing/.test(t) ? 'high'
    : /somewhat|maybe|consider|liked/.test(t) ? 'medium'
      : /not interested|no interest|pass\b|not a fit|did not like|didn't like/.test(t) ? 'none' : 'low';
  const price_view = /(over ?priced|too high|price is high|a (little|bit) high|high for)/.test(t) ? 'high'
    : /(good (price|value)|fair(ly)? priced|priced right|well priced)/.test(t) ? 'fair'
      : /(under ?priced|great deal|below market)/.test(t) ? 'below' : 'unknown';
  const one = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return { interest, price_view, offer_expected: offer, summary_pt: one, summary_en: one };
}

export async function classifyFeedback(text, listing) {
  if (!aiEnabled() || !String(text || '').trim()) return classifyByRules(text);
  const res = await ai().messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(Feedback) },
    system: 'You read feedback that a buyer\'s agent sent after showing a house listed for sale in Florida. '
      + 'Classify it for the listing agent. interest: how likely these buyers are to pursue the house. '
      + 'price_view: what the feedback says about the asking price (unknown if it says nothing). '
      + 'offer_expected: true only if the text says an offer is coming or being considered. '
      + 'summary_pt / summary_en: one neutral sentence for the seller (Portuguese / English) without the agent\'s name or brokerage.',
    messages: [{ role: 'user', content: `House: ${listing.address} — list price $${Number(listing.list_price || 0).toLocaleString('en-US')}\n\nFeedback:\n${String(text).slice(0, 6000)}` }],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return classifyByRules(text);
  return res.parsed_output;
}

// One short paragraph for the seller about the week, in the report language. Returns null without a key.
export async function weeklyNarrative(metrics, lang) {
  if (!aiEnabled()) return null;
  const res = await ai().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'medium' },
    system: `You are a Florida listing agent at Kubrusly Basso writing to the owner of a house you have listed. `
      + `Write ${lang === 'en' ? 'in English' : 'in Brazilian Portuguese'}, 3 to 5 sentences, plain text, no greeting or sign-off. `
      + 'Say what the week\'s numbers mean (showings, feedback, the nearby market) and, only if the data supports it, one concrete next step '
      + '(e.g. keep course, refresh photos, adjust price toward the market $/sq ft). Use only the numbers given; do not invent facts or promise results.',
    messages: [{ role: 'user', content: JSON.stringify(metrics) }],
  });
  if (res.stop_reason === 'refusal') return null;
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null;
}
