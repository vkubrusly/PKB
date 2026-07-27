-- =============================================================================
-- 0001_extensions_enums.sql
-- Extensions, shared enums, and the updated_at trigger helper.
-- =============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";      -- case-insensitive text (emails, codes)

-- ---------------------------------------------------------------------------
-- Enums (Parte 5 / ARCHITECTURE §4)
-- ---------------------------------------------------------------------------

-- Nível de especificação. 'any' = material aplicável a qualquer nível.
do $$ begin
  create type spec_level as enum ('essential', 'signature', 'luxury', 'any');
exception when duplicate_object then null; end $$;

-- Origem do preço. Ordem reflete a confiabilidade crescente na calibração:
-- invoice (pago) > quote (cotado) > web > catalog > estimated.
do $$ begin
  create type price_source as enum ('catalog', 'quote', 'web', 'invoice', 'estimated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type water_source as enum ('municipal', 'well');
exception when duplicate_object then null; end $$;

-- Séptico convencional vs. redução de nitrogênio (BMAP) vs. esgoto municipal.
do $$ begin
  create type sewer_type as enum ('municipal', 'septic', 'septic_nitrogen');
exception when duplicate_object then null; end $$;

do $$ begin
  create type contract_type as enum ('fixed_price', 'cost_plus');
exception when duplicate_object then null; end $$;

do $$ begin
  create type estimate_status as enum ('draft', 'approved', 'superseded');
exception when duplicate_object then null; end $$;

-- Unidades comuns na construção residencial FL. Extensível.
-- ea=each, sf=square foot, lf=linear foot, cy=cubic yard, ls=lump sum,
-- hr=hour, gal=gallon, sq=roofing square (100 sf), ton=HVAC ton,
-- bid=preço fechado por bid (lump), mo=mês (aluguéis: banheiro químico, etc.).
-- 'bid' e 'mo' vieram do orçamento real da Sunny (Estimate Affordable).
do $$ begin
  create type unit_type as enum
    ('ea', 'sf', 'lf', 'cy', 'ls', 'hr', 'gal', 'sq', 'ton', 'bid', 'mo');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- updated_at trigger helper — reused by every business table.
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
