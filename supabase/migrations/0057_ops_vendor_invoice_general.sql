-- 0057 — Vendor invoice lines Camila says to bill "sem associar a casa" go to the company's general job in
-- Buildertrend (where she enters bills without a house). general = true marks them.
alter table ops.vendor_invoice_lines add column if not exists general boolean not null default false;
