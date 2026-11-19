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
  synced: (since, error, backfilled, warnings) => sql(`select public.ops_qbo_synced_svc(${lit(since)}::timestamptz, ${lit(error)}, ${backfilled ? 'true' : 'false'}, ${warnings ? dq(JSON.stringify(warnings)) + '::jsonb' : 'null'})`),
  error: (e) => sql(`select public.ops_qbo_error_svc(${lit(e.kind)}, ${e.status == null ? 'null' : Number(e.status)}, ${lit(e.intuit_tid)}, ${lit(e.endpoint)}, ${lit(e.code)}, ${lit(e.message)})`),
  needsReconnect: (reason) => sql(`select public.ops_qbo_needs_reconnect_svc(${lit(reason)})`),
  features: (f) => sql(`select public.ops_qbo_features_svc(${dq(JSON.stringify(f))}::jsonb)`),
};
try { console.log('QuickBooks sync:', JSON.stringify(await sync(store))); }
catch (e) { console.error(`QuickBooks sync failed (${e.kind || 'error'}${e.intuit_tid ? ', intuit_tid ' + e.intuit_tid : ''}): ${e.message}`); process.exitCode = 1; }
