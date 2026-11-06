-- 0019_inventory.sql
-- Warehousing and tracking. Where every piece is, what state it is in, and
-- the history of how it got there.
--
-- Rules this file sets:
--   1. stock_level (0015) stays the one quantity per product per location,
--      and only packages/core/inventory.ts writes it. This file adds `held`:
--      units physically here but not sellable (damaged, in repair, on a
--      vendor claim, back from a customer awaiting inspection). Available is
--      on_hand - reserved - held.
--   2. A serialized product is tracked piece by piece. A unit is one or more
--      cartons (the catalog's product_piece rows); each carton carries its
--      own barcode label, status and bin.
--   3. Every move is a row in inv_move. Nothing there is ever edited or
--      deleted -- the database refuses it.
--   4. A count is approved by a store manager or owner who neither made nor
--      submitted it (maker is never the checker), enforced here as well.

-- ------------------------------------------------- stock_level: held --
alter table stock_level add column held numeric(12,2) not null default 0 check (held >= 0);

create or replace view product_availability as
  select s.entity_id, s.product_id, s.location_id, l.kind location_kind,
         s.on_hand, s.reserved, s.on_hand - s.reserved - s.held available, s.on_order, s.held
    from stock_level s join location l on l.id = s.location_id;

-- Receiving needs to know what a PO line is. Purchasing may already have
-- added these; adding them again is a no-op.
alter table purchase_order_line add column if not exists product_id uuid references product(id);
alter table purchase_order_line add column if not exists expected_on date;
create index if not exists purchase_order_line_product on purchase_order_line (product_id);

-- --------------------------------------------------- zones, aisles, bins --
create table inv_zone (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  location_id uuid not null references location(id),
  code        text not null,
  name        text not null,
  kind        text not null default 'storage'
                check (kind in ('receiving','storage','showroom','staging','damage','outlet','will_call')),
  active      boolean not null default true,
  unique (location_id, code)
);
create index inv_zone_entity on inv_zone (entity_id, location_id);

create table inv_bin (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  location_id uuid not null references location(id),
  zone_id     uuid not null references inv_zone(id),
  aisle       text,
  rack        text,
  level       text,
  code        text not null,                   -- "A-03-2": what the label on the shelf says
  max_cubic_ft numeric(8,2) check (max_cubic_ft >= 0),
  active      boolean not null default true,
  unique (location_id, code)
);
create index inv_bin_entity on inv_bin (entity_id, location_id);

-- A bin belongs to the location its zone is in.
create or replace function inv_bin_location_check() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from inv_zone z where z.id = new.zone_id and z.location_id = new.location_id and z.entity_id = new.entity_id) then
    raise exception 'a bin must sit in a zone at the same location';
  end if;
  return new;
end $$;
create trigger inv_bin_location_check before insert or update on inv_bin
  for each row execute function inv_bin_location_check();

-- Non-serialized stock by bin (lamps, chair packs). Serialized stock is
-- binned piece by piece in inv_piece instead.
create table inv_bin_stock (
  entity_id   uuid not null references entity(id),
  bin_id      uuid not null references inv_bin(id),
  product_id  uuid not null references product(id),
  qty         numeric(12,2) not null default 0 check (qty >= 0),
  primary key (bin_id, product_id)
);
create index inv_bin_stock_entity on inv_bin_stock (entity_id, product_id);

-- ---------------------------------------------------------- transfers --
create table inv_transfer (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  number        text not null,
  from_location_id uuid not null references location(id),
  to_location_id   uuid not null references location(id),
  status        text not null default 'draft' check (status in ('draft','in_transit','received','cancelled')),
  note          text,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  shipped_by    uuid references app_user(id),
  shipped_at    timestamptz,
  received_by   uuid references app_user(id),
  received_at   timestamptz,
  unique (entity_id, number),
  check (from_location_id <> to_location_id)
);
create index inv_transfer_entity on inv_transfer (entity_id, status);

create table inv_transfer_line (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  transfer_id uuid not null references inv_transfer(id),
  product_id  uuid not null references product(id),
  qty         numeric(12,2) not null check (qty > 0),
  unit_ids    uuid[] not null default '{}',     -- serialized units chosen at ship
  cost_minor  bigint not null default 0
);
create index inv_transfer_line_t on inv_transfer_line (transfer_id);

-- ------------------------------------------------------------- pieces --
create table inv_piece (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  label        text not null,                 -- the barcode
  product_id   uuid not null references product(id),
  unit_id      uuid not null,                 -- cartons of one unit share it
  carton_seq   smallint not null default 1 check (carton_seq >= 1),
  carton_count smallint not null default 1 check (carton_count >= 1),
  carton_label text,                          -- "Sofa base", "Back cushions"
  cubic_ft     numeric(8,2),
  weight_lb    numeric(8,2),
  location_id  uuid not null references location(id),
  bin_id       uuid references inv_bin(id),
  status       text not null default 'in_stock' check (status in
                 ('in_stock','reserved','picked','loaded','delivered','damaged','in_repair',
                  'vendor_claim','as_is','returned','in_transit','written_off','returned_to_vendor')),
  cost_minor   bigint not null default 0 check (cost_minor >= 0),   -- per unit, same on each carton
  as_is_price_minor bigint check (as_is_price_minor >= 0),
  as_is_note   text,
  sales_order_line_id uuid references sales_order_line(id),
  transfer_id  uuid references inv_transfer(id),
  goods_receipt_line_id uuid references goods_receipt_line(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (entity_id, label),
  check (carton_seq <= carton_count),
  check (status <> 'reserved' or sales_order_line_id is not null)
);
create index inv_piece_unit on inv_piece (unit_id);
create index inv_piece_where on inv_piece (entity_id, product_id, location_id, status);
create index inv_piece_line on inv_piece (sales_order_line_id) where sales_order_line_id is not null;
create index inv_piece_bin on inv_piece (bin_id) where bin_id is not null;

-- ------------------------------------------------------ movement history --
create table inv_move (
  id            bigserial primary key,
  entity_id     uuid not null references entity(id),
  at            timestamptz not null default now(),
  kind          text not null check (kind in ('receive','putaway','move','allocate','unallocate','pick','unpick',
                  'load','unload','deliver','return','transfer_out','transfer_in','damage','repair','claim',
                  'restore','as_is','write_off','vendor_return','adjust','count','opening')),
  piece_id      uuid references inv_piece(id),
  product_id    uuid not null references product(id),
  qty           numeric(12,2) not null,
  from_location_id uuid references location(id),
  to_location_id   uuid references location(id),
  from_bin_id   uuid references inv_bin(id),
  to_bin_id     uuid references inv_bin(id),
  from_status   text,
  to_status     text,
  ref_type      text,                         -- 'receipt', 'transfer', 'order_line', 'count', 'adjustment', 'damage'
  ref_id        uuid,
  reason        text,
  by_user       uuid references app_user(id)
);
create index inv_move_piece on inv_move (piece_id, at);
create index inv_move_entity on inv_move (entity_id, at desc);
create index inv_move_product on inv_move (entity_id, product_id, at desc);

create or replace function inv_move_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'stock movements are history; they are never edited or deleted. Record a new move instead';
end $$;
create trigger inv_move_immutable before update or delete on inv_move
  for each row execute function inv_move_immutable();

-- ------------------------------------------------- receiving calendar --
create table inv_dock (
  entity_id   uuid not null references entity(id),
  location_id uuid not null references location(id) primary key,
  daily_piece_limit integer not null default 200 check (daily_piece_limit > 0),
  receiving_bin_id uuid references inv_bin(id)      -- where received goods land
);

create table inv_receiving_appt (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  location_id  uuid not null references location(id),
  day          date not null,
  window_label text,                            -- "8–10am"
  vendor_id    uuid references vendor(id),
  purchase_order_id uuid references purchase_order(id),
  carrier      text,
  expected_pieces integer not null check (expected_pieces > 0),
  status       text not null default 'booked' check (status in ('booked','arrived','received','no_show','cancelled')),
  note         text,
  booked_by    uuid references app_user(id),
  created_at   timestamptz not null default now()
);
create index inv_receiving_appt_day on inv_receiving_appt (entity_id, location_id, day);

-- ------------------------------------------------- damage and vendor claims --
create table inv_damage (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  number       text not null,
  product_id   uuid not null references product(id),
  location_id  uuid not null references location(id),
  unit_id      uuid,                           -- serialized: the unit; else null
  qty          numeric(12,2) not null check (qty > 0),
  source       text not null check (source in ('receiving','warehouse','showroom','delivery','customer_return','transfer','count')),
  description  text not null,
  photo_urls   text[] not null default '{}',
  status       text not null default 'open' check (status in ('open','in_repair','vendor_claim','resolved')),
  resolution   text check (resolution in ('restocked','as_is','written_off','returned_to_vendor')),
  resolution_note text,
  cost_minor   bigint not null default 0,      -- per unit at the time
  journal_entry_id uuid references journal_entry(id),
  opened_by    uuid references app_user(id),
  opened_at    timestamptz not null default now(),
  resolved_by  uuid references app_user(id),
  resolved_at  timestamptz,
  unique (entity_id, number),
  check ((status = 'resolved') = (resolution is not null))
);
create index inv_damage_entity on inv_damage (entity_id, status);

create table inv_vendor_claim (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  number       text not null,
  damage_id    uuid not null references inv_damage(id),
  vendor_id    uuid references vendor(id),
  vendor_ref   text,                           -- the vendor's RA / claim number
  amount_claimed_minor bigint not null check (amount_claimed_minor >= 0),
  credit_minor bigint check (credit_minor >= 0),
  photo_urls   text[] not null default '{}',
  status       text not null default 'open' check (status in ('open','submitted','approved','denied','credited')),
  resolution   text,
  opened_by    uuid references app_user(id),
  opened_at    timestamptz not null default now(),
  closed_by    uuid references app_user(id),
  closed_at    timestamptz,
  unique (entity_id, number),
  check (status not in ('credited','denied') or (closed_at is not null and coalesce(trim(resolution),'') <> '')),
  check (status <> 'credited' or credit_minor is not null)
);
create index inv_vendor_claim_entity on inv_vendor_claim (entity_id, status);

-- --------------------------------------------------------- cycle counts --
create table inv_count (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  number       text not null,
  location_id  uuid not null references location(id),
  bin_id       uuid references inv_bin(id),     -- null: the unbinned stock at the location
  status       text not null default 'open' check (status in ('open','submitted','approved','rejected')),
  note         text,
  created_by   uuid not null references app_user(id),
  created_at   timestamptz not null default now(),
  submitted_by uuid references app_user(id),
  submitted_at timestamptz,
  decided_by   uuid references app_user(id),
  decided_at   timestamptz,
  decision_note text,
  variance_minor bigint,
  journal_entry_id uuid references journal_entry(id),
  unique (entity_id, number),
  check (decided_by is null or (decided_by <> created_by and decided_by is distinct from submitted_by))
);
create index inv_count_entity on inv_count (entity_id, status);

create table inv_count_line (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  count_id     uuid not null references inv_count(id),
  product_id   uuid not null references product(id),
  serialized   boolean not null,
  expected_qty numeric(12,2) not null,
  counted_qty  numeric(12,2) check (counted_qty >= 0),
  expected_labels text[] not null default '{}',
  scanned_labels  text[] not null default '{}',
  unit_cost_minor bigint not null default 0,
  unique (count_id, product_id)
);

-- ------------------------------------------------------ adjustments --
create table inv_adjustment (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  number       text not null,
  location_id  uuid not null references location(id),
  bin_id       uuid references inv_bin(id),
  product_id   uuid not null references product(id),
  qty          numeric(12,2) not null check (qty <> 0),
  reason_code  text not null check (reason_code in ('found','lost','theft','damaged_beyond_repair','data_correction',
                                                    'sample','donation','opening_balance','other')),
  note         text,
  labels       text[] not null default '{}',
  value_minor  bigint not null,                 -- qty x unit cost, signed
  journal_entry_id uuid references journal_entry(id),
  by_user      uuid not null references app_user(id),
  at           timestamptz not null default now(),
  unique (entity_id, number),
  check (reason_code <> 'other' or coalesce(trim(note),'') <> '')
);
create index inv_adjustment_entity on inv_adjustment (entity_id, at desc);
