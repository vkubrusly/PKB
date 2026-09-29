#!/usr/bin/env node
// =============================================================================
// Rule R-BT-SESSION — the bot's Buildertrend session expired (or its cookies are
// missing), so the Buildertrend steps (jobs, fields, photos, Daily Logs) stop.
// E-mails the director once a day until the cookies are exported again
// (BT_COOKIES_JSON secret). Exit code 0 either way; prints "ok" or "expired".
//   node rules/bt_session.mjs
// =============================================================================
import { existsSync, readFileSync } from 'node:fs';
import { sql } from '../scripts/sb.mjs';
import { sendEmail } from '../notify/email.mjs';

const ORG = process.env.OPS_ORG_NAME || 'PKB Homes';
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const contacts = JSON.parse(readFileSync(new URL('../config/contacts.json', import.meta.url), 'utf8'));

let state = 'ok', detail = '';
if (!process.env.BT_COOKIES_FILE || !existsSync(process.env.BT_COOKIES_FILE)) { state = 'expired'; detail = 'O segredo BT_COOKIES_JSON está vazio.'; }
else {
  try {
    const { openBuildertrend } = await import('../collectors/buildertrend/session.mjs');
    const { browser, loggedIn } = await openBuildertrend();
    await browser.close();
    if (!loggedIn) { state = 'expired'; detail = 'O Buildertrend pediu login de novo: a sessão do bot expirou.'; }
  } catch (e) { state = 'expired'; detail = `Não foi possível abrir o Buildertrend com os cookies salvos (${e.message}).`; }
}
console.log(state);
if (state === 'ok') process.exit(0);

const orgId = (await sql(`select id from public.orgs where name = ${q(ORG)} limit 1`))[0]?.id;
const key = `bt.session.expired:${new Date().toISOString().slice(0, 10)}`;
const ev = await sql(`insert into ops.events (org_id, kind, source, occurred_at, payload, dedupe_key, processed_at)
  values (${q(orgId)}, 'bt.session.expired', 'rule', now(), ${q(JSON.stringify({ detail }))}::jsonb, ${q(key)}, now())
  on conflict (org_id, dedupe_key) do nothing returning id`);
if (!ev.length) process.exit(0); // already announced today
const to = contacts.internal.director.email;
const repo = process.env.GITHUB_REPOSITORY || 'vkubrusly/PKB';
const text = `${detail}

Enquanto isso, o PKB Ops não atualiza obras, campos, fotos nem Daily Logs do Buildertrend.
Os portais dos condados e os e-mails continuam funcionando.

Como renovar (2 minutos):
1. No Chrome, entre no Buildertrend com o usuário do bot (Bot PKB).
2. Extensão Cookie-Editor → Export → JSON (copia para a área de transferência).
3. Cole em: https://github.com/${repo}/settings/secrets/actions/BT_COOKIES_JSON → Update secret.

— PKB Ops (aviso automático, no máximo 1 por dia)`;
try { const r = await sendEmail({ to, subject: "Buildertrend: sessão do bot expirou — renovar cookies", text, alwaysCc: false }); console.log(r.dryRun ? `alert (dry run) for ${to}` : `alert sent to ${to}`); }
catch (e) { console.error(`alert failed: ${e.message}`); }
