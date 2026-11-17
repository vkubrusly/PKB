// =============================================================================
// ops-qbo-callback — Intuit sends the owner back here after "Connect QuickBooks" (Redirect URI in the
// Intuit app). Public (no Supabase login: Intuit calls it); the one-time state ties it to the owner who
// started it. Exchanges the code for tokens (Vault), reads the company name, starts the first sync
// (backfill) and sends the owner back to the Finance tab.
// =============================================================================
import { PORTAL, REDIRECT, later, rpc, secret, store, svc } from '../_shared/qbo_store.ts';
import { companyName, exchangeCode, sync } from '../_shared/qbo.mjs';

const back = (result: string) => new Response(null, { status: 302, headers: { Location: `${PORTAL}?qbo=${result}#finance` } });

Deno.serve(async (req) => {
  const u = new URL(req.url);
  if (u.searchParams.get('error')) return back('denied');
  const code = u.searchParams.get('code'), state = u.searchParams.get('state'), realm = u.searchParams.get('realmId');
  if (!code || !state || !realm) return back('invalid');
  try {
    const sb = svc();
    const st = await rpc(sb, 'ops_qbo_state_take_svc', { p_state: state });
    if (!st) return back('expired');
    const id = await secret(sb, 'qbo_client_id'), sec = await secret(sb, 'qbo_client_secret');
    const t = await exchangeCode(id!, sec!, code, REDIRECT);
    const company = await companyName(st.environment, realm, t.access).catch(() => null);
    await rpc(sb, 'ops_qbo_save_tokens_svc', { p_access: t.access, p_refresh: t.refresh, p_access_exp: t.accessExp, p_refresh_exp: t.refreshExp,
      p_realm: realm, p_env: st.environment, p_company: company, p_email: st.email });
    await later(sync(store(sb)).catch((e) => console.error('qbo first sync:', e.message)));
    return back('connected');
  } catch (e) {
    console.error('qbo callback:', (e as Error).message);
    return back('error');
  }
});
