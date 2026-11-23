-- 0066 — A vendor-invoice line can point straight at a Buildertrend job (bt_job_id) when the house is in
-- Buildertrend but not yet in ops.jobs (new lots 0086–0097 found by parcel, Shady 3182 — Victor 11/23/26).
alter table ops.vendor_invoice_lines add column if not exists bt_job_id bigint;
