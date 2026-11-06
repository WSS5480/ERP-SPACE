-- 0012_purchasing.sql
-- PLACEHOLDER buying-program data: this month's and the next two months'
-- budgets by category for the DC and Enola, reorder points, and one
-- customer order waiting in the special-order queue (a made-to-order sofa
-- and a backordered nightstand). Dates are relative to the day it is loaded.

begin;

insert into buying_budget (entity_id, month, category, location_id, budget_minor, set_by)
select '22222222-2222-2222-2222-222222222222', (date_trunc('month', current_date) + make_interval(months => m))::date, c.category, l.id,
       c.amount * case when l.kind = 'warehouse' then 3 else 1 end, '55555555-0000-0000-0000-000000000001'
  from generate_series(0, 2) m
 cross join (values ('Living room', 1500000::bigint), ('Bedroom', 1000000::bigint), ('Dining', 600000::bigint)) c(category, amount)
 cross join location l
 where l.id in ('33333333-0000-0000-0000-0000000000dc','33333333-0000-0000-0000-000000000001');

insert into reorder_rule (entity_id, product_id, location_id, min_qty, max_qty) values
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000003','33333333-0000-0000-0000-0000000000dc',8,12),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000001','33333333-0000-0000-0000-0000000000dc',4,10),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000021','33333333-0000-0000-0000-0000000000dc',2,6),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000009','33333333-0000-0000-0000-000000000001',6,12),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000022','33333333-0000-0000-0000-0000000000dc',2,6);

-- A customer order with two lines waiting on a vendor PO.
insert into sales_order (id, entity_id, number, channel, location_id, customer_id, salesperson_id, status, fulfillment,
                         ship_address_id, notes, created_by)
select '7b7b7b7b-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','SO-DEMO-0001','pos',
       '33333333-0000-0000-0000-000000000001','88888888-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000011',
       'open','delivery', a.id, 'Special order: Hudson in navy velvet', '55555555-0000-0000-0000-000000000011'
  from customer_address a where a.customer_id = '88888888-0000-0000-0000-000000000001' and a.is_default;

insert into sales_order_line (id, entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, config, fulfil_from_id, line_status) values
  ('7b7b7b7b-0000-0000-0000-0000000000a1','22222222-2222-2222-2222-222222222222','7b7b7b7b-0000-0000-0000-000000000001',1,
   '77777777-0000-0000-0000-000000000010','CUW-SOFA-CUSTOM','Hudson sofa, made to order — 96" sofa, Velvet, navy, Walnut',1,164900,
   '{"size":[{"code":"96","label":"96\" sofa","vendorCode":"S96","deltaMinor":"20000"}],
     "fabric":[{"code":"velvet-navy","label":"Velvet, navy","vendorCode":"VV-NAV","deltaMinor":"15000"}],
     "legs":[{"code":"walnut","label":"Walnut","vendorCode":"LG-WAL","deltaMinor":"0"}]}',
   '33333333-0000-0000-0000-0000000000dc','on_order'),
  ('7b7b7b7b-0000-0000-0000-0000000000a2','22222222-2222-2222-2222-222222222222','7b7b7b7b-0000-0000-0000-000000000001',2,
   '77777777-0000-0000-0000-000000000021','ASH-B192-92','Willowton Nightstand',2,22999,'{}',
   '33333333-0000-0000-0000-0000000000dc','on_order');
select sales_order_retotal('7b7b7b7b-0000-0000-0000-000000000001');

commit;
