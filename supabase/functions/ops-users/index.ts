// ops-users — admin only (Victor, 2026-11-06): send a portal user their access link.
//   POST { email }  → user with a login: password reset link; without one: first-access (invite) link.
// The link opens budget.pkbhomes.com/ops/password/ (token in the query, used only when the person taps
// Continue, so link previews cannot spend it), where the person chooses a password. It is e-mailed
// from the bot mailbox (BOT_EMAIL / BOT_EMAIL_PASSWORD secrets, Gmail SMTP) and also returned, so the
// admin can send it another way (WhatsApp) if the e-mail does not arrive. Only e-mails in ops.portal_users.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, BOT_EMAIL, BOT_EMAIL_PASSWORD
import { createClient } from 'jsr:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.14';
import { cors, json } from '../_shared/cors.ts';

const REDIRECT = 'https://budget.pkbhomes.com/ops/password/';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    // ops_users() refuses anyone but the admin, and gives the list the e-mail must be in.
    const { data: users, error } = await caller.rpc('ops_users');
    if (error) return json({ error: error.message }, error.code === '42501' ? 403 : 400);
    const { email } = await req.json().catch(() => ({}));
    const u = (users as Array<Record<string, unknown>>).find((x) => String(x.email).toLowerCase() === String(email || '').toLowerCase());
    if (!u) return json({ error: 'not a PKB Ops user' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const kind = u.has_login ? 'recovery' : 'invite';
    const { data: link, error: le } = await admin.auth.admin.generateLink({ type: kind, email: String(u.email), options: { redirectTo: REDIRECT } });
    if (le) return json({ error: le.message }, 400);
    // Not Supabase's one-use verify link: WhatsApp / e-mail previews open links in the background and that
    // spent it before the person tapped (11/09). Our page gets the token and uses it only on "Continue".
    const url = `${REDIRECT}?t=${encodeURIComponent(link.properties.hashed_token)}&k=${kind}&e=${encodeURIComponent(String(u.email))}`;

    const first = String(u.name || '').split(' ')[0] || '';
    const subject = kind === 'invite' ? 'PKB Ops — your first access' : 'PKB Ops — reset your password';
    const text = `${first ? first + ',' : 'Hi,'}\n\n${kind === 'invite'
      ? 'You have access to PKB Ops. Open the link below to choose your password (it works once and expires in 24 hours):'
      : 'Open the link below to choose a new password for PKB Ops (it works once and expires in 24 hours):'}\n\n${url}\n\nAfter that, sign in at ${u.role === 'field' ? 'https://budget.pkbhomes.com/ops/field/' : 'https://budget.pkbhomes.com/ops/'} with ${u.email}.\n\n— PKB Ops`;
    let sent = false, mailError = null;
    const from = Deno.env.get('BOT_EMAIL') || 'botpkbhomes@gmail.com', pass = Deno.env.get('BOT_EMAIL_PASSWORD');
    if (pass) {
      try {
        await nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: from, pass } })
          .sendMail({ from: `PKB Ops <${from}>`, to: String(u.email), subject, text });
        sent = true;
      } catch (e) { mailError = String((e as Error).message || e).slice(0, 300); }
    } else mailError = 'bot mailbox not configured in Supabase';
    return json({ kind, email: u.email, sent, mailError, link: url, subject, text });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
