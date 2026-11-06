-- 0011_catalog.sql
-- PLACEHOLDER catalog data: vendor ordering facts and freight, a package,
-- multi-carton items, images, MAP, a special-order fabric template, a
-- contract price list, a live promotion, and products in each lifecycle
-- status. Promotions touch only the products added here, so other modules'
-- prices for the 0010 products are unchanged.

begin;

-- ------------------------------------------------------- vendor facts --
insert into vendor_profile (entity_id, vendor_id, order_email, account_no, sku_prefix, lead_days, freight_min_minor, freight_min_qty, notes) values
  ('22222222-2222-2222-2222-222222222222','66666666-0000-0000-0000-0000000000a1','orders@ashley.example','PX-10442','ASH',21,250000,0,'Prepaid freight at $2,500 net'),
  ('22222222-2222-2222-2222-222222222222','66666666-0000-0000-0000-0000000000a2','po@coaster.example','PX-2209','COA',14,150000,0,null),
  ('22222222-2222-2222-2222-222222222222','66666666-0000-0000-0000-0000000000a3','sales@globalfurniture.example',null,'GLB',30,0,12,'Container pricing at 12 pieces'),
  ('22222222-2222-2222-2222-222222222222','66666666-0000-0000-0000-0000000000a4','custom@cuw.example',null,'CUW',42,0,0,'Made to order; fabric grades on the template');

insert into vendor_freight (entity_id, vendor_id, location_id, freight_bps, per_unit_minor)
select '22222222-2222-2222-2222-222222222222', v.id, l.id,
       case when l.kind = 'warehouse' then 600 when l.state = 'TX' then 900 else 700 end,
       case when v.id = '66666666-0000-0000-0000-0000000000a3' then 1500 else 0 end
  from vendor v cross join location l
 where v.id in ('66666666-0000-0000-0000-0000000000a1','66666666-0000-0000-0000-0000000000a2',
                '66666666-0000-0000-0000-0000000000a3','66666666-0000-0000-0000-0000000000a4')
   and l.entity_id = '22222222-2222-2222-2222-222222222222' and l.kind in ('warehouse','store');

-- -------------------------------------------- MAP, barcodes, images --
update product set map_minor = 74999, msrp_minor = 99999, barcode = '024052293033'
 where id = '77777777-0000-0000-0000-000000000001' and entity_id = '22222222-2222-2222-2222-222222222222';
update product set map_minor = 64999, msrp_minor = 89999
 where id = '77777777-0000-0000-0000-000000000002' and entity_id = '22222222-2222-2222-2222-222222222222';

insert into product_image (entity_id, product_id, seq, url, alt)
select '22222222-2222-2222-2222-222222222222', p.id, 1, 'https://images.example.com/catalog/' || lower(p.sku) || '.jpg', p.name
  from product p where p.entity_id = '22222222-2222-2222-2222-222222222222' and p.kind in ('stock','configurable');

-- ---------------------------------------------------- new products --
-- ids 77777777-...-00000000002N
insert into product (id, entity_id, sku, name, kind, vendor_id, vendor_sku, brand, category, subcategory, collection, color,
                     price_minor, cost_minor, serialized, ship_class, cubic_ft, weight_lb, web_visible, status, status_note) values
  ('77777777-0000-0000-0000-000000000021','22222222-2222-2222-2222-222222222222','ASH-B192-92','Willowton Nightstand','stock',
   '66666666-0000-0000-0000-0000000000a1','B192-92','Ashley','Bedroom','Nightstands','Willowton','Whitewash',22999,9500,false,'delivery',6,45,true,'active',null),
  ('77777777-0000-0000-0000-000000000022','22222222-2222-2222-2222-222222222222','ASH-2930314','Darcy Ottoman','stock',
   '66666666-0000-0000-0000-0000000000a1','2930314','Ashley','Living room','Ottomans','Darcy','Cobblestone',24999,10500,false,'delivery',8,30,true,'drop','Ashley dropped it from the 2027 line'),
  ('77777777-0000-0000-0000-000000000023','22222222-2222-2222-2222-222222222222','COA-508281-FS','Bachman Sofa (floor model)','stock',
   '66666666-0000-0000-0000-0000000000a2','508281','Coaster','Living room','Sofas','Bachman','Charcoal',49999,31000,true,'delivery',45,140,false,'floor_sample','Showroom model, small scuff on the back left leg'),
  ('77777777-0000-0000-0000-000000000024','22222222-2222-2222-2222-222222222222','COA-SET-ANDREA5','Andrea 5-piece dining set','kit',
   '66666666-0000-0000-0000-0000000000a2',null,'Coaster','Dining','Sets','Andrea','Cappuccino',79999,35400,true,'delivery',46,206,true,'active',null),
  ('77777777-0000-0000-0000-000000000025','22222222-2222-2222-2222-222222222222','GLB-U9900','Lift chair, power','stock',
   '66666666-0000-0000-0000-0000000000a3','U9900','Global','Living room','Recliners',null,'Taupe',0,41000,true,'delivery',34,120,false,'draft',null),
  ('77777777-0000-0000-0000-000000000026','22222222-2222-2222-2222-222222222222','CUW-CHAIR-CUSTOM','Hudson accent chair, made to order','special_order',
   '66666666-0000-0000-0000-0000000000a4','HUD-C','Custom Upholstery Works','Living room','Chairs','Hudson',null,69900,31000,true,'delivery',20,55,true,'active',null);

-- The package: a table and two 2-packs of chairs. Components cost 19000 + 2 x 8200.
insert into product_kit_component (entity_id, kit_id, component_id, qty, seq) values
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000024','77777777-0000-0000-0000-000000000005',1,1),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000024','77777777-0000-0000-0000-000000000006',2,2);

-- ---------------------------------------------------- multi-carton --
insert into product_piece (entity_id, product_id, seq, label, cubic_ft, weight_lb) values
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000003',1,'Headboard',14,70),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000003',2,'Footboard',9,50),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000003',3,'Rails and slats',7,40),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000005',1,'Table top',14,70),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000005',2,'Base',8,40),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000010',1,'Sofa body',42,125),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000010',2,'Legs and cushions',8,25);

-- ------------------------------------------- special-order template --
insert into option_template (id, entity_id, name, vendor_id, category) values
  ('79797979-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','CUW fabric grades and legs',
   '66666666-0000-0000-0000-0000000000a4','Living room');
insert into option_template_group (id, entity_id, template_id, code, label, required, seq) values
  ('79797979-0000-0000-0000-0000000000a1','22222222-2222-2222-2222-222222222222','79797979-0000-0000-0000-000000000001','fabric','Fabric',true,1),
  ('79797979-0000-0000-0000-0000000000a2','22222222-2222-2222-2222-222222222222','79797979-0000-0000-0000-000000000001','legs','Leg finish',true,2);
insert into option_template_option (entity_id, group_id, code, label, price_delta_minor, cost_delta_minor, lead_days, swatch, vendor_code, seq) values
  ('22222222-2222-2222-2222-222222222222','79797979-0000-0000-0000-0000000000a1','grade-a-oat','Grade A linen, oat',0,0,0,'#d8cbb3','GA-OAT',1),
  ('22222222-2222-2222-2222-222222222222','79797979-0000-0000-0000-0000000000a1','grade-b-navy','Grade B velvet, navy',8000,3800,7,'#1f2a44','GB-NAV',2),
  ('22222222-2222-2222-2222-222222222222','79797979-0000-0000-0000-0000000000a1','grade-c-cognac','Grade C leather, cognac',30000,15000,21,'#9a5b2c','GC-COG',3),
  ('22222222-2222-2222-2222-222222222222','79797979-0000-0000-0000-0000000000a2','walnut','Walnut',0,0,0,'#5b3a29','LG-WAL',1),
  ('22222222-2222-2222-2222-222222222222','79797979-0000-0000-0000-0000000000a2','black','Matte black',0,0,0,'#222222','LG-BLK',2);

-- ----------------------------------------- price list and promotion --
insert into price_list (id, entity_id, code, name) values
  ('7a7a7a7a-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','CONTRACT','Contract pricing (apartments, hospitality)');
insert into price_list_item (entity_id, price_list_id, product_id, price_minor) values
  ('22222222-2222-2222-2222-222222222222','7a7a7a7a-0000-0000-0000-000000000001','77777777-0000-0000-0000-000000000021',18999),
  ('22222222-2222-2222-2222-222222222222','7a7a7a7a-0000-0000-0000-000000000001','77777777-0000-0000-0000-000000000024',69999);

insert into promotion (entity_id, name, kind, pct_bps, product_id, starts_on, ends_on, created_by) values
  ('22222222-2222-2222-2222-222222222222','Nightstand event','percent',2000,'77777777-0000-0000-0000-000000000021',
   current_date - 3, current_date + 25, '55555555-0000-0000-0000-000000000001');

-- Opening stock for the new stock items: none of the nightstand anywhere, so it shows up to reorder.
insert into stock_level (entity_id, product_id, location_id, on_hand) values
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000022','33333333-0000-0000-0000-0000000000dc',3),
  ('22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000023','33333333-0000-0000-0000-000000000001',1);

commit;
