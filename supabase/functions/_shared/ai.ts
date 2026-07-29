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

// deno-lint-ignore no-explicit-any
export async function createWithFallback(anthropic: Anthropic, params: Record<string, any>) {
  const models = modelChain();
  let lastErr: unknown;
  for (const model of models) {
    try {
      const resp = await anthropic.messages.create({ ...params, model });
      return { resp, model };
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 404 || status === 403) { lastErr = e; continue; } // model unavailable → try next
      throw e; // real error (credits, bad request, rate limit) → surface
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
