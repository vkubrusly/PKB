-- =============================================================================
-- Kubrusly Basso — listing monitoring. Standalone database (its own Supabase
-- project; nothing shared with PKB). Everything lives in schema `kb`.
--
--   listings            one row per house we list (MLS number, seller, price, status)
--   listing_history     every price/status change (manual, MLS import)
--   inbound_emails      showing-related messages read from the listing mailboxes
--   showings            showing requests (ShowingTime, BrokerBay, …) + the feedback we chased
--   outbound_messages   every e-mail the system sent or drafted (feedback requests, reports)
--   market_comps        MLS export of the areas where we have listings (active, pending, sold)
--   listing_reports     the weekly report per listing (draft → sent), e-mail + WhatsApp text
--   suggestions         product suggestions from the market (floor plan, size, price band)
--
-- Access is server-side only (service role / Management API); RLS on with no
-- policies keeps the tables closed to the anon key. Idempotent.
-- =============================================================================
create extension if not exists pgcrypto;
create schema if not exists kb;

create table if not exists kb.listings (
  id                  uuid primary key default gen_random_uuid(),
  mls_number          text unique,
  address             text not null,
  city                text,
  county              text,
  zip                 text,
  subdivision         text,
  property_type       text,
  beds                numeric,
  baths               numeric,
  sqft                numeric,                                -- heated area
  lot_sf              numeric,
  year_built          integer,
  list_price          numeric,
  original_list_price numeric,
  status              text not null default 'active'
                      check (status in ('coming_soon', 'active', 'pending', 'sold', 'withdrawn', 'expired')),
  listed_at           date,
  pending_at          date,
  sold_at             date,
  sold_price          numeric,
  seller_name         text,
  seller_emails       text[] not null default '{}',
  seller_whatsapp     text,
  report_channels     text[] not null default '{email}',      -- email | whatsapp
  report_lang         text not null default 'pt' check (report_lang in ('pt', 'en')),
  market_filter       jsonb not null default '{}',            -- {"zips":[], "cities":[], "subdivisions":[]}; default = own zip
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists idx_kb_listings_addr on kb.listings(lower(address));

create table if not exists kb.listing_history (
  id          bigint generated always as identity primary key,
  listing_id  uuid not null references kb.listings(id) on delete cascade,
  status      text not null,
  list_price  numeric,
  changed_at  timestamptz not null default now(),
  source      text not null default 'manual',                 -- manual | mls_import
  note        text
);
create index if not exists idx_kb_listing_history on kb.listing_history(listing_id, changed_at desc);

create table if not exists kb.inbound_emails (
  id           uuid primary key default gen_random_uuid(),
  mailbox      text not null,
  message_id   text not null unique,
  received_at  timestamptz,
  from_addr    text,
  from_name    text,
  to_addrs     text[] not null default '{}',
  cc_addrs     text[] not null default '{}',
  subject      text,
  body_text    text,
  category     text,                                          -- showing_requested | showing_confirmed | … | showing_feedback_reply
  parsed       jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

create table if not exists kb.showings (
  id                    uuid primary key default gen_random_uuid(),
  ref                   text generated always as ('S-' || upper(substr(replace(id::text, '-', ''), 1, 6))) stored,
  listing_id            uuid not null references kb.listings(id) on delete cascade,
  source                text not null,                        -- showingtime | brokerbay | aligned | showingassist | email | manual
  external_id           text not null,                        -- platform appointment id, or a hash
  status                text not null default 'requested'
                        check (status in ('requested', 'confirmed', 'declined', 'cancelled', 'rescheduled', 'completed')),
  requested_at          timestamptz,
  starts_at             timestamptz,
  ends_at               timestamptz,
  agent_name            text,
  agent_email           text,
  agent_phone           text,
  agent_brokerage       text,
  mailbox               text,
  inbound_email_id      uuid references kb.inbound_emails(id) on delete set null,
  feedback_requested_at timestamptz,
  feedback_followups    integer not null default 0,
  feedback_received_at  timestamptz,
  feedback_source       text,                                 -- platform | reply
  feedback_text         text,
  feedback_interest     text check (feedback_interest in ('high', 'medium', 'low', 'none')),
  feedback_price_view   text check (feedback_price_view in ('below', 'fair', 'high')),
  offer_expected        boolean,
  feedback_summary      text,
  parsed                jsonb not null default '{}',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (source, external_id)
);
create unique index if not exists idx_kb_showings_ref on kb.showings(ref);
create index if not exists idx_kb_showings_listing on kb.showings(listing_id, starts_at desc);

create table if not exists kb.outbound_messages (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,                                 -- feedback_request | feedback_followup | weekly_report | internal
  listing_id   uuid references kb.listings(id) on delete set null,
  showing_id   uuid references kb.showings(id) on delete set null,
  channel      text not null default 'email' check (channel in ('email', 'whatsapp')),
  to_addrs     text[] not null default '{}',
  subject      text,
  body         text,
  status       text not null default 'draft' check (status in ('draft', 'sent', 'failed')),
  error        text,
  external_id  text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists kb.market_comps (
  id            uuid primary key default gen_random_uuid(),
  mls_number    text not null unique,
  status        text not null,                                -- active | pending | sold | withdrawn | expired | coming_soon
  address       text,
  city          text,
  county        text,
  zip           text,
  subdivision   text,
  property_type text,
  beds          numeric,
  baths         numeric,
  sqft          numeric,
  lot_sf        numeric,
  year_built    integer,
  garage        numeric,
  pool          boolean,
  list_price    numeric,
  original_list_price numeric,
  sold_price    numeric,
  listed_at     date,
  pending_at    date,
  sold_at       date,
  dom           integer,
  source        text not null default 'mls_csv',
  raw           jsonb not null default '{}',
  imported_at   timestamptz not null default now()
);
create index if not exists idx_kb_comps_zip on kb.market_comps(zip, status);
create index if not exists idx_kb_comps_dates on kb.market_comps(pending_at, sold_at);

create table if not exists kb.listing_reports (
  id             uuid primary key default gen_random_uuid(),
  listing_id     uuid not null references kb.listings(id) on delete cascade,
  week_start     date not null,
  week_end       date not null,                              -- exclusive
  metrics        jsonb not null default '{}',
  subject        text,
  html           text,
  whatsapp_text  text,
  status         text not null default 'draft' check (status in ('draft', 'sent', 'failed')),
  sent_to        text[] not null default '{}',
  sent_at        timestamptz,
  created_at     timestamptz not null default now(),
  unique (listing_id, week_start)
);

create table if not exists kb.suggestions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,                          -- stable: area + kind, so a rerun updates instead of duplicating
  area        text not null,                                 -- the market (zip / city / subdivision)
  kind        text not null,                                 -- floor_plan | size | price_band | new_construction | feature
  title       text not null,
  detail      text,
  evidence    jsonb not null default '{}',
  status      text not null default 'new' check (status in ('new', 'accepted', 'dismissed', 'done')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['listings', 'listing_history', 'inbound_emails', 'showings', 'outbound_messages',
                           'market_comps', 'listing_reports', 'suggestions'] loop
    execute format('alter table kb.%I enable row level security;', t);
  end loop;
end $$;
grant usage on schema kb to service_role;
grant all on all tables in schema kb to service_role;
