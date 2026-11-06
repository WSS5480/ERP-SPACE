-- 0020_pos.sql
-- Point of sale: registers and drawer sessions, the selling screen's extra
-- facts about an order (quote expiry, layaway schedule, signature, returns),
-- per-line fulfilment, salesperson splits, and manager overrides.
--
-- The order itself is the shared sales_order (channel 'pos'); every dollar is
-- a customer_receipt carrying the drawer session it went into. Rules here:
--   1. one open session per register; a session closes once, with the cash
--      counted by denomination, and its over/short is posted
--   2. a delivery line needs an address and a promised date
--   3. a discount past the limit, or a price below cost, is recorded with the
--      manager who allowed it and why -- the row cannot exist without both
--   4. a return names its original order line and a reason code

-- ------------------------------------------------------------- settings --
create table pos_setting (
  entity_id              uuid primary key references entity(id),
  discount_limit_bps     integer not null default 1000 check (discount_limit_bps between 0 and 10000),
  quote_valid_days       integer not null default 30 check (quote_valid_days between 1 and 365),
  layaway_min_deposit_bps integer not null default 2000 check (layaway_min_deposit_bps between 0 and 10000),
  layaway_max_days       integer not null default 90 check (layaway_max_days between 7 and 365),
  layaway_installments   integer not null default 4 check (layaway_installments between 1 and 24),
  delivery_product_id    uuid references product(id),
  protection_product_id  uuid references product(id)
);

-- ------------------------------------------------- registers and sessions --
create table pos_register (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  location_id uuid not null references location(id),
  code        text not null,
  name        text not null,
  active      boolean not null default true,
  unique (location_id, code)
);
create index pos_register_entity on pos_register (entity_id, location_id);

create table pos_session (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  register_id    uuid not null references pos_register(id),
  location_id    uuid not null references location(id),
  number         text not null,
  status         text not null default 'open' check (status in ('open','closed')),
  float_minor    bigint not null check (float_minor >= 0),
  opened_by      uuid not null references app_user(id),
  opened_at      timestamptz not null default now(),
  closed_by      uuid references app_user(id),
  closed_at      timestamptz,
  counted_minor  bigint check (counted_minor >= 0),
  counted_detail jsonb,                         -- {"10000": 3, "2000": 5, ...} cents -> count
  expected_cash_minor bigint,
  over_short_minor bigint,
  close_note     text,
  journal_entry_id uuid references journal_entry(id),
  z_report       jsonb,
  unique (entity_id, number),
  check ((status = 'closed') = (closed_at is not null and counted_minor is not null and over_short_minor is not null))
);
create unique index pos_session_one_open on pos_session (register_id) where status = 'open';
create index pos_session_entity on pos_session (entity_id, location_id, opened_at desc);

-- A closed session is history.
create or replace function pos_session_closed_is_final() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'register sessions are never deleted'; end if;
  if old.status = 'closed' then raise exception 'a closed register session cannot change'; end if;
  return new;
end $$;
create trigger pos_session_closed_is_final before update or delete on pos_session
  for each row execute function pos_session_closed_is_final();

create table pos_cash_movement (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  session_id  uuid not null references pos_session(id),
  kind        text not null check (kind in ('drop','paid_in','paid_out')),
  amount_minor bigint not null check (amount_minor > 0),
  note        text,
  by_user     uuid not null references app_user(id),
  at          timestamptz not null default now(),
  check (kind = 'drop' or coalesce(trim(note),'') <> '')
);
create index pos_cash_movement_session on pos_cash_movement (session_id);

alter table customer_receipt add constraint customer_receipt_register_session_fk
  foreign key (register_session_id) references pos_session(id);
create index customer_receipt_session on customer_receipt (register_session_id) where register_session_id is not null;

-- ------------------------------------------------------- order extras --
create table pos_order (
  sales_order_id   uuid primary key references sales_order(id),
  entity_id        uuid not null references entity(id),
  kind             text not null check (kind in ('sale','quote','layaway','return')),
  quote_expires_on date,
  layaway_schedule jsonb not null default '[]'::jsonb,   -- [{"due":"2026-11-20","amount":"12500"}]
  paid_off_at      timestamptz,
  tax_exempt_ref   text,
  signature_data_url text,
  signed_name      text,
  signed_at        timestamptz,
  original_order_id uuid references sales_order(id),
  register_session_id uuid references pos_session(id),
  return_note      text,
  created_by       uuid references app_user(id),
  check (kind <> 'quote' or quote_expires_on is not null),
  check (kind <> 'return' or original_order_id is not null),
  check (signature_data_url is null or (signature_data_url ~ '^data:image/(png|jpeg|webp);base64,' and length(signature_data_url) < 200000)),
  check (tax_exempt_ref is null or trim(tax_exempt_ref) <> '')
);
create index pos_order_entity on pos_order (entity_id, kind);
create index pos_order_original on pos_order (original_order_id) where original_order_id is not null;

create table pos_override (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  sales_order_id uuid not null references sales_order(id),
  sales_order_line_id uuid references sales_order_line(id),
  kind           text not null check (kind in ('discount','below_cost')),
  detail         text not null,                 -- "25% off is past the 10% limit"
  requested_by   uuid references app_user(id),
  approved_by    uuid not null references app_user(id),
  reason         text not null check (trim(reason) <> ''),
  at             timestamptz not null default now()
);
create index pos_override_order on pos_override (sales_order_id);

create table pos_line (
  sales_order_line_id uuid primary key references sales_order_line(id),
  entity_id      uuid not null references entity(id),
  sales_order_id uuid not null references sales_order(id),
  role           text not null default 'item' check (role in ('item','tax_refund')),
  fulfillment    text not null default 'carry' check (fulfillment in ('carry','pickup','delivery','ship')),
  promised_on    date,
  ship_address_id uuid references customer_address(id),
  unit_cost_minor bigint not null default 0,
  list_price_minor bigint not null default 0,
  package_sku    text,                          -- set when the line is part of a package
  needs_override text,                          -- why, while it waits for a manager
  override_id    uuid references pos_override(id),
  original_line_id uuid references sales_order_line(id),
  return_reason  text check (return_reason in ('defective','damaged_in_delivery','wrong_item','changed_mind',
                                               'not_as_described','late_delivery','other')),
  return_disposition text check (return_disposition in ('restock','damage','none')),
  check (fulfillment <> 'delivery' or (ship_address_id is not null and promised_on is not null)),
  check (fulfillment <> 'ship' or ship_address_id is not null),
  check (original_line_id is null or return_reason is not null)
);
create index pos_line_order on pos_line (sales_order_id);
create index pos_line_original on pos_line (original_line_id) where original_line_id is not null;

-- Who sold it, and how the credit splits. The workforce module reads (and
-- may create) the same table for commissions.
create table if not exists sales_order_salesperson (
  entity_id      uuid not null references entity(id),
  sales_order_id uuid not null references sales_order(id),
  app_user_id    uuid not null references app_user(id),
  split_bps      integer not null check (split_bps > 0 and split_bps <= 10000),
  primary key (sales_order_id, app_user_id)
);
create index if not exists sales_order_salesperson_user on sales_order_salesperson (entity_id, app_user_id);
