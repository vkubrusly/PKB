#!/usr/bin/env node
// =============================================================================
// Rule R8 — an inspection passed on the county portal.
// E-mail to the job's supervisor(s) and PM(s): which inspection passed, which one is
// next on this permit's own list, and the construction work that comes before it
// (from config/field_manual.json, the PKB field manual, else config/construction_sequence.json).
// Also queues a Buildertrend Daily Log (inspection events → supervisors, PMs, Cristiano).
// One message per job per run; only inspections from the last RECENT_DAYS days are
// announced, older ones are a silent baseline.
//   node rules/inspection_passed.mjs [--dry-run]
// =============================================================================
import { readFileSync } from 'node:fs';
import { sql, q, DRY, EMAIL, RECENT_DAYS, brDate, street, daysAgo, orgId, team, seen, recordEvent, mail, queueDailyLog, contacts } from './lib.mjs';
import { progressAll } from '../analysis/inspection_progress.mjs';

const seq = JSON.parse(readFileSync(new URL('../config/construction_sequence.json', import.meta.url), 'utf8'));
const items = seq.phases.flatMap((ph) => ph.items.map((it) => ({ ...it, phase: ph.name })));
const shortType = (t) => String(t || '').replace(/ - 1 ?& ?2 Res(idential)?( Fam(ily)?)?$/i, '').trim();

const manual = JSON.parse(readFileSync(new URL('../config/field_manual.json', import.meta.url), 'utf8'));
const steps = manual.phases.flatMap((ph) => ph.steps.map((st) => ({ ...st, phase: `Fase ${ph.n} — ${ph.name}` })));

// The construction work between the previous inspection and `name`: first from the PKB field
// manual (39 steps · 8 phases), else from config/construction_sequence.json.
function workBefore(name) {
  const m = steps.findIndex((st) => st.type === 'inspection' && new RegExp(st.portal, 'i').test(name));
  if (m >= 0) {
    let i = m - 1; const tasks = [];
    while (i >= 0 && steps[i].type !== 'inspection') { tasks.unshift(`${steps[i].n}. ${steps[i].name} (${steps[i].en})`); i--; }
    return { phase: steps[m].phase, step: `etapa ${steps[m].n}/39 do Manual de Obra`, tasks };
  }
  const idx = items.findIndex((it) => it.type === 'inspection' && it.portal && new RegExp(it.portal, 'i').test(name));
  if (idx < 0) return { phase: null, tasks: [] };
  let i = idx - 1; const tasks = [];
  while (i >= 0 && items[i].type !== 'inspection') { if (items[i].type === 'task') tasks.unshift(items[i].name); i--; }
  return { phase: items[idx].phase, tasks };
}

const passed = await sql(`select i.number, i.type, coalesce(i.actual_at, i.scheduled_at) at, i.inspector, c.id case_id, c.number permit, j.id job_id, j.job_number, j.address
  from ops.inspections i join ops.permit_cases c on c.id = i.permit_case_id join ops.jobs j on j.id = c.job_id
  where j.org_id = ${q(await orgId())} and c.kind = 'building' and i.passed
    and not exists (select 1 from ops.events e where e.org_id = j.org_id and e.dedupe_key = 'inspection.passed:' || c.id || ':' || i.number)
  order by 3`);
if (!passed.length) { console.log('inspection passed: nothing new'); process.exit(0); }

const prog = await progressAll();
const byJob = {};
for (const p of passed) (byJob[p.job_number] ||= []).push(p);
let sent = 0, baseline = 0;
for (const [jobNumber, list] of Object.entries(byJob)) {
  const recent = list.filter((p) => daysAgo(p.at) <= RECENT_DAYS);
  for (const p of list.filter((x) => !recent.includes(x))) { baseline++; await recordEvent({ jobId: p.job_id, caseId: p.case_id, kind: 'inspection.passed', at: p.at, payload: { type: p.type, baseline: true }, key: `inspection.passed:${p.case_id}:${p.number}` }); }
  if (!recent.length) continue;
  const j = recent[0];
  let evId = null;
  for (const p of recent) evId = evId ?? await recordEvent({ jobId: p.job_id, caseId: p.case_id, kind: 'inspection.passed', at: p.at, payload: { type: p.type, inspector: p.inspector }, key: `inspection.passed:${p.case_id}:${p.number}` });

  const pr = prog.jobs[jobNumber];
  const next = pr?.supported ? pr.next : null;
  const nextStep = pr?.steps?.find((s) => s.name === next);
  const w = next && nextStep?.state !== 'failed_open' ? workBefore(next) : { tasks: [] };
  const done = recent.map((p) => `✔ ${shortType(p.type)} — aprovada em ${brDate(p.at)}${p.inspector ? ` (${p.inspector})` : ''}`).join('\n');
  const nextText = next
    ? `Próxima inspeção do permit: ${next}${nextStep?.state === 'failed_open' ? ' (REPROVADA, falta a reinspeção)' : ''}${w.phase ? `\n${w.phase}${w.step ? ` (${w.step})` : ''}` : ''}${w.tasks.length ? `\n\nAntes de pedir essa inspeção, concluir:\n${w.tasks.map((t) => `- ${t}`).join('\n')}` : ''}`
    : 'Não há próxima inspeção pendente neste permit.';
  const progress = pr?.supported ? `\nProgresso: ${pr.passed}/${pr.required} inspeções aprovadas.` : '';
  const t = await team(j.job_id);
  await mail({
    rule: 'R8', jobId: j.job_id, eventId: evId, to: t.emails.length ? t.emails : [EMAIL.cristiano],
    subject: `Inspeção aprovada — ${recent.map((p) => shortType(p.type)).join(', ')} — ${jobNumber} · ${street(j.address)}`,
    text: `Obra ${jobNumber} — ${j.address}
Permit: ${j.permit}

${done}
${progress}

${nextText}
${t.missing.length ? `\n(Sem e-mail cadastrado para: ${t.missing.join(', ')}.)\n` : ''}
— PKB Ops (aviso automático)`,
  });
  await queueDailyLog({
    rule: 'R8', jobId: j.job_id, eventId: evId, title: `Inspection passed — ${recent.map((p) => shortType(p.type)).join(', ')}`,
    notes: `${recent.map((p) => `${shortType(p.type)} passed on ${brDate(p.at)}${p.inspector ? ` (inspector ${p.inspector})` : ''}.`).join('\n')}${next ? `\nNext inspection: ${next}.${w.tasks.length ? ` Work before it: ${w.tasks.join(', ')}.` : ''}` : ''}`,
    notify: [...t.btNames, contacts.internal.contractor_of_record?.bt_name].filter(Boolean),
  });
  sent++;
}
console.log(`inspection passed: ${sent} job(s) announced · ${baseline} baseline${DRY ? ' · DRY RUN' : ''}`);
