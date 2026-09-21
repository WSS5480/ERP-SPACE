-- 0001_pentex.sql
-- Seed data. PLACEHOLDERS, not your records -- replace the entity, the
-- locations and the chart of accounts with the real ones before anything
-- is posted in anger. Everything here exists so the schema can be exercised.

begin;

-- ----------------------------------------------------------------- tenant --

insert into tenant (id, name, vertical, location_label, profit_object_label, aging_label)
values ('11111111-1111-1111-1111-111111111111',
        'Pentex', 'rto', 'Store', 'Store', 'Back balances');

insert into entity (id, tenant_id, name, legal_name, fiscal_year_end_month)
values ('22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
        'Pentex, LLC', 'Pentex, LLC', 12);

insert into location (id, entity_id, code, name, state) values
  ('33333333-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','ENL','Enola','PA'),
  ('33333333-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','PAL','Palestine','TX'),
  ('33333333-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','SOC','Socorro','TX');

-- For a rent-to-own tenant the profit object is the store. For a trucking
-- tenant these rows would be trucks, and nothing else would change.
insert into profit_object (id, entity_id, kind, code, name, location_id) values
  ('44444444-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','store','ENL','Enola','33333333-0000-0000-0000-000000000001'),
  ('44444444-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','store','PAL','Palestine','33333333-0000-0000-0000-000000000002'),
  ('44444444-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','store','SOC','Socorro','33333333-0000-0000-0000-000000000003'),
  ('44444444-0000-0000-0000-000000000009','22222222-2222-2222-2222-222222222222','other','ADM','Administration',null);

insert into department (tenant_id, code, name) values
  ('11111111-1111-1111-1111-111111111111','SLS','Sales'),
  ('11111111-1111-1111-1111-111111111111','DEL','Delivery'),
  ('11111111-1111-1111-1111-111111111111','ADM','Administration');

-- ------------------------------------------------------ chart of accounts --

insert into gl_account (tenant_id, code, name, account_type, normal_balance) values
  ('11111111-1111-1111-1111-111111111111','1010','Cash, operating','asset','D'),
  ('11111111-1111-1111-1111-111111111111','1020','Cash, payroll','asset','D'),
  ('11111111-1111-1111-1111-111111111111','1210','Rental merchandise, at cost','asset','D'),
  ('11111111-1111-1111-1111-111111111111','1215','Rental merchandise, accumulated depreciation','asset','C'),
  ('11111111-1111-1111-1111-111111111111','1500','Fixed assets, at cost','asset','D'),
  ('11111111-1111-1111-1111-111111111111','1510','Fixed assets, accumulated depreciation','asset','C'),
  ('11111111-1111-1111-1111-111111111111','1600','Prepaid expenses','asset','D'),
  ('11111111-1111-1111-1111-111111111111','2010','Accounts payable','liability','C'),
  ('11111111-1111-1111-1111-111111111111','2050','Accrued liabilities','liability','C'),
  ('11111111-1111-1111-1111-111111111111','2100','Sales tax payable','liability','C'),
  ('11111111-1111-1111-1111-111111111111','2150','Payroll liabilities','liability','C'),
  ('11111111-1111-1111-1111-111111111111','2200','Employee deductions payable','liability','C'),
  ('11111111-1111-1111-1111-111111111111','2600','Notes payable','liability','C'),
  ('11111111-1111-1111-1111-111111111111','3000','Owner equity','equity','C'),
  ('11111111-1111-1111-1111-111111111111','3900','Retained earnings','equity','C'),
  ('11111111-1111-1111-1111-111111111111','4010','Rental revenue','revenue','C'),
  ('11111111-1111-1111-1111-111111111111','4020','Fees and other revenue','revenue','C'),
  ('11111111-1111-1111-1111-111111111111','5010','Cost of merchandise on rent','expense','D'),
  ('11111111-1111-1111-1111-111111111111','5020','Merchandise charge-off','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6100','Wages','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6110','Payroll taxes','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6120','Employee benefits','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6200','Repairs and maintenance','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6300','Delivery and fleet','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6310','Fuel','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6400','Occupancy','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6410','Utilities','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6500','Insurance','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6600','Franchise royalty','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6610','Franchise advertising fund','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6700','Professional fees','expense','D'),
  ('11111111-1111-1111-1111-111111111111','6800','Other operating','expense','D'),
  ('11111111-1111-1111-1111-111111111111','7000','Depreciation, fixed assets','expense','D'),
  ('11111111-1111-1111-1111-111111111111','7100','Interest expense','expense','D');

insert into entity_gl_account (entity_id, gl_account_id)
select '22222222-2222-2222-2222-222222222222', id
  from gl_account where tenant_id = '11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------- periods --

insert into fiscal_period (entity_id, starts_on, ends_on, status)
select '22222222-2222-2222-2222-222222222222',
       d::date,
       (d + interval '1 month - 1 day')::date,
       case when d < date_trunc('month', current_date) then 'soft_locked' else 'open' end
  from generate_series(date_trunc('month', current_date) - interval '11 months',
                       date_trunc('month', current_date) + interval '1 month',
                       interval '1 month') d;

-- ------------------------------------------------------- people and roles --

insert into app_user (id, tenant_id, email, name) values
  ('55555555-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','steve@example.com','Steve'),
  ('55555555-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','controller@example.com','Controller'),
  ('55555555-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','apclerk@example.com','A/P clerk'),
  ('55555555-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','palestine@example.com','Palestine manager');

insert into role_grant (app_user_id, entity_id, role) values
  ('55555555-0000-0000-0000-000000000001', null, 'owner'),
  ('55555555-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','controller'),
  ('55555555-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','ap_clerk'),
  ('55555555-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','approver');

-- ------------------------------------------------------ approval policies --

-- Read as: at or above this amount, these steps. Below the lowest policy,
-- no human approval is required and the agent may post.
insert into approval_policy (entity_id, subject_type, min_amount_minor, steps, requires_callback) values
  ('22222222-2222-2222-2222-222222222222','invoice',       100000,
     '[{"seq":1,"role":"approver"}]'::jsonb, false),
  ('22222222-2222-2222-2222-222222222222','invoice',      1000000,
     '[{"seq":1,"role":"approver"},{"seq":2,"role":"controller"}]'::jsonb, false),
  ('22222222-2222-2222-2222-222222222222','vendor',             0,
     '[{"seq":1,"role":"controller"}]'::jsonb, false),
  ('22222222-2222-2222-2222-222222222222','vendor_bank_account',0,
     '[{"seq":1,"role":"controller"},{"seq":2,"role":"owner"}]'::jsonb, true),
  ('22222222-2222-2222-2222-222222222222','payment_run',        0,
     '[{"seq":1,"role":"controller"}]'::jsonb, false),
  ('22222222-2222-2222-2222-222222222222','journal_entry', 500000,
     '[{"seq":1,"role":"controller"}]'::jsonb, false),
  ('22222222-2222-2222-2222-222222222222','fiscal_period',      0,
     '[{"seq":1,"role":"controller"}]'::jsonb, false);

-- ---------------------------------------------------------------- vendors --

insert into vendor (id, tenant_id, legal_name, tax_classification, is_1099, w9_on_file, status) values
  ('66666666-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Valley Power and Light','c_corp',false,true,'active'),
  ('66666666-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Lone Star Fuel Services','c_corp',false,true,'active'),
  ('66666666-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Bridgeway Repairs','llc',true,true,'active'),
  ('66666666-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Meridian Supply','c_corp',false,true,'active');

insert into vendor_entity (vendor_id, entity_id, terms_days, default_gl_account_id, default_profit_object_id)
select v.id, '22222222-2222-2222-2222-222222222222', 30,
       (select id from gl_account where code = g.code and tenant_id = v.tenant_id),
       '44444444-0000-0000-0000-000000000001'
  from vendor v
  join (values ('Valley Power and Light','6410'),
               ('Lone Star Fuel Services','6310'),
               ('Bridgeway Repairs','6200'),
               ('Meridian Supply','1210')) as g(name, code)
    on g.name = v.legal_name;

-- A template only exists once history supports it.
insert into vendor_template (vendor_entity_id, gl_account_id, profit_object_id,
                             expected_amount_minor, tolerance_bps, cadence,
                             built_from_count, status)
select ve.id, ve.default_gl_account_id, ve.default_profit_object_id,
       128455, 1500, 'monthly', 6, 'active'
  from vendor_entity ve
  join vendor v on v.id = ve.vendor_id
 where v.legal_name = 'Valley Power and Light';

commit;
