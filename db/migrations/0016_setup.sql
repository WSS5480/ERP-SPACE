-- 0016_setup.sql
-- Out of the box for different businesses. A pack is a starting shape -- the
-- kind of business, which modules are on, the accounts its postings need,
-- the reasons and tenders its people pick from -- applied to one company.
-- Applying a pack only ever adds: it never removes an account, a module's
-- data or a setting someone changed afterwards.

create table entity_module (
  entity_id  uuid not null references entity(id),
  module     text not null check (module in
               ('catalog','purchasing','inventory','pos','ar','workforce','fleet','shop')),
  enabled    boolean not null default true,
  changed_at timestamptz not null default now(),
  changed_by text,
  primary key (entity_id, module)
);

-- Free-form per-company settings modules read by key: 'pos.discount_limit_bps',
-- 'fleet.service_minutes', 'ar.late_fee', 'branding'. A pack writes defaults;
-- a person's later change wins.
create table entity_setting (
  entity_id  uuid not null references entity(id),
  key        text not null check (key ~ '^[a-z_]+(\.[a-z_]+)*$'),
  value      jsonb not null,
  set_by     text,
  set_at     timestamptz not null default now(),
  from_pack  boolean not null default false,
  primary key (entity_id, key)
);

-- Pick lists every module shares.
create table reason_code (
  entity_id uuid not null references entity(id),
  kind      text not null check (kind in ('return','adjustment','damage','discount','write_off','delivery_exception','void')),
  code      text not null,
  label     text not null,
  restock   boolean,                  -- for returns: goes back to sellable stock
  active    boolean not null default true,
  primary key (entity_id, kind, code)
);

create table pack_application (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  pack       text not null,
  applied_at timestamptz not null default now(),
  applied_by text not null,
  summary    jsonb not null default '{}'::jsonb
);

-- Opening balances brought over from the old system, one row per customer.
-- The A/R module treats each as an invoice dated as_of with no lines.
create table opening_receivable (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  customer_id uuid not null references customer(id),
  reference   text not null,
  as_of       date not null,
  due_on      date,
  amount_minor bigint not null check (amount_minor <> 0),
  journal_entry_id uuid references journal_entry(id),
  imported_at timestamptz not null default now(),
  unique (entity_id, reference)
);

create table import_run (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  kind        text not null check (kind in ('customers','open_ar','locations')),
  filename    text,
  rows_seen   integer not null default 0,
  rows_added  integer not null default 0,
  rows_updated integer not null default 0,
  rows_refused integer not null default 0,
  problems    jsonb not null default '[]'::jsonb,
  run_by      text not null,
  run_at      timestamptz not null default now()
);
