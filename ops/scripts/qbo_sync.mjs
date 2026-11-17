#!/usr/bin/env node
// =============================================================================
// qbo_sync.mjs — the daily safety sync with QuickBooks (ops-daily rounds). Webhooks normally keep the
// data current (ops-qbo-webhook → one CDC call); this catches a missed webhook with the same CDC
// (supabase/functions/_shared/qbo.mjs). Read-only towards QuickBooks; tokens stay in Supabase Vault.
//   node scripts/qbo_sync.mjs
// =============================================================================
import { sql } from './sb.mjs';
import { sync } from '../../supabase/functions/_shared/qbo.mjs';

const dq = (v) => { const tag = '$q' + Math.random().toString(36).slice(2, 8) + '$'; return `${tag}${v}${tag}`; };
const lit = (v) => (v == null ? 'null' : dq(String(v)));
const store = {
  tokens: async () => (await sql('select public.ops_qbo_tokens_svc() t'))[0]?.t,
  saveTokens: (n) => sql(`select public.ops_qbo_save_tokens_svc(${lit(n.access)}, ${lit(n.refresh)}, ${lit(n.accessExp)}::timestamptz, ${lit(n.refreshExp)}::timestamptz)`),
  upsert: (records) => sql(`select public.ops_qbo_upsert_svc(${dq(JSON.stringify(records))}::jsonb)`),
  synced: (since, error, backfilled) => sql(`select public.ops_qbo_synced_svc(${lit(since)}::timestamptz, ${lit(error)}, ${backfilled ? 'true' : 'false'})`),
};
const r = await sync(store);
console.log('QuickBooks sync:', JSON.stringify(r));
