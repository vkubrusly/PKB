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

export async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok || (body && body.message)) throw new Error(`Supabase SQL ${res.status}: ${body?.message || text.slice(0, 500)}`);
  return body;
}
