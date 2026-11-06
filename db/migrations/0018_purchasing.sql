-- 0018_purchasing.sql
-- The owner's buying program on top of purchase_order (0004): budgets and
-- open-to-buy, ship-to and expected dates, special orders tied to the
-- customer's line, vendor acknowledgments, landed cost, reorder points.
--
-- Rules set here:
--   1. open-to-buy is never stored: it is the month's budget less what open
--      POs commit, so a placed PO takes it and a cancelled one gives it back
--      without anybody remembering to
--   2. a PO goes to one vendor and one ship-to location
--   3. a customer's special-order line is on at most one live PO line, and
--      that PO line's vendor date is what the customer is told
--   4. on_order moves only through packages/core/inventory.ts

-- ------------------------------------------------- PO header and lines --

alter table purchase_order add column ship_to_location_id uuid references location(id);
alter table purchase_order add column expected_on   date;
alter table purchase_order add column kind          text not null default 'stock'
  check (kind in ('stock','special'));
alter table purchase_order add column acknowledged_on date;
alter table purchase_order add column vendor_ref    text;      -- the vendor's order/ack number
alter table purchase_order add column exported_at   timestamptz;
alter table purchase_order add column cancel_reason text;
alter table purchase_order add column over_budget_reason text;
alter table purchase_order add column created_at    timestamptz not null default now();
alter table purchase_order add constraint purchase_order_cancel_reason
  check (status <> 'cancelled' or ship_to_location_id is null or coalesce(trim(cancel_reason),'') <> '');
create index purchase_order_entity_status on purchase_order (entity_id, status, ordered_on desc);

-- Finance-side lines (0004) have none of these; retail lines carry all of them.
alter table purchase_order_line add column entity_id   uuid references entity(id);
alter table purchase_order_line add column product_id  uuid references product(id);
alter table purchase_order_line add column vendor_sku  text;
alter table purchase_order_line add column category    text;       -- at order time, for open-to-buy
alter table purchase_order_line add column config      jsonb not null default '{}'::jsonb;
alter table purchase_order_line add column expected_on date;
alter table purchase_order_line add column ack_status  text not null default 'pending'
  check (ack_status in ('pending','accepted','backordered','changed','rejected'));
alter table purchase_order_line add column cancelled_qty numeric(12,3) not null default 0;
alter table purchase_order_line add column landed_minor bigint not null default 0 check (landed_minor >= 0);
alter table purchase_order_line add constraint purchase_order_line_cancel_le_qty
  check (cancelled_qty >= 0 and cancelled_qty <= quantity);
create index purchase_order_line_entity_product on purchase_order_line (entity_id, product_id);

-- ------------------------------------------------------ special orders --

create table po_line_sales_line (
  id                     uuid primary key default gen_random_uuid(),
  entity_id              uuid not null references entity(id),
  purchase_order_line_id uuid not null references purchase_order_line(id),
  sales_order_line_id    uuid not null references sales_order_line(id),
  expected_on            date,                -- what the customer's order shows
  active                 boolean not null default true,   -- false once the PO line is cancelled or rejected
  created_at             timestamptz not null default now()
);
create unique index po_line_sales_line_live on po_line_sales_line (sales_order_line_id) where active;
create index po_line_sales_line_po on po_line_sales_line (purchase_order_line_id);

-- When the customer's goods are due, by order line. POS and the web store read this.
create view sales_line_eta as
  select k.entity_id, sl.sales_order_id, k.sales_order_line_id, po.id purchase_order_id, po.number po_number,
         pol.ack_status, k.expected_on, po.acknowledged_on
    from po_line_sales_line k
    join sales_order_line sl on sl.id = k.sales_order_line_id
    join purchase_order_line pol on pol.id = k.purchase_order_line_id
    join purchase_order po on po.id = pol.purchase_order_id
   where k.active;

-- --------------------------------------------------------- open-to-buy --

create table buying_budget (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  month        date not null check (extract(day from month) = 1),
  category     text not null,
  location_id  uuid not null references location(id),
  budget_minor bigint not null check (budget_minor >= 0),
  set_by       uuid references app_user(id),
  set_at       timestamptz not null default now(),
  unique (entity_id, month, category, location_id)
);

-- What each open stock PO line commits, by the month it is due in, category
-- and ship-to. Special orders are bought against a customer's sale, so they
-- do not spend open-to-buy.
create view purchase_commitment as
  select po.entity_id, date_trunc('month', coalesce(pol.expected_on, po.expected_on, po.ordered_on))::date as month,
         pol.category, po.ship_to_location_id location_id,
         sum(round((pol.quantity - pol.cancelled_qty) * pol.unit_price_minor))::bigint committed_minor
    from purchase_order po join purchase_order_line pol on pol.purchase_order_id = po.id
   where po.status <> 'cancelled' and po.kind = 'stock' and po.ship_to_location_id is not null and pol.category is not null
   group by 1, 2, 3, 4;

create view open_to_buy as
  select b.entity_id, b.month, b.category, b.location_id, b.budget_minor,
         coalesce(c.committed_minor, 0) committed_minor,
         b.budget_minor - coalesce(c.committed_minor, 0) open_minor
    from buying_budget b
    left join purchase_commitment c on c.entity_id = b.entity_id and c.month = b.month
                                   and c.category = b.category and c.location_id = b.location_id;

-- ------------------------------------------------------- replenishment --

create table reorder_rule (
  entity_id   uuid not null references entity(id),
  product_id  uuid not null references product(id),
  location_id uuid not null references location(id),
  min_qty     numeric(10,2) not null check (min_qty >= 0),
  max_qty     numeric(10,2) not null,
  active      boolean not null default true,
  primary key (entity_id, product_id, location_id),
  check (max_qty >= min_qty and max_qty > 0)
);

-- ---------------------------------------------------------- landed cost --

create table po_landed_cost (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entity(id),
  purchase_order_id uuid not null references purchase_order(id),
  kind              text not null check (kind in ('freight','duty','fuel','other')),
  amount_minor      bigint not null check (amount_minor > 0),
  basis             text not null default 'value' check (basis in ('value','qty','cube')),
  note              text,
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now()
);
create index po_landed_cost_po on po_landed_cost (purchase_order_id);

-- --------------------------------------------- vendor acknowledgments --

create table po_ack_run (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  filename   text,
  rows       integer not null default 0,
  applied    integer not null default 0,
  problems   jsonb not null default '[]'::jsonb,   -- [{row, message}]
  created_by uuid references app_user(id),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------- PO transmission --
-- Every attempt to send a PO to its vendor, whichever way: an email to the
-- vendor's order address, a file (850-style CSV), or the vendor's API.
create table po_transmission (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entity(id),
  purchase_order_id uuid not null references purchase_order(id),
  method            text not null check (method in ('email','file','api')),
  status            text not null check (status in ('sent','prepared','failed')),
  destination       text,                   -- address, file name or endpoint
  detail            text,                   -- the vendor's answer or why it failed, in plain words
  vendor_ref        text,
  sent_by           uuid references app_user(id),
  sent_at           timestamptz not null default now()
);
create index po_transmission_po on po_transmission (purchase_order_id, sent_at desc);
