// ops-invoice — read a vendor invoice (PDF or image) and return its data as JSON, for the bills built from
// invoice@pkbhomes.com (Victor, 2026-11-19). Called by rules/vendor_invoices.mjs with the service-role key;
// no one else may call it.
//   POST { file_base64, media_type, file_name, email_subject?, email_from? }
//   → { is_invoice, vendor, invoice_number, invoice_date, due_date, total, sites[], invoice_fees[], notes }
//   POST { mode: 'answer', answer_text, invoice: {vendor, invoice_number, total, issues[], lines[]}, jobs: [{job_number, address}] }
//   → { decision, assignments[], exclude[], no_job[], cost_code, summary }   (Camila's / Victor's e-mail answer, read)
//   POST { mode: 'reply', from, from_name, subject, text, context, as_of } → { reply, needs_victor, summary }   (a team e-mail, answered)
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

const ANSWER_INSTRUCTIONS = `PKB Ops (an automated system) asked Camila (PKB Homes accounts) by e-mail what to do with a vendor invoice before creating its bills in Buildertrend, one bill per house (job). You read her answer (or Victor's, the owner) and turn it into actions. Read only the newest reply at the top; ignore quoted older text and signatures. Never invent a job number: use only job numbers from the list given, or ones the answer writes explicitly.
- decision: "create" when the answer says to go ahead (e.g. "pode criar", "ok", "segue"), also when it only fixes addresses/jobs and implies going ahead; "ignore" when it says not to create the bills (already billed, wrong invoice, cancel, "não lançar"); "duplicate" when it says this invoice was already entered; "wait" when it asks to wait or the answer is unclear.
- assignments: for each invoice line whose house the answer names: line_address (the address as in the line), job_number (4 digits like "0063", as in the jobs list).
- exclude: addresses of lines the answer says to leave out (e.g. "não é nossa", "tira essa").
- no_job: addresses of lines the answer says to bill without a house / job (e.g. "crie uma bill sem associar a casa", "lança no geral").
- cost_code: the cost code text the answer asks for, or null.
- summary: one short sentence in Brazilian Portuguese of what you understood.`;
const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['decision', 'assignments', 'exclude', 'no_job', 'cost_code', 'summary'],
  properties: {
    decision: { type: 'string', enum: ['create', 'ignore', 'duplicate', 'wait'] },
    assignments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['line_address', 'job_number'], properties: { line_address: { type: 'string' }, job_number: { type: 'string' } } } },
    exclude: { type: 'array', items: { type: 'string' } },
    no_job: { type: 'array', items: { type: 'string' } },
    cost_code: { type: ['string', 'null'] },
    summary: { type: 'string' },
  },
};

const REPLY_INSTRUCTIONS = `You are PKB Ops, the operations assistant of PKB Homes (a Florida home builder). The bot mailbox is a conversation channel with the PKB team: you are answering an e-mail a team member (@pkbhomes.com) wrote to it; earlier messages of the thread may be quoted below theirs. Write the reply in Brazilian Portuguese, short and direct, like a helpful colleague: no greeting line beyond the person's first name, no sign-off (the system adds one).
Answer ONLY from the DATA given (houses/jobs, vendor invoices and their bills, open questions). Never invent a number, a date, a job or an amount; if the data does not have the answer, say so plainly and say that Victor was copied.
You cannot act in Buildertrend from this e-mail except through the invoice process (the invoice answers are handled elsewhere). If the person asks for an action (create/change/delete something, pay, send to someone), say you passed it to Victor (he is in copy) and set needs_victor true.
Dates in MM/DD/YY. Money as $1,234.56.
- reply: the e-mail body text.
- needs_victor: true when it needs a person (an action, a decision, or the data does not answer).
- summary: one short line in Portuguese of what was asked.`;
const REPLY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'needs_victor', 'summary'],
  properties: { reply: { type: 'string' }, needs_victor: { type: 'boolean' }, summary: { type: 'string' } },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!svc || req.headers.get('Authorization') !== `Bearer ${svc}`) return json({ error: 'not allowed' }, 403);
    const body = await req.json().catch(() => ({}));
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);
    const anthropic = new Anthropic({ apiKey });
    const ask = async (params: Any) => {
      let resp: Any;
      try { resp = await anthropic.messages.create({ ...params, fallbacks: 'default' } as Any, { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } }); }
      catch (e) {
        if ((e as Any)?.status === 400 && /fallback/i.test(String((e as Any)?.message || ''))) resp = await anthropic.messages.create(params);
        else throw e;
      }
      return resp;
    };
    if (body.mode === 'reply') {
      const resp = await ask({
        model: MODEL, max_tokens: 4000, system: REPLY_INSTRUCTIONS,
        messages: [{ role: 'user', content: `DATA (as of ${body.as_of || '—'}):\n${String(body.context || '').slice(0, 150000)}\n\nE-MAIL from ${body.from_name || ''} <${body.from || ''}>\nSubject: ${body.subject || ''}\n\n${String(body.text || '').slice(0, 12000)}` }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: REPLY_SCHEMA } },
      });
      if (resp.stop_reason === 'refusal') return json({ error: 'the model declined' }, 422);
      try { return json({ ...JSON.parse((resp.content || []).find((b: Any) => b.type === 'text')?.text || ''), model: resp.model }); }
      catch { return json({ error: 'no JSON in the answer' }, 502); }
    }
    if (body.mode === 'answer') {
      const resp = await ask({
        model: MODEL, max_tokens: 4000, system: ANSWER_INSTRUCTIONS,
        messages: [{ role: 'user', content: `Invoice: ${JSON.stringify(body.invoice || {})}\n\nJobs (job_number, address): ${JSON.stringify(body.jobs || [])}\n\nThe answer e-mail:\n${String(body.answer_text || '').slice(0, 12000)}` }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
      });
      if (resp.stop_reason === 'refusal') return json({ error: 'the model declined' }, 422);
      try { return json({ ...JSON.parse((resp.content || []).find((b: Any) => b.type === 'text')?.text || ''), model: resp.model }); }
      catch { return json({ error: 'no JSON in the answer' }, 502); }
    }
    const data = String(body.file_base64 || ''), mt = String(body.media_type || 'application/pdf');
    if (!data) return json({ error: 'file_base64 missing' }, 400);
    const file = mt === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : /^image\/(png|jpeg|gif|webp)$/.test(mt) ? { type: 'image', source: { type: 'base64', media_type: mt, data } } : null;
    if (!file) return json({ error: `unsupported file type ${mt}` }, 400);

    const params: Any = {
      model: MODEL,
      max_tokens: 16000,
      system: INSTRUCTIONS,
      messages: [{ role: 'user', content: [file, { type: 'text', text: `File: ${body.file_name || '—'}\nE-mail from: ${body.email_from || '—'}\nE-mail subject: ${body.email_subject || '—'}` }] }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    };
    const resp = await ask(params);
    if (resp.stop_reason === 'refusal') return json({ error: 'the model declined to read this file' }, 422);
    const text = (resp.content || []).find((b: Any) => b.type === 'text')?.text || '';
    let out: Any;
    try { out = JSON.parse(text); } catch { return json({ error: 'no JSON in the answer', raw: text.slice(0, 500) }, 502); }
    return json({ ...out, model: resp.model, usage: resp.usage });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
