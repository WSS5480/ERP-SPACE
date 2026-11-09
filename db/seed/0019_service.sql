-- 0019_service.sql
-- PLACEHOLDER service and repair data: the accounts service posts to, a
-- technician who also drives the service van, service charge products, a
-- replacement part bought from a vendor, manufacturer warranty rules, a
-- protection plan's terms, an outside repair company, and one open ticket.
-- Nothing here is a real record.

begin;

insert into gl_account (tenant_id, code, name, account_type, normal_balance) values
  ('11111111-1111-1111-1111-111111111111','1150','Vendor chargebacks receivable','asset','D'),
  ('11111111-1111-1111-1111-111111111111','4050','Service revenue','revenue','C'),
  ('11111111-1111-1111-1111-111111111111','6150','Warranty and service expense','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6155','Service labor applied','expense','C')
on conflict (tenant_id, code) do nothing;
insert into entity_gl_account (entity_id, gl_account_id)
select '22222222-2222-2222-2222-222222222222', id from gl_account
 where tenant_id = '11111111-1111-1111-1111-111111111111' and code in ('1150','4050','6150','6155')
on conflict do nothing;

-- Pat fixes furniture and drives the service van, so Pat is on the delivery crew too.
insert into app_user (id, tenant_id, email, name) values
  ('55555555-0000-0000-0000-000000000031','11111111-1111-1111-1111-111111111111','pat.tech@example.com','Pat (technician)');
insert into role_grant (app_user_id, entity_id, role) values
  ('55555555-0000-0000-0000-000000000031','22222222-2222-2222-2222-222222222222','technician'),
  ('55555555-0000-0000-0000-000000000031','22222222-2222-2222-2222-222222222222','driver');
insert into driver_profile (entity_id, app_user_id, kind, license_class, license_state, license_last4, license_expires, phone, hourly_cost_minor) values
  ('22222222-2222-2222-2222-222222222222','55555555-0000-0000-0000-000000000031','driver','C','PA','7720','2028-06-30','717-555-0161',3000);

insert into product (id, entity_id, sku, name, kind, vendor_id, vendor_sku, brand, category, subcategory, price_minor, cost_minor, taxable, ship_class, cubic_ft, weight_lb) values
  ('77777777-0000-0000-0000-000000000051','22222222-2222-2222-2222-222222222222','SVC-REPAIR-CALL','In-home service call','service',
   null,null,null,'Services','Repair',8900,0,false,'none',null,null),
  ('77777777-0000-0000-0000-000000000052','22222222-2222-2222-2222-222222222222','SVC-LABOR-HR','Repair labor, per hour','service',
   null,null,null,'Services','Repair',6500,0,false,'none',null,null),
  ('77777777-0000-0000-0000-000000000053','22222222-2222-2222-2222-222222222222','PRT-U8303-MOTOR','Power recline motor (U8303)','stock',
   '66666666-0000-0000-0000-0000000000a3','U8303-MTR','Global','Parts','Recliner parts',12900,4500,true,'parcel',1,6);

insert into service_warranty_rule (entity_id, vendor_id, category, months, covers, note) values
  ('22222222-2222-2222-2222-222222222222', null, null, 12, '{defect,warranty,assembly}', 'Default: one year parts and labor'),
  ('22222222-2222-2222-2222-222222222222', '66666666-0000-0000-0000-0000000000a3', null, 24, '{defect,warranty}', 'Global: two years on mechanisms'),
  ('22222222-2222-2222-2222-222222222222', null, 'Mattresses', 120, '{defect,warranty}', 'Mattresses: ten-year limited');

insert into entity_setting (entity_id, key, value, set_by) values
  ('22222222-2222-2222-2222-222222222222','service.sla_hours','{"urgent":24,"high":48,"normal":120,"low":240}','seed'),
  ('22222222-2222-2222-2222-222222222222','service.labor_rate_minor','3000','seed'),
  ('22222222-2222-2222-2222-222222222222','service.plan_terms',
   '{"SVC-PROTECT-5Y":{"years":5,"covers":["protection_plan","defect","warranty","comfort"],"name":"5-year protection plan"}}','seed')
on conflict (entity_id, key) do nothing;

insert into service_provider (entity_id, name, phone, email, vendor_id, hourly_rate_minor, categories) values
  ('22222222-2222-2222-2222-222222222222','Keystone Furniture Repair','717-555-0170','jobs@keystone.example',null,7500,'{Living room,Dining,Bedroom}');

-- One open ticket from a phone call, so the screens have something to show.
insert into service_ticket (id, entity_id, number, source, customer_id, address_id, issue_type, description, priority, sla_due_at, created_by)
select 'a3a3a3a3-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
       next_doc_no('22222222-2222-2222-2222-222222222222','service','SV-'), 'phone',
       '88888888-0000-0000-0000-000000000006', a.id, 'comfort',
       'Seat cushion on the left side has gone flat after three months.', 'normal', now() + interval '5 days',
       '55555555-0000-0000-0000-000000000011'
  from customer_address a where a.entity_id = '22222222-2222-2222-2222-222222222222' and a.customer_id = '88888888-0000-0000-0000-000000000006' and a.is_default;

commit;
