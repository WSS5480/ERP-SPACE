-- 0026_configurator.sql
-- PLACEHOLDER demo data for the configurator (migration 0043): the Hudson
-- sectional (fifteen piece SKUs, five popular layouts), Custom Upholstery
-- Works' grade table A, B, C and L1 with swatches, motion and power options
-- with their rules, a made-to-order mattress, table, chair, bed and lift
-- chair whose options depend on each other, and Buddy's condition grades.
begin;

insert into product (id, entity_id, sku, name, kind, vendor_id, vendor_sku, brand, category, subcategory, collection, color, price_minor, cost_minor, serialized, ship_class, cubic_ft, weight_lb, web_visible, description) values
  ('c0c00000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','CUW-HUD-SECT','Hudson sectional, build your own','configurable','66666666-0000-0000-0000-0000000000a4','HUD-SECT','Custom Upholstery Works','Living room','Sectionals','Hudson',null,199900,0,false,'delivery',null,null,true,'Pick the pieces, the layout and the cover. Every piece is made to order in your fabric, or ships from stock in oat linen.'),
  ('c0c00000-0000-0000-0000-000000000101','22222222-2222-2222-2222-222222222222','CUW-HUD-LS','Hudson LAF sofa','stock','66666666-0000-0000-0000-0000000000a4','HUD-LS','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',99900,45000,false,'delivery',55,140,false,null),
  ('c0c00000-0000-0000-0000-000000000102','22222222-2222-2222-2222-222222222222','CUW-HUD-RS','Hudson RAF sofa','stock','66666666-0000-0000-0000-0000000000a4','HUD-RS','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',99900,45000,false,'delivery',55,140,false,null),
  ('c0c00000-0000-0000-0000-000000000103','22222222-2222-2222-2222-222222222222','CUW-HUD-LL','Hudson LAF loveseat','stock','66666666-0000-0000-0000-0000000000a4','HUD-LL','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',79900,36000,false,'delivery',40,105,false,null),
  ('c0c00000-0000-0000-0000-000000000104','22222222-2222-2222-2222-222222222222','CUW-HUD-RL','Hudson RAF loveseat','stock','66666666-0000-0000-0000-0000000000a4','HUD-RL','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',79900,36000,false,'delivery',40,105,false,null),
  ('c0c00000-0000-0000-0000-000000000105','22222222-2222-2222-2222-222222222222','CUW-HUD-LC','Hudson LAF chair','stock','66666666-0000-0000-0000-0000000000a4','HUD-LC','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',59900,27000,false,'delivery',26,70,false,null),
  ('c0c00000-0000-0000-0000-000000000106','22222222-2222-2222-2222-222222222222','CUW-HUD-RC','Hudson RAF chair','stock','66666666-0000-0000-0000-0000000000a4','HUD-RC','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',59900,27000,false,'delivery',26,70,false,null),
  ('c0c00000-0000-0000-0000-000000000107','22222222-2222-2222-2222-222222222222','CUW-HUD-AC','Hudson armless chair','stock','66666666-0000-0000-0000-0000000000a4','HUD-AC','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',44900,20000,false,'delivery',20,55,false,null),
  ('c0c00000-0000-0000-0000-000000000108','22222222-2222-2222-2222-222222222222','CUW-HUD-AL','Hudson armless loveseat','stock','66666666-0000-0000-0000-0000000000a4','HUD-AL','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',69900,31000,false,'delivery',36,90,false,null),
  ('c0c00000-0000-0000-0000-000000000109','22222222-2222-2222-2222-222222222222','CUW-HUD-WG','Hudson wedge','stock','66666666-0000-0000-0000-0000000000a4','HUD-WG','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',54900,25000,false,'delivery',38,85,false,null),
  ('c0c00000-0000-0000-0000-000000000110','22222222-2222-2222-2222-222222222222','CUW-HUD-CR','Hudson corner','stock','66666666-0000-0000-0000-0000000000a4','HUD-CR','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',49900,22000,false,'delivery',30,70,false,null),
  ('c0c00000-0000-0000-0000-000000000111','22222222-2222-2222-2222-222222222222','CUW-HUD-LCH','Hudson LAF chaise','stock','66666666-0000-0000-0000-0000000000a4','HUD-LCH','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',79900,36000,false,'delivery',45,110,false,null),
  ('c0c00000-0000-0000-0000-000000000112','22222222-2222-2222-2222-222222222222','CUW-HUD-RCH','Hudson RAF chaise','stock','66666666-0000-0000-0000-0000000000a4','HUD-RCH','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',79900,36000,false,'delivery',45,110,false,null),
  ('c0c00000-0000-0000-0000-000000000113','22222222-2222-2222-2222-222222222222','CUW-HUD-OT','Hudson cocktail ottoman','stock','66666666-0000-0000-0000-0000000000a4','HUD-OT','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',29900,13000,false,'delivery',14,35,false,null),
  ('c0c00000-0000-0000-0000-000000000114','22222222-2222-2222-2222-222222222222','CUW-HUD-CN','Hudson storage console','stock','66666666-0000-0000-0000-0000000000a4','HUD-CN','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',34900,15000,false,'delivery',10,40,false,null),
  ('c0c00000-0000-0000-0000-000000000115','22222222-2222-2222-2222-222222222222','CUW-HUD-APR','Hudson armless power recliner','stock','66666666-0000-0000-0000-0000000000a4','HUD-APR','Custom Upholstery Works','Living room','Sectional pieces','Hudson','Oat linen',74900,34000,false,'delivery',24,85,false,null);

insert into fabric_grade_table (id, entity_id, vendor_id, code, name) values
  ('c0c00000-0000-0000-0000-000000000201','22222222-2222-2222-2222-222222222222','66666666-0000-0000-0000-0000000000a4','CUW','Custom Upholstery Works covers');
insert into fabric_grade (id, entity_id, table_id, code, label, uplift_bps, cost_uplift_bps, seq) values
  ('c0c00000-0000-0000-0000-000000000211','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000201','A','Grade A',0,0,1),
  ('c0c00000-0000-0000-0000-000000000212','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000201','B','Grade B',1000,1000,2),
  ('c0c00000-0000-0000-0000-000000000213','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000201','C','Grade C',2000,2000,3),
  ('c0c00000-0000-0000-0000-000000000214','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000201','L1','Leather L1',3500,3500,4);
insert into fabric_grade_adder (entity_id, grade_id, piece_type, price_adder_minor, cost_adder_minor) values
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','laf_sofa',15000,7000),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','raf_sofa',15000,7000),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','laf_loveseat',12000,5500),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','raf_loveseat',12000,5500),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','laf_chair',8000,3600),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','raf_chair',8000,3600),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','armless_chair',7000,3200),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','armless_loveseat',11000,5000),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','wedge',9000,4000),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','corner',7000,3200),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','laf_chaise',10000,4500),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','raf_chaise',10000,4500),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','ottoman',5000,2200),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000212','console',4000,1800);
insert into swatch (id, entity_id, grade_table_id, grade_code, code, cover_name, material, color_family, color, content, cleaning_code, vendor_code, hex, discontinued_on) values
  ('c0c00000-0000-0000-0000-000000000301','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000201','A','oat-linen','Performance linen, oat','performance','beige','Oat','100% polyester','W','PL-OAT','#d8cbb3',null),
  ('c0c00000-0000-0000-0000-000000000302','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000201','B','navy-velvet','Velvet, navy','fabric','blue','Navy','100% polyester velvet','S','VV-NAV','#1f2a44',null),
  ('c0c00000-0000-0000-0000-000000000303','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000201','B','sage-velvet','Velvet, sage','fabric','green','Sage','100% polyester velvet','S','VV-SAG','#87947a',null),
  ('c0c00000-0000-0000-0000-000000000304','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000201','C','stone-boucle','Boucle, stone','fabric','gray','Stone','62% polyester, 38% acrylic','S','BC-STN','#b9b3a9',null),
  ('c0c00000-0000-0000-0000-000000000305','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000201','L1','cognac-leather','Top-grain leather, cognac','leather','brown','Cognac','Top-grain leather','S','TG-COG','#9a5b2c',null),
  ('c0c00000-0000-0000-0000-000000000306','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000201','B','tweed-retired','Tweed, heather (retired)','fabric','gray','Heather','Wool blend','WS','TW-HTH','#8d8a86','2026-01-01');

insert into sectional_family (product_id, entity_id, min_pieces, max_pieces, bundle_discount_bps, bundle_min_pieces, grade_table_id, stock_swatch_id, notes) values
  ('c0c00000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',2,7,500,3,'c0c00000-0000-0000-0000-000000000201','c0c00000-0000-0000-0000-000000000301','Stocked in oat linen at the DC; every other cover is made to order, about six weeks.');
insert into sectional_piece (entity_id, family_id, product_id, code, piece_type, motion, width_in, depth_in, height_in, seats, seq) values
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000101','laf-sofa','laf_sofa','none',90,38,36,3,1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000102','raf-sofa','raf_sofa','none',90,38,36,3,2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000103','laf-loveseat','laf_loveseat','none',64,38,36,2,3),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000104','raf-loveseat','raf_loveseat','none',64,38,36,2,4),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000105','laf-chair','laf_chair','none',40,38,36,1,5),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000106','raf-chair','raf_chair','none',40,38,36,1,6),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000107','armless-chair','armless_chair','none',30,38,36,1,7),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000108','armless-loveseat','armless_loveseat','none',58,38,36,2,8),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000109','wedge','wedge','none',50,50,36,1,9),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000110','corner','corner','none',38,38,36,1,10),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000111','laf-chaise','laf_chaise','none',36,65,36,1,11),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000112','raf-chaise','raf_chaise','none',36,65,36,1,12),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000113','ottoman','ottoman','none',36,28,36,0,13),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000114','console','console','none',14,38,36,0,14),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','c0c00000-0000-0000-0000-000000000115','armless-recliner','armless_chair','power',32,38,36,1,15);
insert into sectional_layout (entity_id, family_id, code, name, pieces, seq) values
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','3pc-sofa-wedge-loveseat','3-pc LAF sofa / wedge / RAF loveseat',array['laf-sofa','wedge','raf-loveseat'],1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','2pc-sofa-chaise','2-pc LAF sofa / RAF chaise',array['laf-sofa','raf-chaise'],2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','3pc-l-corner','3-pc L: LAF loveseat / corner / RAF sofa',array['laf-loveseat','corner','raf-sofa'],3),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','5pc-u','5-pc U: loveseat / corner / armless loveseat / corner / loveseat',array['laf-loveseat','corner','armless-loveseat','corner','raf-loveseat'],4),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','5pc-theater','5-pc power theater: chair / recliner / console / recliner / chair',array['laf-chair','armless-recliner','console','armless-recliner','raf-chair'],5);

-- Stock in the stock cover at the DC.
insert into stock_level (entity_id, product_id, location_id, on_hand) values
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000101','33333333-0000-0000-0000-0000000000dc',3),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000103','33333333-0000-0000-0000-0000000000dc',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000104','33333333-0000-0000-0000-0000000000dc',3),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000107','33333333-0000-0000-0000-0000000000dc',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000109','33333333-0000-0000-0000-0000000000dc',3),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000112','33333333-0000-0000-0000-0000000000dc',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000113','33333333-0000-0000-0000-0000000000dc',2);

-- Made-to-order goods whose options depend on each other.
insert into product (id, entity_id, sku, name, kind, vendor_id, vendor_sku, brand, category, subcategory, collection, color, price_minor, cost_minor, serialized, ship_class, cubic_ft, weight_lb, web_visible) values
  ('c0c00000-0000-0000-0000-000000000401','22222222-2222-2222-2222-222222222222','MAT-BAY-CUSTOM','Bayview hybrid mattress, made to order','configurable','66666666-0000-0000-0000-0000000000a1','BAY-HYB','Sierra Sleep','Mattresses','Custom',null,null,69900,28000,false,'delivery',16,70,true),
  ('c0c00000-0000-0000-0000-000000000402','22222222-2222-2222-2222-222222222222','COA-ANDREA-EXT','Andrea extension table, made to order','configurable','66666666-0000-0000-0000-0000000000a2','121229','Coaster','Dining','Tables','Andrea','Cappuccino',59900,25000,false,'delivery',24,120,true),
  ('c0c00000-0000-0000-0000-000000000403','22222222-2222-2222-2222-222222222222','COA-ANDREA-UPH','Andrea upholstered side chair','configurable','66666666-0000-0000-0000-0000000000a2','121224','Coaster','Dining','Chairs','Andrea','Cappuccino',16900,7000,false,'delivery',8,25,true),
  ('c0c00000-0000-0000-0000-000000000404','22222222-2222-2222-2222-222222222222','ASH-B192-STOR','Willowton storage bed, made to order','configurable','66666666-0000-0000-0000-0000000000a1','B192-STOR','Ashley','Bedroom','Beds','Willowton','Whitewash',79900,35000,false,'delivery',34,180,true),
  ('c0c00000-0000-0000-0000-000000000405','22222222-2222-2222-2222-222222222222','GLB-LIFT-CUSTOM','Lift chair, made to order','configurable','66666666-0000-0000-0000-0000000000a3','U9900-C','Global','Living room','Recliners','U9900','Grey',89900,40000,false,'delivery',30,120,true);
insert into product_option_group (id, entity_id, product_id, code, label, required, seq) values
  ('c0c00000-0000-0000-0000-000000000501','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','recline','Recline',false,1),
  ('c0c00000-0000-0000-0000-000000000502','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','headrest','Headrest',false,2),
  ('c0c00000-0000-0000-0000-000000000503','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','lumbar','Lumbar',false,3),
  ('c0c00000-0000-0000-0000-000000000504','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','usb','Charging',false,4),
  ('c0c00000-0000-0000-0000-000000000511','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000401','size','Size',true,1),
  ('c0c00000-0000-0000-0000-000000000512','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000401','firmness','Firmness',true,2),
  ('c0c00000-0000-0000-0000-000000000513','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000401','topper','Topper',false,3),
  ('c0c00000-0000-0000-0000-000000000514','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000401','base','Base',false,4),
  ('c0c00000-0000-0000-0000-000000000521','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000402','size','Size',true,1),
  ('c0c00000-0000-0000-0000-000000000522','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000402','leaves','Leaves',true,2),
  ('c0c00000-0000-0000-0000-000000000531','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000403','upholstery','Upholstery',true,1),
  ('c0c00000-0000-0000-0000-000000000532','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000403','nailhead','Nailhead trim',false,2),
  ('c0c00000-0000-0000-0000-000000000541','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000404','size','Size',true,1),
  ('c0c00000-0000-0000-0000-000000000542','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000404','storage','Storage',false,2),
  ('c0c00000-0000-0000-0000-000000000543','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000404','height','Height',true,3),
  ('c0c00000-0000-0000-0000-000000000551','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000405','lift','Lift rating',true,1),
  ('c0c00000-0000-0000-0000-000000000552','22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000405','motor','Motor',true,2);
insert into product_option (entity_id, group_id, code, label, price_delta_minor, cost_delta_minor, lead_days, vendor_code, seq) values
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000501','manual','Manual recline',20000,9000,0,'RCL-M',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000501','power','Power recline',35000,16000,7,'RCL-P',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000502','power-headrest','Power headrest',15000,6000,7,'PH',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000503','power-lumbar','Power lumbar',12000,5000,7,'PL',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000504','usb-c','USB-C charging',4000,1500,0,'USB',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000511','twin','Twin',0,0,0,'T',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000511','full','Full',20000,8000,0,'F',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000511','queen','Queen',40000,16000,0,'Q',3),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000511','king','King',60000,24000,0,'K',4),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000512','plush','Plush',0,0,0,'PLU',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000512','medium','Medium',0,0,0,'MED',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000512','firm','Firm',0,0,0,'FRM',3),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000513','pillow-top','Pillow top',15000,6000,0,'PT',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000514','adjustable','Adjustable base',79900,35000,7,'ADJ',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000521','60','60 inch',0,0,0,'T60',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000521','72','72 inch',15000,6000,0,'T72',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000522','none','No leaf',0,0,0,'L0',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000522','one','One 18 inch leaf',9000,3500,0,'L1',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000522','two','Two 18 inch leaves',16000,6500,0,'L2',3),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000531','fabric','Linen fabric seat',0,0,0,'UF',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000531','leather','Leather seat',6000,2500,7,'UL',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000532','nailhead','Nailhead trim',2000,800,0,'NH',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000541','queen','Queen',0,0,0,'Q',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000541','king','King',20000,9000,0,'K',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000542','drawers','Footboard drawers',25000,11000,7,'DRW',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000543','standard','Standard height',0,0,0,'STD',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000543','low-profile','Low profile',0,0,0,'LOW',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000551','lift-300','Lift, 300 lb rating',0,0,0,'L300',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000551','lift-400','Lift, 400 lb rating',15000,6500,0,'L400',2),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000551','lift-500','Bariatric lift, 500 lb rating',35000,15000,14,'L500',3),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000552','single','Single motor',0,0,0,'M1',1),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000552','dual','Dual motor (infinite position)',20000,9000,0,'M2',2);

-- The rules: requires, excludes, and only on these pieces.
insert into product_option_rule (entity_id, product_id, group_code, option_code, kind, target_group, target_options, piece_types, message) values
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','recline',null,'only_on',null,'{}',array['laf_sofa','raf_sofa','laf_loveseat','raf_loveseat','laf_chair','raf_chair','armless_chair'],'Recline is offered on sofas, loveseats and chairs only.'),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','headrest','power-headrest','requires','recline',array['power'],'{}','A power headrest needs power recline.'),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','lumbar','power-lumbar','requires','recline',array['power'],'{}','Power lumbar needs power recline.'),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','headrest',null,'only_on',null,'{}',array['laf_sofa','raf_sofa','laf_loveseat','raf_loveseat','laf_chair','raf_chair','armless_chair'],'A power headrest goes on a seat that reclines.'),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000001','usb','usb-c','only_on',null,'{}',array['console','armless_chair','laf_chair','raf_chair'],'USB charging is built into the console and the chairs only.'),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000401','topper','pillow-top','excludes','firmness',array['firm'],'{}','A pillow top is not made in firm.'),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000401','base','adjustable','requires','size',array['queen','king'],'{}','The adjustable base comes in queen and king only.'),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000402','leaves','two','requires','size',array['72'],'{}','Two leaves fit the 72 inch table only.'),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000403','nailhead','nailhead','requires','upholstery',array['leather'],'{}','Nailhead trim is offered on the leather seat only.'),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000404','storage','drawers','excludes','height',array['low-profile'],'{}','Storage drawers do not fit under the low-profile frame.'),
  ('22222222-2222-2222-2222-222222222222','c0c00000-0000-0000-0000-000000000405','lift','lift-500','requires','motor',array['dual'],'{}','The 500 lb bariatric lift needs the dual motor.');

-- Condition grades: the share of retail an as-is piece sells for.
insert into condition_grade_rule (entity_id, grade, pct_bps) values
  ('22222222-2222-2222-2222-222222222222','new',10000), ('22222222-2222-2222-2222-222222222222','like_new',8500), ('22222222-2222-2222-2222-222222222222','good',7000), ('22222222-2222-2222-2222-222222222222','fair',5000), ('22222222-2222-2222-2222-222222222222','damaged',3000);

commit;
