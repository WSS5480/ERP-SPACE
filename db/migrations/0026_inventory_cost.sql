-- 0026_inventory_cost.sql
-- Inventory at cost, and the ledger holding it to the penny.
--
-- Decision (Nov 6 2026, review round): stock is carried at a perpetual
-- average cost per product per company. inv_cost keeps the quantity and the
-- total value of every product the company owns on hand (in-transit stock
-- is out of the pool and on the transfer line instead). Every change of
-- value -- a receipt at PO cost plus landed cost, a sale, a return, a
-- transfer, a count, a write-off -- moves the pool and posts the same amount
-- to 1300, so valuation and GL 1300 (+ 1310 in transit) always tie.
-- Receiving posts Dr 1300 Cr 2050 received-not-invoiced; the vendor's
-- merchandise bill then clears 2050.
--
-- Also: POS can take over an order another channel wrote (a web pickup
-- handed over at the counter, a web return refunded at the register). Those
-- lines are adopted by POS, so the POS-only rule that a delivery line carries
-- its own address and promised date applies to lines POS wrote itself.

create table inv_cost (
  entity_id   uuid not null references entity(id),
  product_id  uuid not null references product(id),
  qty         numeric(12,2) not null default 0,
  value_minor bigint not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (entity_id, product_id)
);

-- The value that left on a transfer, so the receiving end lands exactly that.
alter table inv_transfer_line add column value_minor bigint not null default 0;
-- A transfer line can carry a customer's order line (a special order moving to the store it is picked up from).
alter table inv_transfer_line add column sales_order_line_id uuid references sales_order_line(id);

alter table pos_line add column origin text not null default 'pos' check (origin in ('pos','adopted'));
alter table pos_line drop constraint pos_line_check;
alter table pos_line drop constraint pos_line_check1;
alter table pos_line add constraint pos_line_delivery_needs_address_and_date
  check (fulfillment <> 'delivery' or origin <> 'pos' or (ship_address_id is not null and promised_on is not null));
alter table pos_line add constraint pos_line_ship_needs_address
  check (fulfillment <> 'ship' or origin <> 'pos' or ship_address_id is not null);
