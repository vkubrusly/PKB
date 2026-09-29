-- Photos uploaded to each Buildertrend job (collectors/buildertrend/photos.mjs):
-- when, by whom, in which folder, and the Daily Log they belong to.
-- `site` is false for pictures of paperwork (bills, receipts, POs).
create table if not exists ops.job_photos (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs(id) on delete cascade,
  job_id          uuid references ops.jobs(id) on delete cascade,
  bt_job_id       bigint not null,
  bt_document_id  bigint not null,
  title           text,
  folder          text,
  site            boolean not null default true,
  added_by        text,
  attached_at     timestamp,          -- Buildertrend local time (Eastern)
  taken_at        timestamp,
  linked_type     text,               -- daily_log | type_<n>
  linked_id       bigint,
  linked_title    text,
  collected_at    timestamptz not null default now(),
  unique (org_id, bt_document_id)
);
create index if not exists idx_ops_job_photos_job on ops.job_photos(job_id, attached_at desc);

alter table ops.job_photos enable row level security;
drop policy if exists org_rw on ops.job_photos;
create policy org_rw on ops.job_photos for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant all on ops.job_photos to authenticated, service_role;
