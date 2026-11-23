-- =============================================================================
-- 0067 — Vendor invoices learn from the team's answers (Victor, 11/23/26: "tudo que a Camila for respondendo de
-- como fazer, vai levando para o aprendizado para não ter que perguntar novamente; use sua inteligência para
-- resolver as dúvidas").
--   ops.invoice_address_map: an address/lot the team placed on a job (or "sem casa" → general job) — used first
--     the next time that address appears on an invoice.
--   ops.invoice_lessons: general rules the team gave ("Preferred: bulk upload, não definir cost code") — passed to
--     the readers of invoices and answers.
--   ops.bt_jobs: every Buildertrend job the daily round reads (name, street, parcel), so a lot without a house
--     number is found by its parcel even before the house is in ops.jobs.
-- =============================================================================
create table if not exists ops.invoice_address_map (
  id          uuid primary key default gen_random_uuid(),
  addr_key    text not null unique,      -- parcel digits, else "<number> <street word>", else the address in lower case
  address     text,
  job_number  text,
  bt_job_id   bigint,
  general     boolean not null default false,
  source      text,
  created_at  timestamptz not null default now()
);
create table if not exists ops.invoice_lessons (
  id          uuid primary key default gen_random_uuid(),
  vendor      text,                      -- null = every vendor
  lesson      text not null,
  source      text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create table if not exists ops.bt_jobs (
  bt_job_id   bigint primary key,
  name        text,
  job_number  text,
  street      text,
  city        text,
  parcel      text,
  status      text,
  updated_at  timestamptz not null default now()
);
alter table ops.invoice_address_map enable row level security;
alter table ops.invoice_lessons enable row level security;
alter table ops.bt_jobs enable row level security;

-- What was learned already (11/19–11/23/26).
insert into ops.invoice_lessons (vendor, lesson, source) values
  (null, 'Cost code: nunca definir; o Buildertrend sugere ao subir o PDF (bulk upload). Invoice dividida em várias obras: usar o cost code que o Buildertrend sugerir para a invoice em todas as obras, mesmo anexo, só o valor muda.', 'Camila 11/21/26, Victor 11/23/26'),
  (null, 'Conferir só a obra e o fornecedor (Pay to); não alterar o que o Buildertrend sugerir.', 'Camila 11/21/26'),
  (null, 'Número de invoice diferente é conta nova, mesmo com mesmo fornecedor e valor; duplicada = mesmo fornecedor e mesmo número.', 'Victor 11/20/26'),
  (null, 'Linha que a equipe disser "sem associar a casa" vai para o job geral.', 'Camila 11/19/26'),
  (null, 'Nunca alterar nem apagar bill existente no Buildertrend; só criar as que faltam.', 'Camila 11/20/26'),
  (null, 'Fornecedor que não está na obra: responder "Do Not Add to Job" (a bill vai para o fornecedor, a equipe da obra não muda).', 'conciliação 11/19/26');
insert into ops.invoice_address_map (addr_key, address, job_number, general, source) values
  ('6320 155', '6320 155th Pl, Ocala, FL 34473', null, true, 'Camila 11/19/26 (I2426)'),
  ('5150 165', '5150 SW 165th Pl, Ocala, FL 34473', '0078', false, 'Camila 11/19/26 (I2426)'),
  ('13304 80', '13304 SW 80th St, Dunnellon, FL 34432', '0070', false, 'Camila 11/19/26 (I2426)'),
  ('3493086009', 'SW 71st Ln (parcel 3493-086-009)', '0092', false, 'Victor 11/23/26 (Shady 3182)'),
  ('3495171110', 'SW 137th Ct (parcel 3495-171-110)', '0093', false, 'Victor 11/23/26 (Shady 3182)')
on conflict (addr_key) do nothing;
update ops.invoice_address_map set bt_job_id = 46644341 where addr_key = '3493086009';
update ops.invoice_address_map set bt_job_id = 46644389 where addr_key = '3495171110';
