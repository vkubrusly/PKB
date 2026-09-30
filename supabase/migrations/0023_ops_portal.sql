-- =============================================================================
-- 0023 — PKB Ops portal on the PKB domain (budget.pkbhomes.com/ops/).
--   ops.portal_users     partners allowed in the portal (Victor = admin)
--   ops.snapshots        board JSON built by the ops-daily workflow (scripts/board_snapshot.mjs)
--   ops.change_requests  "pedir mudança" — structural change requests for Claude
--   ops.ask_actions      actions the Ask assistant proposes; run only when a partner confirms
-- Access: only through the SECURITY DEFINER functions below, which check that the caller
-- is signed in with a confirmed e-mail listed in ops.portal_users. The ops schema itself
-- stays private (RLS on, no policies).
-- =============================================================================

create table if not exists ops.portal_users (
  email      text primary key,
  name       text,
  role       text not null default 'partner' check (role in ('admin', 'partner')),
  created_at timestamptz not null default now()
);
insert into ops.portal_users (email, name, role) values
  ('victor@pkbhomes.com', 'Victor Kubrusly', 'admin'),
  ('thiago@wra-usa.com', 'Thiago', 'partner'),
  ('guilherme@pkbhomes.com', 'Guilherme Pinto', 'partner'),
  ('cristiano@pkbhomes.com', 'Cristiano Pedrosa', 'partner'),
  ('daniela@pkbhomes.com', 'Daniela', 'partner')
on conflict (email) do nothing;

create table if not exists ops.snapshots (
  id         bigserial primary key,
  org_id     uuid references public.orgs(id) on delete cascade,
  kind       text not null,
  data       jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists snapshots_kind_created on ops.snapshots (kind, created_at desc);

create table if not exists ops.change_requests (
  id         bigserial primary key,
  org_id     uuid references public.orgs(id) on delete cascade,
  email      text not null,
  text       text not null,
  status     text not null default 'open' check (status in ('open', 'doing', 'done', 'dismissed')),
  answer     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ops.ask_actions (
  id           bigserial primary key,
  org_id       uuid references public.orgs(id) on delete cascade,
  proposed_by  text not null,
  action       text not null check (action in ('daily_log', 'email', 'pause_job', 'resume_job', 'set_contact', 'job_note', 'change_request')),
  input        jsonb not null,
  summary      text not null,
  status       text not null default 'proposed' check (status in ('proposed', 'done', 'cancelled', 'failed')),
  result       text,
  decided_by   text,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);

alter table ops.portal_users enable row level security;
alter table ops.snapshots enable row level security;
alter table ops.change_requests enable row level security;
alter table ops.ask_actions enable row level security;

-- Who is calling: {email, name, role} for a confirmed partner, else null.
create or replace function public.ops_me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('email', p.email, 'name', p.name, 'role', p.role)
  from ops.portal_users p join auth.users u on lower(u.email) = lower(p.email)
  where u.id = auth.uid() and u.email_confirmed_at is not null
$$;

create or replace function ops.require_partner() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := public.ops_me();
begin
  if me is null or me->>'role' not in ('admin', 'partner', 'pm') then raise exception 'PKB Ops: access is limited to the partners and project managers' using errcode = '42501'; end if;
  return me;
end $$;

create or replace function ops.org() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.orgs where name = 'PKB Homes' limit 1
$$;

-- Everything the portal page shows: the latest board snapshot + live outbox, actions, requests.
create or replace function public.ops_board(p_with_board boolean default true) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me jsonb := ops.require_partner(); s record;
begin
  select data, created_at into s from ops.snapshots where kind = 'board' order by created_at desc limit 1;
  return jsonb_build_object(
    'me', me,
    'snapshot_at', s.created_at,
    'board', case when p_with_board then s.data end,
    'outbox', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
        select m.id, m.channel, m.rule, m.to_addresses, m.cc_addresses, m.subject, left(m.body, 1500) body, m.status, m.error, m.created_at, m.sent_at, j.job_number
        from ops.outbound_messages m left join ops.jobs j on j.id = m.job_id
        order by m.created_at desc limit 80) x),
    'actions', (select coalesce(jsonb_agg(a order by a.created_at desc), '[]') from (
        select id, proposed_by, action, input, summary, status, result, decided_by, created_at, decided_at
        from ops.ask_actions order by created_at desc limit 40) a),
    'requests', (select coalesce(jsonb_agg(r order by r.created_at desc), '[]') from (
        select id, email, text, status, answer, created_at, updated_at from ops.change_requests order by created_at desc limit 40) r)
  );
end $$;

-- The Ask assistant records a proposed action; nothing runs until ops_confirm.
create or replace function public.ops_propose(p_action text, p_input jsonb, p_summary text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_partner(); new_id bigint;
begin
  insert into ops.ask_actions (org_id, proposed_by, action, input, summary)
  values (ops.org(), me->>'email', p_action, coalesce(p_input, '{}'), left(p_summary, 2000)) returning id into new_id;
  return new_id;
end $$;

create or replace function ops.job_by_number(p_number text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from ops.jobs where org_id = ops.org() and upper(job_number) = upper(trim(p_number)) limit 1
$$;

-- A partner confirms a proposed action → it runs here, in one transaction.
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
      insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, subject, body, status)
      values (ops.org(), job, 'bt_daily_log', 'ASK', coalesce(array(select jsonb_array_elements_text(i->'notify')), '{}'),
              left(i->>'title', 50), left(i->>'notes', 4000), 'draft');
      msg := 'Daily Log queued — posted to Buildertrend on the next run (6 AM / 1 PM).';
    when 'email' then
      if coalesce(jsonb_array_length(i->'to'), 0) = 0 then raise exception 'e-mail without recipient'; end if;
      insert into ops.outbound_messages (org_id, job_id, channel, rule, to_addresses, cc_addresses, subject, body, status)
      values (ops.org(), ops.job_by_number(i->>'job_number'), 'email', 'ASK',
              array(select jsonb_array_elements_text(i->'to')), coalesce(array(select jsonb_array_elements_text(i->'cc')), '{}'),
              i->>'subject', i->>'text', 'approved');
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

create or replace function public.ops_cancel(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_partner();
begin
  update ops.ask_actions set status = 'cancelled', decided_by = me->>'email', decided_at = now() where id = p_id and status = 'proposed';
  return jsonb_build_object('status', 'cancelled');
end $$;

-- Outbox: cancel a message that has not gone out yet (draft Daily Log, approved e-mail).
create or replace function public.ops_outbox_cancel(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_partner(); n int;
begin
  update ops.outbound_messages set status = 'cancelled', error = 'cancelled by ' || (me->>'email') where id = p_id and status in ('draft', 'approved');
  get diagnostics n = row_count;
  return jsonb_build_object('cancelled', n);
end $$;

-- "Pedir mudança": a structural change request for Claude (admin and partners).
create or replace function public.ops_request_change(p_text text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_partner(); new_id bigint;
begin
  if length(trim(coalesce(p_text, ''))) < 3 then raise exception 'empty request'; end if;
  insert into ops.change_requests (org_id, email, text) values (ops.org(), me->>'email', trim(p_text)) returning id into new_id;
  return new_id;
end $$;

revoke all on function public.ops_me(), public.ops_board(boolean), public.ops_propose(text, jsonb, text), public.ops_confirm(bigint),
  public.ops_cancel(bigint), public.ops_outbox_cancel(uuid), public.ops_request_change(text) from public, anon;
grant execute on function public.ops_me(), public.ops_board(boolean), public.ops_propose(text, jsonb, text), public.ops_confirm(bigint),
  public.ops_cancel(bigint), public.ops_outbox_cancel(uuid), public.ops_request_change(text) to authenticated;
revoke all on function ops.require_partner(), ops.org(), ops.job_by_number(text) from public, anon, authenticated;
