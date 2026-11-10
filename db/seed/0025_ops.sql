-- 0025_ops.sql
-- PLACEHOLDER operations data: staging lanes at the distribution center,
-- haul-away fees, recycling programs by state, leave types, and two delivery
-- orders the operations checks load, deliver and haul away from. Nothing
-- here is a real record.

begin;

-- --------------------------------------------------------- staging lanes --
insert into dock_lane (entity_id, dc_location_id, code, name) values
  ('22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','L1','Lane 1 (door 3)'),
  ('22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','L2','Lane 2 (door 4)'),
  ('22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','L3','Lane 3 (door 5)'),
  ('22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','L4','Lane 4 (door 6)');

-- ----------------------------------------------------------- haul-away --
insert into product (id, entity_id, sku, name, kind, category, subcategory, price_minor, cost_minor, taxable, serialized, ship_class) values
  ('77777777-0000-0000-0000-000000000061','22222222-2222-2222-2222-222222222222','SVC-HAUL-MATT','Haul-away, mattress or box spring','fee','Services','Haul-away',2500,0,false,false,'none'),
  ('77777777-0000-0000-0000-000000000062','22222222-2222-2222-2222-222222222222','SVC-HAUL-FURN','Haul-away, furniture piece','fee','Services','Haul-away',3500,0,false,false,'none');

insert into haul_away_rate (entity_id, category, label, fee_product_id, fee_minor, est_weight_lb) values
  ('22222222-2222-2222-2222-222222222222','mattress','Old mattress','77777777-0000-0000-0000-000000000061',2500,60),
  ('22222222-2222-2222-2222-222222222222','box_spring','Old box spring','77777777-0000-0000-0000-000000000061',2500,40),
  ('22222222-2222-2222-2222-222222222222','sofa','Old sofa','77777777-0000-0000-0000-000000000062',3500,120),
  ('22222222-2222-2222-2222-222222222222','recliner','Old recliner','77777777-0000-0000-0000-000000000062',3500,90),
  ('22222222-2222-2222-2222-222222222222','chair','Old chair','77777777-0000-0000-0000-000000000062',3500,30),
  ('22222222-2222-2222-2222-222222222222','other','Other piece','77777777-0000-0000-0000-000000000062',3500,50);

-- Pennsylvania and Texas have no mattress program today; Connecticut's is an
-- example of one that charges a fee per unit and wants a report.
insert into recycling_program (entity_id, state, name, categories, program_fee_minor, report_required) values
  ('22222222-2222-2222-2222-222222222222','PA','Pennsylvania (no state program)','{mattress,box_spring}',0,false),
  ('22222222-2222-2222-2222-222222222222','TX','Texas (no state program)','{mattress,box_spring}',0,false),
  ('22222222-2222-2222-2222-222222222222','CT','Connecticut mattress stewardship (example)','{mattress,box_spring}',1625,true);

-- ----------------------------------------------------------- leave types --
insert into leave_type (entity_id, code, name, kind, paid, accrual, accrue_hours, per_hours, cap_hours, allow_negative) values
  ('22222222-2222-2222-2222-222222222222','VAC','Vacation','vacation',true,'per_hour',1,30,80,false),
  ('22222222-2222-2222-2222-222222222222','SICK','Sick','sick',true,'per_period',2,null,40,false),
  ('22222222-2222-2222-2222-222222222222','UNPAID','Unpaid','unpaid',false,'none',0,null,null,true),
  ('22222222-2222-2222-2222-222222222222','BRV','Bereavement','other',true,'none',0,null,null,true),
  ('eeee0000-0000-0000-0000-00000000000e','VAC','Vacation','vacation',true,'per_period',4,null,120,false);

-- ------------------------------------------------- orders for the checks --
-- 99999999-...-0000000000eN: a bed and a chest for Grace, a mattress for Ivy.
insert into sales_order (id, entity_id, number, channel, location_id, customer_id, salesperson_id, status, fulfillment, ship_address_id, notes)
select x.id::uuid, '22222222-2222-2222-2222-222222222222', next_doc_no('22222222-2222-2222-2222-222222222222','order','SO-'), 'pos',
       '33333333-0000-0000-0000-000000000001', x.cust::uuid, '55555555-0000-0000-0000-000000000011', 'open', 'delivery',
       (select a.id from customer_address a where a.entity_id = '22222222-2222-2222-2222-222222222222' and a.customer_id = x.cust::uuid and a.is_default),
       x.note
  from (values
    ('99999999-0000-0000-0000-0000000000e1','88888888-0000-0000-0000-0000000000f1','Take the old mattress and sofa'),
    ('99999999-0000-0000-0000-0000000000e2','88888888-0000-0000-0000-0000000000f3',null)) x(id, cust, note)
 order by x.id;

insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, tax_minor, fulfil_from_id)
select '22222222-2222-2222-2222-222222222222', x.so::uuid, x.seq, p.id, p.sku, p.name, x.qty, p.price_minor,
       case when p.kind = 'stock' then round(x.qty * p.price_minor * 0.06)::bigint else 0 end,
       case when p.kind = 'stock' then '33333333-0000-0000-0000-0000000000dc'::uuid end
  from (values
    ('99999999-0000-0000-0000-0000000000e1',1,'77777777-0000-0000-0000-000000000003',1),
    ('99999999-0000-0000-0000-0000000000e1',2,'77777777-0000-0000-0000-000000000006',2),
    ('99999999-0000-0000-0000-0000000000e1',3,'77777777-0000-0000-0000-000000000011',1),
    ('99999999-0000-0000-0000-0000000000e2',1,'77777777-0000-0000-0000-000000000008',1),
    ('99999999-0000-0000-0000-0000000000e2',2,'77777777-0000-0000-0000-000000000011',1)) x(so, seq, prod, qty)
  join product p on p.id = x.prod::uuid;

do $$ begin
  perform sales_order_retotal(id) from sales_order
   where entity_id = '22222222-2222-2222-2222-222222222222' and id::text like '99999999-0000-0000-0000-0000000000e%';
end $$;

commit;
