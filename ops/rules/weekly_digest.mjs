#!/usr/bin/env node
// =============================================================================
// Rule R6 — weekly digest for the partners (Monday morning run).
// Stalled permits (no county activity for N days, N per status), permits issued and not
// started, open failed inspections, idle jobs, open website leads and the week's numbers.
// Sent once per ISO week (dedupe); --force sends now whatever the day.
//   node rules/weekly_digest.mjs [--dry-run] [--force]
// =============================================================================
import { sql, q, DRY, brDate, street, orgId, seen, recordEvent, mail, contacts } from './lib.mjs';

const STALL = { in_review: 21, corrections: 7, fees_due: 7, requested: 30 };
const nyDay = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
if (nyDay !== 'Mon' && !process.argv.includes('--force')) { console.log('weekly digest: not Monday'); process.exit(0); }
const d = new Date(); const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
const week = `${d.getUTCFullYear()}-W${String(Math.ceil(((d - onejan) / 864e5 + onejan.getUTCDay() + 1) / 7)).padStart(2, '0')}`;
const key = `digest.weekly:${week}`;
if (await seen(key) && !process.argv.includes('--force')) { console.log(`weekly digest: already sent for ${week}`); process.exit(0); }
const org = q(await orgId());

const stalled = await sql(`select j.job_number, j.address, c.number, c.ops_status, c.ball_with,
    greatest(c.applied_at, (select max(e.occurred_at)::date from ops.events e where e.permit_case_id = c.id), (select max(r.completed_at) from ops.review_items r where r.permit_case_id = c.id)) last_move
  from ops.permit_cases c join ops.jobs j on j.id = c.job_id
  where j.org_id = ${org} and c.kind = 'building' and c.ops_status in ('in_review','corrections','fees_due','requested')
    and not exists (select 1 from ops.job_pauses p where p.job_id = j.id and p.ended_at is null)`);
const stalledRows = stalled.map((s) => ({ ...s, days: s.last_move ? Math.floor((Date.now() - new Date(s.last_move)) / 864e5) : null }))
  .filter((s) => s.days == null || s.days >= STALL[s.ops_status]).sort((a, b) => (b.days ?? 999) - (a.days ?? 999));
const notStarted = await sql(`select j.job_number, j.address, c.issued_at from ops.permit_cases c join ops.jobs j on j.id = c.job_id
  where j.org_id = ${org} and c.kind = 'building' and c.issued_at < now() - interval '14 days' and j.status in ('licensing','starting')
    and not exists (select 1 from ops.inspections i where i.permit_case_id = c.id and i.passed)
    and not exists (select 1 from ops.job_pauses p where p.job_id = j.id and p.ended_at is null) order by c.issued_at`);
const openFails = await sql(`select distinct on (j.job_number, i.type) j.job_number, j.address, i.type, coalesce(i.actual_at, i.scheduled_at) at
  from ops.inspections i join ops.permit_cases c on c.id = i.permit_case_id join ops.jobs j on j.id = c.job_id
  where j.org_id = ${org} and i.failed and coalesce(i.actual_at, i.scheduled_at) < now() - interval '5 days'
    and not exists (select 1 from ops.inspections k where k.permit_case_id = c.id and k.type = i.type and k.passed and coalesce(k.actual_at, k.scheduled_at) >= coalesce(i.actual_at, i.scheduled_at))
  order by j.job_number, i.type, at desc`);
const idle = await sql(`select distinct on (e.job_id) j.job_number, j.address, (e.payload->>'days')::int days from ops.events e join ops.jobs j on j.id = e.job_id
  where e.org_id = ${org} and e.kind = 'job.idle' and e.occurred_at > now() - interval '7 days' order by e.job_id, e.occurred_at desc`);
const leads = await sql(`select ref, client, model, received_at, followups from ops.leads where org_id = ${org} and status = 'open' order by received_at`);
const [wk] = await sql(`select
  (select count(*) from ops.events where org_id = ${org} and kind = 'permit.issued' and occurred_at > now() - interval '7 days' and not coalesce((payload->>'baseline')::boolean, false))::int issued,
  (select count(*) from ops.inspections i join ops.permit_cases c on c.id = i.permit_case_id join ops.jobs j on j.id = c.job_id where j.org_id = ${org} and i.passed and coalesce(i.actual_at, i.scheduled_at) > now() - interval '7 days')::int passed,
  (select count(*) from ops.inspections i join ops.permit_cases c on c.id = i.permit_case_id join ops.jobs j on j.id = c.job_id where j.org_id = ${org} and i.failed and coalesce(i.actual_at, i.scheduled_at) > now() - interval '7 days')::int failed,
  (select count(*) from ops.jobs where org_id = ${org} and signed_at > now() - interval '7 days')::int signed`);

// AI usage this month (field channel + Ask), at list prices per million tokens.
const PRICE = { 'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10] };
const usage = await sql(`select feature, model, count(*)::int calls, sum(input_tokens)::bigint i, sum(output_tokens)::bigint o, sum(cache_read)::bigint cr, sum(cache_write)::bigint cw
  from ops.ai_usage where org_id = ${org} and at >= date_trunc('month', now()) group by 1, 2`);
const cost = (r) => { const [pi, po] = PRICE[String(r.model).replace(/-\d{8}$/, '')] || [4, 20]; return (Number(r.i) * pi + Number(r.o) * po + Number(r.cr) * pi * 0.1 + Number(r.cw) * pi * 1.25) / 1e6; };
const aiLine = usage.length ? usage.reduce((m, r) => { m[r.feature] = (m[r.feature] || 0) + cost(r); m.calls[r.feature] = (m.calls[r.feature] || 0) + r.calls; return m; }, { calls: {} }) : null;

const STATUS = { in_review: 'em análise no condado', corrections: 'correções pedidas', fees_due: 'taxas a pagar', requested: 'pedido, sem protocolo' };
const sec = (title, rows, fmt) => `\n${title} (${rows.length})\n${rows.length ? rows.map(fmt).join('\n') : '  — nenhum'}`;
const text = `Resumo semanal do PKB Ops — semana ${week}

Na semana: ${wk.issued} permit(s) emitido(s) · ${wk.passed} inspeção(ões) aprovada(s) · ${wk.failed} reprovada(s) · ${wk.signed} contrato(s) assinado(s).
${sec('PERMITS PARADOS', stalledRows, (s) => `  ${s.job_number} · ${street(s.address)} — ${STATUS[s.ops_status]}${s.days != null ? ` há ${s.days} dias` : ''}${s.number ? ` (permit ${s.number})` : ''}`)}
${sec('PERMIT EMITIDO E OBRA SEM INÍCIO (14+ dias)', notStarted, (s) => `  ${s.job_number} · ${street(s.address)} — emitido em ${brDate(s.issued_at)}`)}
${sec('INSPEÇÕES REPROVADAS SEM REINSPEÇÃO (5+ dias)', openFails, (s) => `  ${s.job_number} · ${street(s.address)} — ${String(s.type).replace(/ - 1 ?& ?2.*$/, '')} em ${brDate(s.at)}`)}
${sec('OBRAS PARADAS (sem foto nem Daily Log)', idle, (s) => `  ${s.job_number} · ${street(s.address)}${s.days != null ? ` — ${s.days} dias` : ''}`)}
${sec('PEDIDOS DO SITE SEM RESPOSTA', leads, (l) => `  ${l.client || '—'} · ${l.model || ''} — desde ${brDate(l.received_at)} (${l.followups} cobrança(s))`)}
${aiLine ? `\nIA NO MÊS: campo US$ ${(aiLine.field || 0).toFixed(2)} (${aiLine.calls.field || 0} chamadas) · Ask US$ ${(aiLine.ask || 0).toFixed(2)} (${aiLine.calls.ask || 0} perguntas)\n` : ''}
— PKB Ops (resumo automático, toda segunda-feira)`;

const partners = (contacts.internal.partners || []).map((p) => p.email);
const ev = await recordEvent({ kind: 'digest.weekly', payload: { week, stalled: stalledRows.length }, key });
await mail({ rule: 'R6', eventId: ev, to: partners, subject: `PKB Ops — resumo semanal ${week}`, text });
console.log(`weekly digest ${week}: ${stalledRows.length} stalled · ${notStarted.length} not started · ${openFails.length} open failures${DRY ? ' · DRY RUN' : ''}`);
