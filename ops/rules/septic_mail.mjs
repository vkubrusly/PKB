#!/usr/bin/env node
// =============================================================================
// Septic tracking from the bot mailbox (the health department portal has no public API).
// Sources:
//   - Buildertrend Daily Log e-mails: "Septic Approved", "Septic application submitted",
//     "Inspeção de Final Septic … dia 9/29", "Final septic passed / failed" (en + pt);
//   - Buildertrend bill e-mails: "… Septic Tank …" / "Septic System" paid → tank paid.
// Effects: an event per stage on the job's septic permit case (created when missing),
// the case status/dates updated (applied → requested, approved → issued, final passed →
// finaled). A failed final septic inspection e-mails the supervisor(s)/PM(s) + Guilherme.
//   node rules/septic_mail.mjs [--dry-run]
// =============================================================================
import { sql, q, DRY, EMAIL, RECENT_DAYS, brDate, street, daysAgo, orgId, team, seen, recordEvent, mail } from './lib.mjs';

const FINAL = String.raw`(?:final\s+septic|septic\s+final|inspe\S*\s+(?:de\s+)?(?:final\s+)?septic|septic\s+inspection)`;
const STAGES = [
  { stage: 'final_failed', rx: new RegExp(`${FINAL}[^\\n.]{0,60}(?:fail|reprovad|rejected|not approved)`, 'i') },
  { stage: 'final_passed', rx: new RegExp(`${FINAL}[^\\n.]{0,60}(?:approved|passed|aprovad)`, 'i') },
  { stage: 'final_scheduled', rx: new RegExp(FINAL, 'i') },
  { stage: 'approved', rx: /septic\s+(?:permit\s+)?(?:approved|aprovad|issued|emitid)|permit\s+(?:de\s+)?septic\s+(?:approved|aprovad|emitid)/i },
  { stage: 'applied', rx: /septic\s+(?:application|applied|aplicad|submitted|protocolad)|(?:aplica\S*|pedido|application)\s+(?:do\s+|de\s+|for\s+)?septic/i },
];
const TANK = /septic\s+(?:tank|system)/i;

// The Daily Log text between the header ("Date: m-d-yyyy") and the weather footer.
function logText(body) {
  const b = String(body || '').replace(/\r/g, '');
  const m = b.match(/Date:\s*(\d{1,2})-(\d{1,2})-(\d{4})\s*\n([\s\S]*?)(?:\n\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*\n|View Details|$)/);
  if (!m) return { date: null, text: b };
  return { date: `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, text: m[4].trim() };
}
// "dia 9/29", "on 10/02" → ISO date in the log's year.
function mentionedDate(text, logDate) {
  const m = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (!m || !logDate) return null;
  return `${logDate.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

const org = await orgId();
const mails = await sql(`select e.id, e.category, e.received_at, e.subject, e.body_text, e.parsed, coalesce(e.job_id, j.id) job_id, coalesce(e.job_number, j.job_number) job_number, j.address
  from ops.inbound_emails e left join ops.jobs j on j.id = e.job_id or (e.job_id is null and j.job_number = e.job_number and j.org_id = e.org_id)
  where e.org_id = ${q(org)} and e.category in ('bt_daily_log', 'bt_bill') and (e.subject ~* 'septic' or e.body_text ~* 'septic')
  order by e.received_at`);

const found = [];
for (const m of mails) {
  if (!m.job_id) continue;
  if (m.category === 'bt_bill') {
    const title = (String(m.body_text).match(/Title:\s*([^\n]+)/) || [])[1] || m.subject;
    if (TANK.test(title) && /payment made|paid/i.test(`${m.subject} ${m.body_text} ${m.parsed?.action || ''}`))
      found.push({ m, stage: 'tank_paid', at: m.received_at, detail: title.trim(), key: `septic.tank_paid:${m.job_id}` });
    continue;
  }
  const { date, text } = logText(m.body_text);
  const hit = STAGES.find((s) => s.rx.test(text));
  if (!hit) continue;
  const at = date || m.received_at;
  const key = ['final_scheduled', 'final_failed'].includes(hit.stage) ? `septic.${hit.stage}:${m.job_id}:${m.id}` : `septic.${hit.stage}:${m.job_id}`;
  found.push({ m, stage: hit.stage, at, detail: text.split('\n')[0].slice(0, 200), when: hit.stage === 'final_scheduled' ? mentionedDate(text, date) : null, key });
}

let n = 0;
for (const f of found) {
  if (await seen(f.key)) continue;
  n++;
  let [c] = await sql(`select id, ops_status, applied_at, issued_at, finaled_at from ops.permit_cases where job_id = ${q(f.m.job_id)} and kind = 'septic' order by created_at limit 1`);
  if (!c && !DRY) {
    [c] = await sql(`insert into ops.permit_cases (org_id, job_id, kind, portal, number, ops_status, ball_with, tracked_by)
      values (${q(org)}, ${q(f.m.job_id)}, 'septic', 'fdep', ${q(`SEPTIC-${f.m.job_number}`)}, 'requested', 'fdep', 'pkb') returning id, ops_status, applied_at, issued_at, finaled_at`);
  }
  const day = String(f.at).slice(0, 10);
  const set = [];
  if (f.stage === 'applied') { if (!c?.applied_at) set.push(`applied_at = ${q(day)}`); if (c?.ops_status === 'not_started') set.push(`ops_status = 'requested'`); }
  if (f.stage === 'approved') { if (!c?.issued_at) set.push(`issued_at = ${q(day)}`); if (!['issued', 'finaled'].includes(c?.ops_status)) set.push(`ops_status = 'issued'`); }
  if (f.stage === 'final_passed') set.push(`ops_status = 'finaled'`, `finaled_at = coalesce(finaled_at, ${q(day)})`, `ball_with = 'pkb'`);
  if (set.length && c && !DRY) await sql(`update ops.permit_cases set ${set.join(', ')}, updated_at = now() where id = ${q(c.id)}`);
  const ev = await recordEvent({ jobId: f.m.job_id, caseId: c?.id, kind: `septic.${f.stage}`, source: 'email', at: f.at, payload: { detail: f.detail, scheduled_for: f.when || undefined, email_id: f.m.id }, key: f.key });
  console.log(`${f.m.job_number} septic ${f.stage} ${day}${f.when ? ` (for ${f.when})` : ''} — ${f.detail}${set.length ? ` → ${set.join(', ')}` : ''}`);

  if (f.stage === 'final_failed' && daysAgo(f.at) <= RECENT_DAYS) {
    const t = await team(f.m.job_id);
    await mail({
      rule: 'SEPTIC', jobId: f.m.job_id, eventId: ev, to: t.emails.length ? t.emails : [EMAIL.guilherme], cc: [EMAIL.guilherme],
      subject: `Inspeção final do septic REPROVADA — ${f.m.job_number} · ${street(f.m.address)}`,
      text: `Obra ${f.m.job_number} — ${f.m.address}\n\nDaily Log de ${brDate(f.at)}:\n${f.detail}\n\nCorrigir e remarcar a inspeção final do septic com o Departamento de Saúde.\n\n— PKB Ops (aviso automático)`,
    });
  }
}
console.log(`septic from e-mail: ${n} new stage(s) of ${found.length} found${DRY ? ' · DRY RUN' : ''}`);
