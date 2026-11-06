-- 0013_inventory.sql
-- PLACEHOLDER warehouse data: zones and bins at the distribution center and
-- the Enola showroom, a dock with a daily piece limit, a labelled piece for
-- every serialized unit already in stock (cartons from the catalog's
-- product_piece if it is there), non-serialized stock put in bins, and one
-- open purchase order with an ETA so receiving and available-to-promise have
-- something to show. Nothing here is a real record.

begin;

-- ----------------------------------------------------------- zones, bins --
insert into inv_zone (id, entity_id, location_id, code, name, kind) values
  ('99990000-0000-0000-0000-0000000000a1','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','RCV','Receiving dock','receiving'),
  ('99990000-0000-0000-0000-0000000000a2','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','A','Aisle A racking','storage'),
  ('99990000-0000-0000-0000-0000000000a3','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','B','Aisle B floor stack','storage'),
  ('99990000-0000-0000-0000-0000000000a4','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','DMG','Damage cage','damage'),
  ('99990000-0000-0000-0000-0000000000a5','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','STG','Truck staging','staging'),
  ('99990000-0000-0000-0000-0000000000b1','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-000000000001','SR','Showroom floor','showroom'),
  ('99990000-0000-0000-0000-0000000000b2','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-000000000001','BK','Back room','storage');

insert into inv_bin (id, entity_id, location_id, zone_id, aisle, rack, level, code) values
  ('99991111-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','99990000-0000-0000-0000-0000000000a1',null,null,null,'RCV-01'),
  ('99991111-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','99990000-0000-0000-0000-0000000000a2','A','01','1','A-01-1'),
  ('99991111-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','99990000-0000-0000-0000-0000000000a2','A','01','2','A-01-2'),
  ('99991111-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','99990000-0000-0000-0000-0000000000a2','A','02','1','A-02-1'),
  ('99991111-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','99990000-0000-0000-0000-0000000000a3','B','01',null,'B-01'),
  ('99991111-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','99990000-0000-0000-0000-0000000000a3','B','02',null,'B-02'),
  ('99991111-0000-0000-0000-000000000007','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','99990000-0000-0000-0000-0000000000a4',null,null,null,'DMG-01'),
  ('99991111-0000-0000-0000-000000000008','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc','99990000-0000-0000-0000-0000000000a5',null,null,null,'STG-01'),
  ('99991111-0000-0000-0000-000000000011','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-000000000001','99990000-0000-0000-0000-0000000000b1',null,null,null,'SR-01'),
  ('99991111-0000-0000-0000-000000000012','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-000000000001','99990000-0000-0000-0000-0000000000b2',null,null,null,'BK-01');

insert into inv_dock (entity_id, location_id, daily_piece_limit, receiving_bin_id) values
  ('22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc', 120, '99991111-0000-0000-0000-000000000001');

-- ------------------------------------------- opening pieces, with labels --
-- One unit per unit on hand of every serialized product; its cartons come
-- from product_piece when the catalog module has defined them.
do $$
declare
  r record; ct record; i int; u uuid; n int; has_pp boolean := to_regclass('product_piece') is not null;
  bin uuid; lbl text;
begin
  for r in
    select s.entity_id, s.product_id, s.location_id, s.on_hand::int qty, p.cost_minor, p.cubic_ft, p.weight_lb, l.kind,
           row_number() over (partition by s.location_id order by p.sku) rn
      from stock_level s join product p on p.id = s.product_id join location l on l.id = s.location_id
     where s.entity_id = '22222222-2222-2222-2222-222222222222' and p.serialized and s.on_hand > 0
  loop
    bin := case
      when r.kind = 'warehouse' then (array['99991111-0000-0000-0000-000000000002','99991111-0000-0000-0000-000000000003',
                                            '99991111-0000-0000-0000-000000000004','99991111-0000-0000-0000-000000000005',
                                            '99991111-0000-0000-0000-000000000006']::uuid[])[1 + (r.rn % 5)]
      when r.location_id = '33333333-0000-0000-0000-000000000001' then '99991111-0000-0000-0000-000000000011'::uuid
      else null end;
    for i in 1..r.qty loop
      u := gen_random_uuid();
      n := 0;
      if has_pp then
        execute 'select count(*) from product_piece where entity_id = $1 and product_id = $2' into n using r.entity_id, r.product_id;
      end if;
      if n > 0 then
        for ct in execute 'select seq, label, cubic_ft, weight_lb from product_piece where entity_id = $1 and product_id = $2 order by seq'
                  using r.entity_id, r.product_id loop
          lbl := next_doc_no(r.entity_id, 'piece', 'P');
          insert into inv_piece (entity_id, label, product_id, unit_id, carton_seq, carton_count, carton_label, cubic_ft, weight_lb, location_id, bin_id, status, cost_minor)
          values (r.entity_id, lbl, r.product_id, u, ct.seq, n, ct.label, ct.cubic_ft, ct.weight_lb, r.location_id, bin, 'in_stock', r.cost_minor);
        end loop;
      else
        lbl := next_doc_no(r.entity_id, 'piece', 'P');
        insert into inv_piece (entity_id, label, product_id, unit_id, location_id, bin_id, status, cost_minor, cubic_ft, weight_lb)
        values (r.entity_id, lbl, r.product_id, u, r.location_id, bin, 'in_stock', r.cost_minor, r.cubic_ft, r.weight_lb);
      end if;
    end loop;
  end loop;
end $$;

insert into inv_move (entity_id, kind, piece_id, product_id, qty, to_location_id, to_bin_id, to_status, reason)
select entity_id, 'opening', id, product_id, 1.0 / carton_count, location_id, bin_id, status, 'opening stock'
  from inv_piece where entity_id = '22222222-2222-2222-2222-222222222222';

-- Non-serialized stock at the DC sits on aisle B; lamps at Enola in the back room.
insert into inv_bin_stock (entity_id, bin_id, product_id, qty)
select s.entity_id, case when s.location_id = '33333333-0000-0000-0000-0000000000dc'
                         then '99991111-0000-0000-0000-000000000006'::uuid else '99991111-0000-0000-0000-000000000012'::uuid end,
       s.product_id, s.on_hand
  from stock_level s join product p on p.id = s.product_id
 where s.entity_id = '22222222-2222-2222-2222-222222222222' and not p.serialized and p.kind = 'stock' and s.on_hand > 0
   and s.location_id in ('33333333-0000-0000-0000-0000000000dc','33333333-0000-0000-0000-000000000001');

-- ------------------------------------------------ an open PO with an ETA --
insert into purchase_order (id, tenant_id, entity_id, vendor_id, number, ordered_on, status) values
  ('99992222-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '66666666-0000-0000-0000-0000000000a1','PO-INV-0001', current_date - 10, 'open');
insert into purchase_order_line (id, purchase_order_id, seq, description, quantity, unit_price_minor, gl_account_id, product_id, expected_on)
select v.id::uuid, '99992222-0000-0000-0000-000000000001', v.seq, v.descr, v.qty, v.price, g.id, v.product::uuid, current_date + v.days
  from (values ('99992222-0000-0000-0000-000000000011', 1, 'Darcy Sofa 2930338', 6, 38500, '77777777-0000-0000-0000-000000000001', 5),
               ('99992222-0000-0000-0000-000000000012', 2, 'Willowton Queen Bed B192-QBED', 4, 26000, '77777777-0000-0000-0000-000000000003', 5),
               ('99992222-0000-0000-0000-000000000013', 3, 'Queen hybrid mattress M43031', 10, 36000, '77777777-0000-0000-0000-000000000008', 12))
       as v(id, seq, descr, qty, price, product, days)
  join gl_account g on g.tenant_id = '11111111-1111-1111-1111-111111111111' and g.code = '1300';

update stock_level s set on_order = s.on_order + v.qty
  from (values ('77777777-0000-0000-0000-000000000001'::uuid, 6), ('77777777-0000-0000-0000-000000000003'::uuid, 4),
               ('77777777-0000-0000-0000-000000000008'::uuid, 10)) as v(product_id, qty)
 where s.entity_id = '22222222-2222-2222-2222-222222222222' and s.product_id = v.product_id
   and s.location_id = '33333333-0000-0000-0000-0000000000dc';

insert into inv_receiving_appt (entity_id, location_id, day, window_label, vendor_id, purchase_order_id, carrier, expected_pieces, booked_by)
values ('22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-0000000000dc', current_date + 5, '8–10am',
        '66666666-0000-0000-0000-0000000000a1','99992222-0000-0000-0000-000000000001','Ashley fleet', 20,
        '55555555-0000-0000-0000-000000000013');

commit;
