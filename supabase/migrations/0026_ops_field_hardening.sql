-- =============================================================================
-- 0026 — field channel hardening (Victor, 2026-09-30)
--   * every Daily Log says who asked for it: outbound_messages.requested_by (the poster
--     writes the signature line: field report / Ask / automatic rule)
--   * nothing is lost: a report is saved before the assistant runs ('pending' until it
--     answers); the phone resends by client id (ops_field_context p_client_id) without
--     duplicating; Daily Log errors are shown and retried
--   * ops.ai_usage: tokens and cost of every assistant call (field + Ask)
--   * jobs carry the Buildertrend job name for house matching ("casa 1" = 0001)
-- =============================================================================
alter table ops.outbound_messages add column if not exists requested_by text;

alter table ops.field_reports drop constraint if exists field_reports_status_check;
alter table ops.field_reports add constraint field_reports_status_check check (status in ('pending', 'open', 'needs_job', 'draft', 'confirmed', 'cancelled'));

create table if not exists ops.ai_usage (
  id            bigserial primary key,
  org_id        uuid references public.orgs(id) on delete cascade,
  at            timestamptz not null default now(),
  feature       text not null,            -- 'field' | 'ask'
  email         text,
  model         text,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  cache_read    int not null default 0,
  cache_write   int not null default 0,
  report_id     bigint
);
alter table ops.ai_usage enable row level security;

-- "Name (e-mail)" of a portal user, for signatures
create or replace function ops.who(p_email text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select coalesce(p.name, p.email) from ops.portal_users p where lower(p.email) = lower(p_email)), p_email)
$$;

create or replace function public.ops_log_usage(p_feature text, p_model text, p_in int, p_out int, p_cache_read int default 0, p_cache_write int default 0, p_report_id bigint default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_member();
begin
  insert into ops.ai_usage (org_id, feature, email, model, input_tokens, output_tokens, cache_read, cache_write, report_id)
  values (ops.org(), left(p_feature, 20), me->>'email', left(p_model, 60), greatest(coalesce(p_in, 0), 0), greatest(coalesce(p_out, 0), 0), greatest(coalesce(p_cache_read, 0), 0), greatest(coalesce(p_cache_write, 0), 0), p_report_id);
end $$;

create or replace function public.ops_confirm(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb := ops.require_partner();
  a ops.ask_actions;
  i jsonb; job uuid; msg text; n int;
begin
  select * into a from ops.ask_actions where id = p_id for update;
  if a.id is null then raise exception 'action % not found', p_id; end if;
  if a.status <> 'proposed' then return jsonb_build_object('status', a.status, 'result', a.result); end if;
  i := a.input;
  if a.action not in ('email', 'change_request') then
    job := ops.job_by_number(i->>'job_number');
    if job is null then raise exception 'job % not found', i->>'job_number'; end if;
  end if;

  case a.action
    when 'daily_log' then
      insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, subject, body, status, requested_by)
      values (ops.org(), job, 'bt_daily_log', 'ASK', coalesce(array(select jsonb_array_elements_text(i->'notify')), '{}'),
              left(i->>'title', 50), left(i->>'notes', 3800), 'draft', ops.who(a.proposed_by) || case when lower(a.proposed_by) <> lower(me->>'email') then ', confirmado por ' || ops.who(me->>'email') else '' end);
      msg := 'Daily Log queued — posted to Buildertrend on the next run (6 AM / 1 PM).';
    when 'email' then
      if coalesce(jsonb_array_length(i->'to'), 0) = 0 then raise exception 'e-mail without recipient'; end if;
      insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, cc_addresses, subject, body, status, requested_by)
      values (ops.org(), ops.job_by_number(i->>'job_number'), 'email', 'ASK',
              array(select jsonb_array_elements_text(i->'to')), coalesce(array(select jsonb_array_elements_text(i->'cc')), '{}'),
              i->>'subject', i->>'text', 'approved', ops.who(a.proposed_by) || case when lower(a.proposed_by) <> lower(me->>'email') then ', confirmado por ' || ops.who(me->>'email') else '' end);
      msg := 'E-mail approved — sent from the bot mailbox within the hour.';
    when 'pause_job' then
      insert into ops.job_pauses (org_id, job_id, reason, started_at, note)
      values (ops.org(), job, coalesce(nullif(i->>'reason', ''), 'other'), coalesce((i->>'since')::date, current_date), i->>'note');
      msg := 'Job paused.';
    when 'resume_job' then
      update ops.job_pauses set ended_at = greatest(started_at, current_date) where job_id = job and ended_at is null;
      get diagnostics n = row_count;
      msg := format('%s pause(s) ended.', n);
    when 'set_contact' then
      if i->>'role' not in ('supervisor', 'pm') then raise exception 'role must be supervisor or pm'; end if;
      if coalesce((i->>'replace')::boolean, true) then delete from ops.job_contacts where job_id = job and role = i->>'role'; end if;
      insert into ops.job_contacts (org_id, job_id, role, name) values (ops.org(), job, i->>'role', i->>'name');
      msg := format('%s set to %s.', i->>'role', i->>'name');
    when 'job_note' then
      update ops.jobs set note = concat_ws(E'\n', nullif(note, ''), format('[%s %s] %s', to_char(now() at time zone 'America/New_York', 'MM/DD'), split_part(me->>'email', '@', 1), i->>'note')), updated_at = now() where id = job;
      msg := 'Note added to the job.';
    when 'change_request' then
      insert into ops.change_requests (org_id, email, text) values (ops.org(), me->>'email', i->>'text');
      msg := 'Change request recorded for Claude.';
  end case;

  update ops.ask_actions set status = 'done', result = msg, decided_by = me->>'email', decided_at = now() where id = p_id;
  return jsonb_build_object('status', 'done', 'result', msg);
end $$;

create or replace function public.ops_field_confirm(p_id bigint, p_title text default null, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb := ops.require_member();
  r ops.field_reports; d jsonb; job uuid; photos jsonb; notify text[]; mid uuid; s jsonb; n int := 0;
begin
  select * into r from ops.field_reports where id = p_id for update;
  if r.id is null or (r.author_email <> me->>'email' and me->>'role' not in ('admin', 'partner', 'pm')) then raise exception 'report % not found', p_id; end if;
  if r.status <> 'draft' then return jsonb_build_object('status', r.status); end if;
  d := r.draft;
  job := coalesce(r.job_id, ops.job_by_number(d->>'job_number'));
  if job is null then raise exception 'report without a job'; end if;

  select coalesce(jsonb_agg(m), '[]') into photos
  from ops.field_reports x, jsonb_array_elements(x.messages) msg, jsonb_array_elements(coalesce(msg->'media', '[]')) m
  where x.id = r.id and (m->>'kind' = 'video' or (m->>'kind' = 'photo' and not coalesce((m->>'from_video')::boolean, false)));
  -- notify: the job's supervisors and PMs + Cristiano (Buildertrend names)
  select array_agg(distinct t.nm) into notify from (
    select coalesce(p.bt_name, c.name) nm from ops.job_contacts c left join ops.portal_users p on lower(p.name) = lower(c.name) or lower(p.bt_name) = lower(c.name)
    where c.job_id = job and c.role in ('supervisor', 'pm')
    union select 'Cristiano Pedrosa') t0, lateral (select regexp_replace(trim(t0.nm), '\s+', ' ', 'g') nm) t where t.nm is not null;

  insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, subject, body, status, media, requested_by)
  values (ops.org(), job, 'bt_daily_log', 'FIELD', coalesce(notify, '{}'),
    left(coalesce(nullif(trim(p_title), ''), d->'daily_log'->>'title', 'Field report'), 50),
    left(coalesce(nullif(trim(p_notes), ''), d->'daily_log'->>'notes', ''), 3800),
    'draft', photos, ops.who(r.author_email) || case when lower(r.author_email) <> lower(me->>'email') then ', confirmado por ' || ops.who(me->>'email') else '' end)
  returning id into mid;

  for s in select * from jsonb_array_elements(coalesce(d->'steps', '[]')) loop
    if s->>'status' in ('done', 'in_progress') then
      insert into ops.field_checklist (job_id, step_n, status, note, report_id, updated_by)
      values (job, s->>'n', s->>'status', left(s->>'evidence', 500), r.id, me->>'email')
      on conflict (job_id, step_n) do update set
        status = case when ops.field_checklist.status = 'done' then 'done' else excluded.status end,
        note = excluded.note, report_id = excluded.report_id, updated_by = excluded.updated_by, updated_at = now();
      n := n + 1;
    end if;
  end loop;

  update ops.field_reports set status = 'confirmed', confirmed_at = now(), outbound_id = mid, job_id = job, updated_at = now() where id = r.id;
  return jsonb_build_object('status', 'confirmed', 'photos', jsonb_array_length(photos), 'steps', n, 'notify', to_jsonb(notify));
end $$;

drop function if exists public.ops_field_context(bigint);
create or replace function public.ops_field_context(p_report_id bigint default null, p_client_id text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_member(); rep jsonb;
begin
  if p_report_id is null and p_client_id is not null then
    select r.id into p_report_id from ops.field_reports r
    where r.author_email = me->>'email' and r.messages @> jsonb_build_array(jsonb_build_object('client_id', p_client_id)) order by r.id desc limit 1;
  end if;
  if p_report_id is not null then
    select to_jsonb(r) - 'org_id' into rep from ops.field_reports r
    where r.id = p_report_id and (r.author_email = me->>'email' or me->>'role' in ('admin', 'partner', 'pm'));
  end if;
  return jsonb_build_object(
    'me', me,
    'report', rep,
    'jobs', (select coalesce(jsonb_agg(x order by x.job_number), '[]') from (
      select j.job_number, j.address, j.status, j.model, j.bt_job_name,
        (select string_agg(c.name, ', ') from ops.job_contacts c where c.job_id = j.id and c.role = 'supervisor') supervisor,
        (select string_agg(c.name, ', ') from ops.job_contacts c where c.job_id = j.id and c.role = 'pm') pms,
        (select jsonb_object_agg(f.step_n, f.status) from ops.field_checklist f where f.job_id = j.id) checklist
      from ops.jobs j
      where j.org_id = ops.org() and j.status in ('construction', 'starting', 'licensing', 'stand_by', 'completed') and (j.co_at is null or j.co_at > current_date - 60)) x)
  );
end $$;

create or replace function public.ops_field_save(p_id bigint, p_messages jsonb, p_status text, p_draft jsonb, p_job text, p_channel text default 'portal') returns bigint
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_member(); rid bigint := p_id; job uuid := case when p_job is null then null else ops.job_by_number(p_job) end;
begin
  if rid is null then
    insert into ops.field_reports (org_id, job_id, author_email, channel, messages, status, draft)
    values (ops.org(), job, me->>'email', coalesce(p_channel, 'portal'), coalesce(p_messages, '[]'), coalesce(p_status, 'open'), p_draft) returning id into rid;
  else
    update ops.field_reports set messages = coalesce(p_messages, messages), status = coalesce(p_status, status), draft = coalesce(p_draft, draft),
      job_id = coalesce(job, job_id), updated_at = now()
    where id = rid and status not in ('confirmed', 'cancelled') and (author_email = me->>'email' or me->>'role' in ('admin', 'partner', 'pm'));
    if not found then raise exception 'report % not found or closed', rid; end if;
  end if;
  return rid;
end $$;

create or replace function public.ops_field_reports(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x.updated_at desc), '[]') from (
    select r.id, r.author_email, r.channel, r.status, r.draft, r.messages, r.created_at, r.updated_at, r.confirmed_at, j.job_number, j.address,
      (select m.status from ops.outbound_messages m where m.id = r.outbound_id) daily_log_status,
      (select m.error from ops.outbound_messages m where m.id = r.outbound_id) daily_log_error
    from ops.field_reports r left join ops.jobs j on j.id = r.job_id, lateral (select ops.require_member() me) k
    where r.author_email = k.me->>'email' or k.me->>'role' in ('admin', 'partner', 'pm')
    order by r.updated_at desc limit least(greatest(p_limit, 1), 100)) x
$$;

revoke all on function public.ops_field_context(bigint, text), public.ops_log_usage(text, text, int, int, int, int, bigint) from public, anon;
grant execute on function public.ops_field_context(bigint, text), public.ops_log_usage(text, text, int, int, int, int, bigint) to authenticated;
revoke all on function ops.who(text) from public, anon, authenticated;
