// =============================================================================
// ops-qbo-webhook — Intuit calls this when something changes in QuickBooks (Webhooks in the Intuit
// app). Public (no Supabase login), so the intuit-signature HMAC is checked against the Verifier Token
// (Vault) before anything happens; every call is logged (ops.qbo_webhook_log). A valid call starts one
// CDC sync after the response (Intuit wants a quick 200).
// =============================================================================
import { later, rpc, secret, store, svc } from '../_shared/qbo_store.ts';
import { sync, verifyWebhook } from '../_shared/qbo.mjs';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  const raw = await req.text();
  try {
    const sb = svc();
    const valid = await verifyWebhook(raw, req.headers.get('intuit-signature'), await secret(sb, 'qbo_webhook_verifier'));
    // deno-lint-ignore no-explicit-any
    let realm: string | null = null, entities: any = null;
    try {
      const j = JSON.parse(raw);
      const n = j.eventNotifications?.[0];
      realm = n?.realmId ?? (Array.isArray(j) ? j[0]?.intuitaccountid ?? null : null);
      // deno-lint-ignore no-explicit-any
      entities = n?.dataChangeEvent?.entities ?? (Array.isArray(j) ? j.map((e: any) => ({ type: e.type, id: e.intuitentityid })) : null);
    } catch { /* not JSON */ }
    await rpc(sb, 'ops_qbo_webhook_log_svc', { p_valid: valid, p_realm: realm, p_entities: entities });
    if (!valid) return new Response('invalid signature', { status: 401 });
    await later(sync(store(sb)).catch((e) => console.error('qbo webhook sync:', e.message)));
    return new Response('ok');
  } catch (e) {
    console.error('qbo webhook:', (e as Error).message);
    return new Response('error', { status: 500 });
  }
});
