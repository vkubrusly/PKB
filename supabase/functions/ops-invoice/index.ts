// ops-invoice — read a vendor invoice (PDF or image) and return its data as JSON, for the bills built from
// invoice@pkbhomes.com (Victor, 2026-11-19). Called by rules/vendor_invoices.mjs with the service-role key;
// no one else may call it.
//   POST { file_base64, media_type, file_name, email_subject?, email_from? }
//   → { is_invoice, vendor, invoice_number, invoice_date, due_date, total, sites[], invoice_fees[], notes }
import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { cors, json } from '../_shared/cors.ts';

// deno-lint-ignore no-explicit-any
type Any = any;
const MODEL = Deno.env.get('OPS_INVOICE_MODEL') || 'claude-opus-5-5';

const INSTRUCTIONS = `You read vendor invoices sent to PKB Homes, a Florida home builder, so that a bill can be created in Buildertrend for each house (job) the invoice charges.
Return only what the document shows. Never invent a number, an address or a date; use null when it is not on the document.
- is_invoice: true only for an invoice / bill / statement asking PKB to pay. False for anything else (W-9, receipt of payment, quote/estimate, signature image, logo, photo, lien waiver, terms and conditions page, marketing).
- vendor: the company being paid (the "from" / remit-to company, not PKB).
- invoice_number, invoice_date and due_date (YYYY-MM-DD) of the document as a whole; total: the amount due for the whole document.
- sites: one entry per house / job / property / service address the invoice charges, with the amount for that site INCLUDING its own tax. Use the site's own subtotal or total line when the invoice gives one; otherwise add up its lines. label: the site's name or code as printed (e.g. "S319"); address: the street address exactly as printed; amount: number. If the whole invoice is for one site, return one entry with the invoice total minus any invoice-wide fees.
- invoice_fees: charges on the whole invoice that belong to no site (delivery, fuel, environmental, service fee…), each with description and amount. Taxes already inside a site amount are not fees.
- notes: in Brazilian Portuguese; anything a person must check (credits, partial payments, a site without an address, figures that do not add up), in one or two short sentences; null when there is nothing.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_invoice', 'vendor', 'invoice_number', 'invoice_date', 'due_date', 'total', 'sites', 'invoice_fees', 'notes'],
  properties: {
    is_invoice: { type: 'boolean' },
    vendor: { type: ['string', 'null'] },
    invoice_number: { type: ['string', 'null'] },
    invoice_date: { type: ['string', 'null'] },
    due_date: { type: ['string', 'null'] },
    total: { type: ['number', 'null'] },
    sites: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'address', 'amount'], properties: { label: { type: ['string', 'null'] }, address: { type: ['string', 'null'] }, amount: { type: 'number' } } } },
    invoice_fees: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['description', 'amount'], properties: { description: { type: 'string' }, amount: { type: 'number' } } } },
    notes: { type: ['string', 'null'] },
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!svc || req.headers.get('Authorization') !== `Bearer ${svc}`) return json({ error: 'not allowed' }, 403);
    const body = await req.json().catch(() => ({}));
    const data = String(body.file_base64 || ''), mt = String(body.media_type || 'application/pdf');
    if (!data) return json({ error: 'file_base64 missing' }, 400);
    const file = mt === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : /^image\/(png|jpeg|gif|webp)$/.test(mt) ? { type: 'image', source: { type: 'base64', media_type: mt, data } } : null;
    if (!file) return json({ error: `unsupported file type ${mt}` }, 400);

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);
    const anthropic = new Anthropic({ apiKey });
    const params: Any = {
      model: MODEL,
      max_tokens: 16000,
      system: INSTRUCTIONS,
      messages: [{ role: 'user', content: [file, { type: 'text', text: `File: ${body.file_name || '—'}\nE-mail from: ${body.email_from || '—'}\nE-mail subject: ${body.email_subject || '—'}` }] }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    };
    let resp: Any;
    try { resp = await anthropic.messages.create({ ...params, fallbacks: 'default' } as Any, { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } }); }
    catch (e) {
      if ((e as Any)?.status === 400 && /fallback/i.test(String((e as Any)?.message || ''))) resp = await anthropic.messages.create(params);
      else throw e;
    }
    if (resp.stop_reason === 'refusal') return json({ error: 'the model declined to read this file' }, 422);
    const text = (resp.content || []).find((b: Any) => b.type === 'text')?.text || '';
    let out: Any;
    try { out = JSON.parse(text); } catch { return json({ error: 'no JSON in the answer', raw: text.slice(0, 500) }, 502); }
    return json({ ...out, model: resp.model, usage: resp.usage });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
