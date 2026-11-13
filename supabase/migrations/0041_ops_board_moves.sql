-- =============================================================================
-- 0041 — Board tab: a partner can drag a job to another phase column (Victor, 2026-11-13).
-- The column comes from the data (ops/analysis/phase_board.mjs, in the board snapshot); a move
-- records the correction with who and when. The portal uses the latest move of a job until the
-- data shows a newer phase change (the computed phase starts after the move). Moving a job
-- back to "automatic" stores a move with phase null. History is kept. Idempotent.
-- =============================================================================
create table if not exists ops.board_moves (
  id          bigint generated always as identity primary key,
  org_id      uuid references public.orgs(id) on delete cascade,
  job_number  text not null,
  phase       text check (phase in ('licensing', 'waiting', 'foundation', 'walls', 'roof', 'mep', 'closein', 'finishes', 'final', 'awaiting_co', 'done', 'standby')),
  moved_by    text not null,
  moved_at    timestamptz not null default now()
);
create index if not exists board_moves_job on ops.board_moves (job_number, moved_at desc);
alter table ops.board_moves enable row level security;

create or replace function public.ops_board_move(p_job text, p_phase text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb := ops.require_partner();
begin
  if p_phase is not null and p_phase not in ('licensing', 'waiting', 'foundation', 'walls', 'roof', 'mep', 'closein', 'finishes', 'final', 'awaiting_co', 'done', 'standby') then
    raise exception 'unknown phase %', p_phase;
  end if;
  if not exists (select 1 from ops.jobs where job_number = p_job) then raise exception 'unknown job %', p_job; end if;
  insert into ops.board_moves (org_id, job_number, phase, moved_by) values (ops.org(), p_job, p_phase, me->>'email');
  return jsonb_build_object('job_number', p_job, 'phase', p_phase);
end $$;
revoke all on function public.ops_board_move(text, text) from public, anon;
grant execute on function public.ops_board_move(text, text) to authenticated;

-- Same as 0040, plus 'moves': the latest move of each job (phase null = back to automatic).
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
        select m.id, m.channel, m.rule, m.to_addresses, m.cc_addresses, m.subject, left(m.body, 1500) body, m.status, m.error, m.created_at, m.sent_at, j.job_number,
               m.payload->'not_notified' not_notified
        from ops.outbound_messages m left join ops.jobs j on j.id = m.job_id
        order by m.created_at desc limit 80) x),
    'actions', (select coalesce(jsonb_agg(a order by a.created_at desc), '[]') from (
        select id, proposed_by, action, input, summary, status, result, decided_by, created_at, decided_at
        from ops.ask_actions order by created_at desc limit 40) a),
    'requests', (select coalesce(jsonb_agg(r order by r.created_at desc), '[]') from (
        select id, email, text, status, answer, created_at, updated_at from ops.change_requests order by created_at desc limit 40) r),
    'moves', (select coalesce(jsonb_agg(v), '[]') from (
        select distinct on (job_number) job_number, phase, moved_by, moved_at from ops.board_moves order by job_number, moved_at desc) v
        where v.phase is not null)
  );
end $$;
