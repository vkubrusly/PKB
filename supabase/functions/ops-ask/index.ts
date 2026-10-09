// =============================================================================
// ops-ask — the "Ask PKB Ops" assistant of the portal (budget.pkbhomes.com/ops/).
//
// POST { question, history?: [{q, a}] }  → { text, used, proposals: [{id, action, summary}] }
// POST { confirm: <proposal id> }        → runs a proposed action   (public.ops_confirm)
// POST { cancel:  <proposal id> }        → discards it              (public.ops_cancel)
//
// Everything runs with the caller's own Supabase session: the SECURITY DEFINER functions
// (migration 0023) allow only the partners listed in ops.portal_users. The assistant answers
// from the latest board snapshot (ops.snapshots) and can PROPOSE actions — Buildertrend Daily
// Log, e-mail from the bot mailbox, pause/resume a job, set supervisor/PM, job note, change
// request for Claude. Nothing is executed until a partner clicks Confirm on the page.
//
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY (OPS_ASK_MODEL optional)
// =============================================================================
import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { cors, json } from '../_shared/cors.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

// Sonnet 5.5: Victor's choice for cost (2026-09-30); Opus stays as the fallback.
const MODELS = [Deno.env.get('OPS_ASK_MODEL') || 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5-5'].filter((v, i, a) => a.indexOf(v) === i);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// The board snapshot is ~1 MB; keep it in the worker between calls, keyed by its timestamp.
let cache: { at: string; board: Any; context: string } | null = null;

const COLS = ['job_number', 'company', 'address', 'county', 'model', 'supervisor', 'stage', 'ops_status', 'permit', 'applied_at', 'issued_at', 'rounds', 'failed_depts_last_round', 'pause', 'turtle', 'inspections', 'failed_inspections', 'insp_progress', 'insp_next', 'insp_failed_open', 'ready_for_finals_est', 'signed_at', 'build_start', 'build_days', 'photos_last_at', 'photos_last_by', 'photos_total', 'last_daily_log', 'last_daily_log_at', 'last_daily_log_by', 'daily_logs_7d', 'field_steps_done', 'last_field_report', 'permit_office'];
const cell = (v: Any) => (v == null || (Array.isArray(v) && !v.length) ? '' : Array.isArray(v) ? v.join('+') : String(v));

function buildContext(D: Any): string {
  const rows = D.jobs.map((j: Any) => COLS.map((k) => cell(j[k])).join('|')).join('\n');
  const dir = (D.directory || []).map((p: Any) => `${p.name} <${p.email || 'no e-mail'}> — ${p.role}${p.bt_name && p.bt_name !== p.name ? ` (Buildertrend: ${p.bt_name})` : ''}`).join('\n');
  return `SNAPSHOT DATE: ${D.asOf} (built ${D.builtAt || D.asOf})
PEOPLE (use these e-mails and Buildertrend names; never invent an address):
${dir}
JOBS (pipe-separated: ${COLS.join('|')}):
${rows}
RECENT FAILED INSPECTIONS: ${JSON.stringify(D.fails)}
DEPARTMENT FAILURES: ${JSON.stringify(D.dept)}
CYCLE BY COUNTY: ${JSON.stringify(D.cycle)}
REVIEW TIME SPLIT: ${JSON.stringify(D.rounds)}
CONSTRUCTION CLOCK: ${JSON.stringify(D.clock)}`;
}

const INSTRUCTIONS = `You are PKB Ops, the operations assistant of PKB Homes, a Florida home builder. You talk to the company's partners.
Answer using ONLY the data in the snapshot and the tools. ACCURACY (Victor's rule): state a number, a cause or a conclusion only when the data shows it — name the jobs/items behind every figure so it can be checked; say the period and the county/source; attribute a cause only when a comment or log text says it (items without a comment are "reason not stated"); use the county's own words ("Revisions Required" is a correction, not a denial; say what was approved later). If the data does not show it, say you don't have it instead of estimating. Reply in the language of the question (Portuguese or English). Be concrete: job numbers, streets, permit numbers, dates, departments, people. Plain text and short lists, no markdown tables.
Reading the data: stage pre = no permit yet; permit = in county review; inspections = issued, under construction; done = CO. failed_depts_last_round non-empty means the ball is with the designer (Sovereign). insp_progress = passed/required inspections from the permit's own list on the county portal. build_start / build_days = construction clock (starts at the later of permit issuance and the 2nd invoice payment). photos_* = last site photo upload in Buildertrend. permit_office = who coordinates the permit (sovereign = Sovereign, the designer/expediter, today for Marion and Citrus; pkb = Guilherme). field_steps_done = steps of the PKB field manual (39) confirmed from supervisors' field reports; get_job_file has field_checklist with the details. ready_for_finals_est is an estimate from PKB's own medians. Prime = legacy company being phased out.
For who wrote the Buildertrend Daily Logs (per job, per supervisor, per person, which houses under construction had none), CALL get_daily_logs; the supervisor's log and the PM's log are told apart by the author. Before the Daily Logs collector, the only proxy was who uploaded the last photo (photos_last_by), which does not prove who wrote the text.
What the Daily Logs SAY (power/water hookup dates, delays, missing material, vendor problems, weather, scheduled inspections/pours/deliveries, a job's or a supervisor's latest logs): CALL search_daily_logs — with a query (it already matches Portuguese/English variants) or with no query to read the full texts of a job / author / supervisor / period — and read the texts yourself to extract dates and facts; quote job, log date, author. To compare a log with the county portal (e.g. "inspection called" but the portal shows none), also CALL get_job_file. get_daily_logs also lists coverage_gaps: Daily Logs Buildertrend e-mailed about whose text the system did not store — report them if any.
For one job's reviews, corrections, inspections, holds, invoices or history, CALL get_job_file and quote the county's comments faithfully (itemize long ones). For review comments across many jobs, use search_reviews. For what the system sent or queued, use get_outbox.
ACTIONS: when the partner asks you to DO something, draft it completely and call the matching propose_* tool:
- propose_daily_log: a Buildertrend Daily Log on a job (write it in English; notify people by their Buildertrend names).
- propose_email: an e-mail from the bot mailbox (Portuguese for PKB people unless asked otherwise; English for outside vendors).
- propose_pause_job / propose_resume_job, propose_set_contact (supervisor or PM), propose_job_note.
- propose_set_office: change which office coordinates a house's permit (sovereign or pkb); corrections e-mails follow it.
- propose_change_request: a change to the system itself (new rule, report, screen, data fix) — it goes to Claude, the system's developer.
A proposal does NOT run anything: it shows a Confirm button to the partner. Never say an action was done; say it is waiting for confirmation. If the request is ambiguous (which job? who receives?), ask before proposing. If the data can't answer, say so and what would be needed.`;

const S = (props: Record<string, Any>, required: string[]) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });
const strs = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

const TOOLS: Any[] = [
  { name: 'get_job_file', description: 'Full file for one job: permits with every review round (department, status, reviewer, date, full county comments), holds, all inspections, pauses, inspection progress, construction clock, site photos, invoices.', input_schema: S({ job_number: str('Job number, e.g. "0034" or "S049"') }, ['job_number']) },
  { name: 'search_reviews', description: 'Search all county review comments for a word or phrase; returns job, permit, round, department, date and a snippet.', input_schema: S({ query: str('Word or phrase'), department: str('Optional department filter') }, ['query']) },
  { name: 'get_daily_logs', description: 'Buildertrend Daily Logs of the last 60 days: job, date, time written (Florida), author, title, and the job\'s supervisor; plus the count per author, the jobs under construction (permit issued) with no log in the period, and coverage_gaps (logs Buildertrend e-mailed about whose text was not collected). For the log TEXT use search_daily_logs.', input_schema: S({ days: { type: 'integer', description: 'Period in days, counting today (default 7, max 60)' }, supervisor: str('Optional: only jobs of this supervisor'), author: str('Optional: only logs written by this person'), job_number: str('Optional job number') }, []) },
  { name: 'search_daily_logs', description: 'Search the TEXT of every Buildertrend Daily Log (whole history). query: words or phrases separated by | (any may match); accents, case and common Portuguese/English variants are matched (energia/power/meter/FPL/SECO/Withlacoochee, água/water, inspeção/inspection, chuva/rain, atraso/delay, material/delivery, concreto/pour, etc.). Without a query, returns the full logs that pass the filters (newest first). Returns job, address, supervisor, date, time, author, title, and the text (whole text when few results, else a snippet around the match).', input_schema: S({ query: str('Optional: words/phrases separated by |'), job_number: str('Optional job number'), author: str('Optional: written by this person'), supervisor: str('Optional: only jobs of this supervisor'), days: { type: 'integer', description: 'Optional: only the last N days' }, limit: { type: 'integer', description: 'Max results (default 40, max 120)' } }, []) },
  { name: 'get_outbox', description: 'Messages the system sent or queued (e-mails, Buildertrend Daily Logs) and the recent assistant actions, newest first. Optional job filter.', input_schema: S({ job_number: str('Optional job number') }, []) },
  { name: 'propose_daily_log', description: 'Propose a Buildertrend Daily Log on a job. Posted on the next run after a partner confirms.', input_schema: S({ job_number: str('Job number'), title: str('Short title (max 50 chars)'), notes: str('Log text, in English'), notify: strs('Buildertrend names to notify') }, ['job_number', 'title', 'notes']) },
  { name: 'propose_email', description: 'Propose an e-mail from the bot mailbox (botpkbhomes@gmail.com). Sent within the hour after a partner confirms.', input_schema: S({ to: strs('Recipient e-mails'), cc: strs('Cc e-mails'), subject: str('Subject'), text: str('Plain-text body, signed "— PKB Ops"'), job_number: str('Optional related job') }, ['to', 'subject', 'text']) },
  { name: 'propose_pause_job', description: 'Propose pausing a job (stops idle/stall alerts and the KPI clocks).', input_schema: S({ job_number: str('Job number'), reason: { type: 'string', enum: ['owner_deferred_start', 'awaiting_1st_draw', 'awaiting_impact_fees', 'awaiting_warranty_deed', 'turtle', 'other'] }, note: str('Why') }, ['job_number', 'reason']) },
  { name: 'propose_resume_job', description: 'Propose ending the open pause(s) of a job.', input_schema: S({ job_number: str('Job number') }, ['job_number']) },
  { name: 'propose_set_contact', description: "Propose setting a job's supervisor or project manager (replaces the current one).", input_schema: S({ job_number: str('Job number'), role: { type: 'string', enum: ['supervisor', 'pm'] }, name: str('Person name as in PEOPLE') }, ['job_number', 'role', 'name']) },
  { name: 'propose_job_note', description: 'Propose adding a note to a job.', input_schema: S({ job_number: str('Job number'), note: str('Note text') }, ['job_number', 'note']) },
  { name: 'propose_set_office', description: "Propose changing which office coordinates a house's permit (Sovereign or PKB). Corrections and follow-up e-mails go to that office.", input_schema: S({ job_number: str('Job number'), office: { type: 'string', enum: ['sovereign', 'pkb'] } }, ['job_number', 'office']) },
  { name: 'propose_change_request', description: 'Propose a change request to the system itself, for Claude (new rule, report, screen, data correction).', input_schema: S({ text: str('The request, complete and specific') }, ['text']) },
];

function findJob(D: Any, n: string): string | null {
  const t = String(n || '').trim().toLowerCase();
  const keys = Object.keys(D.files || {});
  return keys.find((k) => k.toLowerCase() === t) || keys.find((k) => k.toLowerCase().endsWith(t)) || null;
}

async function runTool(name: string, input: Any, D: Any, sb: SupabaseClient, proposals: Any[]): Promise<Any> {
  if (name === 'get_job_file') {
    const k = findJob(D, input.job_number);
    if (!k) throw new Error(`No job ${input.job_number}`);
    const f = structuredClone(D.files[k]);
    for (const p of f.permits || []) for (const r of p.rounds || []) for (const x of r.reviews || []) if (x.comments?.length > 3000) x.comments = x.comments.slice(0, 3000) + ' …';
    return f;
  }
  if (name === 'search_reviews') {
    const q = String(input.query).toLowerCase(), out: Any[] = [];
    for (const [n, f] of Object.entries<Any>(D.files || {})) for (const p of f.permits || []) for (const r of p.rounds || []) for (const x of r.reviews || []) {
      if (!x.comments || (input.department && !String(x.department).toLowerCase().includes(String(input.department).toLowerCase()))) continue;
      const i = x.comments.toLowerCase().indexOf(q); if (i < 0) continue;
      out.push({ job: n, permit: p.number, round: r.round, department: x.department, failed: x.failed, date: x.completed_at, snippet: x.comments.slice(Math.max(0, i - 160), i + 260) });
    }
    return { matches: out.length, results: out.slice(0, 25) };
  }
  if (name === 'get_daily_logs') {
    const days = Math.min(Math.max(Number(input.days) || 7, 1), 60);
    const since = new Date(Date.now() - (days - 1) * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const low = (v: Any) => String(v || '').toLowerCase();
    const job = (n: string) => D.jobs.find((j: Any) => j.job_number === n) || {};
    const jobOk = (j: Any) => (!input.supervisor || low(j.supervisor).includes(low(input.supervisor))) && (!input.job_number || low(j.job_number).endsWith(low(input.job_number)));
    const logs = (D.daily_logs || []).filter((l: Any) => l.date >= since && jobOk(job(l.job_number)) && (!input.author || low(l.by).includes(low(input.author))))
      .map((l: Any) => ({ ...l, supervisor: job(l.job_number).supervisor || null, address: String(job(l.job_number).address || '').split(',')[0] }));
    const per_author: Record<string, number> = {};
    for (const l of logs) per_author[l.by || '?'] = (per_author[l.by || '?'] || 0) + 1;
    const silent = D.jobs.filter((j: Any) => j.stage === 'inspections' && j.clock_phase !== 'co' && jobOk(j) && !logs.some((l: Any) => l.job_number === j.job_number))
      .map((j: Any) => ({ job_number: j.job_number, address: String(j.address || '').split(',')[0], supervisor: j.supervisor, last_log: j.last_daily_log_at || j.last_daily_log, last_by: j.last_daily_log_by }));
    const gaps = (D.daily_log_gaps || []).filter((g: Any) => jobOk(job(g.job_number)));
    return { since, days, logs: logs.length, per_author, entries: logs.slice(0, 150), under_construction_without_log: silent, coverage_gaps: gaps };
  }
  if (name === 'search_daily_logs') {
    const fold = (v: Any) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    // Portuguese / English variants the field team uses for the same thing.
    const GROUPS = [
      ['energia', 'power', 'meter', 'medidor', 'fpl', 'seco', 'withlacoochee', 'duke', 'tug', 'pre-power', 'luz', 'ligacao de energia', 'energizar', 'energized'],
      ['agua', 'water', 'poco', 'well pump', 'hidrometro', 'water meter'],
      ['esgoto', 'sewer', 'septic', 'septico', 'fossa', 'drainfield'],
      ['inspecao', 'inspection', 'inspector', 'inspetor', 'vistoria'],
      ['chuva', 'rain', 'weather', 'clima', 'storm', 'tempestade', 'furacao', 'hurricane'],
      ['atraso', 'atrasad', 'delay', 'postpon', 'adiad', 'reschedul', 'remarc'],
      ['material', 'materiais', 'supply', 'supplies', 'delivery', 'entrega', 'fornecedor', 'vendor', 'supplier', 'falta', 'missing', 'shortage'],
      ['concreto', 'concretagem', 'concrete', 'pour', 'slab', 'laje', 'footing', 'sapata'],
      ['conexao', 'ligacao', 'connection', 'hookup', 'hook-up', 'hook up'],
      ['telhado', 'roof', 'shingle', 'telha'],
      ['drywall', 'gesso', 'sheetrock'],
    ];
    const terms = String(input.query || '').split('|').map((t) => fold(t).trim()).filter(Boolean);
    const words = new Set<string>();
    for (const t of terms) { words.add(t); for (const g of GROUPS) if (g.some((w) => t.includes(w) || w.includes(t))) g.forEach((w) => words.add(w)); }
    const low = (v: Any) => String(v || '').toLowerCase();
    const job = (n: string) => D.jobs.find((j: Any) => j.job_number === n) || {};
    const since = input.days ? new Date(Date.now() - (Number(input.days) - 1) * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : '';
    const limit = Math.min(Math.max(Number(input.limit) || 40, 1), 120);
    const hits: Any[] = [];
    for (const l of D.daily_log_texts || []) {
      const j = job(l.job_number);
      if (since && l.date < since) continue;
      if (input.job_number && !low(l.job_number).endsWith(low(input.job_number))) continue;
      if (input.author && !low(l.by).includes(low(input.author))) continue;
      if (input.supervisor && !low(j.supervisor).includes(low(input.supervisor))) continue;
      const text = `${l.title || ''}\n${l.notes || ''}`, f = fold(text);
      let at = -1, matched = '';
      if (words.size) { for (const w of words) { const i = f.indexOf(w); if (i >= 0 && (at < 0 || i < at)) { at = i; matched = w; } } if (at < 0) continue; }
      hits.push({ job_number: l.job_number, address: String(j.address || '').split(',')[0], supervisor: j.supervisor || null, date: l.date, at: l.at, by: l.by, title: l.title, matched: matched || null, _text: l.notes || '', _i: at });
    }
    const full = hits.length <= 15;
    const results = hits.slice(0, limit).map(({ _text, _i, ...h }) => ({ ...h, text: full || _i < 0 ? _text : _text.slice(Math.max(0, _i - 200), _i + 400) }));
    return { matches: hits.length, matched_words: [...words], results };
  }
  if (name === 'get_outbox') {
    const { data, error } = await sb.rpc('ops_board', { p_with_board: false });
    if (error) throw new Error(error.message);
    const f = (m: Any) => !input.job_number || String(m.job_number || '').toLowerCase().endsWith(String(input.job_number).toLowerCase());
    return { outbox: (data.outbox || []).filter(f).slice(0, 30).map((m: Any) => ({ ...m, body: String(m.body || '').slice(0, 400) })), actions: (data.actions || []).slice(0, 15) };
  }
  // propose_*
  const action = { propose_daily_log: 'daily_log', propose_email: 'email', propose_pause_job: 'pause_job', propose_resume_job: 'resume_job', propose_set_contact: 'set_contact', propose_job_note: 'job_note', propose_change_request: 'change_request', propose_set_office: 'set_office' }[name];
  if (!action) throw new Error(`Unknown tool ${name}`);
  if (input.job_number) {
    const k = findJob(D, input.job_number);
    if (!k && action !== 'email') throw new Error(`No job ${input.job_number}`);
    if (k) input.job_number = k;
  }
  const summary = summarize(action, input, D);
  const { data: id, error } = await sb.rpc('ops_propose', { p_action: action, p_input: input, p_summary: summary });
  if (error) throw new Error(error.message);
  proposals.push({ id, action, summary, input });
  return { proposal_id: id, status: 'waiting for the partner to click Confirm', summary };
}

function summarize(action: string, i: Any, D: Any): string {
  const job = i.job_number ? `${i.job_number} · ${String(D.files?.[i.job_number]?.address || '').split(',')[0]}` : '';
  switch (action) {
    case 'daily_log': return `Daily Log no Buildertrend — ${job}\n“${i.title}”\n${i.notes}${i.notify?.length ? `\nNotificar: ${i.notify.join(', ')}` : ''}`;
    case 'email': return `E-mail para ${i.to.join(', ')}${i.cc?.length ? ` (cc ${i.cc.join(', ')})` : ''}\nAssunto: ${i.subject}\n\n${i.text}`;
    case 'pause_job': return `Pausar a obra ${job} — ${i.reason}${i.note ? `: ${i.note}` : ''}`;
    case 'resume_job': return `Retomar a obra ${job} (encerrar a pausa)`;
    case 'set_contact': return `${i.role === 'pm' ? 'Project manager' : 'Supervisor'} da obra ${job}: ${i.name}`;
    case 'job_note': return `Nota na obra ${job}: ${i.note}`;
    case 'set_office': return `Escritório do permit da obra ${job}: ${i.office === 'sovereign' ? 'Sovereign' : 'PKB (Guilherme)'}`;
    default: return `Pedido de mudança no sistema: ${i.text}`;
  }
}

async function create(anthropic: Anthropic, model: string, params: Any): Promise<Any> {
  try {
    return await anthropic.messages.create({ ...params, model, fallbacks: 'default' } as Any, { headers: { 'anthropic-beta': FALLBACK_BETA } });
  } catch (e) {
    const status = (e as Any)?.status, msg = String((e as Any)?.message || '');
    if (status === 400 && /fallback/i.test(msg)) return await anthropic.messages.create({ ...params, model } as Any);
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const body = await req.json().catch(() => ({}));

    if (body.confirm || body.cancel) {
      const { data, error } = await sb.rpc(body.confirm ? 'ops_confirm' : 'ops_cancel', { p_id: body.confirm || body.cancel });
      if (error) return json({ error: error.message }, error.code === '42501' ? 403 : 400);
      return json(data);
    }

    const question = String(body.question || '').trim();
    if (!question) return json({ error: 'empty question' }, 400);

    const head = await sb.rpc('ops_board', { p_with_board: false });
    if (head.error) return json({ error: head.error.message }, head.error.code === '42501' ? 403 : 400);
    const at = String(head.data.snapshot_at);
    if (!cache || cache.at !== at) {
      const full = await sb.rpc('ops_board', { p_with_board: true });
      if (full.error || !full.data?.board) return json({ error: full.error?.message || 'no snapshot yet' }, 400);
      cache = { at, board: full.data.board, context: buildContext(full.data.board) };
    }
    const D = cache.board;
    const me = head.data.me;

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);
    const anthropic = new Anthropic({ apiKey });

    // Stable prefix first (tools → instructions → snapshot) so it is cached across questions.
    const system = [
      { type: 'text', text: INSTRUCTIONS },
      { type: 'text', text: cache.context, cache_control: { type: 'ephemeral' } },
    ];
    const messages: Any[] = [];
    for (const h of (Array.isArray(body.history) ? body.history : []).slice(-4)) {
      if (h?.q && h?.a) messages.push({ role: 'user', content: String(h.q) }, { role: 'assistant', content: String(h.a) });
    }
    messages.push({ role: 'user', content: `${question}\n\n(asked by ${me?.name || me?.email}, ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} Florida time)` });

    const used = new Set<string>();
    const proposals: Any[] = [];
    let model = MODELS[0], resp: Any = null;
    for (let turn = 0; turn < 10; turn++) {
      const params = { max_tokens: 16000, system, tools: TOOLS, messages, output_config: { effort: 'medium' } };
      if (turn === 0) {
        // pick the first model this API key can use, then stay on it for the whole loop
        for (let m = 0; m < MODELS.length; m++) {
          try { model = MODELS[m]; resp = await create(anthropic, model, params); break; }
          catch (e) { const s = (e as Any)?.status; if ((s === 404 || s === 403) && m < MODELS.length - 1) continue; throw e; }
        }
      } else resp = await create(anthropic, model, params);

      const u = resp.usage || {};
      sb.rpc('ops_log_usage', { p_feature: 'ask', p_model: resp.model || model, p_in: u.input_tokens || 0, p_out: u.output_tokens || 0, p_cache_read: u.cache_read_input_tokens || 0, p_cache_write: u.cache_creation_input_tokens || 0 }).then(() => {}, () => {});
      if (resp.stop_reason === 'refusal') return json({ text: 'Não consigo responder a essa pergunta.', used: [...used], proposals });
      if (resp.stop_reason !== 'tool_use') break;
      messages.push({ role: 'assistant', content: resp.content });
      const results: Any[] = [];
      for (const b of resp.content.filter((x: Any) => x.type === 'tool_use')) {
        used.add(b.name === 'get_job_file' ? `job ${b.input.job_number}` : b.name === 'search_reviews' ? `search "${b.input.query}"` : b.name.replace(/_/g, ' '));
        try { results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await runTool(b.name, b.input, D, sb, proposals)) }); }
        catch (e) { results.push({ type: 'tool_result', tool_use_id: b.id, content: String((e as Error).message || e), is_error: true }); }
      }
      messages.push({ role: 'user', content: results });
    }
    const text = (resp?.content || []).filter((b: Any) => b.type === 'text').map((b: Any) => b.text).join('\n').trim();
    return json({ text: text || (resp?.stop_reason === 'max_tokens' ? '(resposta cortada)' : ''), used: [...used], proposals, snapshot_at: at, model });
  } catch (e) {
    const status = (e as Any)?.status;
    return json({ error: status === 429 ? 'Muitas perguntas agora — tente em um minuto.' : String((e as Error).message || e) }, status === 429 ? 429 : 500);
  }
});
