// QuickBooks Online, read-only (Victor, 2026-11-17). Plain JavaScript, used by the Edge Functions (Deno)
// and by the daily safety sync (Node, ops/scripts/qbo_sync.mjs). Nothing here writes to QuickBooks.
// Sync = webhooks + CDC: an Intuit webhook says something changed, one CDC call fetches only what
// changed since the last sync (all entities at once); a daily CDC catches a missed webhook; the first
// connection (or a gap over 29 days, CDC's limit is 30) backfills with paged queries.

export const SCOPE = 'com.intuit.quickbooks.accounting';
export const ENTITIES = ['Invoice', 'Payment', 'Deposit', 'Bill', 'BillPayment', 'Customer', 'Vendor'];
const MINOR = '75';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const apiBase = (env) => (env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com');

export const authorizeUrl = ({ clientId, redirectUri, state }) =>
  `https://appcenter.intuit.com/connect/oauth2?${new URLSearchParams({ client_id: clientId, response_type: 'code', scope: SCOPE, redirect_uri: redirectUri, state })}`;

async function tokenRequest(clientId, clientSecret, form) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${clientId}:${clientSecret}`), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Intuit token ${r.status}: ${j.error || ''} ${j.error_description || ''}`.trim());
  const now = Date.now();
  return { access: j.access_token, refresh: j.refresh_token, accessExp: new Date(now + (j.expires_in || 3600) * 1000).toISOString(),
    refreshExp: j.x_refresh_token_expires_in ? new Date(now + j.x_refresh_token_expires_in * 1000).toISOString() : null };
}
export const exchangeCode = (clientId, clientSecret, code, redirectUri) => tokenRequest(clientId, clientSecret, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
export const refreshTokens = (clientId, clientSecret, refreshToken) => tokenRequest(clientId, clientSecret, { grant_type: 'refresh_token', refresh_token: refreshToken });

async function get(env, realm, token, path, params = {}) {
  const u = new URL(`${apiBase(env)}/v3/company/${realm}/${path}`);
  for (const [k, v] of Object.entries({ ...params, minorversion: MINOR })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`QuickBooks ${path.split('?')[0]} ${r.status}: ${JSON.stringify(j.Fault?.Error?.[0] || j).slice(0, 200)}`);
  return j;
}
export const companyName = async (env, realm, token) => (await get(env, realm, token, `companyinfo/${realm}`)).CompanyInfo?.CompanyName || null;

// One QuickBooks object → a row for ops.qbo_records (the full object is kept in data).
export function toRecord(entity, o) {
  const ref = o.CustomerRef || o.VendorRef || null;
  const party = entity === 'Customer' || entity === 'Vendor' ? o.DisplayName : ref?.name ?? null;
  return {
    entity, qbo_id: String(o.Id), doc_number: o.DocNumber || o.PaymentRefNum || null,
    party: party ?? null, party_id: entity === 'Customer' || entity === 'Vendor' ? String(o.Id) : ref?.value ?? null,
    txn_date: o.TxnDate || null, due_date: o.DueDate || null,
    total: o.TotalAmt ?? null, balance: o.Balance ?? null,
    deleted: o.status === 'Deleted', qbo_updated_at: o.MetaData?.LastUpdatedTime || null, data: o,
  };
}

export async function cdc(env, realm, token, sinceIso) {
  const j = await get(env, realm, token, 'cdc', { entities: ENTITIES.join(','), changedSince: sinceIso });
  const out = [];
  for (const block of j.CDCResponse?.[0]?.QueryResponse || [])
    for (const e of ENTITIES) for (const o of block[e] || []) out.push(toRecord(e, o));
  return out;
}

export async function backfill(env, realm, token) {
  const out = [];
  for (const e of ENTITIES) {
    for (let start = 1; ; start += 1000) {
      const j = await get(env, realm, token, 'query', { query: `select * from ${e} startposition ${start} maxresults 1000` });
      const rows = j.QueryResponse?.[e] || [];
      for (const o of rows) out.push(toRecord(e, o));
      if (rows.length < 1000) break;
    }
  }
  return out;
}

// Intuit signs the raw webhook body: base64(HMAC-SHA256(body, verifier token)) in the intuit-signature header.
export async function verifyWebhook(rawBody, signature, verifier) {
  if (!signature || !verifier) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(verifier), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// store: { tokens(), saveTokens(t), upsert(records), synced(sinceIso|null, error|null, backfilled) }
export async function sync(store) {
  const t = await store.tokens();
  if (!t?.realm_id) return { skipped: 'not connected' };
  let token = t.access_token;
  if (!token || !t.access_expires_at || Date.parse(t.access_expires_at) - Date.now() < 5 * 60e3) {
    const n = await refreshTokens(t.client_id, t.client_secret, t.refresh_token);
    await store.saveTokens(n);
    token = n.access;
  }
  const started = new Date(Date.now() - 60e3).toISOString();   // a minute of overlap: nothing falls between two syncs
  try {
    const full = !t.backfilled_at || !t.last_sync_at || Date.now() - Date.parse(t.last_sync_at) > 29 * 864e5;
    const recs = full ? await backfill(t.environment, t.realm_id, token) : await cdc(t.environment, t.realm_id, token, t.last_sync_at);
    for (let i = 0; i < recs.length; i += 300) await store.upsert(recs.slice(i, i + 300));
    await store.synced(started, null, full);
    return { records: recs.length, backfill: full };
  } catch (e) {
    await store.synced(null, String(e.message || e).slice(0, 500), false);
    throw e;
  }
}
