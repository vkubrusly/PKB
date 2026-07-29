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
// deno-lint-ignore no-explicit-any
export async function createWithFallback(
  anthropic: Anthropic,
  params: Record<string, any>,
  opts: { webSearch?: boolean; maxUses?: number } = {},
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
        const resp = await anthropic.messages.create(body);
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

// Turn any thrown error into a clear message (Anthropic API errors include a nested message).
export function aiErrorMessage(e: unknown): string {
  const err = e as { status?: number; message?: string; error?: { error?: { message?: string } } };
  const apiMsg = err?.error?.error?.message;
  return apiMsg ? `Claude API ${err.status ?? ''}: ${apiMsg}`.trim()
    : (e instanceof Error ? e.message : String(e));
}
