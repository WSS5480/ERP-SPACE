-- 0023_tax_sales.sql
-- PLACEHOLDER sales tax setup for the demo company. Rates are illustrative:
-- CHECK WITH YOUR ACCOUNTANT before relying on any of them.
--   Pennsylvania 6% state; Cumberland and Dauphin counties add no local tax.
--   Texas 6.25% state, plus 2% local in Palestine (city 1.5%, Anderson County
--   0.5%) and in Socorro (city 1.5%, El Paso County 0.5%).
-- Delivery charges and protection plans are marked taxable and installation
-- labor exempt in both states; again, check with your accountant.
-- Nothing here is a real record.

begin;

insert into tax_setting (entity_id, sourcing, set_by) values ('22222222-2222-2222-2222-222222222222', 'destination', 'seed');

update pos_setting set special_order_deposit_bps = 5000, stocked_deposit_bps = 0, quote_holds_allowed = true, quote_hold_max_days = 3
 where entity_id = '22222222-2222-2222-2222-222222222222';

insert into tax_jurisdiction (id, entity_id, code, name, level, state, taxes_delivery, taxes_labor, taxes_warranty, note, created_by) values
  ('a7a70000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','PA','Pennsylvania','state','PA',true,false,true,
   'Placeholder: 6% state rate. Check with your accountant.','seed'),
  ('a7a70000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','TX','Texas','state','TX',true,false,true,
   'Placeholder: 6.25% state rate. Check with your accountant.','seed'),
  ('a7a70000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','TX-PALESTINE','City of Palestine','city','TX',true,false,true,
   'Placeholder: 1.5% city rate. Check with your accountant.','seed'),
  ('a7a70000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','TX-ANDERSON','Anderson County','county','TX',true,false,true,
   'Placeholder: 0.5% county rate. Check with your accountant.','seed'),
  ('a7a70000-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','TX-SOCORRO','City of Socorro','city','TX',true,false,true,
   'Placeholder: 1.5% city rate. Check with your accountant.','seed'),
  ('a7a70000-0000-0000-0000-000000000006','22222222-2222-2222-2222-222222222222','TX-ELPASO','El Paso County','county','TX',true,false,true,
   'Placeholder: 0.5% county rate. Check with your accountant.','seed');

insert into tax_rate (entity_id, jurisdiction_id, rate_bps, effective_from, note, created_by) values
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000001',600,'2000-01-01','check with your accountant','seed'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000002',625,'2000-01-01','check with your accountant','seed'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000003',150,'2000-01-01','check with your accountant','seed'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000004',50,'2000-01-01','check with your accountant','seed'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000005',150,'2000-01-01','check with your accountant','seed'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000006',50,'2000-01-01','check with your accountant','seed');

-- Statewide, then the local ones by postal code (stores are placed by their own address).
insert into tax_area (entity_id, jurisdiction_id, state, postal) values
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000001','PA',null),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000002','TX',null),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000003','TX','75801'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000003','TX','75802'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000003','TX','75803'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000004','TX','75801'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000004','TX','75802'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000004','TX','75803'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000005','TX','79927'),
  ('22222222-2222-2222-2222-222222222222','a7a70000-0000-0000-0000-000000000006','TX','79927');

-- The business customer's resale certificate (its tax_exempt_ref from 0014).
insert into tax_exemption_certificate (entity_id, customer_id, number, state, reason, expires_on, created_by) values
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000005','PA-REV-1220-0042871','PA','resale',
   current_date + interval '3 years','seed');

commit;
