// ops-mail-watch — every 5 minutes (pg_cron, migration 0060): is there an unread vendor invoice (from invoice@) or
// an unread answer to "Invoice para revisar" in the bot mailbox? If so, start ops-mail now instead of waiting for
// the hourly round (Victor, 11/20/26: "entrou e-mail você processa"). Only LOOKS at the mailbox (EXAMINE =
// read-only: nothing is marked read); ops-mail does the reading. Called by pg_cron with the shared secret.
//   POST (header x-watch-secret) → { invoices, answers, dispatched }
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors, json } from '../_shared/cors.ts';

const enc = new TextEncoder(), dec = new TextDecoder();

async function imapCounts(user: string, pass: string) {
  const conn = await Deno.connectTls({ hostname: 'imap.gmail.com', port: 993 });
  let buf = '';
  const readUntil = async (tag: string) => {
    const chunk = new Uint8Array(16384);
    const t0 = Date.now();
    while (!new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`).test(buf)) {
      if (Date.now() - t0 > 20000) throw new Error(`IMAP timeout waiting for ${tag}`);
      const n = await conn.read(chunk);
      if (n === null) throw new Error('IMAP connection closed');
      buf += dec.decode(chunk.subarray(0, n));
    }
    const out = buf; buf = '';
    if (new RegExp(`${tag} (NO|BAD)`).test(out)) throw new Error(`IMAP ${tag} failed`);
    return out;
  };
  const cmd = async (tag: string, line: string) => { await conn.write(enc.encode(`${tag} ${line}\r\n`)); return await readUntil(tag); };
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const count = (r: string) => ((/\* SEARCH([^\r\n]*)/.exec(r) || [])[1] || '').trim().split(/\s+/).filter(Boolean).length;
  try {
    // greeting
    const chunk = new Uint8Array(4096); const n = await conn.read(chunk); if (n === null) throw new Error('no IMAP greeting');
    await cmd('a1', `LOGIN ${q(user)} ${q(pass)}`);
    await cmd('a2', 'EXAMINE INBOX');   // read-only
    const since = new Date(Date.now() - 3 * 864e5).toUTCString().slice(5, 16).replace(/ /g, '-');   // DD-Mon-YYYY
    const invoices = count(await cmd('a3', `SEARCH UNSEEN SINCE ${since} OR FROM "invoice@pkbhomes.com" OR TO "invoice@pkbhomes.com" CC "invoice@pkbhomes.com"`));
    const answers = count(await cmd('a4', `SEARCH UNSEEN SINCE ${since} SUBJECT "Invoice para revisar"`));
    await conn.write(enc.encode('a5 LOGOUT\r\n')).catch(() => 0);
    return { invoices, answers };
  } finally { try { conn.close(); } catch { /* closed */ } }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const secret = Deno.env.get('OPS_WATCH_SECRET');
    if (!secret || req.headers.get('x-watch-secret') !== secret) return json({ error: 'not allowed' }, 403);
    const user = Deno.env.get('BOT_EMAIL'), pass = Deno.env.get('BOT_EMAIL_PASSWORD');
    if (!user || !pass) return json({ error: 'BOT_EMAIL / BOT_EMAIL_PASSWORD not set' }, 500);
    const c = await imapCounts(user, pass);
    let dispatched = false;
    if (c.invoices + c.answers > 0) {
      const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data, error } = await sb.rpc('ops_dispatch_mail_now');
      if (error) return json({ ...c, error: error.message }, 500);
      dispatched = !!data;
    }
    return json({ ...c, dispatched });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
