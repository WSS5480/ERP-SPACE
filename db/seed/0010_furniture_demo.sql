-- 0010_furniture_demo.sql
-- PLACEHOLDER furniture-retail data shared by every retail module: the GL
-- accounts a retailer needs, a distribution center, store addresses and map
-- points, furniture vendors, a dozen SKUs (one customizable sofa), opening
-- stock, customers with delivery addresses, and staff in each new role.
-- Nothing here is a real record.

begin;

-- --------------------------------------------------- retail GL accounts --
insert into gl_account (tenant_id, code, name, account_type, normal_balance) values
  ('11111111-1111-1111-1111-111111111111','1100','Accounts receivable, customers','asset','D'),
  ('11111111-1111-1111-1111-111111111111','1110','Receivable from finance companies','asset','D'),
  ('11111111-1111-1111-1111-111111111111','1190','Allowance for doubtful accounts','asset','C'),
  ('11111111-1111-1111-1111-111111111111','1300','Merchandise inventory','asset','D'),
  ('11111111-1111-1111-1111-111111111111','1310','Inventory in transit','asset','D'),
  ('11111111-1111-1111-1111-111111111111','1050','Undeposited funds','asset','D'),
  ('11111111-1111-1111-1111-111111111111','2300','Customer deposits','liability','C'),
  ('11111111-1111-1111-1111-111111111111','2310','Gift cards outstanding','liability','C'),
  ('11111111-1111-1111-1111-111111111111','2320','Store credit outstanding','liability','C'),
  ('11111111-1111-1111-1111-111111111111','2160','Commissions payable','liability','C'),
  ('11111111-1111-1111-1111-111111111111','4000','Merchandise sales','revenue','C'),
  ('11111111-1111-1111-1111-111111111111','4030','Delivery and setup revenue','revenue','C'),
  ('11111111-1111-1111-1111-111111111111','4040','Protection plan revenue','revenue','C'),
  ('11111111-1111-1111-1111-111111111111','4900','Sales returns and allowances','revenue','D'),
  ('11111111-1111-1111-1111-111111111111','4910','Sales discounts','revenue','D'),
  ('11111111-1111-1111-1111-111111111111','5000','Cost of goods sold','expense','D'),
  ('11111111-1111-1111-1111-111111111111','5030','Freight in','expense','D'),
  ('11111111-1111-1111-1111-111111111111','5040','Inventory shrink and damage','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6130','Sales commissions','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6900','Bad debt expense','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6910','Card and finance fees','expense','D');

insert into entity_gl_account (entity_id, gl_account_id)
select '22222222-2222-2222-2222-222222222222', id from gl_account
 where tenant_id = '11111111-1111-1111-1111-111111111111'
   and code in ('1100','1110','1190','1300','1310','1050','2300','2310','2320','2160','4000','4030','4040',
                '4900','4910','5000','5030','5040','6130','6900','6910')
on conflict do nothing;

-- ------------------------------------------- stores, DC, addresses, tax --
update location set kind = 'store', tax_rate_bps = 600, geo = point(-76.9336, 40.2601),
  address = '{"line1":"100 Main St","city":"Enola","state":"PA","postal":"17025"}'
 where id = '33333333-0000-0000-0000-000000000001';
update location set kind = 'store', tax_rate_bps = 825, geo = point(-95.6308, 31.7621),
  address = '{"line1":"200 Spring St","city":"Palestine","state":"TX","postal":"75801"}'
 where id = '33333333-0000-0000-0000-000000000002';
update location set kind = 'store', tax_rate_bps = 825, geo = point(-106.3031, 31.6546),
  address = '{"line1":"300 Horizon Blvd","city":"Socorro","state":"TX","postal":"79927"}'
 where id = '33333333-0000-0000-0000-000000000003';

insert into location (id, entity_id, code, name, state, kind, geo, address) values
  ('33333333-0000-0000-0000-0000000000dc','22222222-2222-2222-2222-222222222222','DC1',
   'Distribution center','PA','warehouse', point(-76.9000, 40.2800),
   '{"line1":"1 Logistics Way","city":"Enola","state":"PA","postal":"17025"}'),
  ('33333333-0000-0000-0000-0000000000eb','22222222-2222-2222-2222-222222222222','WEB',
   'Online store','PA','web', null, '{}');

-- ------------------------------------------------------- staff in roles --
insert into app_user (id, tenant_id, email, name) values
  ('55555555-0000-0000-0000-000000000011','11111111-1111-1111-1111-111111111111','sales@example.com','Maria (sales)'),
  ('55555555-0000-0000-0000-000000000012','11111111-1111-1111-1111-111111111111','cashier@example.com','Luis (cashier)'),
  ('55555555-0000-0000-0000-000000000013','11111111-1111-1111-1111-111111111111','warehouse@example.com','Dee (warehouse)'),
  ('55555555-0000-0000-0000-000000000014','11111111-1111-1111-1111-111111111111','dispatch@example.com','Ray (dispatch)'),
  ('55555555-0000-0000-0000-000000000015','11111111-1111-1111-1111-111111111111','driver@example.com','Tony (driver)'),
  ('55555555-0000-0000-0000-000000000016','11111111-1111-1111-1111-111111111111','buyer@example.com','Ana (buyer)'),
  ('55555555-0000-0000-0000-000000000017','11111111-1111-1111-1111-111111111111','ar@example.com','Jen (A/R)'),
  ('55555555-0000-0000-0000-000000000018','11111111-1111-1111-1111-111111111111','enolamgr@example.com','Enola manager');

insert into role_grant (app_user_id, entity_id, role) values
  ('55555555-0000-0000-0000-000000000011','22222222-2222-2222-2222-222222222222','sales'),
  ('55555555-0000-0000-0000-000000000012','22222222-2222-2222-2222-222222222222','cashier'),
  ('55555555-0000-0000-0000-000000000013','22222222-2222-2222-2222-222222222222','warehouse'),
  ('55555555-0000-0000-0000-000000000014','22222222-2222-2222-2222-222222222222','dispatcher'),
  ('55555555-0000-0000-0000-000000000015','22222222-2222-2222-2222-222222222222','driver'),
  ('55555555-0000-0000-0000-000000000016','22222222-2222-2222-2222-222222222222','buyer'),
  ('55555555-0000-0000-0000-000000000017','22222222-2222-2222-2222-222222222222','ar_clerk'),
  ('55555555-0000-0000-0000-000000000018','22222222-2222-2222-2222-222222222222','store_manager'),
  ('55555555-0000-0000-0000-000000000018','22222222-2222-2222-2222-222222222222','sales');

-- ------------------------------------------------------ furniture vendors --
insert into vendor (id, tenant_id, legal_name, tax_classification, w9_on_file, status) values
  ('66666666-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','Ashley Furniture Industries','c_corp',true,'active'),
  ('66666666-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111','Coaster Company of America','c_corp',true,'active'),
  ('66666666-0000-0000-0000-0000000000a3','11111111-1111-1111-1111-111111111111','Global Furniture USA','c_corp',true,'active'),
  ('66666666-0000-0000-0000-0000000000a4','11111111-1111-1111-1111-111111111111','Custom Upholstery Works','llc',true,'active');

insert into vendor_entity (vendor_id, entity_id, terms_days, default_gl_account_id)
select v.id, '22222222-2222-2222-2222-222222222222', 30, g.id
  from vendor v, gl_account g
 where v.id in ('66666666-0000-0000-0000-0000000000a1','66666666-0000-0000-0000-0000000000a2',
                '66666666-0000-0000-0000-0000000000a3','66666666-0000-0000-0000-0000000000a4')
   and g.tenant_id = '11111111-1111-1111-1111-111111111111' and g.code = '2050';   -- merchandise bills clear received-not-invoiced; receiving put it in 1300

-- --------------------------------------------------------------- products --
-- ids 77777777-...-0000000000NN; prices and costs in cents
insert into product (id, entity_id, sku, name, kind, vendor_id, vendor_sku, brand, category, subcategory,
                     collection, color, price_minor, cost_minor, serialized, ship_class, cubic_ft, weight_lb, web_visible) values
  ('77777777-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','ASH-2930338','Darcy Sofa','stock',
   '66666666-0000-0000-0000-0000000000a1','2930338','Ashley','Living room','Sofas','Darcy','Cobblestone',79999,38500,true,'delivery',48,145,true),
  ('77777777-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','ASH-2930335','Darcy Loveseat','stock',
   '66666666-0000-0000-0000-0000000000a1','2930335','Ashley','Living room','Loveseats','Darcy','Cobblestone',69999,33000,true,'delivery',38,120,true),
  ('77777777-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','ASH-B192-QBED','Willowton Queen Bed','stock',
   '66666666-0000-0000-0000-0000000000a1','B192-QBED','Ashley','Bedroom','Beds','Willowton','Whitewash',59999,26000,true,'delivery',30,160,true),
  ('77777777-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','ASH-B192-31','Willowton Dresser','stock',
   '66666666-0000-0000-0000-0000000000a1','B192-31','Ashley','Bedroom','Dressers','Willowton','Whitewash',54999,24000,true,'delivery',26,190,true),
  ('77777777-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','COA-121221','Andrea Dining Table','stock',
   '66666666-0000-0000-0000-0000000000a2','121221','Coaster','Dining','Tables','Andrea','Cappuccino',44999,19000,true,'delivery',22,110,true),
  ('77777777-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222','COA-121222','Andrea Side Chair (2-pack)','stock',
   '66666666-0000-0000-0000-0000000000a2','121222','Coaster','Dining','Chairs','Andrea','Cappuccino',19999,8200,false,'delivery',12,48,true),
  ('77777777-0000-0000-0000-000000000007','22222222-2222-2222-2222-222222222222','GLB-U8303','Recliner, power','stock',
   '66666666-0000-0000-0000-0000000000a3','U8303','Global','Living room','Recliners','U8303','Grey',64999,29000,true,'delivery',32,95,true),
  ('77777777-0000-0000-0000-000000000008','22222222-2222-2222-2222-222222222222','MAT-QHYB12','Queen hybrid mattress 12"','stock',
   '66666666-0000-0000-0000-0000000000a1','M43031','Sierra Sleep','Mattresses','Queen',null,'White',89999,36000,true,'delivery',18,80,true),
  ('77777777-0000-0000-0000-000000000009','22222222-2222-2222-2222-222222222222','ACC-LAMP-01','Ceramic table lamp','stock',
   '66666666-0000-0000-0000-0000000000a2','901234','Coaster','Accents','Lamps',null,'Ivory',5999,1900,false,'carry',2,7,true),
  ('77777777-0000-0000-0000-000000000010','22222222-2222-2222-2222-222222222222','CUW-SOFA-CUSTOM','Hudson sofa, made to order','configurable',
   '66666666-0000-0000-0000-0000000000a4','HUD-S','Custom Upholstery Works','Living room','Sofas','Hudson',null,129900,62000,true,'delivery',50,150,true),
  ('77777777-0000-0000-0000-000000000011','22222222-2222-2222-2222-222222222222','SVC-DELIVERY','White-glove delivery and setup','fee',
   null,null,null,'Services','Delivery',null,null,9900,0,false,'none',null,null,false),
  ('77777777-0000-0000-0000-000000000012','22222222-2222-2222-2222-222222222222','SVC-PROTECT-5Y','5-year furniture protection plan','warranty',
   null,null,null,'Services','Protection',null,null,14999,3000,false,'none',null,null,true);

-- The customizable sofa: size, fabric, leg finish.
insert into product_option_group (id, entity_id, product_id, code, label, required, seq) values
  ('78787878-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000010','size','Size',true,1),
  ('78787878-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000010','fabric','Fabric',true,2),
  ('78787878-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','77777777-0000-0000-0000-000000000010','legs','Leg finish',true,3);
insert into product_option (entity_id, group_id, code, label, price_delta_minor, cost_delta_minor, lead_days, swatch, vendor_code, seq) values
  ('22222222-2222-2222-2222-222222222222','78787878-0000-0000-0000-000000000001','84','84" sofa',0,0,0,null,'S84',1),
  ('22222222-2222-2222-2222-222222222222','78787878-0000-0000-0000-000000000001','96','96" sofa',20000,9000,0,null,'S96',2),
  ('22222222-2222-2222-2222-222222222222','78787878-0000-0000-0000-000000000001','sect','Sectional, left chaise',90000,41000,7,null,'SECL',3),
  ('22222222-2222-2222-2222-222222222222','78787878-0000-0000-0000-000000000002','linen-oat','Performance linen, oat',0,0,0,'#d8cbb3','PL-OAT',1),
  ('22222222-2222-2222-2222-222222222222','78787878-0000-0000-0000-000000000002','velvet-navy','Velvet, navy',15000,7000,7,'#1f2a44','VV-NAV',2),
  ('22222222-2222-2222-2222-222222222222','78787878-0000-0000-0000-000000000002','leather-cognac','Top-grain leather, cognac',60000,30000,21,'#9a5b2c','TG-COG',3),
  ('22222222-2222-2222-2222-222222222222','78787878-0000-0000-0000-000000000003','walnut','Walnut',0,0,0,'#5b3a29','LG-WAL',1),
  ('22222222-2222-2222-2222-222222222222','78787878-0000-0000-0000-000000000003','black','Matte black',0,0,0,'#222222','LG-BLK',2),
  ('22222222-2222-2222-2222-222222222222','78787878-0000-0000-0000-000000000003','brass','Brushed brass',8000,3500,0,'#b8964b','LG-BRS',3);

-- Opening stock: the DC holds most of it, stores hold floor models and carry items.
insert into stock_level (entity_id, product_id, location_id, on_hand)
select '22222222-2222-2222-2222-222222222222', p.id, l.id,
       case when l.kind = 'warehouse' then 8 when p.ship_class = 'carry' then 12 else 1 end
  from product p cross join location l
 where p.entity_id = '22222222-2222-2222-2222-222222222222' and p.kind = 'stock'
   and l.entity_id = '22222222-2222-2222-2222-222222222222' and l.kind in ('warehouse','store');

-- ---------------------------------------------------------------- customers --
insert into customer (id, entity_id, number, name, email, phone, credit_limit_minor, terms_days, home_location_id, marketing_ok) values
  ('88888888-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','C-000001','Alicia Gomez','alicia@example.com','717-555-0101',0,0,'33333333-0000-0000-0000-000000000001',true),
  ('88888888-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','C-000002','Brian Kelly','brian@example.com','717-555-0102',0,0,'33333333-0000-0000-0000-000000000001',false),
  ('88888888-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','C-000003','Chen Family','chen@example.com','717-555-0103',300000,30,'33333333-0000-0000-0000-000000000001',true),
  ('88888888-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','C-000004','Dana Wright','dana@example.com','903-555-0104',0,0,'33333333-0000-0000-0000-000000000002',true),
  ('88888888-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','C-000005','Riverside Apartments LLC','ops@riverside.example','717-555-0105',2500000,30,'33333333-0000-0000-0000-000000000001',false),
  ('88888888-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222','C-000006','Ed Martinez','ed@example.com','915-555-0106',0,0,'33333333-0000-0000-0000-000000000003',false);
update customer set kind = 'business' where id = '88888888-0000-0000-0000-000000000005';

insert into customer_address (entity_id, customer_id, label, line1, city, state, postal, geo, stairs, notes, is_default) values
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000001','Home','12 Oak Ln','Camp Hill','PA','17011',point(-76.9199,40.2398),0,null,true),
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000002','Home','45 River Rd','Marysville','PA','17053',point(-77.0236,40.3426),1,'Call 30 min ahead',true),
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000003','Home','9 Linden Ct','Mechanicsburg','PA','17055',point(-77.0086,40.2143),2,'Narrow stairway',true),
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000004','Home','300 Elm St','Palestine','TX','75801',point(-95.6270,31.7700),0,null,true),
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000005','Leasing office','800 Front St','Harrisburg','PA','17101',point(-76.8867,40.2589),0,'Loading dock at rear',true),
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000006','Home','77 Alameda Ave','Socorro','TX','79927',point(-106.2900,31.6600),0,null,true);

update tenant set vertical = 'furniture', aging_label = 'Receivables'
 where id = '11111111-1111-1111-1111-111111111111';

commit;
