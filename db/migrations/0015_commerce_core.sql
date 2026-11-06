-- 0015_commerce_core.sql
-- The shared spine of the retail side: who buys, what is sold, and the one
-- order that every channel writes. POS, the web store, phone orders, A/R,
-- the warehouse and the delivery fleet all read and write these same rows,
-- which is what "omnichannel" actually means -- one order, many doors.
--
-- Decision (Nov 6 2026): POS is now in scope. The Sep 2026 plan kept the
-- existing POS and read it by report; the product is now an out-of-the-box
-- retail furniture ERP for many businesses, so it carries its own POS. The
-- POS feed in 0011 stays, for tenants who keep an outside POS.
--
-- Rules this file sets for every module after it:
--   1. money is bigint minor units, never numeric dollars
--   2. every row carries entity_id; nothing reads across companies
--   3. an order line keeps its own copy of description and price -- a catalog
--      change never rewrites what a customer already bought
--   4. order numbers come from doc_sequence, per entity and kind, no gaps
--      created by rollbacks (row lock, not a Postgres sequence)

-- ------------------------------------------------- verticals and roles --

alter table tenant drop constraint tenant_vertical_check;
alter table tenant add constraint tenant_vertical_check
  check (vertical in ('rto','retail','furniture','trucking','services'));

alter table role_grant drop constraint role_grant_role_check;
alter table role_grant add constraint role_grant_role_check
  check (role in ('owner','controller','ap_clerk','approver','viewer',
                  'store_manager','sales','cashier','buyer','warehouse',
                  'dispatcher','driver','ar_clerk','hr','web_admin'));

-- What kind of place a location is. A furniture retailer has showrooms, a
-- distribution center and sometimes a clearance outlet; a trucker has yards.
alter table location add column kind text not null default 'store'
  check (kind in ('store','warehouse','outlet','yard','office','web'));
alter table location add column address jsonb not null default '{}'::jsonb;
alter table location add column geo point;           -- (lng, lat) for routing
alter table location add column tax_rate_bps integer not null default 0
  check (tax_rate_bps between 0 and 2000);           -- 825 = 8.25%

-- ---------------------------------------------------------- numbering --

create table doc_sequence (
  entity_id uuid not null references entity(id),
  kind      text not null,          -- 'order', 'ticket', 'invoice', 'route', ...
  prefix    text not null default '',
  next_no   bigint not null default 1 check (next_no > 0),
  primary key (entity_id, kind)
);

-- Gapless per entity and kind: the row lock serialises takers, and a
-- rolled-back transaction gives its number back.
create or replace function next_doc_no(p_entity uuid, p_kind text, p_prefix text default '')
returns text language plpgsql as $$
declare n bigint; pre text;
begin
  insert into doc_sequence (entity_id, kind, prefix) values (p_entity, p_kind, p_prefix)
    on conflict (entity_id, kind) do nothing;
  update doc_sequence set next_no = next_no + 1
   where entity_id = p_entity and kind = p_kind
   returning next_no - 1, prefix into n, pre;
  return pre || lpad(n::text, 6, '0');
end $$;

-- ----------------------------------------------------------- customers --

create table customer (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  number        text not null,
  kind          text not null default 'person' check (kind in ('person','business')),
  name          text not null,
  email         text,
  phone         text,
  tax_exempt_ref text,               -- certificate number; exemption needs one
  credit_limit_minor bigint not null default 0 check (credit_limit_minor >= 0),
  terms_days    smallint not null default 0 check (terms_days >= 0),
  home_location_id uuid references location(id),
  marketing_ok  boolean not null default false,
  status        text not null default 'active' check (status in ('active','hold','inactive')),
  created_at    timestamptz not null default now(),
  unique (entity_id, number)
);
create index customer_entity_name on customer (entity_id, lower(name));
create index customer_entity_phone on customer (entity_id, phone);
create unique index customer_entity_email on customer (entity_id, lower(email)) where email is not null;

create table customer_address (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  customer_id uuid not null references customer(id),
  label       text not null default 'Home',
  line1       text not null,
  line2       text,
  city        text not null,
  state       char(2) not null,
  postal      text not null,
  geo         point,                 -- (lng, lat), filled by geocoding
  stairs      smallint not null default 0 check (stairs >= 0),
  notes       text,                  -- gate code, narrow hallway, call first
  is_default  boolean not null default false
);
create index customer_address_customer on customer_address (customer_id);
create unique index customer_address_one_default on customer_address (customer_id) where is_default;

-- ------------------------------------------------------------ products --
-- One row per sellable SKU. The catalog module adds vendor feeds, option
-- groups, images and price rules on top; POS, web and A/R only need this.

create table product (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  sku            text not null,
  name           text not null,
  kind           text not null default 'stock'
                   check (kind in ('stock','configurable','special_order','service','fee','warranty','gift_card')),
  vendor_id      uuid references vendor(id),
  vendor_sku     text,
  brand          text,
  category       text,
  subcategory    text,
  collection     text,
  color          text,
  description    text,
  price_minor    bigint not null default 0 check (price_minor >= 0),
  cost_minor     bigint not null default 0 check (cost_minor >= 0),
  taxable        boolean not null default true,
  serialized     boolean not null default false,  -- tracked piece by piece
  ship_class     text not null default 'delivery'
                   check (ship_class in ('carry','parcel','delivery','none')),
  cubic_ft       numeric(8,2) check (cubic_ft >= 0),   -- truck loading
  weight_lb      numeric(8,2) check (weight_lb >= 0),
  web_visible    boolean not null default false,
  status         text not null default 'active' check (status in ('draft','active','discontinued')),
  attributes     jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (entity_id, sku)
);
create index product_entity_cat on product (entity_id, category, subcategory);
create index product_entity_vendor on product (entity_id, vendor_id);
create index product_search on product using gin (to_tsvector('simple',
  coalesce(name,'') || ' ' || coalesce(sku,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(collection,'')));

-- ----------------------------------------------------------- sales orders --
-- The one order every channel writes.

create table sales_order (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  number         text not null,
  channel        text not null check (channel in ('pos','web','phone','marketplace','b2b')),
  location_id    uuid not null references location(id),   -- the store credited with the sale
  customer_id    uuid references customer(id),            -- null only for cash-and-carry
  salesperson_id uuid references app_user(id),
  status         text not null default 'draft'
                   check (status in ('draft','open','fulfilling','fulfilled','closed','cancelled')),
  fulfillment    text not null default 'carry'
                   check (fulfillment in ('carry','pickup','delivery','ship')),
  ship_address_id uuid references customer_address(id),
  promised_on    date,
  subtotal_minor bigint not null default 0,
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor      bigint not null default 0 check (tax_minor >= 0),
  fees_minor     bigint not null default 0 check (fees_minor >= 0),   -- delivery, setup, haul-away
  total_minor    bigint not null default 0,
  paid_minor     bigint not null default 0,
  notes          text,
  external_ref   text,              -- web cart id, marketplace order id
  ordered_at     timestamptz not null default now(),
  created_by     uuid references app_user(id),
  unique (entity_id, number)
);
create index sales_order_entity_status on sales_order (entity_id, status, ordered_at desc);
create index sales_order_customer on sales_order (customer_id);
create unique index sales_order_external on sales_order (entity_id, channel, external_ref) where external_ref is not null;

-- Delivery needs an address; cash-and-carry needs nothing; anything owed
-- later needs a customer to owe it.
alter table sales_order add constraint sales_order_delivery_address
  check (fulfillment not in ('delivery','ship') or ship_address_id is not null or status in ('draft','cancelled'));

create table sales_order_line (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  sales_order_id  uuid not null references sales_order(id) on delete cascade,
  seq             smallint not null,
  product_id      uuid references product(id),
  sku             text not null,          -- copied at sale time
  description     text not null,          -- copied at sale time
  qty             numeric(10,2) not null check (qty <> 0),   -- negative = return
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  discount_minor  bigint not null default 0 check (discount_minor >= 0),
  tax_minor       bigint not null default 0 check (tax_minor >= 0),
  config          jsonb not null default '{}'::jsonb,   -- chosen options: fabric, finish, legs...
  fulfil_from_id  uuid references location(id),         -- warehouse or store that supplies it
  line_status     text not null default 'open'
                    check (line_status in ('open','reserved','on_order','ready','fulfilled','returned','cancelled')),
  unique (sales_order_id, seq)
);
create index sales_order_line_order on sales_order_line (sales_order_id);
create index sales_order_line_product on sales_order_line (entity_id, product_id, line_status);

-- ------------------------------------------------------- money received --
-- Every dollar a customer hands over, whichever door it came through. A/R
-- applies these to invoices and orders; POS writes them at the register;
-- the web store writes them on capture.

create table customer_receipt (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  number         text not null,
  customer_id    uuid references customer(id),
  sales_order_id uuid references sales_order(id),
  location_id    uuid not null references location(id),
  channel        text not null check (channel in ('pos','web','phone','mail','ach','lockbox')),
  method         text not null check (method in ('cash','card','check','ach','financing','gift_card','store_credit','other')),
  amount_minor   bigint not null check (amount_minor <> 0),   -- negative = refund
  reference      text,              -- last 4, check number, processor id; never a full card
  register_session_id uuid,         -- set by POS; FK added in the POS migration
  received_at    timestamptz not null default now(),
  received_by    uuid references app_user(id),
  voided_at      timestamptz,
  void_reason    text,
  unique (entity_id, number),
  check (reference is null or reference !~ '[0-9]{12,}')   -- no card numbers, ever
);
create index customer_receipt_order on customer_receipt (sales_order_id);
create index customer_receipt_customer on customer_receipt (entity_id, customer_id, received_at desc);

-- A voided receipt carries its reason; nothing is deleted.
create or replace function customer_receipt_rules() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'customer_receipt rows are never deleted; void it with a reason';
  end if;
  if new.amount_minor <> old.amount_minor or new.method <> old.method
     or new.sales_order_id is distinct from old.sales_order_id then
    raise exception 'a receipt''s amount, method and order cannot change; void and re-take it';
  end if;
  if new.voided_at is not null and coalesce(trim(new.void_reason),'') = '' then
    raise exception 'voiding a receipt needs a reason';
  end if;
  return new;
end $$;
create trigger customer_receipt_rules before update or delete on customer_receipt
  for each row execute function customer_receipt_rules();

-- Keep an order's paid total honest: it is the sum of its live receipts.
create or replace function sales_order_paid_sync() returns trigger
language plpgsql as $$
declare oid uuid;
begin
  oid := coalesce(new.sales_order_id, old.sales_order_id);
  if oid is not null then
    update sales_order so set paid_minor = coalesce((
      select sum(amount_minor) from customer_receipt r
       where r.sales_order_id = oid and r.voided_at is null), 0)
     where so.id = oid;
  end if;
  return null;
end $$;
create trigger sales_order_paid_sync after insert or update on customer_receipt
  for each row execute function sales_order_paid_sync();

-- Recompute an order's totals from its lines. Modules call this after they
-- change lines, so nobody hand-adds a total.
create or replace function sales_order_retotal(p_order uuid) returns void
language plpgsql as $$
begin
  update sales_order so set
    subtotal_minor = t.sub, discount_minor = t.disc, tax_minor = t.tax,
    total_minor = t.sub - t.disc + t.tax + so.fees_minor
  from (
    select coalesce(sum(round(qty * unit_price_minor)::bigint),0) sub,
           coalesce(sum(discount_minor),0) disc, coalesce(sum(tax_minor),0) tax
      from sales_order_line where sales_order_id = p_order and line_status <> 'cancelled'
  ) t
  where so.id = p_order;
end $$;

-- What a customer owes on their open orders, before any invoice exists.
create view sales_order_balance as
  select so.entity_id, so.id sales_order_id, so.number, so.customer_id, so.location_id,
         so.status, so.total_minor, so.paid_minor, so.total_minor - so.paid_minor balance_minor
    from sales_order so
   where so.status not in ('draft','cancelled');

-- ------------------------------------------------- customizable products --
-- A configurable sofa: groups (Fabric, Leg finish, Size) each with options
-- that may change price and lead time. The catalog module maintains these;
-- POS and the web customizer both read them, and an order line stores the
-- choices in config so the price a customer saw is the price they keep.

create table product_option_group (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  product_id  uuid not null references product(id) on delete cascade,
  code        text not null,                -- 'fabric'
  label       text not null,                -- 'Fabric'
  required    boolean not null default true,
  multi       boolean not null default false,
  seq         smallint not null default 0,
  unique (product_id, code)
);

create table product_option (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  group_id        uuid not null references product_option_group(id) on delete cascade,
  code            text not null,            -- 'perf-linen-oat'
  label           text not null,            -- 'Performance linen, oat'
  price_delta_minor bigint not null default 0,
  cost_delta_minor  bigint not null default 0,
  lead_days       smallint not null default 0 check (lead_days >= 0),
  swatch          text,                     -- image url or #hex
  vendor_code     text,                     -- what the factory calls it, for the PO
  active          boolean not null default true,
  seq             smallint not null default 0,
  unique (group_id, code)
);

-- ------------------------------------------------------------ stock level --
-- One row per product per location. The inventory module is the only
-- writer (receipts, transfers, reservations, sales); every other module
-- reads it. available = on_hand - reserved, never stored.

create table stock_level (
  entity_id    uuid not null references entity(id),
  product_id   uuid not null references product(id),
  location_id  uuid not null references location(id),
  on_hand      numeric(12,2) not null default 0,
  reserved     numeric(12,2) not null default 0 check (reserved >= 0),
  on_order     numeric(12,2) not null default 0 check (on_order >= 0),
  updated_at   timestamptz not null default now(),
  primary key (entity_id, product_id, location_id)
);

create view product_availability as
  select s.entity_id, s.product_id, s.location_id, l.kind location_kind,
         s.on_hand, s.reserved, s.on_hand - s.reserved available, s.on_order
    from stock_level s join location l on l.id = s.location_id;
