-- =============================================================================
-- 0028 — website work requests → Buildertrend (Victor, 2026-10-02):
--   * new request with no job yet → a Lead Opportunity proposal (ask_actions 'bt_lead');
--     a partner confirms in the portal → outbound_messages channel 'bt_lead' → created in
--     Buildertrend by rules/post_bt_leads.mjs
--   * request for a job that already exists → Daily Log on that job with buyer/agent details
-- =============================================================================
alter table ops.outbound_messages drop constraint if exists outbound_messages_channel_check;
alter table ops.outbound_messages add constraint outbound_messages_channel_check check (channel in ('email', 'whatsapp', 'bt_daily_log', 'bt_lead'));
alter table ops.outbound_messages add column if not exists payload jsonb;

alter table ops.ask_actions drop constraint if exists ask_actions_action_check;
alter table ops.ask_actions add constraint ask_actions_action_check check (action in ('daily_log', 'email', 'pause_job', 'resume_job', 'set_contact', 'job_note', 'change_request', 'set_office', 'bt_lead'));

alter table ops.leads add column if not exists bt_lead_status text;      -- proposed / queued / created / duplicate / failed
alter table ops.leads add column if not exists bt_lead_url text;
alter table ops.leads add column if not exists job_logged_at timestamptz; -- Daily Log posted on the matched job

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
  if a.action not in ('email', 'change_request', 'bt_lead') then
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
    when 'set_office' then
      if coalesce(i->>'office', '') !~ '^[a-z_]{2,30}$' then raise exception 'invalid office'; end if;
      update ops.jobs set permit_office = i->>'office', permit_office_source = 'manual', updated_at = now() where id = job;
      update ops.permit_cases set ball_with = case when ball_with = 'sovereign' and i->>'office' <> 'sovereign' then 'pkb' else ball_with end where job_id = job and kind = 'building';
      msg := format('Permit office set to %s.', i->>'office');
    when 'bt_lead' then
      insert into ops.outbound_messages (org_id, channel, rule, to_addresses, subject, body, status, payload, requested_by)
      values (ops.org(), 'bt_lead', 'R-LEAD', '{}', left(i->>'title', 200), coalesce(i->>'notes', ''), 'draft', i,
              ops.who(a.proposed_by) || case when lower(a.proposed_by) <> lower(me->>'email') then ', confirmado por ' || ops.who(me->>'email') else '' end);
      update ops.leads set bt_lead_status = 'queued' where org_id = ops.org() and ref = i->>'lead_ref';
      msg := 'Lead Opportunity queued — created in Buildertrend within the hour.';
    when 'change_request' then
      insert into ops.change_requests (org_id, email, text) values (ops.org(), me->>'email', i->>'text');
      msg := 'Change request recorded for Claude.';
  end case;

  update ops.ask_actions set status = 'done', result = msg, decided_by = me->>'email', decided_at = now() where id = p_id;
  return jsonb_build_object('status', 'done', 'result', msg);
end $$;
