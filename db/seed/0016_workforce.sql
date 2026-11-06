-- 0016_workforce.sql
-- PLACEHOLDER time clock and commission setup for the furniture demo: each
-- store's clock time zone, a weekly "Sales floor" pay group with two hourly
-- salespeople linked to their sign-ins and a pay period covering this week,
-- a week of shifts at Enola, two commission plans (% of sale with volume
-- tiers and a mattress rate; % of margin), a draw, and two spiffs.
-- No punches and no commissions: the workforce checks make those through the
-- same functions the screens use, so every hour and dollar has its trail.
-- Nothing here touches the existing "Stores, weekly" or managers' groups.

begin;

insert into workforce_settings (entity_id, timezone, missed_punch_hours, max_shift_hours)
values ('22222222-2222-2222-2222-222222222222', 'America/New_York', 12, 14)
on conflict (entity_id) do nothing;

insert into workforce_location (location_id, entity_id, timezone) values
  ('33333333-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','America/New_York'),
  ('33333333-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','America/Chicago'),
  ('33333333-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','America/Denver'),
  ('33333333-0000-0000-0000-0000000000dc','22222222-2222-2222-2222-222222222222','America/New_York')
on conflict (location_id) do nothing;

insert into pay_group (id, tenant_id, entity_id, name, frequency, bank_account_id, pay_lag_days, workweek_start_dow)
values ('99999999-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
        'Sales floor, weekly','weekly','88888888-0000-0000-0000-000000000002', 5, 0)
on conflict do nothing;

-- The week ending today, so the clock has somewhere to put today's punches.
insert into pay_period (id, pay_group_id, starts_on, ends_on, pay_date)
values ('cccc0000-0000-0000-0000-000000000003','99999999-0000-0000-0000-000000000003',
        current_date - 6, current_date,
        case extract(isodow from current_date + 5) when 6 then current_date + 4 when 7 then current_date + 3 else current_date + 5 end)
on conflict do nothing;

insert into employee (id, tenant_id, entity_id, pay_group_id, app_user_id, employee_no, first_name, last_name, position,
                      hired_on, pay_type, base_rate_minor, work_state, comp_class_code, profit_object_id)
values
  ('aaaa0000-0000-0000-0000-000000000011','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '99999999-0000-0000-0000-000000000003','55555555-0000-0000-0000-000000000011','E-3001','Maria','Sales','Sales associate',
   '2024-03-04','hourly',1500,'PA','8017','44444444-0000-0000-0000-000000000001'),
  ('aaaa0000-0000-0000-0000-000000000012','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '99999999-0000-0000-0000-000000000003','55555555-0000-0000-0000-000000000018','E-3002','Enola','Manager','Floor manager',
   '2021-06-14','hourly',2400,'PA','8017','44444444-0000-0000-0000-000000000001')
on conflict do nothing;

-- Next week's floor at Enola: Maria Tue-Sat 10-6, the manager Mon-Fri 9-5.
insert into work_shift (entity_id, location_id, employee_id, starts_at, ends_at, role, created_by)
select '22222222-2222-2222-2222-222222222222','33333333-0000-0000-0000-000000000001', x.emp,
       ((date_trunc('week', current_date) + interval '7 days' + (d || ' days')::interval)::date + x.start_t) at time zone 'America/New_York',
       ((date_trunc('week', current_date) + interval '7 days' + (d || ' days')::interval)::date + x.end_t) at time zone 'America/New_York',
       x.role, '55555555-0000-0000-0000-000000000018'
  from (values ('aaaa0000-0000-0000-0000-000000000011'::uuid, time '10:00', time '18:00', 'Floor', 1, 5),
               ('aaaa0000-0000-0000-0000-000000000012'::uuid, time '09:00', time '17:00', 'Opening', 0, 4)) x(emp, start_t, end_t, role, d0, d1)
  cross join generate_series(0, 6) d
 where d between x.d0 and x.d1;

-- Commission plans.
insert into commission_plan (id, entity_id, name, basis, rate_bps, notes) values
  ('cdcd0000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Floor: % of delivered sales','sale', 400,
   '4% of delivered sales, 5% once the month passes $20,000, 6% past $40,000; mattresses 8%'),
  ('cdcd0000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','Managers: % of gross margin','margin', 1000,
   '10% of the gross margin on delivered sales');
insert into commission_tier (entity_id, plan_id, min_monthly_minor, rate_bps) values
  ('22222222-2222-2222-2222-222222222222','cdcd0000-0000-0000-0000-000000000001', 2000000, 500),
  ('22222222-2222-2222-2222-222222222222','cdcd0000-0000-0000-0000-000000000001', 4000000, 600);
insert into commission_rule (entity_id, plan_id, category, rate_bps) values
  ('22222222-2222-2222-2222-222222222222','cdcd0000-0000-0000-0000-000000000001','Mattresses', 800);

insert into commission_assignment (entity_id, app_user_id, plan_id, effective_from, draw_minor, draw_recoverable) values
  ('22222222-2222-2222-2222-222222222222','55555555-0000-0000-0000-000000000011','cdcd0000-0000-0000-0000-000000000001', date_trunc('year', current_date)::date, 20000, true),
  ('22222222-2222-2222-2222-222222222222','55555555-0000-0000-0000-000000000018','cdcd0000-0000-0000-0000-000000000002', date_trunc('year', current_date)::date, 0, true);

-- Spiffs this month: $25 a protection plan, $15 a Global recliner.
insert into spiff (entity_id, name, product_id, vendor_id, amount_minor, starts_on, ends_on) values
  ('22222222-2222-2222-2222-222222222222','Protection plan push','77777777-0000-0000-0000-000000000012', null, 2500,
   date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date),
  ('22222222-2222-2222-2222-222222222222','Global recliner spiff', null,'66666666-0000-0000-0000-0000000000a3', 1500,
   date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date);

-- Payroll release for the new group waits on the owner, as the others do.
-- (approval_policy for payroll_run is per entity and already covers it.)

commit;
