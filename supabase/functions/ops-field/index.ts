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
const MAX_PHOTOS = 8, MAX_FRAMES = 4;   // what the assistant sees; Buildertrend still gets every photo

const STEPS = (manual as Any).phases.flatMap((ph: Any) => ph.steps.map((s: Any) => ({ ...s, phase: `${ph.n}. ${ph.name}` })));
const MANUAL_TEXT = STEPS.map((s: Any) => `${s.n} | ${s.phase} | ${s.name} (${s.en})${s.type === 'inspection' ? ' [inspection]' : ''}`).join('\n');

// House numbers: "casa 1", "house 01", "obra 001", "#0001", "job 1" → 0001; "S49"/"S049" → S049.
// Addresses: street number + a word of the street ("8188 Hale", "13304 SW 42nd").
const padJob = (raw: string) => { const m = String(raw).trim().match(/^(s)?\s*0*(\d{1,4})$/i); if (!m) return null; return m[1] ? 'S' + m[2].padStart(3, '0') : m[2].padStart(4, '0'); };
function houseCandidates(text: string, jobs: Any[]): { job: string; why: string }[] {
  const out = new Map<string, string>();
  const byNum = new Map(jobs.map((j: Any) => [String(j.job_number).toUpperCase(), j]));
  const t = ' ' + String(text || '').replace(/[\n\r]+/g, ' ') + ' ';
  for (const m of t.matchAll(/(?:casa|house|home|obra|job|n[ºo°]|numero|número|#)\s*(?:n[ºo°.]?\s*)?(?:do|da|de|number|no\.?)?\s*#?\s*(s\s*\d{1,3}|\d{1,4})\b/gi)) {
    const k = padJob(m[1].replace(/\s+/g, '')); if (k && byNum.has(k)) out.set(k, m[0].trim());
  }
  for (const m of t.matchAll(/\b(0\d{3}|S\s?\d{1,3})\b/gi)) { const k = padJob(m[1].replace(/\s+/g, '')); if (k && byNum.has(k)) out.set(k, m[1]); }
  const words = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (const m of t.matchAll(/\b(\d{3,6})\s+([A-Za-z0-9 .]{2,40})/g)) {
    const said = words(m[2]).filter((w) => !['sw', 'se', 'ne', 'nw', 'n', 's', 'e', 'w', 'st', 'rd', 'ave', 'dr', 'ln', 'ct', 'cir', 'pl', 'ter', 'way', 'blvd'].includes(w));
    for (const j of jobs) {
      const a = words(String(j.address || '').split(',')[0]);
      if (a[0] === m[1] && said.some((w) => a.slice(1).includes(w))) out.set(String(j.job_number), `${m[1]} ${m[2].trim()}`);
    }
  }
  return [...out].map(([job, why]) => ({ job, why }));
}

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
1. Identify the house. The author must say the house number or the street address. House numbers are the Buildertrend job numbers with leading zeros: "casa 1", "house 01", "obra 001" and "0001" all mean job 0001; "S49" means S049. A street address (e.g. "8188 Hale") also identifies the house. DETECTED HOUSE CANDIDATES lists what the system matched in the text — use it. Match against JOBS. If the report covers more than one house, ask the author to send one report per house (a Daily Log belongs to one job). If the report does not identify the house, or it matches more than one job, set job_number null and ask in "question" which house it is (list the likely options if you have them). Never guess the house from the photos alone.
2. Understand the report: the text, the audio transcripts and the photos (frames marked as video frames come from a video the author filmed). The author's statements about the work are the primary source: include what they report even if the photos don't show it — a photo shows only part of the site, so something missing from a photo is not evidence against the report. Use the photos to add detail and to spot problems; flag a contradiction only when a photo clearly shows the opposite of what was said.
3. Write the Buildertrend Daily Log as a SUMMARY a manager can read in 20 seconds — never paste or paraphrase the transcript line by line, never narrate the photos. Title: max 50 characters, the main work of the day. Notes, in the author's language, plain text, short lines, with these labels translated to that language (Portuguese: "Feito hoje:", "Em andamento:", "Próximo:", "Problemas:"):
   Done today: …
   In progress: …
   Next: …
   Issues: …
   Leave out any line that has nothing to say (never write a label followed by a dash or 'none').
   Mention only construction facts (work done, materials delivered, crews on site, inspections, problems). Leave out vehicles, signs, weather and other scenery unless they matter to the work. Keep it under ~8 lines.
4. Map the work to the PKB field manual (MANUAL, 39 steps): list only the steps the report or photos clearly show as done or in progress, with a short evidence note. Do not mark inspections as passed unless the author says they passed.
5. List issues (safety, quality, missing material, delays) if any.
If something essential is missing besides the house (e.g. the photos are unclear and the author asks for something specific), ask in "question" but still fill what you can.
"reply" is a short message to the author (Portuguese if they wrote in Portuguese): what you understood and, only when job_number is set and the draft is ready, that they can review and confirm it. While the house is unknown, do not say a draft is ready and do not repeat the question inside "reply" (the question goes only in "question"). Mark a manual step only when the report or a photo shows that specific work (e.g. graded soil is not landscaping).
MANUAL (n | phase | step):
${MANUAL_TEXT}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  let savedId: Any = null;
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

    const clientId = body.client_id ? String(body.client_id).slice(0, 80) : null;
    const ctx = await sb.rpc('ops_field_context', { p_report_id: body.report_id ?? null, p_client_id: clientId });
    if (ctx.error) return json({ error: ctx.error.message }, ctx.error.code === '42501' ? 403 : 400);
    const { me, jobs, report } = ctx.data;
    if (body.report_id && !report) return json({ error: 'report not found' }, 404);
    if (report && ['confirmed', 'cancelled'].includes(report.status)) return json({ error: 'this report is closed — start a new one' }, 400);

    const media = (Array.isArray(body.media) ? body.media : []).filter((m: Any) => m?.path && ['photo', 'audio', 'video'].includes(m.kind)).slice(0, 60);
    const text = String(body.text || '').trim(), transcript = String(body.transcript || '').trim();
    let messages: Any[] = [...(report?.messages || [])];
    const already = clientId ? messages.findIndex((m: Any) => m.client_id === clientId) : -1;
    if (already >= 0 && messages[already + 1]?.from === 'assistant') {
      // the phone resent something the server already answered (the reply was lost on the way back)
      const last = messages.slice(already + 1).find((m: Any) => m.from === 'assistant');
      return json({ report_id: report.id, status: report.status, reply: last?.text || '', draft: report.draft, duplicate: true });
    }
    if (already < 0 && !body.retry) {
      if (!text && !transcript && !media.length) return json({ error: 'empty report' }, 400);
      messages.push({ from: 'user', text, transcript, media, at: new Date().toISOString(), ...(clientId ? { client_id: clientId } : {}) });
    }
    if (!messages.length || messages[messages.length - 1].from !== 'user') return json({ error: 'nothing to process' }, 400);
    // House first, without the AI: "casa 1" / "0001" / "8188 Hale" are matched here. When the
    // report doesn't say the house (or says more than one) the question costs nothing.
    const said = messages.filter((m: Any) => m.from === 'user').map((m: Any) => `${m.text || ''} ${m.transcript || ''}`).join(' ');
    const cands = houseCandidates(said, jobs || []);
    const lastUser = [...messages].reverse().find((m: Any) => m.from === 'user');
    const latest = houseCandidates(`${lastUser?.text || ''} ${lastUser?.transcript || ''}`, jobs || []);
    // the latest message wins (answer to "which house?" or a correction), then the draft's house, then the whole report
    const known = latest.length === 1 ? latest : report?.draft?.job_number && !latest.length ? [{ job: report.draft.job_number, why: 'report' }] : latest.length ? latest : cands;
    if (known.length !== 1) {
      const q = known.length
        ? `Este relatório fala de mais de uma casa (${known.map((c: Any) => c.job).join(', ')}). Qual é a casa deste relatório? Mande um relatório por casa.`
        : 'Qual é a casa deste relatório? Diga o número da casa (ex.: "casa 37" ou "0037") ou o endereço (ex.: "8188 Hale").';
      messages.push({ from: 'assistant', text: q, at: new Date().toISOString() });
      const saved = await sb.rpc('ops_field_save', { p_id: report?.id ?? null, p_messages: messages, p_status: 'needs_job', p_draft: null, p_job: null, p_channel: body.channel || 'portal' });
      if (saved.error) return json({ error: saved.error.message }, 400);
      return json({ report_id: saved.data, status: 'needs_job', reply: q, question: q, draft: null, candidates: known });
    }
    const house = (jobs || []).find((j: Any) => j.job_number === known[0].job);
    // Save first: the photos, audio and text are kept even if the assistant fails; the report can be resent.
    const pre = await sb.rpc('ops_field_save', { p_id: report?.id ?? null, p_messages: messages, p_status: report?.status && report.status !== 'pending' ? report.status : 'pending', p_draft: null, p_job: null, p_channel: body.channel || 'portal' });
    if (pre.error) return json({ error: pre.error.message }, 400);
    const reportId = pre.data; savedId = reportId;

    // Photos of the whole report (latest first, capped) as signed URLs Claude can fetch.
    const allPhotos = messages.flatMap((m: Any) => (m.media || []).filter((x: Any) => x.kind === 'photo'));
    const photos = [...allPhotos.filter((x: Any) => !x.from_video).slice(-MAX_PHOTOS), ...allPhotos.filter((x: Any) => x.from_video).slice(-MAX_FRAMES)];
    let urls: string[] = [];
    if (photos.length) {
      const { data, error } = await sb.storage.from('field-media').createSignedUrls(photos.map((p: Any) => p.ai_path || p.path), 900);
      if (error) return json({ error: 'photos: ' + error.message }, 400);
      urls = (data || []).map((d: Any) => d.signedUrl).filter(Boolean);
    }

    const j = house;
    const jobsText = `${j.job_number} | ${j.bt_job_name || ''} | ${j.address} | ${j.status} | supervisor ${j.supervisor || '—'} | PM ${j.pms || '—'} | done steps: ${Object.entries(j.checklist || {}).filter(([, st]) => st === 'done').map(([n]) => n).join(',') || '—'}`;
    const convo = messages.map((m: Any) => m.from === 'assistant'
      ? `PKB Ops: ${m.text}`
      : `${me.name || me.email}: ${[m.text, m.transcript ? `[audio transcript] ${m.transcript}` : '', (m.media || []).some((x: Any) => x.kind === 'audio') && !m.transcript ? '[audio sent without transcript]' : '', (m.media || []).filter((x: Any) => x.kind === 'photo' && !x.from_video).length ? `[${(m.media || []).filter((x: Any) => x.kind === 'photo' && !x.from_video).length} photo(s)]` : '', (m.media || []).filter((x: Any) => x.from_video).length ? `[video: ${(m.media || []).filter((x: Any) => x.from_video).length} frames${(m.media || []).some((x: Any) => x.kind === 'video') ? '' : ', video file too large to keep'}; the sound of the video is not available]` : ''].filter(Boolean).join(' ')}`).join('\n');

    const content: Any[] = [
      ...urls.flatMap((u, i) => [{ type: 'text', text: photos[i]?.from_video ? `Video frame (${photos[i].name || ''})` : `Photo ${i + 1}` }, { type: 'image', source: { type: 'url', url: u } }]),
      { type: 'text', text: `THE HOUSE (identified by the system from "${known[0].why}"; use this job_number): job | Buildertrend name | address | status | team | manual steps already done\n${jobsText}\n\nAUTHOR: ${me.name || me.email} (${me.role})\nNOW: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} Florida time\n\nREPORT CONVERSATION:\n${convo}` },
    ];

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);
    const anthropic = new Anthropic({ apiKey });
    const params: Any = {
      max_tokens: 16000,
      system: [{ type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: { effort: Deno.env.get('OPS_FIELD_EFFORT') || 'low', format: { type: 'json_schema', schema: SCHEMA } },
    };
    let resp: Any = null, lastErr: unknown = null;
    const models = body.model_test && me.role === 'admin' ? [String(body.model_test)] : MODELS;
    for (const model of models) {
      const p2 = /haiku/.test(model) ? { ...params, output_config: { format: params.output_config.format } } : params;   // Haiku has no effort setting
      try { resp = await anthropic.messages.create({ ...p2, model, fallbacks: 'default' } as Any, { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } }); break; }
      catch (e) {
        const s = (e as Any)?.status, msg = String((e as Any)?.message || '');
        if (s === 400 && /fallback/i.test(msg)) { resp = await anthropic.messages.create({ ...p2, model } as Any); break; }
        if (s === 404 || s === 403) { lastErr = e; continue; }
        throw e;
      }
    }
    if (!resp) throw lastErr;
    const u = resp.usage || {};
    await sb.rpc('ops_log_usage', { p_feature: 'field', p_model: resp.model || '', p_in: u.input_tokens || 0, p_out: u.output_tokens || 0, p_cache_read: u.cache_read_input_tokens || 0, p_cache_write: u.cache_creation_input_tokens || 0, p_report_id: reportId });
    if (resp.stop_reason === 'refusal') return json({ report_id: reportId, status: 'pending', error: 'The assistant could not process this report — it is saved; send it again or add details.' }, 400);
    const out = JSON.parse((resp.content || []).filter((b: Any) => b.type === 'text').map((b: Any) => b.text).join(''));

    const norm = out.job_number ? (padJob(out.job_number) || String(out.job_number).toUpperCase()) : null;
    const job = norm && (jobs || []).find((j: Any) => j.job_number.toUpperCase() === norm) ? (jobs || []).find((j: Any) => j.job_number.toUpperCase() === norm).job_number : null;
    const status = !job ? 'needs_job' : out.daily_log && !out.question ? 'draft' : out.daily_log ? 'draft' : 'open';
    const draft = job && out.daily_log ? { job_number: job, address: (jobs || []).find((j: Any) => j.job_number === job)?.address, daily_log: out.daily_log, steps: out.steps || [], issues: out.issues || [] } : null;
    const say = [out.reply, out.question].filter(Boolean).join('\n\n');
    messages.push({ from: 'assistant', text: say, at: new Date().toISOString() });

    const saved = await sb.rpc('ops_field_save', { p_id: reportId, p_messages: messages, p_status: status, p_draft: draft, p_job: job, p_channel: body.channel || 'portal' });
    if (saved.error) return json({ report_id: reportId, status: 'pending', error: saved.error.message }, 400);
    return json({ report_id: saved.data, status, reply: say, question: out.question, draft, photos_seen: urls.length, usage: resp.usage, model: resp.model });
  } catch (e) {
    const status = (e as Any)?.status;
    return json({ report_id: savedId, status: savedId ? 'pending' : undefined, error: (status === 429 ? 'Muitos envios agora — tente em um minuto.' : String((e as Error).message || e)) + (savedId ? ' (report saved — it can be sent again)' : '') }, status === 429 ? 429 : 500);
  }
});
