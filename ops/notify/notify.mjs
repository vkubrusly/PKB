// =============================================================================
// notify.mjs — one entry point for team alerts, fanned out to the channels each
// person has enabled in config/team.json (email and/or whatsapp).
//
//   import { notify } from './notify/notify.mjs';
//   await notify('inspection_failed', { job: '0034 - 4730 SW 142nd Pl Rd',
//     inspection: 'Framing', inspector: 'Feria Miguel', comment: '...' },
//     { recipients: ['carlos@pkbhomes.com', 'job_supervisors'], jobSupervisors: [...] });
//
// Every alert type has an e-mail rendering (below) and a WhatsApp template
// (notify/whatsapp.mjs TEMPLATES) with the same parameters.
// =============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendEmail } from './email.mjs';
import { sendTemplate, TEMPLATES } from './whatsapp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEAM_FILE = join(HERE, '..', 'config', 'team.json');

function loadTeam() {
  if (!existsSync(TEAM_FILE)) return {};
  const t = JSON.parse(readFileSync(TEAM_FILE, 'utf8'));
  return Object.fromEntries((t.people || []).map(p => [p.email.toLowerCase(), p]));
}

const EMAIL = {
  inspection_failed: p => [`Inspection FAILED — ${p.inspection} — ${p.job}`, `${p.inspection} failed at ${p.job}.\nInspector: ${p.inspector}\nComment: ${p.comment}`],
  inspection_passed: p => [`Inspection passed — ${p.inspection} — ${p.job}`, `${p.inspection} passed at ${p.job}.\nNext step: ${p.next_step}`],
  permit_corrections: p => [`Permit corrections — ${p.permit} — ${p.job}`, `The county requested corrections on ${p.permit} (${p.job}) in: ${p.departments}.\nThe corrections e-mail was sent to the designer.`],
  permit_issued: p => [`Permit ISSUED — ${p.permit} — ${p.job}`, `${p.permit} (${p.job}) was issued.`],
  permit_hold: p => [`HOLD on permit ${p.permit} — ${p.job}`, `A blocking hold was placed on ${p.permit} (${p.job}): ${p.reason}`],
  daily_digest: p => [`PKB Ops — ${p.count} item(s) need action`, p.summary],
};

export async function notify(type, params, { recipients = [], jobSupervisors = [] } = {}) {
  if (!TEMPLATES[type] || !EMAIL[type]) throw new Error(`unknown alert type "${type}"`);
  const team = loadTeam();
  const emails = [...new Set(recipients.flatMap(r => r === 'job_supervisors' ? jobSupervisors : [r]).map(e => e.toLowerCase()))];
  const [subject, text] = EMAIL[type](params);
  const results = [];
  for (const email of emails) {
    const person = team[email] || { email, channels: ['email'] };
    const channels = person.channels || ['email'];
    if (channels.includes('email')) {
      results.push({ email, channel: 'email', ...(await sendEmail({ to: email, subject, text }).catch(e => ({ error: e.message }))) });
    }
    if (channels.includes('whatsapp') && person.whatsapp) {
      results.push({ email, channel: 'whatsapp', ...(await sendTemplate(person.whatsapp, type, params).catch(e => ({ error: e.message }))) });
    }
  }
  return results;
}
