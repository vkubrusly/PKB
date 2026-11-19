// =============================================================================
// email.mjs — e-mail channel (SMTP) from the bot mailbox.
// Gmail: smtp.gmail.com:465 with BOT_EMAIL + BOT_EMAIL_PASSWORD (app password).
// OPS_ALWAYS_CC is added to every message (decision §9.4: Guilherme in Cc).
// COPY_WITH: whenever an address is on a message, its companions are copied too (Victor, 2026-10-27:
// every e-mail that copies Guilherme also copies Stefano).
// OPS_SEND_ENABLED=false turns every send into a logged dry run.
// =============================================================================
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'node:url';

// Every e-mail carries the PKB Homes logo (Victor, 11/19/26): an HTML version of the text with the logo at the end (signature),
// embedded inline (cid) so it shows without loading remote images. The plain text stays as the fallback.
const LOGO = fileURLToPath(new URL('./logo-email.png', import.meta.url));
const LOGO_CID = 'pkb-logo@pkbhomes.com';
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const linkify = (t) => t.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
// Paragraphs (blank line) → <p>, line breaks → <br> (Outlook ignores white-space:pre-wrap); logo at the end,
// as a signature (Victor, 11/19/26).
export const textToHtml = (text) => String(text || '').replace(/\r/g, '').split(/\n{2,}/)
  .map((p) => `<p style="margin:0 0 12px">${linkify(esc(p)).replace(/\n/g, '<br>')}</p>`).join('');
export function brandHtml(text, html) {
  const body = html || textToHtml(text);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#2e2e30;max-width:640px">`
    + body
    + `<p style="margin:18px 0 0"><img src="cid:${LOGO_CID}" alt="PKB Homes" width="70" style="display:block;width:70px;height:auto;border:0"></p></div>`;
}

export const COPY_WITH = { 'guilherme@pkbhomes.com': ['stefano@pkbhomes.com'] };
// The Cc list with the companions of every address on the message (to or cc) added.
export function withCompanions(to, cc) {
  const all = [...[].concat(to), ...cc].map((a) => String(a).trim().toLowerCase());
  const extra = all.flatMap((a) => COPY_WITH[a] || []);
  return [...new Set([...cc, ...extra])].filter((a) => !all.includes(a) || cc.includes(a));
}

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: true,
      auth: { user: process.env.BOT_EMAIL, pass: process.env.BOT_EMAIL_PASSWORD },
    });
  }
  return transport;
}

// alwaysCc=false for internal alerts (the Guilherme Cc rule applies to e-mails that leave PKB).
// force=true: a partner approved this message in the portal — send even when OPS_SEND_ENABLED=false.
export async function sendEmail({ to, cc = [], subject, text, html, attachments = [], alwaysCc = true, force = false }) {
  const always = alwaysCc ? (process.env.OPS_ALWAYS_CC || '').split(',').map(s => s.trim()).filter(Boolean) : [];
  const ccAll = withCompanions(to, [...new Set([...cc, ...always])].filter(a => ![].concat(to).includes(a)));
  const msg = { from: `PKB Ops <${process.env.BOT_EMAIL}>`, to, cc: ccAll, subject, text, html: brandHtml(text, html),
    attachments: [...attachments, { filename: 'pkb-homes.png', path: LOGO, cid: LOGO_CID }] };
  if ((process.env.OPS_SEND_ENABLED === 'false' && !force) || !process.env.BOT_EMAIL_PASSWORD) {
    console.log('[email dry-run]', JSON.stringify({ to, cc: ccAll, subject }));
    return { dryRun: true, cc: ccAll };
  }
  const info = await getTransport().sendMail(msg);
  return { id: info.messageId, cc: ccAll };
}
