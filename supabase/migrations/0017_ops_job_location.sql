-- Job location for the Ops map. Source: Buildertrend jobsite mapping (latitude/longitude),
-- falling back to the US Census geocoder for jobs not in Buildertrend.
alter table ops.jobs add column if not exists latitude  double precision;
alter table ops.jobs add column if not exists longitude double precision;
alter table ops.jobs add column if not exists location_source text;  -- 'buildertrend' | 'census'
