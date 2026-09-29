-- Keep only when each job last got a site photo in Buildertrend (who, where),
-- not a row per photo: replaces ops.job_photos from 0019, which was never filled.
drop table if exists ops.job_photos;
alter table ops.jobs add column if not exists photos_last_at        timestamp;  -- Buildertrend local time (Eastern)
alter table ops.jobs add column if not exists photos_last_by        text;
alter table ops.jobs add column if not exists photos_last_folder    text;
alter table ops.jobs add column if not exists photos_last_daily_log timestamp;  -- the Daily Log the photo is attached to
alter table ops.jobs add column if not exists photos_count          integer;
alter table ops.jobs add column if not exists photos_checked_at     timestamptz;
