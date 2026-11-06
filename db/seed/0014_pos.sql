-- 0014_pos.sql
-- PLACEHOLDER point-of-sale setup: the company's POS settings (discount
-- limit, quote life, layaway terms, the delivery and protection add-ons),
-- registers at each store, and a tax-exemption certificate on the business
-- customer. Nothing here is a real record.

begin;

insert into pos_setting (entity_id, discount_limit_bps, quote_valid_days, layaway_min_deposit_bps, layaway_max_days, layaway_installments,
                         delivery_product_id, protection_product_id)
values ('22222222-2222-2222-2222-222222222222', 1000, 30, 2000, 90, 4,
        '77777777-0000-0000-0000-000000000011', '77777777-0000-0000-0000-000000000012');

insert into pos_register (id, entity_id, location_id, code, name) values
  ('9a9a0000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-000000000001','R1','Enola front counter'),
  ('9a9a0000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-000000000001','T1','Enola sales tablet'),
  ('9a9a0000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-000000000002','R1','Palestine counter'),
  ('9a9a0000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-000000000003','R1','Socorro counter');

update customer set tax_exempt_ref = 'PA-REV-1220-0042871'
 where id = '88888888-0000-0000-0000-000000000005' and entity_id = '22222222-2222-2222-2222-222222222222';

commit;
