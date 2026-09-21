-- 0007_pay_schedules.sql
-- Placeholder data for mixed pay schedules: store staff stay weekly, and the
-- two managers are salaried on a semimonthly schedule, paid on the 15th and
-- the last day of the month. Plus the approval rules for hiring and for
-- changing anyone's pay.

begin;

-- The weekly group pays five days after the period ends, as its periods do.
update pay_group g
   set pay_lag_days = greatest(0, least(31, p.pay_date - p.ends_on))
  from (select distinct on (pay_group_id) pay_group_id, pay_date, ends_on
          from pay_period order by pay_group_id, starts_on desc) p
 where p.pay_group_id = g.id and g.pay_lag_days = 0;

-- A placeholder pay date that fell on a weekend moves to the Friday before,
-- as every pay date worked out from now on does. Only periods nothing has been
-- paid from yet.
update pay_period pp
   set pay_date = pp.pay_date - case extract(isodow from pp.pay_date) when 6 then 1 else 2 end
 where extract(isodow from pp.pay_date) in (6, 7)
   and pp.status = 'open'
   and not exists (select 1 from payroll_run pr where pr.pay_period_id = pp.id)
   and pp.pay_group_id in (select id from pay_group where entity_id = '22222222-2222-2222-2222-222222222222');

update employee set position = case employee_no
         when 'E-1001' then 'Sales associate'
         when 'E-1002' then 'Delivery driver'
         when 'E-1003' then 'Sales associate'
         when 'E-1004' then 'Sales associate' end
 where entity_id = '22222222-2222-2222-2222-222222222222' and position is null;

insert into pay_group (id, tenant_id, entity_id, name, frequency, bank_account_id, pay_lag_days, workweek_start_dow)
values ('99999999-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222','Managers, semimonthly','semimonthly',
        '88888888-0000-0000-0000-000000000002', 0, 0)
on conflict do nothing;

insert into employee (id, tenant_id, entity_id, pay_group_id, employee_no, first_name, last_name, position,
                      hired_on, pay_type, base_rate_minor, work_state, comp_class_code, profit_object_id)
values
  ('aaaa0000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '99999999-0000-0000-0000-000000000002','E-2001','K','Brennan','Store manager','2019-05-06','salary',5200000,'PA','8017',
   '44444444-0000-0000-0000-000000000001'),
  ('aaaa0000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '99999999-0000-0000-0000-000000000002','E-2002','L','Ortiz','District manager','2018-02-12','salary',6240000,'TX','8810',
   '44444444-0000-0000-0000-000000000002')
on conflict do nothing;

-- The semimonthly period running now: the 1st to the 15th, or the 16th to the
-- month's end. Paid on its last day, or the Friday before if that is a weekend.
with p as (
  select case when extract(day from current_date) <= 15 then date_trunc('month', current_date)::date
              else (date_trunc('month', current_date) + interval '15 days')::date end as starts_on,
         case when extract(day from current_date) <= 15 then (date_trunc('month', current_date) + interval '14 days')::date
              else (date_trunc('month', current_date) + interval '1 month - 1 day')::date end as ends_on
)
insert into pay_period (pay_group_id, starts_on, ends_on, pay_date)
select '99999999-0000-0000-0000-000000000002', p.starts_on, p.ends_on,
       case extract(isodow from p.ends_on) when 6 then p.ends_on - 1 when 7 then p.ends_on - 2 else p.ends_on end
  from p
on conflict do nothing;

-- The placeholder vendors get a made-up address and contact, so a bank change
-- has a phone on file to be called back on. 555-01xx numbers are reserved for
-- fiction, and example.com for examples.
update vendor v
   set address_line1 = x.addr, city = x.city, state = x.state, postal_code = x.zip,
       contact_name = x.contact, contact_phone = x.phone, contact_email = x.email
  from (values
    ('66666666-0000-0000-0000-000000000001'::uuid, '100 Placeholder Ave', 'Harrisburg', 'PA', '17101', 'Accounts receivable', '(717) 555-0142', 'billing@example.com'),
    ('66666666-0000-0000-0000-000000000002'::uuid, '200 Sample Rd',       'Tyler',      'TX', '75701', 'Dispatch office',     '(903) 555-0118', 'fuel@example.com'),
    ('66666666-0000-0000-0000-000000000003'::uuid, '300 Example St',      'El Paso',    'TX', '79901', 'Front desk',          '(915) 555-0167', 'repairs@example.com'),
    ('66666666-0000-0000-0000-000000000004'::uuid, '400 Demo Blvd',       'Lancaster',  'PA', '17601', 'Customer accounts',   '(717) 555-0190', 'orders@example.com')
  ) as x(id, addr, city, state, zip, contact, phone, email)
 where v.id = x.id and v.tenant_id = '11111111-1111-1111-1111-111111111111' and v.contact_phone is null;

-- Hiring someone, or changing their pay or pay group, waits on the owner.
insert into approval_policy (entity_id, subject_type, min_amount_minor, steps)
select e.id, s.subject_type, 0, '[{"seq":1,"role":"owner"}]'::jsonb
  from entity e cross join (values ('employee'), ('employee_change')) s(subject_type)
 where e.id in ('22222222-2222-2222-2222-222222222222', 'eeee0000-0000-0000-0000-00000000000e')
on conflict do nothing;

commit;
