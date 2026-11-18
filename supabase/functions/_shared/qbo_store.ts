// QuickBooks storage for the Edge Functions: the *_svc database functions (0046), called with the
// project secret key. Tokens and the Intuit app credentials live in Supabase Vault.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { secretKey } from './keys.ts';

export const REDIRECT = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ops-qbo-callback`;
export const PORTAL = 'https://budget.pkbhomes.com/ops/';
export const svc = () => createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), { auth: { persistSession: false } });
export async function rpc(sb: SupabaseClient, fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
export const secret = (sb: SupabaseClient, name: string) => rpc(sb, 'ops_secret_get', { p_name: name }) as Promise<string | null>;
// deno-lint-ignore no-explicit-any
export const store = (sb: SupabaseClient) => ({
  tokens: () => rpc(sb, 'ops_qbo_tokens_svc'),
  // deno-lint-ignore no-explicit-any
  saveTokens: (n: any) => rpc(sb, 'ops_qbo_save_tokens_svc', { p_access: n.access, p_refresh: n.refresh, p_access_exp: n.accessExp, p_refresh_exp: n.refreshExp }),
  // deno-lint-ignore no-explicit-any
  upsert: (records: any[]) => rpc(sb, 'ops_qbo_upsert_svc', { p_records: records }),
  // deno-lint-ignore no-explicit-any
  synced: (since: string | null, error: string | null, backfilled: boolean, warnings: any = null) => rpc(sb, 'ops_qbo_synced_svc', { p_since: since, p_error: error, p_backfilled: backfilled, p_warnings: warnings }),
  // deno-lint-ignore no-explicit-any
  error: (e: any) => rpc(sb, 'ops_qbo_error_svc', { p_kind: e.kind, p_status: e.status ?? null, p_tid: e.intuit_tid ?? null, p_endpoint: e.endpoint ?? null, p_code: e.code ?? null, p_message: e.message ?? null }),
  needsReconnect: (reason: string) => rpc(sb, 'ops_qbo_needs_reconnect_svc', { p_reason: reason }),
  // deno-lint-ignore no-explicit-any
  features: (f: any) => rpc(sb, 'ops_qbo_features_svc', { p_features: f }),
});
// Work that must finish after the response (Supabase Edge Runtime keeps the worker alive for it).
export function later(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p); else return p;
}
