// =============================================================================
// email.mjs — e-mail channel (SMTP) from the bot mailbox.
// Gmail: smtp.gmail.com:465 with BOT_EMAIL + BOT_EMAIL_PASSWORD (app password).
// OPS_ALWAYS_CC is added to every message (decision §9.4: Guilherme in Cc).
// OPS_SEND_ENABLED=false turns every send into a logged dry run.
// =============================================================================
import nodemailer from 'nodemailer';

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

export async function sendEmail({ to, cc = [], subject, text, html, attachments = [] }) {
  const always = (process.env.OPS_ALWAYS_CC || '').split(',').map(s => s.trim()).filter(Boolean);
  const ccAll = [...new Set([...cc, ...always])].filter(a => ![].concat(to).includes(a));
  const msg = { from: `PKB Ops <${process.env.BOT_EMAIL}>`, to, cc: ccAll, subject, text, html, attachments };
  if (process.env.OPS_SEND_ENABLED === 'false' || !process.env.BOT_EMAIL_PASSWORD) {
    console.log('[email dry-run]', JSON.stringify({ to, cc: ccAll, subject }));
    return { dryRun: true };
  }
  const info = await getTransport().sendMail(msg);
  return { id: info.messageId };
}
