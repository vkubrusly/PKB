// =============================================================================
// ops-qbo — QuickBooks actions for the owners (Finance tab). Signed-in callers with the Finance
// permission only.
//   POST { action: 'connect', environment: 'sandbox' | 'production' } → { url } (Intuit consent page)
//   POST { action: 'sync' }                                             → { records, backfill }
//   POST { action: 'disconnect' }   revokes the tokens at Intuit, clears them → { was_connected, revoked }
//   POST { action: 'disconnected' } Intuit already disconnected (from /ops/quickbooks/disconnected): clears only
//   POST { action: 'test', test: 'expire_access' | 'revoke_access' | 'break_refresh' }  sandbox only, then a sync
// Read-only towards QuickBooks. See _shared/qbo.mjs.
// =============================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { publishableKey } from '../_shared/keys.ts';
import { REDIRECT, rpc, secret, store, svc } from '../_shared/qbo_store.ts';
import { authorizeUrl, errorRow, revokeToken, sync } from '../_shared/qbo.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const caller = createClient(Deno.env.get('SUPABASE_URL')!, publishableKey(), { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: me } = await caller.rpc('ops_me');
    if (!me?.finance) return json({ error: 'PKB Ops Finance is limited to the owners' }, 403);
    const body = await req.json().catch(() => ({}));
    const sb = svc();
    if (body.action === 'connect') {
      const env = body.environment === 'production' ? 'production' : 'sandbox';
      const clientId = await secret(sb, 'qbo_client_id');
      if (!clientId || !(await secret(sb, 'qbo_client_secret'))) return json({ error: 'QuickBooks Client ID / Secret not set (Users → Integrations)' }, 400);
      const state = await rpc(sb, 'ops_qbo_state_new_svc', { p_email: me.email, p_env: env });
      return json({ url: await authorizeUrl(env, { clientId, redirectUri: REDIRECT, state }) });
    }
    if (body.action === 'sync') {
      try { return json(await sync(store(sb))); }
      // deno-lint-ignore no-explicit-any
      catch (e: any) { return json({ error: e.message, kind: e.kind || 'other', needs_reconnect: e.kind === 'invalid_grant', intuit_tid: e.intuit_tid || null }, 502); }
    }
    if (body.action === 'test') {
      await rpc(sb, 'ops_qbo_test_svc', { p_action: String(body.test || '') });
      try { return json({ test: body.test, result: await sync(store(sb)) }); }
      // deno-lint-ignore no-explicit-any
      catch (e: any) { return json({ test: body.test, failed: true, message: e.message, kind: e.kind || 'other', needs_reconnect: e.kind === 'invalid_grant', intuit_tid: e.intuit_tid || null }); }
    }
    if (body.action === 'disconnect' || body.action === 'disconnected') {
      let revoked = false;
      if (body.action === 'disconnect') {
        const t = await rpc(sb, 'ops_qbo_tokens_svc');
        if (t?.refresh_token) revoked = await revokeToken(t.environment, t.client_id, t.client_secret, t.refresh_token).catch(async (e) => { await store(sb).error(errorRow(e)).catch(() => {}); return false; });
      }
      const r = await rpc(sb, 'ops_qbo_disconnect_svc', { p_email: me.email });
      return json({ ...r, revoked });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
