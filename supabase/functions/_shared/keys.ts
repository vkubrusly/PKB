// Project API keys for Edge Functions (security, 2026-11-17). Supabase injects the new keys as JSON
// dictionaries (SUPABASE_SECRET_KEYS / SUPABASE_PUBLISHABLE_KEYS, keyed by name — 'default'); the legacy
// JWT keys (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY) are only a fallback until they are disabled.
const pick = (env: string) => { try { return JSON.parse(Deno.env.get(env) || '{}').default as string | undefined; } catch { return undefined; } };
export const secretKey = (): string => pick('SUPABASE_SECRET_KEYS') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
export const publishableKey = (): string => pick('SUPABASE_PUBLISHABLE_KEYS') || Deno.env.get('SUPABASE_ANON_KEY')!;
