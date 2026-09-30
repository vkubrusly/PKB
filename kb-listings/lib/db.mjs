// SQL on the Kubrusly Basso Supabase project through the Management API (HTTPS, no driver).
// Env: KB_SUPABASE_ACCESS_TOKEN, KB_SUPABASE_PROJECT_REF (required — no default, so this can
// never write into another company's database by accident).
export const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''").replace(/\0/g, '')}'`);
export const qa = (a) => (a && a.length ? `array[${a.map(q).join(',')}]::text[]` : `'{}'::text[]`);
export const qn = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? 'null' : String(Number(v)));

export async function sql(query) {
  const ref = (process.env.KB_SUPABASE_PROJECT_REF || '').trim();
  const token = (process.env.KB_SUPABASE_ACCESS_TOKEN || '').trim();
  if (!ref || !token) throw new Error('KB_SUPABASE_PROJECT_REF / KB_SUPABASE_ACCESS_TOKEN not set');
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok || (body && body.message)) throw new Error(`Supabase SQL ${res.status}: ${body?.message || text.slice(0, 500)}`);
  return body;
}
