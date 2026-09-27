#!/usr/bin/env node
// Send one short test e-mail through the same SMTP path the rules use (bot mailbox).
//   node notify/test_email.mjs someone@pkbhomes.com
import { sendEmail } from './email.mjs';

const to = process.argv[2];
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { console.error('usage: test_email.mjs <address>'); process.exit(1); }
if (!process.env.BOT_EMAIL_PASSWORD) { console.error('BOT_EMAIL_PASSWORD is not set — add the Gmail app password as a repository secret'); process.exit(1); }
const r = await sendEmail({
  to: [to], alwaysCc: false,
  subject: 'PKB Ops — teste de envio automático',
  text: `Este é um teste do envio automático do PKB Ops (GitHub Actions → Gmail do bot ${process.env.BOT_EMAIL}).\n\nSe você recebeu esta mensagem, os avisos de inspeção reprovada vão sair por este mesmo caminho.\n\n— PKB Ops`,
});
if (r.dryRun) { console.error('sent nothing: OPS_SEND_ENABLED is not "true"'); process.exit(1); }
console.log('sent', JSON.stringify(r));
