-- =============================================================================
-- 0034 — "not notified" is a note, not an error (Victor, 2026-10-13).
-- A Buildertrend Daily Log that was posted but could not notify someone who is not a
-- Buildertrend user on that job kept the names in outbound_messages.error, so a sent log
-- looked like a failure (health check: 68 of 148 sent messages "with error"). The poster
-- (ops/rules/post_bt_logs.mjs) now keeps them in payload.not_notified; this moves the old
-- rows there and has the portal's Outbox return them, shown as a neutral note.
-- Idempotent.
-- =============================================================================
update ops.outbound_messages
set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('not_notified',
      (select coalesce(jsonb_agg(btrim(n)), '[]'::jsonb)
       from unnest(string_to_array(substring(error from length('not notified (not Buildertrend users on the job): ') + 1), ',')) n
       where btrim(n) <> '')),
    error = null
where error like 'not notified (not Buildertrend users on the job): %';

-- Same as 0023, plus not_notified on each Outbox row.
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
        select id, email, text, status, answer, created_at, updated_at from ops.change_requests order by created_at desc limit 40) r)
  );
end $$;
