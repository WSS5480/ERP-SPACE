-- 0017_catalog.sql
-- The catalog module: everything a buyer and a sales floor need to know about
-- a product beyond the one row in `product` (0015). Option templates per
-- vendor or category, packages, cartons, price lists, scheduled promotions,
-- images, vendor ordering facts and freight, and the vendor feed import.
--
-- Rules set here:
--   1. a product's lifecycle is its status: draft, active, floor_sample (sell
--      as-is, do not reorder), drop (vendor dropped it: sell through, never
--      reorder) and discontinued (cannot be sold)
--   2. one product per vendor model number, so a vendor feed updates the row
--      it created rather than adding a second one
--   3. a promotion never takes an advertised price below the product's MAP
--      unless it says so; pricing.ts applies that, the column records it
--   4. an import is previewed before it changes anything, and the run keeps
--      what each row did: added, changed, unchanged or skipped

-- ------------------------------------------------------ product master --

alter table product drop constraint product_status_check;
alter table product add constraint product_status_check
  check (status in ('draft','active','floor_sample','drop','discontinued'));

alter table product drop constraint product_kind_check;
alter table product add constraint product_kind_check
  check (kind in ('stock','configurable','special_order','kit','service','fee','warranty','gift_card'));

alter table product add column map_minor  bigint check (map_minor >= 0);    -- minimum advertised price
alter table product add column msrp_minor bigint check (msrp_minor >= 0);
alter table product add column barcode    text;                              -- UPC/EAN from the vendor; sku when null
alter table product add column status_note text;                             -- why it is floor sample / dropped

create unique index product_vendor_model on product (entity_id, vendor_id, vendor_sku)
  where vendor_id is not null and vendor_sku is not null;
create unique index product_barcode on product (entity_id, barcode) where barcode is not null;

create table product_image (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  product_id uuid not null references product(id),
  seq        smallint not null default 1 check (seq > 0),
  url        text not null check (url ~* '^https?://'),
  alt        text,
  unique (product_id, seq)
);

-- Several boxes for one SKU: a sectional ships in three cartons, a bed in two.
-- The warehouse tracks and scans pieces; trucks load by cube and weight.
create table product_piece (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  product_id uuid not null references product(id),
  seq        smallint not null check (seq > 0),
  label      text not null,                    -- 'Headboard', 'Box 2 of 3'
  cubic_ft   numeric(8,2) check (cubic_ft >= 0),
  weight_lb  numeric(8,2) check (weight_lb >= 0),
  unique (product_id, seq)
);

-- A package (5-piece dining set) is itself a product of kind 'kit' whose
-- price is the package price; these rows say what is in it.
create table product_kit_component (
  entity_id    uuid not null references entity(id),
  kit_id       uuid not null references product(id),
  component_id uuid not null references product(id),
  qty          numeric(8,2) not null check (qty > 0),
  seq          smallint not null default 1,
  primary key (kit_id, component_id),
  check (kit_id <> component_id)
);

-- ------------------------------------------- special-order templates --
-- A vendor's fabric grades and finishes, or a category's standard choices,
-- kept once and applied to every product that offers them.

create table option_template (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  name       text not null,
  vendor_id  uuid references vendor(id),
  category   text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (entity_id, name)
);

create table option_template_group (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  template_id uuid not null references option_template(id),
  code        text not null check (code ~ '^[a-z0-9][a-z0-9_-]*$'),
  label       text not null,
  required    boolean not null default true,
  multi       boolean not null default false,
  seq         smallint not null default 0,
  unique (template_id, code)
);

create table option_template_option (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entity(id),
  group_id          uuid not null references option_template_group(id),
  code              text not null check (code ~ '^[a-z0-9][a-z0-9_-]*$'),
  label             text not null,
  price_delta_minor bigint not null default 0,
  cost_delta_minor  bigint not null default 0,
  lead_days         smallint not null default 0 check (lead_days >= 0),
  swatch            text,
  vendor_code       text,
  active            boolean not null default true,
  seq               smallint not null default 0,
  unique (group_id, code)
);

create table product_template_applied (
  entity_id   uuid not null references entity(id),
  product_id  uuid not null references product(id),
  template_id uuid not null references option_template(id),
  applied_at  timestamptz not null default now(),
  applied_by  uuid references app_user(id),
  primary key (product_id, template_id)
);

-- ------------------------------------------------ price lists, promotions --

-- A named list of prices that replace the ticket price when asked for:
-- contract pricing for a business customer, an outlet's prices, employee.
create table price_list (
  id        uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entity(id),
  code      text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]*$'),
  name      text not null,
  starts_on date,
  ends_on   date,
  active    boolean not null default true,
  unique (entity_id, code),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create table price_list_item (
  entity_id     uuid not null references entity(id),
  price_list_id uuid not null references price_list(id),
  product_id    uuid not null references product(id),
  price_minor   bigint not null check (price_minor >= 0),
  primary key (price_list_id, product_id)
);

-- A sale with dates. Reaches one product, a vendor, a category, or (all
-- three null) everything. The lowest promoted price wins; they never stack.
create table promotion (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  name        text not null,
  kind        text not null check (kind in ('percent','amount_off','fixed_price')),
  pct_bps     integer check (pct_bps between 1 and 9000),          -- 1500 = 15% off
  amount_minor bigint check (amount_minor >= 0),                    -- amount off, or the fixed price
  product_id  uuid references product(id),
  vendor_id   uuid references vendor(id),
  category    text,
  starts_on   date not null,
  ends_on     date not null,
  respect_map boolean not null default true,
  active      boolean not null default true,
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  check (ends_on >= starts_on),
  check ((kind = 'percent') = (pct_bps is not null)),
  check ((kind <> 'percent') = (amount_minor is not null))
);
create index promotion_entity_dates on promotion (entity_id, starts_on, ends_on) where active;

-- ------------------------------------------------- vendor ordering facts --
-- What CATALOG-APP kept as vendor info: where orders go, the freight
-- minimum that gets a prepaid truck, lead time, and our SKU prefix for them.

create table vendor_profile (
  entity_id        uuid not null references entity(id),
  vendor_id        uuid not null references vendor(id),
  order_email      text check (order_email is null or order_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  account_no       text,                     -- our account number with them
  sku_prefix       text check (sku_prefix ~ '^[A-Z0-9]{1,8}$'),
  lead_days        smallint not null default 30 check (lead_days between 0 and 365),
  freight_min_minor bigint not null default 0 check (freight_min_minor >= 0),
  freight_min_qty  integer not null default 0 check (freight_min_qty >= 0),
  notes            text,
  primary key (entity_id, vendor_id)
);

-- Freight to each store, as a percent of cost and/or a flat amount per unit.
-- Landed cost in the margin view is cost plus this.
create table vendor_freight (
  entity_id      uuid not null references entity(id),
  vendor_id      uuid not null references vendor(id),
  location_id    uuid not null references location(id),
  freight_bps    integer not null default 0 check (freight_bps between 0 and 10000),
  per_unit_minor bigint not null default 0 check (per_unit_minor >= 0),
  primary key (entity_id, vendor_id, location_id)
);

-- ------------------------------------------------------ vendor feed import --

create table catalog_import_run (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  vendor_id   uuid not null references vendor(id),
  filename    text,
  mapping     jsonb not null,               -- field -> column heading
  status      text not null default 'previewed' check (status in ('previewed','applied','abandoned')),
  rows        integer not null default 0,
  added       integer not null default 0,
  changed     integer not null default 0,
  unchanged   integer not null default 0,
  skipped     integer not null default 0,
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  applied_by  uuid references app_user(id),
  applied_at  timestamptz,
  check ((status = 'applied') = (applied_at is not null))
);
create index catalog_import_run_entity on catalog_import_run (entity_id, created_at desc);

create table catalog_import_row (
  entity_id  uuid not null references entity(id),
  run_id     uuid not null references catalog_import_run(id),
  row_no     integer not null,
  vendor_sku text,
  action     text not null check (action in ('add','change','same','skip')),
  product_id uuid references product(id),
  fields     jsonb not null default '{}'::jsonb,   -- the normalised values from the file
  changes    jsonb not null default '{}'::jsonb,   -- field -> [before, after]
  message    text,                                 -- why a row was skipped
  primary key (run_id, row_no)
);

-- ------------------------------------------------- vendor connections --
-- How a vendor's catalog, availability and freight reach us: a person
-- uploading (manual), a pull from their API or SFTP, or an email. Like the
-- finance connections in 0012, no secret is stored: credential_ref names an
-- environment variable (ERP_SECRET_<REF>) and config is refused if a key
-- looks like a password or token.

create table vendor_connection (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  vendor_id      uuid not null references vendor(id),
  kind           text not null check (kind in ('manual','api','sftp','email')),
  adapter        text not null default 'generic' check (adapter in ('generic','ashley')),
  name           text not null,
  config         jsonb not null default '{}'::jsonb,   -- urls, params, page size, ATP customer/ship-to, store ship-to numbers
  credential_ref text,                                 -- 'secret://vendor/ashley' -> ERP_SECRET_VENDOR_ASHLEY
  schedule_cron  text,
  mapping        jsonb not null default '{}'::jsonb,   -- import field -> pulled column, as in the CSV import
  active         boolean not null default true,
  last_run_at    timestamptz,
  last_ok        boolean,
  last_note      text,
  consecutive_failures integer not null default 0,
  created_at     timestamptz not null default now(),
  unique (entity_id, vendor_id, kind),
  check (kind not in ('sftp') or credential_ref is not null),
  check (kind in ('api','sftp') or schedule_cron is null),
  check (credential_ref is null or credential_ref ~ '^secret://[a-z0-9/_-]+$')
);
create trigger vendor_connection_no_secrets before insert or update on vendor_connection
  for each row execute function connection_no_secrets();

create table vendor_feed_run (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  connection_id uuid not null references vendor_connection(id),
  trigger       text not null default 'manual' check (trigger in ('manual','schedule')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  outcome       text check (outcome in ('ok','failed')),
  rows          integer not null default 0,
  import_run_id uuid references catalog_import_run(id),
  atp_rows      integer not null default 0,
  freight_rows  integer not null default 0,
  note          text,                                  -- what happened, in plain words
  run_by        uuid references app_user(id)
);
create index vendor_feed_run_conn on vendor_feed_run (connection_id, started_at desc);

-- What the vendor says it can ship now, per model: Ashley's ATP inquiry.
create table vendor_availability (
  entity_id     uuid not null references entity(id),
  vendor_id     uuid not null references vendor(id),
  vendor_sku    text not null,
  product_id    uuid references product(id),
  qty_available numeric(12,2),
  lead_days     integer check (lead_days >= 0),
  exception     text,
  as_of         timestamptz not null default now(),
  primary key (entity_id, vendor_id, vendor_sku)
);

-- Freight the vendor quotes per model to each of our ship-to places.
create table vendor_sku_freight (
  entity_id      uuid not null references entity(id),
  vendor_id      uuid not null references vendor(id),
  vendor_sku     text not null,
  location_id    uuid not null references location(id),
  freight_minor  bigint not null check (freight_minor >= 0),
  net_minor      bigint,                               -- vendor's net price before freight
  as_of          timestamptz not null default now(),
  primary key (entity_id, vendor_id, vendor_sku, location_id)
);

-- Product photos fetched once from the vendor's address and served from our
-- own origin (the page's security policy allows no outside images).
create table catalog_image_cache (
  entity_id    uuid not null references entity(id),
  url          text not null,
  content_type text not null check (content_type ~ '^image/'),
  bytes        bytea not null check (octet_length(bytes) <= 5242880),
  fetched_at   timestamptz not null default now(),
  primary key (entity_id, url)
);
