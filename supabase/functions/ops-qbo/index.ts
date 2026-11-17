// =============================================================================
// ops-qbo — QuickBooks actions for the owners (Finance tab). Signed-in callers with the Finance
// permission only.
//   POST { action: 'connect', environment: 'sandbox' | 'production' } → { url } (Intuit consent page)
//   POST { action: 'sync' }                                             → { records, backfill }
// Read-only towards QuickBooks. See _shared/qbo.mjs.
// =============================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { publishableKey } from '../_shared/keys.ts';
import { REDIRECT, rpc, secret, store, svc } from '../_shared/qbo_store.ts';
import { authorizeUrl, sync } from '../_shared/qbo.mjs';

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
      return json({ url: authorizeUrl({ clientId, redirectUri: REDIRECT, state }) });
    }
    if (body.action === 'sync') return json(await sync(store(sb)));
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
