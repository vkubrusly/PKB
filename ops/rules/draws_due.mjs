#!/usr/bin/env node
// =============================================================================
// draws_due.mjs — draws that reached their trigger but have no invoice in QuickBooks (Victor, 11/19/26).
// Triggers (ops.qbo_draws_core, migration 0053): 2nd building permit issued · 3rd Roof Assembly · 4th Framing ·
// 5th Power Release · 6th Final Structural (before the CO). One e-mail to Daniela ONLY (finance) when a
// house/stage becomes due for the first time; it lists every draw still pending, the new ones marked NEW.
// Dedupe per house + stage (ops.events 'draw.due:<job>:<stage>'); nothing is sent when nothing is new.
//   node rules/draws_due.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, usDate, street, seenPrefix, seen, recordEvent, mail } from './lib.mjs';

const TO = 'daniela@pkbhomes.com';
const usd = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
const ord = (n) => `${n}ª`;

const conn = (await sql(`select disconnected_at is null and not needs_reconnect as ok, last_sync_at from ops.qbo_connection where id = 1`))[0];
if (!conn?.ok) { console.log('draws_due: QuickBooks not connected — nothing checked'); process.exit(0); }
const data = (await sql(`select ops.qbo_draws_core() j`))[0].j;
const due = [];
for (const h of data.houses || []) for (const d of h.due_not_invoiced || []) due.push({ h, d, key: `draw.due:${h.job}:${d.stage}` });
await seenPrefix('draw.due:');
const fresh = [];
for (const x of due) if (!(await seen(x.key))) fresh.push(x);
console.log(`draws_due: ${due.length} pending · ${fresh.length} new`);
if (!fresh.length) process.exit(0);

const jobs = Object.fromEntries((await sql(`select job_number, id from ops.jobs where job_number in (${[...new Set(due.map((x) => x.h.job))].map(q).join(',')})`)).map((r) => [r.job_number, r.id]));
due.sort((a, b) => b.d.days_since_trigger - a.d.days_since_trigger);
const line = ({ h, d, key }) => `${fresh.some((f) => f.key === key) ? '🆕 ' : ''}${h.job} · ${street(h.address)} — ${ord(d.stage)} parcela (${d.standard_pct}%${d.expected_amount ? ` ≈ ${usd(d.expected_amount)}` : ''})
   ${d.trigger.replace('building permit issued', 'permit emitido').replace(' passed', ' aprovada')} em ${usDate(d.trigger_on)} · há ${d.days_since_trigger} dia(s) · cobradas até agora: ${(h.billed_stages || []).map(ord).join(', ') || 'nenhuma'}`;
const text = `Daniela,

${fresh.length === 1 ? 'Uma casa chegou' : `${fresh.length} parcelas chegaram`} ao ponto de cobrança e não há fatura no QuickBooks:

${due.map(line).join('\n\n')}

Gatilhos (PKB): 2ª permit emitido · 3ª Roof Assembly · 4ª Framing · 5ª Power Release · 6ª Final Structural (antes do CO). Valor esperado = contrato × % padrão (10/32/17/18/20/3); contratos com outra divisão podem ter valor diferente.
QuickBooks sincronizado em ${usDate(conn.last_sync_at)}. Detalhes por casa: aba Finance ou o Ask ("draws da casa 0020").

— PKB Ops`;
const st = await mail({ rule: 'draws_due', to: [TO], subject: `Draws a cobrar: ${fresh.map((x) => `${x.h.job} ${ord(x.d.stage)}`).join(', ')}`, text });
if (st !== 'sent') process.exit(0);   // a draft (sending off) or a failure is retried on the next run
for (const { h, d, key } of fresh) await recordEvent({ jobId: jobs[h.job] || null, kind: 'draw.due', payload: { stage: d.stage, trigger: d.trigger, trigger_on: d.trigger_on, expected: d.expected_amount }, key });
