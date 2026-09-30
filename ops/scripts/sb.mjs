// sb.mjs — run SQL on the Supabase project through the Management API (HTTPS).
// Works anywhere (GitHub Actions, the dev container, a VM) without a direct
// Postgres connection. Needs SUPABASE_ACCESS_TOKEN; SUPABASE_PROJECT_REF defaults
// to the PKB project.
const REF = process.env.SUPABASE_PROJECT_REF || 'fvjknahpmihueyeasgbx';

function token() {
  let t = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();
  if (t.startsWith('ssbp_')) t = t.slice(1); // tolerate a pasted extra "s"
  if (!t) throw new Error('SUPABASE_ACCESS_TOKEN not set');
  return t;
}

// Retries on 429 (the Management API throttles bursts) with a growing pause.
export async function sql(query, attempt = 0) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (res.status === 429 && attempt < 6) {
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    return sql(query, attempt + 1);
  }
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok || (body && body.message)) throw new Error(`Supabase SQL ${res.status}: ${body?.message || text.slice(0, 500)}`);
  return body;
}

// Service-role key of the project, read through the Management API (same access token), for
// server-side jobs that need Storage (e.g. downloading field photos to attach in Buildertrend).
let svcKey = null;
export async function serviceKey() {
  if (svcKey) return svcKey;
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${token()}` } });
  const keys = await r.json();
  svcKey = (Array.isArray(keys) ? keys : []).find((k) => k.name === 'service_role' || k.type === 'secret')?.api_key;
  if (!svcKey) throw new Error('service key not available to this access token');
  return svcKey;
}

export async function downloadObject(bucket, path) {
  const key = await serviceKey();
  const r = await fetch(`https://${REF}.supabase.co/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`storage ${r.status} ${path}`);
  return Buffer.from(await r.arrayBuffer());
}
