// Shared CORS + JSON helpers for the Edge Functions.
export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

// Extract a JSON object from a model text response. Handles ```json fences and
// responses where web-search citations add prose/braces around the JSON: tries
// first-brace→last-brace, then falls back to the LAST balanced {...} block.
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Resposta da IA sem JSON.');
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    // Scan backward for the last balanced object that parses.
    for (let e = end; e >= start; e = raw.lastIndexOf('}', e - 1)) {
      let depth = 0;
      for (let s = e; s >= 0; s--) {
        if (raw[s] === '}') depth++;
        else if (raw[s] === '{') { depth--; if (depth === 0) {
          try { return JSON.parse(raw.slice(s, e + 1)) as T; } catch { break; }
        } }
      }
    }
    throw new Error('Resposta da IA sem JSON válido.');
  }
}
