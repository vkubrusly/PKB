// SMTP sender. The system writes FROM one of the listing mailboxes (so agents' replies land in a
// mailbox the collector reads), configured by KB_SMTP_USER / KB_SMTP_PASS (default: mailbox 1).
//   KB_SMTP_HOST (smtp.gmail.com) · KB_SMTP_PORT (465) · KB_FROM_NAME ("Kubrusly Basso Team")
//   KB_ALWAYS_BCC — copy of every outgoing e-mail (e.g. the listing agent's own inbox)
// KB_SEND_ENABLED must be 'true' to really send; anything else is a logged dry run (draft).
import nodemailer from 'nodemailer';

let transport = null;
const account = () => ({
  user: process.env.KB_SMTP_USER || process.env.LISTING_MAIL1_USER,
  pass: process.env.KB_SMTP_PASS || process.env.LISTING_MAIL1_PASS,
});
export const sendingEnabled = () => process.env.KB_SEND_ENABLED === 'true' && !!account().pass;
export const fromAddress = () => account().user;

export async function sendEmail({ to, subject, text, html, replyTo, bcc = [] }) {
  const { user, pass } = account();
  const always = (process.env.KB_ALWAYS_BCC || '').split(',').map((s) => s.trim()).filter(Boolean);
  const msg = { from: `${process.env.KB_FROM_NAME || 'Kubrusly Basso Team'} <${user}>`, to, bcc: [...new Set([...bcc, ...always])], subject, text, html, replyTo };
  if (!sendingEnabled()) {
    console.log('[email dry-run]', JSON.stringify({ to, subject }));
    return { dryRun: true };
  }
  transport ||= nodemailer.createTransport({
    host: process.env.KB_SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.KB_SMTP_PORT || 465),
    secure: Number(process.env.KB_SMTP_PORT || 465) === 465,
    auth: { user, pass },
  });
  const info = await transport.sendMail(msg);
  return { id: info.messageId };
}
