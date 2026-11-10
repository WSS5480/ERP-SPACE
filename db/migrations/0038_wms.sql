-- 0038_wms.sql
-- Warehouse management on top of inventory (0019) and purchasing (0018, 0036):
-- containers and freight from the vendor to the DC, goods in transit, and the
-- deluxing / touch-up / assembly queue warehouse staff work from a phone.
--
-- Rules set here:
--   1. A container carries PO lines with quantities. One PO may span several
--      containers and one container may carry lines of several POs; it never
--      carries more of a PO line than is left on order.
--   2. A container moves through fixed stages, each with an expected and an
--      actual day. Its arrival day at the DC is what the PO lines and the
--      customers' special orders on them are told.
--   3. Freight, drayage, duty, tariff and port fees on a container are spread
--      over what it carries (by cube, value, weight or quantity) into
--      po_landed_cost, the landed cost purchasing already has, so receiving
--      values the goods with them. A re-spread retires the old shares (active
--      = false); nothing is deleted.
--   4. Goods in transit never count as on hand. A transfer's in-transit value
--      stays in 1300 unless the company keeps 1310; the account a transfer
--      shipped through is kept on it, so its receipt reverses the same one.
--   5. A prep job (unbox, inspect, touch-up, steam, assemble) is done, or a
--      problem with what was found; a problem puts the piece on damage hold.

-- ------------------------------------------------- location kinds --
-- Virtual places: goods on the road (vendor to DC, store to store) and stock
-- a supplier holds and ships for us. Nothing is ever on hand at them.
alter table location drop constraint location_kind_check;
alter table location add constraint location_kind_check
  check (kind in ('store','warehouse','outlet','yard','office','web','in_transit','dropship'));

-- ------------------------------------------------- transfers --
alter table inv_transfer add column transit_gl text check (transit_gl in ('1300','1310'));
alter table inv_transfer add column expected_on date;
-- Transfers already on the road went through 1310 (the only way they could).
update inv_transfer set transit_gl = '1310' where status = 'in_transit' /* unscoped: one-time backfill of every company */;

-- Companies that already post transfers keep doing it the way they do today:
-- two steps, through 1310. New companies choose in Warehouse settings.
insert into entity_setting (entity_id, key, value, set_by, from_pack)
  select distinct t.entity_id, 'inventory.transfers_two_step', 'true'::jsonb, 'migration 0038', false
    from inv_transfer t
  on conflict do nothing;
insert into entity_setting (entity_id, key, value, set_by, from_pack)
  select distinct je.entity_id, 'inventory.in_transit_gl', '"1310"'::jsonb, 'migration 0038', false
    from journal_line jl join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id
   where g.code = '1310'
  on conflict do nothing;

-- ------------------------------------------------- containers --
create table wms_container (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entity(id),
  number            text not null,                 -- CT-0001, ours
  container_no      text,                          -- MSCU1234567 (or the trailer / equipment number)
  carrier           text,
  vessel            text,
  voyage            text,
  bol               text,                          -- bill of lading
  port_loading      text,
  port_discharge    text,
  dest_location_id  uuid not null references location(id),
  vendor_id         uuid references vendor(id),
  stage             text not null default 'booked' check (stage in
                      ('booked','departed','at_port','customs_cleared','on_rail','delivered_dc','unloaded')),
  note              text,
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now(),
  unique (entity_id, number)
);
create unique index wms_container_no on wms_container (entity_id, upper(container_no)) where container_no is not null;

create table wms_container_stage (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  container_id  uuid not null references wms_container(id),
  stage         text not null check (stage in ('booked','departed','at_port','customs_cleared','on_rail','delivered_dc','unloaded')),
  expected_on   date,
  actual_on     date,
  updated_by    uuid references app_user(id),
  updated_at    timestamptz not null default now(),
  unique (container_id, stage)
);

create table wms_container_line (
  id                     uuid primary key default gen_random_uuid(),
  entity_id              uuid not null references entity(id),
  container_id           uuid not null references wms_container(id),
  purchase_order_line_id uuid not null references purchase_order_line(id),
  qty                    numeric(12,3) not null check (qty > 0),
  received_qty           numeric(12,3) not null default 0 check (received_qty >= 0),
  created_at             timestamptz not null default now(),
  check (received_qty <= qty),
  unique (container_id, purchase_order_line_id)
);
create index wms_container_line_pol on wms_container_line (purchase_order_line_id);

create table wms_container_cost (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  container_id  uuid not null references wms_container(id),
  kind          text not null check (kind in ('freight','drayage','duty','tariff','port_fees','other')),
  amount_minor  bigint not null check (amount_minor > 0),
  basis         text not null check (basis in ('cube','value','weight','qty')),
  note          text,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);

create table wms_container_receipt (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  container_id     uuid not null references wms_container(id),
  goods_receipt_id uuid not null references goods_receipt(id),
  created_at       timestamptz not null default now()
);

-- A ship notice that names a container or trailer is attached to it.
alter table po_shipment add column container_id uuid references wms_container(id);
alter table po_shipment add column equipment_no text;

-- ------------------------------------------------- landed cost --
-- A container's share of a cost lands on the exact PO line it belongs to.
alter table po_landed_cost add column purchase_order_line_id uuid references purchase_order_line(id);
alter table po_landed_cost add column container_cost_id uuid references wms_container_cost(id);
alter table po_landed_cost add column active boolean not null default true;
alter table po_landed_cost drop constraint po_landed_cost_kind_check;
alter table po_landed_cost add constraint po_landed_cost_kind_check
  check (kind in ('freight','duty','fuel','other','drayage','tariff','port_fees'));
alter table po_landed_cost drop constraint po_landed_cost_basis_check;
alter table po_landed_cost add constraint po_landed_cost_basis_check
  check (basis in ('value','qty','cube','weight','line'));
create index po_landed_cost_container on po_landed_cost (container_cost_id) where container_cost_id is not null;

-- ------------------------------------------------- goods in transit --
-- What is on the road, by product and where it is going: PO quantities a
-- vendor has shipped (an 856, or a container that has left) and not yet
-- received, and same-company transfers that have shipped.
create view inv_in_transit as
  select * from (
    select pol.entity_id, 'po'::text source, po.id ref_id, po.number ref_no, pol.product_id, po.ship_to_location_id to_location_id,
           greatest(greatest(coalesce(sh.shipped, 0), coalesce(ct.departed, 0)) - coalesce(r.received, 0), 0)::numeric(12,3) qty,
           coalesce(pol.expected_on, po.expected_on) arriving_on
      from purchase_order_line pol
      join purchase_order po on po.id = pol.purchase_order_id
      left join lateral (select sum(sl.quantity) shipped from po_shipment_line sl join po_shipment s on s.id = sl.shipment_id
                          where sl.purchase_order_line_id = pol.id and s.status <> 'cancelled') sh on true
      left join lateral (select sum(cl.qty) departed from wms_container_line cl join wms_container_stage st on st.container_id = cl.container_id
                          where cl.purchase_order_line_id = pol.id and st.stage = 'departed' and st.actual_on is not null) ct on true
      left join lateral (select sum(g.quantity) received from goods_receipt_line g where g.purchase_order_line_id = pol.id) r on true
     where pol.entity_id is not null and pol.product_id is not null and po.status = 'open' and po.ship_to_location_id is not null
    union all
    select t.entity_id, 'transfer', t.id, t.number, tl.product_id, t.to_location_id, tl.qty::numeric(12,3), t.expected_on
      from inv_transfer t join inv_transfer_line tl on tl.transfer_id = t.id
     where t.status = 'in_transit'
  ) x where qty > 0;

-- ------------------------------------------------- prep queue --
create table wms_prep_rule (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  product_id   uuid references product(id),
  category     text,
  prep_types   text[] not null check (cardinality(prep_types) between 1 and 5
                 and prep_types <@ array['unbox','inspect','touch_up','steam','assemble']::text[]),
  std_minutes  integer check (std_minutes is null or std_minutes between 1 and 600),
  active       boolean not null default true,
  set_by       uuid references app_user(id),
  set_at       timestamptz not null default now(),
  check ((product_id is null) <> (category is null))
);
create unique index wms_prep_rule_product on wms_prep_rule (entity_id, product_id) where product_id is not null;
create unique index wms_prep_rule_category on wms_prep_rule (entity_id, lower(category)) where category is not null;

create table wms_prep_job (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  number              text not null,
  prep_type           text not null check (prep_type in ('unbox','inspect','touch_up','steam','assemble')),
  product_id          uuid not null references product(id),
  location_id         uuid not null references location(id),
  unit_id             uuid,                       -- the labelled unit; null for a quantity of unlabelled stock
  qty                 numeric(12,2) not null default 1 check (qty > 0),
  status              text not null default 'queued' check (status in ('queued','in_progress','done','problem','cancelled')),
  source              text not null check (source in ('receipt','delivery','manual')),
  goods_receipt_id    uuid references goods_receipt(id),
  sales_order_line_id uuid references sales_order_line(id),
  std_minutes         integer,
  started_by          uuid references app_user(id),
  started_at          timestamptz,
  finished_by         uuid references app_user(id),
  finished_at         timestamptz,
  labor_minutes       integer check (labor_minutes is null or labor_minutes between 0 and 1440),
  note                text,
  problem             text,
  photos              text[] not null default '{}' check (cardinality(photos) <= 6),
  damage_id           uuid references inv_damage(id),
  created_by          uuid references app_user(id),
  created_at          timestamptz not null default now(),
  unique (entity_id, number),
  check (status <> 'problem' or coalesce(trim(problem), '') <> ''),
  check (status <> 'cancelled' or coalesce(trim(note), '') <> '')
);
-- One live job per unit per kind of prep.
create unique index wms_prep_job_live on wms_prep_job (unit_id, prep_type) where unit_id is not null and status in ('queued','in_progress','problem');
create index wms_prep_job_queue on wms_prep_job (entity_id, status, location_id);
