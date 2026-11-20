-- =============================================================================
-- 0060 — Vendor invoices processed minutes after they arrive (Victor, 11/20/26: "o ideal é você ficar com email
-- ativo, entrou email você processa"). Every 5 minutes pg_cron calls the Edge Function ops-mail-watch, which only
-- LOOKS at the bot mailbox (IMAP EXAMINE): an unread e-mail from/to invoice@ or an unread answer to "Invoice para
-- revisar" → ops_dispatch_mail_now() starts ops-mail (not again within 10 minutes). The hourly ops-mail stays as
-- the backstop. The shared secret is in Vault (ops_watch_secret) and in the function's secrets.
-- =============================================================================
create or replace function public.ops_dispatch_mail_now() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from ops.dispatch_log where workflow = 'ops-mail.yml' and created_at > now() - interval '10 minutes') then
    return false;
  end if;
  perform ops.dispatch_workflow('ops-mail.yml');
  update ops.dispatch_log set note = 'mail watch: new invoice e-mail' where id = (select max(id) from ops.dispatch_log where workflow = 'ops-mail.yml');
  return true;
end $$;
revoke all on function public.ops_dispatch_mail_now() from public, anon, authenticated;
grant execute on function public.ops_dispatch_mail_now() to service_role;

create or replace function ops.call_mail_watch() returns void
language plpgsql security definer set search_path = '' as $$
declare s text;
begin
  select decrypted_secret into s from vault.decrypted_secrets where name = 'ops_watch_secret' limit 1;
  if s is null then return; end if;
  perform net.http_post(
    url := 'https://fvjknahpmihueyeasgbx.supabase.co/functions/v1/ops-mail-watch',
    headers := jsonb_build_object('x-watch-secret', s, 'Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
end $$;
revoke all on function ops.call_mail_watch() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname = 'pkb-ops-mail-watch';
select cron.schedule('pkb-ops-mail-watch', '*/5 * * * *', 'select ops.call_mail_watch()');
