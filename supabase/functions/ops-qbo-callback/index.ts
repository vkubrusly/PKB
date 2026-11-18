// =============================================================================
// ops-qbo-callback — Intuit sends the owner back here after "Connect QuickBooks" (Redirect URI in the
// Intuit app). Public (no Supabase login: Intuit calls it); the one-time state ties it to the owner who
// started it. Exchanges the code for tokens (Vault), reads the company name, starts the first sync
// (backfill) and sends the owner back to the Finance tab.
// Every failure is written to ops.qbo_errors (endpoint 'callback', with Intuit's intuit_tid when the
// failure came from Intuit) before the owner is sent back with ?qbo=<reason>.
// =============================================================================
import { PORTAL, REDIRECT, later, rpc, secret, store, svc } from '../_shared/qbo_store.ts';
import { companyName, errorRow, exchangeCode, sync } from '../_shared/qbo.mjs';

const back = (result: string) => new Response(null, { status: 302, headers: { Location: `${PORTAL}?qbo=${result}#finance` } });

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const sb = svc();
  // deno-lint-ignore no-explicit-any
  const fail = async (result: string, e: any) => {
    const row = { ...errorRow(e), endpoint: e?.endpoint ? `callback ${e.endpoint}` : 'callback' };
    console.error('qbo callback:', row.kind, row.code || '', row.message, row.intuit_tid ? `intuit_tid ${row.intuit_tid}` : '');
    await store(sb).error(row).catch((x) => console.error('qbo callback: could not log the error:', x.message));
    return back(result);
  };
  const err = u.searchParams.get('error');
  if (err) return fail('denied', { kind: 'auth', code: err, message: `Intuit returned error=${err}${u.searchParams.get('error_description') ? ': ' + u.searchParams.get('error_description') : ''}` });
  const code = u.searchParams.get('code'), state = u.searchParams.get('state'), realm = u.searchParams.get('realmId');
  if (!code || !state || !realm) return fail('invalid', { kind: 'other', code: 'missing_params', message: `callback without ${[!code && 'code', !state && 'state', !realm && 'realmId'].filter(Boolean).join(', ')}` });
  let step = 'state';
  try {
    const st = await rpc(sb, 'ops_qbo_state_take_svc', { p_state: state });
    if (!st) return fail('expired', { kind: 'auth', code: 'state_invalid', message: 'OAuth state unknown, already used or older than 15 minutes (start again at /ops/quickbooks)' });
    step = 'credentials';
    const id = await secret(sb, 'qbo_client_id'), sec = await secret(sb, 'qbo_client_secret');
    if (!id || !sec) return fail('error', { kind: 'auth_config', code: 'no_credentials', message: 'QuickBooks Client ID / Secret not set (Users → Integrations)' });
    step = 'token exchange';
    const t = await exchangeCode(st.environment, id, sec, code, REDIRECT);
    step = 'company info';
    const company = await companyName({ env: st.environment, realm, token: t.access }).catch(() => null);
    step = 'save connection';
    await rpc(sb, 'ops_qbo_save_tokens_svc', { p_access: t.access, p_refresh: t.refresh, p_access_exp: t.accessExp, p_refresh_exp: t.refreshExp,
      p_realm: realm, p_env: st.environment, p_company: company, p_email: st.email });
    await later(sync(store(sb)).catch((e) => store(sb).error(errorRow(e)).catch(() => {})));
    return back('connected');
  } catch (e) {
    // deno-lint-ignore no-explicit-any
    const x = e as any;
    return fail('error', { ...x, kind: x.kind || 'other', message: `${step}: ${x.message || x}`, endpoint: x.endpoint || step, intuit_tid: x.intuit_tid || null, status: x.status ?? null, code: x.code || null });
  }
});
