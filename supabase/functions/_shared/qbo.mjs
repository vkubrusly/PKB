// QuickBooks Online, read-only (Victor, 2026-11-17 / hardened 11-18 for Intuit's production review).
// Plain JavaScript, used by the Edge Functions (Deno) and by the daily safety sync (Node,
// ops/scripts/qbo_sync.mjs). Nothing here writes to QuickBooks.
//
// Sync = webhooks + CDC: an Intuit webhook says something changed, one CDC call fetches only what
// changed since the last sync; a daily CDC catches a missed webhook; the first connection (or a gap
// over 29 days — CDC reaches back 30) backfills with paged queries.
//
// Robustness
//   endpoints   OAuth endpoints come from Intuit's discovery document (cached 24 h; built-in fallback)
//   tokens      refreshed 5 min before expiry; a 401 refreshes once and retries the call
//   reconnect   invalid_grant (refresh token expired or revoked) → store.needsReconnect(); no retries
//   retries     429 / 5xx / network: one retry after a pause
//   errors      every failure → store.error({kind, status, intuit_tid, endpoint, code, message})
//   plan        Preferences tell which features the company's plan has (classes, locations,
//               multicurrency, projects). Optional entities are read only when on; anything the plan
//               refuses is skipped with a warning and the sync goes on. Amounts are kept in the home
//               currency when the company uses multicurrency.
//   version     minorversion per connection (default 75)

export const SCOPE = 'com.intuit.quickbooks.accounting';
export const CORE = ['Invoice', 'Payment', 'Deposit', 'Bill', 'BillPayment', 'Customer', 'Vendor'];
export const OPTIONAL = { Class: 'classes', Department: 'locations' };   // entity → feature that enables it
export const DEFAULT_MINOR = '75';
export const apiBase = (env) => (env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com');

export class QboError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

// ---------- discovery ----------------------------------------------------------------------------
const DISCOVERY_URL = { sandbox: 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration',
  production: 'https://developer.api.intuit.com/.well-known/openid_configuration' };
const FALLBACK = { authorization_endpoint: 'https://appcenter.intuit.com/connect/oauth2',
  token_endpoint: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revocation_endpoint: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke' };
const discoveryCache = {};
export async function discovery(env) {
  const key = env === 'production' ? 'production' : 'sandbox';
  const c = discoveryCache[key];
  if (c && Date.now() - c.at < 24 * 3600e3) return c.doc;
  try {
    const r = await fetch(DISCOVERY_URL[key], { headers: { Accept: 'application/json' } });
    const j = await r.json();
    if (!j.token_endpoint || !j.authorization_endpoint) throw new Error('incomplete');
    discoveryCache[key] = { at: Date.now(), doc: { ...FALLBACK, ...j } };
  } catch { discoveryCache[key] = { at: Date.now() - 23 * 3600e3, doc: FALLBACK }; }   // retry in an hour
  return discoveryCache[key].doc;
}

export async function authorizeUrl(env, { clientId, redirectUri, state }) {
  const d = await discovery(env);
  return `${d.authorization_endpoint}?${new URLSearchParams({ client_id: clientId, response_type: 'code', scope: SCOPE, redirect_uri: redirectUri, state })}`;
}

// ---------- tokens -------------------------------------------------------------------------------
const basic = (id, secret) => 'Basic ' + btoa(`${id}:${secret}`);
const tid = (r) => r.headers.get('intuit_tid') || r.headers.get('intuit-tid') || null;
const pause = (ms) => new Promise((res) => setTimeout(res, ms));

async function tokenRequest(env, clientId, clientSecret, form) {
  const { token_endpoint } = await discovery(env);
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(token_endpoint, { method: 'POST', headers: { Authorization: basic(clientId, clientSecret), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    } catch (e) {
      if (attempt === 0) { await pause(2000); continue; }
      throw new QboError('network', `Intuit token endpoint unreachable: ${e.message}`, { endpoint: 'oauth/token' });
    }
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) {
      const now = Date.now();
      return { access: j.access_token, refresh: j.refresh_token, accessExp: new Date(now + (j.expires_in || 3600) * 1000).toISOString(),
        refreshExp: j.x_refresh_token_expires_in ? new Date(now + j.x_refresh_token_expires_in * 1000).toISOString() : null };
    }
    if ((r.status === 429 || r.status >= 500) && attempt === 0) { await pause(2000); continue; }
    const kind = j.error === 'invalid_grant' ? 'invalid_grant' : j.error === 'invalid_client' ? 'auth_config' : r.status >= 500 ? 'server' : 'auth';
    throw new QboError(kind, `Intuit token ${r.status}: ${j.error || ''} ${j.error_description || ''}`.trim(), { status: r.status, intuit_tid: tid(r), endpoint: 'oauth/token', code: j.error || null });
  }
}
export const exchangeCode = (env, clientId, clientSecret, code, redirectUri) => tokenRequest(env, clientId, clientSecret, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
export const refreshTokens = (env, clientId, clientSecret, refreshToken) => tokenRequest(env, clientId, clientSecret, { grant_type: 'refresh_token', refresh_token: refreshToken });

// Disconnect: Intuit revokes the refresh token (and the access tokens issued from it).
export async function revokeToken(env, clientId, clientSecret, token) {
  if (!token) return false;
  const { revocation_endpoint } = await discovery(env);
  const r = await fetch(revocation_endpoint, { method: 'POST', headers: { Authorization: basic(clientId, clientSecret), Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  return r.ok;
}

// ---------- API calls ----------------------------------------------------------------------------
// ctx: { env, realm, minor, token, refresh: async () => newAccessToken }
const PLAN_RX = /not supported|not available|not enabled|feature|subscription|upgrade|plan (does|doesn)|invalid query|not valid for|unknown entity|no such|QueryParserError/i;
function faultError(path, r, j) {
  const f = j?.Fault?.Error?.[0] || {};
  const type = j?.Fault?.type || '';
  const text = `${f.Message || ''} ${f.Detail || ''}`.trim() || JSON.stringify(j).slice(0, 200);
  const kind = r.status === 401 ? 'auth' : r.status === 403 ? 'forbidden' : r.status === 429 ? 'throttle' : r.status >= 500 ? 'server'
    : /minor ?version/i.test(text) ? 'minorversion' : PLAN_RX.test(text) ? 'plan' : /validation/i.test(type) ? 'validation' : 'other';
  return new QboError(kind, `QuickBooks ${path.split('?')[0]} ${r.status}: ${text}`.slice(0, 600), { status: r.status, intuit_tid: tid(r), endpoint: path.split('?')[0], code: f.code || type || null });
}
async function get(ctx, path, params = {}) {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const u = new URL(`${apiBase(ctx.env)}/v3/company/${ctx.realm}/${path}`);
    for (const [k, v] of Object.entries({ ...params, minorversion: ctx.minor || DEFAULT_MINOR })) u.searchParams.set(k, v);
    let r;
    try { r = await fetch(u, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' } }); }
    catch (e) {
      if (attempt === 0) { await pause(2000); continue; }
      throw new QboError('network', `QuickBooks unreachable: ${e.message}`, { endpoint: path.split('?')[0] });
    }
    if (r.status === 401 && !refreshed && ctx.refresh) { refreshed = true; ctx.token = await ctx.refresh(); continue; }   // one refresh + retry
    if ((r.status === 429 || r.status >= 500) && attempt === 0) { await pause(r.status === 429 ? 5000 : 2000); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.Fault) throw faultError(path, r, j);
    return j;
  }
}
export const companyName = async (ctx) => (await get(ctx, `companyinfo/${ctx.realm}`)).CompanyInfo?.CompanyName || null;

// Which features the company's plan has on (QuickBooks Preferences). Missing preferences = off.
export async function features(ctx) {
  const p = (await get(ctx, 'preferences')).Preferences || {};
  const acc = p.AccountingInfoPrefs || {}, other = (p.OtherPrefs?.NameValue || []);
  const nv = (name) => other.find((x) => x.Name === name)?.Value;
  return {
    classes: !!(acc.ClassTrackingPerTxn || acc.ClassTrackingPerTxnLine),
    locations: !!acc.TrackDepartments,
    multicurrency: !!p.CurrencyPrefs?.MultiCurrencyEnabled,
    home_currency: p.CurrencyPrefs?.HomeCurrency?.value || null,
    projects: String(nv('ProjectsEnabled') ?? nv('ProjectsEnabledInUI') ?? '').toLowerCase() === 'true',
  };
}
export const entitiesFor = (f) => [...CORE, ...Object.entries(OPTIONAL).filter(([, feat]) => f?.[feat]).map(([e]) => e)];

// One QuickBooks object → a row for ops.qbo_records (the full object is kept in data). Amounts in the
// home currency when QuickBooks gives them (multicurrency companies).
export function toRecord(entity, o) {
  const ref = o.CustomerRef || o.VendorRef || null;
  const named = ['Customer', 'Vendor', 'Class', 'Department'].includes(entity);
  return {
    entity, qbo_id: String(o.Id), doc_number: o.DocNumber || o.PaymentRefNum || null,
    party: named ? (o.DisplayName || o.FullyQualifiedName || o.Name || null) : ref?.name ?? null,
    party_id: named ? String(o.Id) : ref?.value ?? null,
    txn_date: o.TxnDate || null, due_date: o.DueDate || null,
    total: o.HomeTotalAmt ?? o.TotalAmt ?? null, balance: o.HomeBalance ?? o.Balance ?? null,
    deleted: o.status === 'Deleted', qbo_updated_at: o.MetaData?.LastUpdatedTime || null, data: o,
  };
}

// Every entity refused: not a plan limit but a problem on our side (query, version) — fail the sync.
function allFailed(entities, warnings) {
  if (entities.length && entities.every((e) => warnings.some((w) => w.entity === e))) {
    const w = warnings.find((x) => x.kind !== 'plan') || warnings[0];
    throw new QboError(w.kind === 'plan' ? 'validation' : w.kind, `QuickBooks refused every entity: ${w.error}`, { intuit_tid: w.intuit_tid, endpoint: 'sync', code: 'all_entities' });
  }
}
const parseCdc = (j, entities) => {
  const out = [];
  for (const block of j.CDCResponse?.[0]?.QueryResponse || []) for (const e of entities) for (const o of block[e] || []) out.push(toRecord(e, o));
  return out;
};
// CDC for all entities in one call; if QuickBooks refuses the call (an entity the plan lacks), entity by
// entity: the ones refused are skipped with a warning.
export async function cdc(ctx, entities, sinceIso, warnings = []) {
  try { return parseCdc(await get(ctx, 'cdc', { entities: entities.join(','), changedSince: sinceIso }), entities); }
  catch (e) { if (!['plan', 'validation', 'other'].includes(e.kind)) throw e; }
  const out = [];
  for (const ent of entities) {
    try { out.push(...parseCdc(await get(ctx, 'cdc', { entities: ent, changedSince: sinceIso }), [ent])); }
    catch (e) { if (!['plan', 'validation', 'other'].includes(e.kind)) throw e; warnings.push({ entity: ent, kind: e.kind, error: e.message, intuit_tid: e.intuit_tid || null }); }
  }
  allFailed(entities, warnings);
  return out;
}
export async function backfill(ctx, entities, warnings = []) {
  const out = [];
  for (const e of entities) {
    try {
      for (let start = 1; ; start += 1000) {
        const j = await get(ctx, 'query', { query: `select * from ${e} startposition ${start} maxresults 1000` });
        const rows = j.QueryResponse?.[e] || [];
        for (const o of rows) out.push(toRecord(e, o));
        if (rows.length < 1000) break;
      }
    } catch (err) {
      if (!['plan', 'validation', 'other'].includes(err.kind)) throw err;
      warnings.push({ entity: e, kind: err.kind, error: err.message, intuit_tid: err.intuit_tid || null });
    }
  }
  allFailed(entities, warnings);
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

// ---------- sync ---------------------------------------------------------------------------------
// store: { tokens(), saveTokens(t), upsert(records), synced(sinceIso|null, error|null, backfilled, warnings),
//          error(err), needsReconnect(reason), features(f) }
export const errorRow = (e) => ({ kind: e.kind || 'other', status: e.status ?? null, intuit_tid: e.intuit_tid ?? null, endpoint: e.endpoint ?? null, code: e.code ?? null, message: String(e.message || e).slice(0, 1000) });

export async function sync(store) {
  const t = await store.tokens();
  if (!t?.realm_id) return { skipped: 'not connected' };
  if (t.needs_reconnect) return { skipped: 'needs reconnect' };
  const ctx = { env: t.environment, realm: t.realm_id, minor: t.minor_version || DEFAULT_MINOR, token: t.access_token };
  ctx.refresh = async () => {
    try {
      const n = await refreshTokens(t.environment, t.client_id, t.client_secret, t.refresh_token);
      await store.saveTokens(n);
      t.refresh_token = n.refresh || t.refresh_token;
      return (ctx.token = n.access);
    } catch (e) {
      if (e.kind === 'invalid_grant') await store.needsReconnect('QuickBooks access expired or was revoked — reconnect at /ops/quickbooks');
      throw e;
    }
  };
  const started = new Date(Date.now() - 60e3).toISOString();   // a minute of overlap: nothing falls between two syncs
  const warnings = [];
  try {
    if (!ctx.token || !t.access_expires_at || Date.parse(t.access_expires_at) - Date.now() < 5 * 60e3) await ctx.refresh();
    let f = t.features;
    if (!f || !t.features_checked_at || Date.now() - Date.parse(t.features_checked_at) > 24 * 3600e3) {
      try { f = await features(ctx); await store.features(f); }
      catch (e) { if (['auth', 'invalid_grant'].includes(e.kind)) throw e; warnings.push({ entity: 'Preferences', kind: e.kind, error: e.message, intuit_tid: e.intuit_tid || null }); f = f || {}; }
    }
    const entities = entitiesFor(f);
    const full = !t.backfilled_at || !t.last_sync_at || Date.now() - Date.parse(t.last_sync_at) > 29 * 864e5;
    const recs = full ? await backfill(ctx, entities, warnings) : await cdc(ctx, entities, t.last_sync_at, warnings);
    for (let i = 0; i < recs.length; i += 300) await store.upsert(recs.slice(i, i + 300));
    for (const w of warnings) await store.error({ kind: w.kind || 'plan', status: null, intuit_tid: w.intuit_tid, endpoint: w.entity, code: 'skipped', message: w.error });
    await store.synced(started, null, full, warnings.length ? warnings : null);
    return { records: recs.length, backfill: full, entities, skipped: warnings.map((w) => w.entity) };
  } catch (e) {
    await store.error(errorRow(e)).catch(() => {});
    await store.synced(null, String(e.message || e).slice(0, 500), false, null).catch(() => {});
    throw e;
  }
}
