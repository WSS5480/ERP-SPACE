-- 0003_second_client.sql
-- A second client company on the same install, in a different industry.
-- Nothing in the schema changes: the profit object is a truck instead of a
-- store, the labels differ, and the two tenants can never see each other.
--
-- This exists so the isolation is tested rather than asserted.

begin;

insert into tenant (id, name, vertical, location_label, profit_object_label, aging_label)
values ('dddd0000-0000-0000-0000-00000000000d',
        'Rio Freight', 'trucking', 'Terminal', 'Truck', 'Settlements');

insert into entity (id, tenant_id, name, legal_name, fiscal_year_end_month)
values ('eeee0000-0000-0000-0000-00000000000e','dddd0000-0000-0000-0000-00000000000d',
        'Rio Freight Lines, LLC','Rio Freight Lines, LLC', 12);

insert into location (id, entity_id, code, name, state) values
  ('eeee0000-0000-0000-0000-000000000101','eeee0000-0000-0000-0000-00000000000e','MCA','McAllen yard','TX');

-- The same table, meaning something else.
insert into profit_object (entity_id, kind, code, name, location_id) values
  ('eeee0000-0000-0000-0000-00000000000e','truck','T-118','Tractor 118','eeee0000-0000-0000-0000-000000000101'),
  ('eeee0000-0000-0000-0000-00000000000e','truck','T-204','Tractor 204','eeee0000-0000-0000-0000-000000000101'),
  ('eeee0000-0000-0000-0000-00000000000e','other','ADM','Administration',null);

insert into gl_account (tenant_id, code, name, account_type, normal_balance) values
  ('dddd0000-0000-0000-0000-00000000000d','1010','Cash, operating','asset','D'),
  ('dddd0000-0000-0000-0000-00000000000d','1020','Cash, payroll','asset','D'),
  ('dddd0000-0000-0000-0000-00000000000d','2010','Accounts payable','liability','C'),
  ('dddd0000-0000-0000-0000-00000000000d','2150','Payroll liabilities','liability','C'),
  ('dddd0000-0000-0000-0000-00000000000d','2200','Employee deductions payable','liability','C'),
  ('dddd0000-0000-0000-0000-00000000000d','4010','Freight revenue','revenue','C'),
  ('dddd0000-0000-0000-0000-00000000000d','6100','Wages','expense','D'),
  ('dddd0000-0000-0000-0000-00000000000d','6110','Payroll taxes','expense','D'),
  ('dddd0000-0000-0000-0000-00000000000d','6120','Employee benefits','expense','D'),
  ('dddd0000-0000-0000-0000-00000000000d','6310','Fuel','expense','D');

insert into entity_gl_account (entity_id, gl_account_id)
select 'eeee0000-0000-0000-0000-00000000000e', id
  from gl_account where tenant_id = 'dddd0000-0000-0000-0000-00000000000d';

insert into fiscal_period (entity_id, starts_on, ends_on, status)
select 'eeee0000-0000-0000-0000-00000000000e',
       d::date, (d + interval '1 month - 1 day')::date, 'open'
  from generate_series(date_trunc('month', current_date) - interval '2 months',
                       date_trunc('month', current_date), interval '1 month') d;

insert into app_user (id, tenant_id, email, name) values
  ('eeee0000-0000-0000-0000-000000000201','dddd0000-0000-0000-0000-00000000000d','owner@riofreight.example','Rio owner');

insert into role_grant (app_user_id, entity_id, role)
values ('eeee0000-0000-0000-0000-000000000201','eeee0000-0000-0000-0000-00000000000e','owner');

insert into bank_account (tenant_id, entity_id, name, purpose, bank_name, routing_last4,
                          account_last4, account_ref, gl_account_id, ach_origination_enabled)
values ('dddd0000-0000-0000-0000-00000000000d','eeee0000-0000-0000-0000-00000000000e',
        'Operating','operating','Rio Commerce Bank','6630','1190','vault://rio/operating',
        (select id from gl_account where tenant_id='dddd0000-0000-0000-0000-00000000000d' and code='1010'),
        true);

insert into approval_policy (entity_id, subject_type, min_amount_minor, steps)
values ('eeee0000-0000-0000-0000-00000000000e','invoice', 250000,
        '[{"seq":1,"role":"owner"}]'::jsonb),
       ('eeee0000-0000-0000-0000-00000000000e','payroll_run', 0,
        '[{"seq":1,"role":"owner"}]'::jsonb);

commit;
