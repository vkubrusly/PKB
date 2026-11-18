-- =============================================================================
-- 0049 — Fix (Victor's sandbox test, 11/18): connecting failed after Intuit returned the tokens —
-- "ops_qbo_save_tokens_svc: DELETE requires a WHERE clause". Supabase's REST API (PostgREST, used by
-- the Edge Functions) runs with pg_safeupdate, which refuses a DELETE without WHERE; the earlier tests
-- called the function straight through SQL, where it is not loaded. Same function, with the WHERE.
-- =============================================================================
create or replace function public.ops_qbo_save_tokens_svc(p_access text, p_refresh text, p_access_exp timestamptz, p_refresh_exp timestamptz,
  p_realm text default null, p_env text default null, p_company text default null, p_email text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare sid uuid; mv text;
begin
  select id into sid from vault.secrets where name = 'pkb_qbo_access_token';
  if sid is null then perform vault.create_secret(p_access, 'pkb_qbo_access_token', 'QuickBooks access token (1 h)'); else perform vault.update_secret(sid, p_access); end if;
  select id into sid from vault.secrets where name = 'pkb_qbo_refresh_token';
  if sid is null then perform vault.create_secret(p_refresh, 'pkb_qbo_refresh_token', 'QuickBooks refresh token'); else perform vault.update_secret(sid, p_refresh); end if;
  if p_realm is not null then
    select minor_version into mv from ops.qbo_connection where id = 1;
    delete from ops.qbo_connection where id = 1;   -- WHERE required: PostgREST runs with pg_safeupdate
    insert into ops.qbo_connection (environment, realm_id, company_name, connected_by, connected_at, access_expires_at, refresh_expires_at, minor_version)
    values (p_env, p_realm, p_company, p_email, now(), p_access_exp, p_refresh_exp, coalesce(mv, '75'));
  else
    update ops.qbo_connection set access_expires_at = p_access_exp, refresh_expires_at = coalesce(p_refresh_exp, refresh_expires_at),
      needs_reconnect = false, needs_reconnect_reason = null, needs_reconnect_at = null, owners_alerted_at = null where id = 1;
  end if;
end $$;
