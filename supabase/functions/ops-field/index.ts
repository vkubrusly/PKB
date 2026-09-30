// =============================================================================
// ops-field — field reports from supervisors and PMs (budget.pkbhomes.com/ops/field/;
// the WhatsApp webhook will call the same flow).
//
// POST { report_id?, text?, transcript?, media?: [{path, kind: 'photo'|'audio', mime, name}] }
//   → { report_id, status: 'needs_job' | 'open' | 'draft', reply, draft? }
// POST { confirm: report_id, title?, notes? } → Daily Log queued with the photos + checklist updated
// POST { cancel: report_id }
//
// Claude reads the conversation, the photos (signed URLs from the private 'field-media'
// bucket) and the PKB field manual (39 steps), finds the house — it ASKS when the report
// doesn't give a house number or address — and drafts the Daily Log and the checklist steps.
// Runs with the caller's session; access checks live in the SQL functions (migration 0024).
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY (OPS_FIELD_MODEL optional)
// =============================================================================
import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors, json } from '../_shared/cors.ts';
import manual from '../_shared/field_manual.json' with { type: 'json' };

// deno-lint-ignore no-explicit-any
type Any = any;

const MODELS = [Deno.env.get('OPS_FIELD_MODEL') || 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'].filter((v, i, a) => a.indexOf(v) === i);
const MAX_PHOTOS = 16;

const STEPS = (manual as Any).phases.flatMap((ph: Any) => ph.steps.map((s: Any) => ({ ...s, phase: `${ph.n}. ${ph.name}` })));
const MANUAL_TEXT = STEPS.map((s: Any) => `${s.n} | ${s.phase} | ${s.name} (${s.en})${s.type === 'inspection' ? ' [inspection]' : ''}`).join('\n');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['job_number', 'question', 'reply', 'daily_log', 'steps', 'issues'],
  properties: {
    job_number: { type: ['string', 'null'], description: 'The job (from JOBS) the report is about; null when it cannot be identified with confidence.' },
    question: { type: ['string', 'null'], description: 'A question for the author when something essential is missing (above all: which house). null when nothing is missing.' },
    reply: { type: 'string', description: 'Short message to the author, in the language they used.' },
    daily_log: {
      type: ['object', 'null'], additionalProperties: false, required: ['title', 'notes'],
      properties: { title: { type: 'string', description: 'Max 50 characters.' }, notes: { type: 'string', description: 'The Daily Log text.' } },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['n', 'status', 'evidence'],
        properties: { n: { type: 'string', enum: STEPS.map((s: Any) => String(s.n)) }, status: { type: 'string', enum: ['done', 'in_progress'] }, evidence: { type: 'string' } },
      },
    },
    issues: { type: 'array', items: { type: 'string' }, description: 'Problems, risks or pending items seen in the report or photos.' },
  },
};

const INSTRUCTIONS = `You are PKB Ops, the field assistant of PKB Homes (Florida home builder). Supervisors and project managers send you site reports: text, audio transcripts and photos.
Your job for each report:
1. Identify the house. The author must say the house number (job number like 0037, or the lot/house number) or the street address. Match it against JOBS. If the report does not identify the house, or it matches more than one job, set job_number null and ask in "question" which house it is (list the likely options if you have them). Never guess the house from the photos alone.
2. Read the text, the transcripts and the photos. Describe only what is actually said or visible.
3. Draft the Buildertrend Daily Log: a title (max 50 characters) and notes with what was done today, what was seen in the photos, what is next and any problem. Write it in the language the author used. No markdown.
4. Map the work to the PKB field manual (MANUAL, 39 steps): list only the steps the report or photos clearly show as done or in progress, with a short evidence note. Do not mark inspections as passed unless the author says they passed.
5. List issues (safety, quality, missing material, delays) if any.
If something essential is missing besides the house (e.g. the photos are unclear and the author asks for something specific), ask in "question" but still fill what you can.
"reply" is a short message to the author (Portuguese if they wrote in Portuguese): what you understood and, only when job_number is set and the draft is ready, that they can review and confirm it. While the house is unknown, do not say a draft is ready and do not repeat the question inside "reply" (the question goes only in "question"). Mark a manual step only when the report or a photo shows that specific work (e.g. graded soil is not landscaping).
MANUAL (n | phase | step):
${MANUAL_TEXT}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const body = await req.json().catch(() => ({}));

    if (body.confirm) {
      const { data, error } = await sb.rpc('ops_field_confirm', { p_id: body.confirm, p_title: body.title ?? null, p_notes: body.notes ?? null });
      if (error) return json({ error: error.message }, error.code === '42501' ? 403 : 400);
      return json(data);
    }
    if (body.cancel) {
      const { data, error } = await sb.rpc('ops_field_cancel', { p_id: body.cancel });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    const ctx = await sb.rpc('ops_field_context', { p_report_id: body.report_id ?? null });
    if (ctx.error) return json({ error: ctx.error.message }, ctx.error.code === '42501' ? 403 : 400);
    const { me, jobs, report } = ctx.data;
    if (body.report_id && !report) return json({ error: 'report not found' }, 404);
    if (report && ['confirmed', 'cancelled'].includes(report.status)) return json({ error: 'this report is closed — start a new one' }, 400);

    const media = (Array.isArray(body.media) ? body.media : []).filter((m: Any) => m?.path && ['photo', 'audio'].includes(m.kind)).slice(0, 40);
    const text = String(body.text || '').trim(), transcript = String(body.transcript || '').trim();
    if (!text && !transcript && !media.length) return json({ error: 'empty report' }, 400);
    const messages: Any[] = [...(report?.messages || []), { from: 'user', text, transcript, media, at: new Date().toISOString() }];

    // Photos of the whole report (latest first, capped) as signed URLs Claude can fetch.
    const photos = messages.flatMap((m: Any) => (m.media || []).filter((x: Any) => x.kind === 'photo')).slice(-MAX_PHOTOS);
    let urls: string[] = [];
    if (photos.length) {
      const { data, error } = await sb.storage.from('field-media').createSignedUrls(photos.map((p: Any) => p.path), 900);
      if (error) return json({ error: 'photos: ' + error.message }, 400);
      urls = (data || []).map((d: Any) => d.signedUrl).filter(Boolean);
    }

    const jobsText = (jobs || []).map((j: Any) => `${j.job_number} | ${j.address} | ${j.status} | supervisor ${j.supervisor || '—'} | PM ${j.pms || '—'} | done steps: ${Object.entries(j.checklist || {}).filter(([, s]) => s === 'done').map(([n]) => n).join(',') || '—'}`).join('\n');
    const convo = messages.map((m: Any) => m.from === 'assistant'
      ? `PKB Ops: ${m.text}`
      : `${me.name || me.email}: ${[m.text, m.transcript ? `[audio transcript] ${m.transcript}` : '', (m.media || []).some((x: Any) => x.kind === 'audio') && !m.transcript ? '[audio sent without transcript]' : '', (m.media || []).filter((x: Any) => x.kind === 'photo').length ? `[${(m.media || []).filter((x: Any) => x.kind === 'photo').length} photo(s)]` : ''].filter(Boolean).join(' ')}`).join('\n');

    const content: Any[] = [
      ...urls.map((u) => ({ type: 'image', source: { type: 'url', url: u } })),
      { type: 'text', text: `JOBS (job | address | status | team | manual steps already done):\n${jobsText}\n\nAUTHOR: ${me.name || me.email} (${me.role})\nNOW: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} Florida time\n\nREPORT CONVERSATION:\n${convo}` },
    ];

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);
    const anthropic = new Anthropic({ apiKey });
    const params: Any = {
      max_tokens: 16000,
      system: [{ type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    };
    let resp: Any = null, lastErr: unknown = null;
    for (const model of MODELS) {
      try { resp = await anthropic.messages.create({ ...params, model, fallbacks: 'default' } as Any, { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } }); break; }
      catch (e) {
        const s = (e as Any)?.status, msg = String((e as Any)?.message || '');
        if (s === 400 && /fallback/i.test(msg)) { resp = await anthropic.messages.create({ ...params, model } as Any); break; }
        if (s === 404 || s === 403) { lastErr = e; continue; }
        throw e;
      }
    }
    if (!resp) throw lastErr;
    if (resp.stop_reason === 'refusal') return json({ error: 'The assistant could not process this report.' }, 400);
    const out = JSON.parse((resp.content || []).filter((b: Any) => b.type === 'text').map((b: Any) => b.text).join(''));

    const job = out.job_number && (jobs || []).find((j: Any) => j.job_number.toLowerCase() === String(out.job_number).toLowerCase()) ? out.job_number : null;
    const status = !job ? 'needs_job' : out.daily_log && !out.question ? 'draft' : out.daily_log ? 'draft' : 'open';
    const draft = job && out.daily_log ? { job_number: job, address: (jobs || []).find((j: Any) => j.job_number === job)?.address, daily_log: out.daily_log, steps: out.steps || [], issues: out.issues || [] } : null;
    const say = [out.reply, out.question].filter(Boolean).join('\n\n');
    messages.push({ from: 'assistant', text: say, at: new Date().toISOString() });

    const saved = await sb.rpc('ops_field_save', { p_id: report?.id ?? null, p_messages: messages, p_status: status, p_draft: draft, p_job: job, p_channel: body.channel || 'portal' });
    if (saved.error) return json({ error: saved.error.message }, 400);
    return json({ report_id: saved.data, status, reply: say, question: out.question, draft, photos_seen: urls.length });
  } catch (e) {
    const status = (e as Any)?.status;
    return json({ error: status === 429 ? 'Muitos envios agora — tente em um minuto.' : String((e as Error).message || e) }, status === 429 ? 429 : 500);
  }
});
