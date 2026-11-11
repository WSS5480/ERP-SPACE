-- 0052_onboarding.sql
-- First-run setup: the per-company setup checklist, opening stock and the
-- opening bank balance, and "rates were not checked" on sales tax.
--
--   1. The checklist's status is computed from real data every time it is
--      read; nothing here stores a tick. The only things kept are a skip
--      (with the reason a person gave) and a dismissal of the Home card.
--      Neither is ever deleted: taking one back stamps withdrawn_at.
--   2. A company's own address and state (the checklist's "company details").
--   3. Every sales tax rate starts unchecked, whoever or whatever entered it
--      (seed, migration stand-in, a person). A person confirms them on the
--      Sales tax screen, which stamps checked_by / checked_at.
--   4. Opening stock comes in from a CSV, previewed first, as of a day the
--      person picks; each applied row is an inventory 'opening_balance'
--      adjustment (Dr 1300 / Cr 3000) posted on that day.
--   5. A bank account's opening balance posts Dr its cash account / Cr 3000,
--      once per account.

-- ------------------------------------------------------ company details --
alter table entity add column if not exists address jsonb not null default '{}'::jsonb;
alter table entity add column if not exists state char(2);
do $$ begin
  alter table entity add constraint entity_state_two_letters check (state is null or state ~ '^[A-Z]{2}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table entity add constraint entity_address_object check (jsonb_typeof(address) = 'object');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------- tax rate checking --
alter table tax_rate add column if not exists checked_by text;
alter table tax_rate add column if not exists checked_at timestamptz;
do $$ begin
  alter table tax_rate add constraint tax_rate_checked_pair check ((checked_by is null) = (checked_at is null));
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------- skips, dismissal --
create table onboarding_skip (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  step          text not null check (step ~ '^[a-z_]{2,40}$'),
  reason        text not null check (length(btrim(reason)) >= 5 and length(reason) <= 500),
  skipped_by    text not null,
  skipped_by_id uuid references app_user(id),
  skipped_at    timestamptz not null default now(),
  withdrawn_by  text,
  withdrawn_at  timestamptz,
  check ((withdrawn_by is null) = (withdrawn_at is null))
);
create unique index onboarding_skip_one_live on onboarding_skip (entity_id, step) where withdrawn_at is null;

create table onboarding_dismissal (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  dismissed_by    text not null,
  dismissed_by_id uuid references app_user(id),
  dismissed_at    timestamptz not null default now(),
  withdrawn_by    text,
  withdrawn_at    timestamptz,
  check ((withdrawn_by is null) = (withdrawn_at is null))
);
create unique index onboarding_dismissal_one_live on onboarding_dismissal (entity_id) where withdrawn_at is null;

-- A company already trading when this migration runs does not get the checklist on Home
-- (it is still under Setup, and anyone can bring it back to Home from there).
insert into onboarding_dismissal (entity_id, dismissed_by)
select e.id, 'migration 0052 (already trading)' from entity e
 where exists (select 1 from journal_entry je where je.entity_id = e.id);

-- -------------------------------------------------------- opening stock --
create table opening_stock_run (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  filename    text,
  as_of       date not null,
  status      text not null default 'previewed' check (status in ('previewed', 'applied')),
  rows_seen   integer not null default 0,
  rows_ok     integer not null default 0,
  rows_refused integer not null default 0,
  units       numeric not null default 0,
  value_minor bigint not null default 0,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  applied_by  text,
  applied_at  timestamptz,
  check ((status = 'applied') = (applied_at is not null))
);
create index opening_stock_run_entity on opening_stock_run (entity_id, created_at desc);

create table opening_stock_row (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references opening_stock_run(id),
  entity_id       uuid not null references entity(id),
  row_no          integer not null,
  sku             text,
  location_code   text,
  bin_code        text,
  qty             numeric,
  unit_cost_minor bigint check (unit_cost_minor is null or unit_cost_minor >= 0),
  serials         text[] not null default '{}',
  lot             text,
  product_id      uuid references product(id),
  location_id     uuid references location(id),
  bin_id          uuid references inv_bin(id),
  action          text not null check (action in ('add', 'refuse')),
  message         text,
  -- the SKU already had stock or movements at this location when previewed: bringing it in adds to that, and needs a confirm
  adds_to_existing boolean not null default false,
  adjustment_id   uuid references inv_adjustment(id),
  unique (run_id, row_no)
);
create index opening_stock_row_run on opening_stock_row (entity_id, run_id);
-- a SKU at a location comes in from an opening import once
create unique index opening_stock_row_once on opening_stock_row (entity_id, product_id, location_id) where adjustment_id is not null;

-- ------------------------------------------------- opening bank balance --
create table opening_bank_balance (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  bank_account_id  uuid not null references bank_account(id),
  as_of            date not null,
  amount_minor     bigint not null check (amount_minor <> 0),
  journal_entry_id uuid not null references journal_entry(id),
  entered_by       text not null,
  entered_at       timestamptz not null default now(),
  unique (bank_account_id)
);
create index opening_bank_balance_entity on opening_bank_balance (entity_id);
