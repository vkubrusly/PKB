-- =============================================================================
-- 0062 — Finance → Vendor invoices panel (Victor, 11/21/26): how many invoice e-mails came in, which invoices
-- became bills, which were already in Buildertrend, which need a review or failed; and an answer box on each one
-- that needs attention ("escrever a solução e você já corrige"). Finance partners only.
-- =============================================================================

-- Period view: counts, the items that need attention (any date) and every invoice of the period.
create or replace function public.ops_vendor_invoices(p_from date, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_finance(); d_to date := coalesce(p_to, (now() at time zone 'America/New_York')::date);
  t0 timestamptz := (p_from::timestamp at time zone 'America/New_York'); t1 timestamptz := ((d_to + 1)::timestamp at time zone 'America/New_York');
begin
  return jsonb_build_object(
    'from', p_from, 'to', d_to,
    'emails', (select count(*) from ops.inbound_emails where category = 'vendor_invoice' and received_at >= t0 and received_at < t1),
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from ops.vendor_invoices
                where received_at >= t0 and received_at < t1 group by status) c),
    'created_amount', (select coalesce(sum(l.bill_amount), 0) from ops.vendor_invoice_lines l join ops.vendor_invoices v on v.id = l.invoice_id
                where v.received_at >= t0 and v.received_at < t1 and l.bt_bill_id is not null),
    'attention', (select coalesce(jsonb_agg(x order by x.received_at), '[]') from (select * from ops.vendor_invoice_rows(null, null)
                where status in ('needs_review', 'duplicate', 'error') or line_errors > 0) x),
    'items', (select coalesce(jsonb_agg(x order by x.received_at desc), '[]') from ops.vendor_invoice_rows(t0, t1) x)
  );
end $$;
revoke all on function public.ops_vendor_invoices(date, date) from public, anon;
grant execute on function public.ops_vendor_invoices(date, date) to authenticated;

-- One row per invoice (shared by the period view and the attention list).
create or replace function ops.vendor_invoice_rows(t0 timestamptz, t1 timestamptz)
returns table (id uuid, received_at timestamptz, email_subject text, vendor text, invoice_number text, invoice_date date, total numeric,
               status text, issues text[], question_sent_at timestamptz, answered_at timestamptz, answer text, bt_found jsonb,
               file_path text, file_name text, lines jsonb, line_errors int)
language sql stable security definer set search_path = '' as $$
  select v.id, v.received_at, v.email_subject, v.vendor, v.invoice_number, v.invoice_date, v.total, v.status, v.issues, v.question_sent_at,
    v.answered_at, v.answer, v.bt_found, nullif(v.file_path, '(no file)'), v.file_name,
    coalesce((select jsonb_agg(jsonb_build_object('job', coalesce(l.job_number, case when l.general then 'geral' end), 'address', l.address,
        'amount', l.bill_amount, 'bill', l.bt_bill_id, 'bt_job', coalesce(j.bt_job_id, case when l.general then 41763140 end),
        'bt_status', l.bt_status, 'bt_error', l.bt_error, 'excluded', l.excluded) order by l.job_number)
      from ops.vendor_invoice_lines l left join ops.jobs j on j.id = l.job_id where l.invoice_id = v.id), '[]'),
    (select count(*)::int from ops.vendor_invoice_lines l where l.invoice_id = v.id and l.bt_status in ('error', 'unknown'))
  from ops.vendor_invoices v
  where (t0 is null or v.received_at >= t0) and (t1 is null or v.received_at < t1)
$$;
revoke all on function ops.vendor_invoice_rows(timestamptz, timestamptz) from public, anon, authenticated;

-- The answer box: the text goes in as an answer to that invoice (the same reader as Camila's e-mail answers,
-- rules/vendor_invoices.mjs) and ops-mail starts now.
create or replace function public.ops_vendor_invoice_answer(p_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_finance(); v record;
begin
  if coalesce(trim(p_text), '') = '' then raise exception 'write the solution first'; end if;
  select * into v from ops.vendor_invoices where id = p_id;
  if v.id is null then raise exception 'invoice not found'; end if;
  insert into ops.inbound_emails (org_id, message_id, received_at, from_addr, from_name, to_addrs, subject, body_text, category, parsed)
  values (v.org_id, 'portal:' || gen_random_uuid(), now(), me->>'email', me->>'name', '{}',
          'Re: Invoice para revisar — ' || coalesce(v.vendor, '') || coalesce(' #' || v.invoice_number, ''), left(p_text, 8000), 'invoice_answer',
          jsonb_build_object('invoice_id', v.id, 'via', 'portal'));
  update ops.vendor_invoices set answer = 'aguardando o robô: ' || left(p_text, 300), updated_at = now() where id = v.id;
  -- process it now (not again if ops-mail started in the last 2 minutes)
  if not exists (select 1 from ops.dispatch_log where workflow = 'ops-mail.yml' and created_at > now() - interval '2 minutes') then
    perform ops.dispatch_workflow('ops-mail.yml');
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.ops_vendor_invoice_answer(uuid, text) from public, anon;
grant execute on function public.ops_vendor_invoice_answer(uuid, text) to authenticated;

-- The invoice PDFs (private bucket ops-invoices): readable by finance partners from the portal (signed URL).
drop policy if exists "ops finance reads vendor invoices" on storage.objects;
create policy "ops finance reads vendor invoices" on storage.objects for select to authenticated
  using (bucket_id = 'ops-invoices' and coalesce((public.ops_me()->>'finance')::boolean, false));
