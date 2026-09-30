-- =============================================================================
-- 0024 — Field channel (budget.pkbhomes.com/ops/field/, later WhatsApp).
-- Supervisors and PMs send photos, audio (transcribed while recording) and text; Claude
-- identifies the house (asks when the report doesn't say), reads the photos and drafts the
-- Buildertrend Daily Log + the PKB field-manual checklist (39 steps). The author confirms,
-- the Daily Log is queued with the photos (posted by rules/post_bt_logs.mjs) and the
-- checklist is updated.
--   role 'field'            supervisors / PMs: only the field channel, not the partner portal
--   ops.field_reports       one report (a short conversation) per visit
--   ops.field_checklist     manual steps per job (done / in progress), from confirmed reports
--   storage 'field-media'   private bucket; files under <auth uid>/…
-- =============================================================================

alter table ops.portal_users drop constraint if exists portal_users_role_check;
alter table ops.portal_users add constraint portal_users_role_check check (role in ('admin', 'partner', 'field'));
alter table ops.portal_users add column if not exists bt_name text;
insert into ops.portal_users (email, name, role, bt_name) values
  ('superintendent@pkbhomes.com', 'Raphael Martins', 'field', 'Raphael Martins'),
  ('gustavo@pkbhomes.com', 'Gustavo', 'field', 'Gustavo Supervisor'),
  ('denis@pkbhomes.com', 'Denis', 'field', 'Denis PKB'),
  ('carlos@pkbhomes.com', 'Carlos Basilio', 'field', 'Carlos Basilio'),
  ('camila@pkbhomes.com', 'Camila Haase', 'field', 'Camila Haase')
on conflict (email) do nothing;
update ops.portal_users set bt_name = 'Cristiano Pedrosa' where email = 'cristiano@pkbhomes.com' and bt_name is null;
update ops.portal_users set bt_name = 'Guilherme Pinto' where email = 'guilherme@pkbhomes.com' and bt_name is null;

create or replace function public.ops_me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('email', p.email, 'name', p.name, 'role', p.role, 'bt_name', p.bt_name)
  from ops.portal_users p join auth.users u on lower(u.email) = lower(p.email)
  where u.id = auth.uid() and u.email_confirmed_at is not null
$$;

-- partner portal: admin + partners only (field users get the field channel only)
create or replace function ops.require_partner() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := public.ops_me();
begin
  if me is null or me->>'role' not in ('admin', 'partner') then raise exception 'PKB Ops: access is limited to the partners' using errcode = '42501'; end if;
  return me;
end $$;

create or replace function ops.require_member() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := public.ops_me();
begin
  if me is null then raise exception 'PKB Ops: no access' using errcode = '42501'; end if;
  return me;
end $$;

alter table ops.outbound_messages add column if not exists media jsonb;

create table if not exists ops.field_reports (
  id           bigserial primary key,
  org_id       uuid references public.orgs(id) on delete cascade,
  job_id       uuid references ops.jobs(id) on delete set null,
  author_email text not null,
  channel      text not null default 'portal' check (channel in ('portal', 'whatsapp')),
  messages     jsonb not null default '[]',   -- [{from: 'user'|'assistant', text, transcript, media: [{path, kind, mime, name}], at}]
  status       text not null default 'open' check (status in ('open', 'needs_job', 'draft', 'confirmed', 'cancelled')),
  draft        jsonb,                          -- {job_number, summary, daily_log: {title, notes}, steps: [{n, status, evidence}], issues: []}
  outbound_id  uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  confirmed_at timestamptz
);
create index if not exists field_reports_author on ops.field_reports (author_email, created_at desc);

create table if not exists ops.field_checklist (
  job_id     uuid not null references ops.jobs(id) on delete cascade,
  step_n     text not null,
  status     text not null check (status in ('in_progress', 'done')),
  note       text,
  report_id  bigint references ops.field_reports(id) on delete set null,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (job_id, step_n)
);
alter table ops.field_reports enable row level security;
alter table ops.field_checklist enable row level security;

-- Jobs a field user can report on (active jobs), with the team and the checklist so far.
create or replace function public.ops_field_context(p_report_id bigint default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_member(); rep jsonb;
begin
  if p_report_id is not null then
    select to_jsonb(r) - 'org_id' into rep from ops.field_reports r
    where r.id = p_report_id and (r.author_email = me->>'email' or me->>'role' in ('admin', 'partner'));
  end if;
  return jsonb_build_object(
    'me', me,
    'report', rep,
    'jobs', (select coalesce(jsonb_agg(x order by x.job_number), '[]') from (
      select j.job_number, j.address, j.status, j.model,
        (select string_agg(c.name, ', ') from ops.job_contacts c where c.job_id = j.id and c.role = 'supervisor') supervisor,
        (select string_agg(c.name, ', ') from ops.job_contacts c where c.job_id = j.id and c.role = 'pm') pms,
        (select jsonb_object_agg(f.step_n, f.status) from ops.field_checklist f where f.job_id = j.id) checklist
      from ops.jobs j
      where j.org_id = ops.org() and j.company = 'PKB' and j.status in ('construction', 'starting', 'licensing', 'stand_by') and j.co_at is null) x)
  );
end $$;

-- Create or update a report (the ops-field function calls this after each exchange).
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
    where id = rid and status not in ('confirmed', 'cancelled') and (author_email = me->>'email' or me->>'role' in ('admin', 'partner'));
    if not found then raise exception 'report % not found or closed', rid; end if;
  end if;
  return rid;
end $$;

-- The author confirms the draft (optionally edited): Daily Log queued with the photos, checklist updated.
create or replace function public.ops_field_confirm(p_id bigint, p_title text default null, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb := ops.require_member();
  r ops.field_reports; d jsonb; job uuid; photos jsonb; notify text[]; mid uuid; s jsonb; n int := 0;
begin
  select * into r from ops.field_reports where id = p_id for update;
  if r.id is null or (r.author_email <> me->>'email' and me->>'role' not in ('admin', 'partner')) then raise exception 'report % not found', p_id; end if;
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

  insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, subject, body, status, media)
  values (ops.org(), job, 'bt_daily_log', 'FIELD', coalesce(notify, '{}'),
    left(coalesce(nullif(trim(p_title), ''), d->'daily_log'->>'title', 'Field report'), 50),
    left(coalesce(nullif(trim(p_notes), ''), d->'daily_log'->>'notes', ''), 3900) || E'\n\n— Reported by ' || coalesce(me->>'name', me->>'email') || ' via PKB Ops',
    'draft', photos) returning id into mid;

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

create or replace function public.ops_field_cancel(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_member();
begin
  update ops.field_reports set status = 'cancelled', updated_at = now()
  where id = p_id and status not in ('confirmed', 'cancelled') and (author_email = me->>'email' or me->>'role' in ('admin', 'partner'));
  return jsonb_build_object('status', 'cancelled');
end $$;

-- The caller's recent reports (partners: everyone's).
create or replace function public.ops_field_reports(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x.updated_at desc), '[]') from (
    select r.id, r.author_email, r.channel, r.status, r.draft, r.messages, r.created_at, r.updated_at, r.confirmed_at, j.job_number, j.address,
      (select m.status from ops.outbound_messages m where m.id = r.outbound_id) daily_log_status
    from ops.field_reports r left join ops.jobs j on j.id = r.job_id, lateral (select ops.require_member() me) k
    where r.author_email = k.me->>'email' or k.me->>'role' in ('admin', 'partner')
    order by r.updated_at desc limit least(greatest(p_limit, 1), 100)) x
$$;

revoke all on function public.ops_field_context(bigint), public.ops_field_save(bigint, jsonb, text, jsonb, text, text), public.ops_field_confirm(bigint, text, text),
  public.ops_field_cancel(bigint), public.ops_field_reports(int) from public, anon;
grant execute on function public.ops_field_context(bigint), public.ops_field_save(bigint, jsonb, text, jsonb, text, text), public.ops_field_confirm(bigint, text, text),
  public.ops_field_cancel(bigint), public.ops_field_reports(int) to authenticated;
revoke all on function ops.require_member() from public, anon, authenticated;

-- Private bucket for field photos and audio: members upload under their own uid folder and read all.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('field-media', 'field-media', false, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav', 'audio/x-m4a', 'video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists field_media_insert on storage.objects;
create policy field_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'field-media' and public.ops_me() is not null and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists field_media_select on storage.objects;
create policy field_media_select on storage.objects for select to authenticated
  using (bucket_id = 'field-media' and public.ops_me() is not null);
