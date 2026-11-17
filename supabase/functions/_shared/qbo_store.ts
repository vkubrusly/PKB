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
  synced: (since: string | null, error: string | null, backfilled: boolean) => rpc(sb, 'ops_qbo_synced_svc', { p_since: since, p_error: error, p_backfilled: backfilled }),
});
// Work that must finish after the response (Supabase Edge Runtime keeps the worker alive for it).
export function later(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p); else return p;
}
