-- 0002_banking_payroll.sql
-- Bank accounts and a payroll group for the placeholder entity.
-- Two banks on purpose: operating and payroll are separate accounts, which
-- is both standard practice and a control.

begin;

insert into bank_account (id, tenant_id, entity_id, name, purpose, bank_name,
                          routing_last4, account_last4, account_ref, gl_account_id,
                          ach_origination_enabled, ach_exposure_limit_minor,
                          positive_pay, debit_block, opened_on)
values
  ('88888888-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','Operating','operating','First Valley Bank',
   '4021','7788','vault://pentex/operating',
   (select id from gl_account where tenant_id='11111111-1111-1111-1111-111111111111' and code='1010'),
   true, 25000000, true, true, '2019-04-01'),
  ('88888888-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','Payroll','payroll','First Valley Bank',
   '4021','9142','vault://pentex/payroll',
   (select id from gl_account where tenant_id='11111111-1111-1111-1111-111111111111' and code='1020'),
   true, 40000000, false, true, '2019-04-01'),
  ('88888888-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222','Tax reserve','tax','Rio Commerce Bank',
   '6630','3355','vault://pentex/tax',
   (select id from gl_account where tenant_id='11111111-1111-1111-1111-111111111111' and code='1010'),
   false, null, false, true, '2023-01-15');

-- ------------------------------------------------------------- pay group --

insert into pay_group (id, tenant_id, entity_id, name, frequency, bank_account_id)
values ('99999999-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222','Stores, weekly','weekly',
        '88888888-0000-0000-0000-000000000002');

insert into employee (id, tenant_id, entity_id, pay_group_id, employee_no, first_name, last_name,
                      hired_on, pay_type, base_rate_minor, work_state, comp_class_code,
                      profit_object_id)
values
  ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '99999999-0000-0000-0000-000000000001','E-1001','A','Rivera','2022-03-14','hourly',2200,'TX','8017',
   '44444444-0000-0000-0000-000000000002'),
  ('aaaa0000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '99999999-0000-0000-0000-000000000001','E-1002','J','Coleman','2021-08-02','hourly',2650,'TX','7380',
   '44444444-0000-0000-0000-000000000002'),
  ('aaaa0000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '99999999-0000-0000-0000-000000000001','E-1003','M','Okafor','2023-01-09','hourly',2050,'PA','8017',
   '44444444-0000-0000-0000-000000000001'),
  ('aaaa0000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '99999999-0000-0000-0000-000000000001','E-1004','D','Whitfield','2020-11-30','hourly',2400,'TX','8018',
   '44444444-0000-0000-0000-000000000003');

-- --------------------------------------------------- deductions and benefits --

insert into deduction_type (id, tenant_id, code, name, kind, employer_match, remit_within_days, gl_account_id)
values
  ('bbbb0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','RET','Retirement plan','retirement',true,7,
   (select id from gl_account where tenant_id='11111111-1111-1111-1111-111111111111' and code='2200')),
  ('bbbb0000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','HLTH','Health premium','health',false,30,
   (select id from gl_account where tenant_id='11111111-1111-1111-1111-111111111111' and code='2200')),
  ('bbbb0000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','CS','Child support order','child_support',false,3,
   (select id from gl_account where tenant_id='11111111-1111-1111-1111-111111111111' and code='2200'));

insert into employee_deduction (employee_id, deduction_type_id, percent_bps, employer_match_bps, priority, effective_from)
values ('aaaa0000-0000-0000-0000-000000000001','bbbb0000-0000-0000-0000-000000000001', 500, 300, 100, '2022-04-01');

insert into employee_deduction (employee_id, deduction_type_id, amount_minor, priority, effective_from)
values ('aaaa0000-0000-0000-0000-000000000002','bbbb0000-0000-0000-0000-000000000002', 12000, 100, '2021-09-01'),
       -- statutory orders come first, whatever else is on the record
       ('aaaa0000-0000-0000-0000-000000000003','bbbb0000-0000-0000-0000-000000000003', 20000,  10, '2024-02-01');

insert into approval_policy (entity_id, subject_type, min_amount_minor, steps)
values ('22222222-2222-2222-2222-222222222222','payroll_run', 0,
        '[{"seq":1,"role":"owner"}]'::jsonb);

-- ------------------------------------------------------------ one period --

insert into pay_period (id, pay_group_id, starts_on, ends_on, pay_date, status)
values ('cccc0000-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001',
        date_trunc('month', current_date)::date,
        (date_trunc('month', current_date) + interval '6 days')::date,
        (date_trunc('month', current_date) + interval '11 days')::date,
        'open');

-- Five days each. Coleman runs 10-hour days, so overtime is real rather than theoretical.
insert into timecard (employee_id, pay_period_id, worked_on, hours, profit_object_id, status)
select e.id,
       'cccc0000-0000-0000-0000-000000000001',
       (date_trunc('month', current_date) + (d || ' days')::interval)::date,
       case when e.employee_no = 'E-1002' then 10 else 8 end,
       e.profit_object_id,
       'approved'
  from employee e
  cross join generate_series(0,4) d
 where e.pay_group_id = '99999999-0000-0000-0000-000000000001';

commit;
