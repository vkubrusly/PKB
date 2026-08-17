// Shared Anthropic helpers: model fallback + safe error message.
//
// The primary model may not be enabled on a given API key. We try a short
// chain and fall through ONLY on model-availability errors (404 not found /
// 403 no access) — never on credits (402) or bad requests (400, e.g. PDF too
// large), which must surface as-is.

// deno-lint-ignore no-explicit-any
type Anthropic = any;

export function modelChain(): string[] {
  const primary = Deno.env.get('AI_MODEL') || 'claude-opus-5';
  return [primary, 'claude-sonnet-5', 'claude-haiku-4-5-20251001']
    .filter((v, i, a) => a.indexOf(v) === i);
}

// Create a message with:
//  • model fallback — fall through ONLY on model-availability errors (404/403);
//  • optional web search — attach Anthropic's web_search tool, and if the
//    account rejects it (400 tool error) retry the same model WITHOUT the tool,
//    so generation still succeeds (just without live web results).
// Upload a PDF to the Anthropic Files API and return its file_id. Lets us send
// large PDFs by reference instead of inline base64 (which inflates ~33% and
// blows the 32MB request limit). Requires the files-api beta.
export async function uploadPdf(apiKey: string, bytes: ArrayBuffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('file', new File([bytes], filename || 'plantas.pdf', { type: 'application/pdf' }));
  const resp = await fetch('https://api.anthropic.com/v1/files', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'files-api-2025-04-14',
    },
    body: form,
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Files API ${resp.status}: ${j?.error?.message ?? 'upload falhou'}`);
  return j.id;
}

export const FILES_BETA = { 'anthropic-beta': 'files-api-2025-04-14' };

// deno-lint-ignore no-explicit-any
export async function createWithFallback(
  anthropic: Anthropic,
  params: Record<string, any>,
  opts: { webSearch?: boolean; maxUses?: number; headers?: Record<string, string> } = {},
) {
  const tool = opts.webSearch
    ? { type: 'web_search_20250305', name: 'web_search', max_uses: opts.maxUses ?? 5 }
    : null;
  const models = modelChain();
  let lastErr: unknown;
  for (const model of models) {
    for (const useTool of (tool ? [true, false] : [false])) {
      try {
        // deno-lint-ignore no-explicit-any
        const body: Record<string, any> = { ...params, model };
        if (useTool && tool) body.tools = [...(params.tools ?? []), tool];
        const resp = await anthropic.messages.create(body, opts.headers ? { headers: opts.headers } : undefined);
        return { resp, model, usedWeb: useTool };
      } catch (e) {
        const status = (e as { status?: number })?.status;
        const msg = String((e as { message?: string })?.message ?? '');
        if (useTool && status === 400 && /tool|web[_ ]?search|search/i.test(msg)) continue; // drop tool, retry
        if (status === 404 || status === 403) { lastErr = e; break; }                        // model → next
        throw e;                                                                             // real error → surface
      }
    }
  }
  throw lastErr;
}

// Join the text blocks of a response (ignores web_search tool_use/result blocks).
// deno-lint-ignore no-explicit-any
export function extractText(resp: any): string {
  return (resp?.content ?? [])
    .filter((b: { type?: string }) => b.type === 'text')
    .map((b: { text?: string }) => b.text ?? '').join('\n');
}

// Create → extract text → parse JSON, with web-search that DEGRADES GRACEFULLY:
// a web-augmented turn can end without a final JSON block (truncated by tool
// output, or a pause_turn). If the web result won't parse, retry once WITHOUT
// web so the caller still gets a valid object.
// deno-lint-ignore no-explicit-any
export async function createJsonWithWeb<T>(
  anthropic: Anthropic,
  params: Record<string, any>,
  parse: (text: string) => T,
  opts: { maxUses?: number } = {},
): Promise<{ result: T; model: string; usedWeb: boolean }> {
  let r = await createWithFallback(anthropic, params, { webSearch: true, maxUses: opts.maxUses ?? 5 });
  try {
    return { result: parse(extractText(r.resp)), model: r.model, usedWeb: r.usedWeb };
  } catch (e) {
    if (!r.usedWeb) throw e; // no web was used → the model genuinely didn't return JSON
    r = await createWithFallback(anthropic, params, {}); // retry without web search
    return { result: parse(extractText(r.resp)), model: r.model, usedWeb: false };
  }
}

// Force a valid structured object via FORCED TOOL USE. The model must call the
// given tool, whose input_schema defines the shape, so we get a schema-valid
// JSON object with no prose, no prefill, no text parsing — and it works on
// models that reject assistant prefill. Do NOT combine with web search.
// deno-lint-ignore no-explicit-any
export async function createViaTool<T>(
  anthropic: Anthropic,
  params: Record<string, any>,
  // deno-lint-ignore no-explicit-any
  tool: { name: string; description: string; input_schema: Record<string, any> },
  headers?: Record<string, string>,
): Promise<{ result: T; model: string }> {
  const { resp, model } = await createWithFallback(anthropic, {
    ...params,
    tools: [...(params.tools ?? []), tool],
    tool_choice: { type: 'tool', name: tool.name },
  }, headers ? { headers } : {});
  const block = (resp?.content ?? []).find((b: { type?: string }) => b.type === 'tool_use');
  if (!block) {
    const sr = resp?.stop_reason ? ` (stop_reason: ${resp.stop_reason})` : '';
    throw new Error(`O modelo não retornou o resultado estruturado${sr}.`);
  }
  return { result: (block as { input: T }).input, model, stop_reason: resp?.stop_reason };
}

// Turn any thrown error into a clear message (Anthropic API errors include a nested message).
export function aiErrorMessage(e: unknown): string {
  const err = e as { status?: number; message?: string; error?: { error?: { message?: string } } };
  const apiMsg = err?.error?.error?.message;
  return apiMsg ? `Claude API ${err.status ?? ''}: ${apiMsg}`.trim()
    : (e instanceof Error ? e.message : String(e));
}
