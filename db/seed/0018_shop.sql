-- 0018_shop.sql
-- PLACEHOLDER web store for the demo company: a live storefront at
-- /shop/buddys/, a web admin, a parcel-shippable item so every fulfillment
-- path has something to buy, one product left unpublished for the publish
-- screen, and two carts left behind. Nothing here is a real record.

begin;

insert into app_user (id, tenant_id, email, name) values
  ('55555555-0000-0000-0000-000000000019','11111111-1111-1111-1111-111111111111','web@example.com','Kim (web store)');
insert into role_grant (app_user_id, entity_id, role) values
  ('55555555-0000-0000-0000-000000000019','22222222-2222-2222-2222-222222222222','web_admin');

-- A parcel item (ships by carrier) and an unpublished one.
insert into product (id, entity_id, sku, name, kind, vendor_id, vendor_sku, brand, category, subcategory,
                     collection, color, description, price_minor, cost_minor, ship_class, cubic_ft, weight_lb, web_visible) values
  ('77777777-0000-0000-0000-000000000020','22222222-2222-2222-2222-222222222222','ACC-PILLOW-VV2','Velvet throw pillows (2-pack)','stock',
   '66666666-0000-0000-0000-0000000000a2','905511','Coaster','Accents','Pillows',null,'Navy',
   'Two 20" square velvet pillows with feather-blend inserts.',4999,1600,'parcel',1.5,4,true),
  ('77777777-0000-0000-0000-000000000021','22222222-2222-2222-2222-222222222222','ASH-B192-92','Willowton Nightstand','stock',
   '66666666-0000-0000-0000-0000000000a1','B192-92','Ashley','Bedroom','Nightstands','Willowton','Whitewash',
   'Two-drawer nightstand to match the Willowton bed and dresser.',18999,8000,'delivery',6,45,false);

update product set description = case sku
  when 'ASH-2930338' then 'Deep seats and pillow-top arms in a soft cobblestone weave.'
  when 'CUW-SOFA-CUSTOM' then 'Built to order in our partner''s upholstery shop: pick the size, the fabric and the legs.'
  when 'MAT-QHYB12' then 'Pocketed coils under a gel memory-foam comfort layer.'
  else description end
 where entity_id = '22222222-2222-2222-2222-222222222222' and description is null;

-- Opening stock for the two new items (the DC and each store), as 0010 does for the rest.
insert into stock_level (entity_id, product_id, location_id, on_hand)
select '22222222-2222-2222-2222-222222222222', p.id, l.id,
       case when l.kind = 'warehouse' then 20 else 4 end
  from product p cross join location l
 where p.id in ('77777777-0000-0000-0000-000000000020','77777777-0000-0000-0000-000000000021')
   and l.entity_id = '22222222-2222-2222-2222-222222222222' and l.kind in ('warehouse','store');

insert into shop_site (id, entity_id, slug, display_name, tagline, brand_primary, brand_accent,
                       web_location_id, tax_location_id, pickup_location_ids,
                       delivery_fee_minor, free_delivery_over_minor, delivery_days, ship_fee_minor, ship_days,
                       mto_base_days, backorder_days, fee_product_id, financing_url, policies, status) values
  ('99990000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','buddys',
   'Buddy''s Home Furnishings','Furniture for every room, delivered and set up.','#23324a','#c08a3e',
   '33333333-0000-0000-0000-0000000000eb','33333333-0000-0000-0000-000000000001',
   array['33333333-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','33333333-0000-0000-0000-000000000003']::uuid[],
   9900, 199900, 5, 1499, 4, 35, 21,
   '77777777-0000-0000-0000-000000000011','https://example.com/apply',
   'Delivery: white-glove delivery and setup from our distribution center, Monday to Saturday. Pickup: we hold your order at the store for 7 days. Returns: unused stock items within 30 days; made-to-order pieces are final sale. Placeholder text — replace with your own policies.',
   'live');

-- Two carts left behind (no order), one with an email so it can be followed up.
insert into shop_cart (site_id, id, entity_id, email, lines, item_count, subtotal_minor, created_at, updated_at) values
  ('99990000-0000-0000-0000-000000000001','seedcart-0001','22222222-2222-2222-2222-222222222222','brian@example.com',
   '[{"productId":"77777777-0000-0000-0000-000000000007","sku":"GLB-U8303","name":"Recliner, power","qty":1,"unitPriceMinor":"64999","choices":[]}]',
   1, 64999, now() - interval '2 days', now() - interval '2 days'),
  ('99990000-0000-0000-0000-000000000001','seedcart-0002','22222222-2222-2222-2222-222222222222',null,
   '[{"productId":"77777777-0000-0000-0000-000000000009","sku":"ACC-LAMP-01","name":"Ceramic table lamp","qty":2,"unitPriceMinor":"5999","choices":[]}]',
   2, 11998, now() - interval '5 hours', now() - interval '5 hours');

commit;
