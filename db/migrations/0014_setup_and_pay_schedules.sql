-- 0014_setup_and_pay_schedules.sql
-- Mixed pay schedules, hiring with approval, fuller vendor records, and the
-- statement-gap view brought in line with the screens.
--
-- Payroll: a company can pay store staff weekly and managers semimonthly.
-- Each pay group now knows how many days after a period ends it pays, and
-- which day its workweek starts, because federal overtime is counted per
-- workweek, not per pay period. A salary is stored as the annual amount and
-- split by the group's schedule, so moving someone between groups does not
-- change what they earn in a year.

alter table pay_group
  add column pay_lag_days smallint not null default 0
    check (pay_lag_days between 0 and 31),
  add column workweek_start_dow smallint not null default 0
    check (workweek_start_dow between 0 and 6);

comment on column pay_group.pay_lag_days is
  'days from period end to pay date; a pay date on a weekend moves to the Friday before';
comment on column pay_group.workweek_start_dow is
  '0 = Sunday. Weekly and biweekly groups count workweeks from the period start instead';

-- Existing groups keep the lag their latest period already had.
update pay_group g
   set pay_lag_days = greatest(0, least(31, p.pay_date - p.ends_on))
  from (select distinct on (pay_group_id) pay_group_id, pay_date, ends_on
          from pay_period order by pay_group_id, starts_on desc) p
 where p.pay_group_id = g.id;

alter table employee add column position text;

-- A salary was a per-period amount; it is now the annual amount.
update employee e
   set base_rate_minor = e.base_rate_minor * case g.frequency
         when 'weekly' then 52 when 'biweekly' then 26 when 'semimonthly' then 24 else 12 end
  from pay_group g
 where g.id = e.pay_group_id and e.pay_type = 'salary';

comment on column employee.base_rate_minor is
  'hourly: the rate per hour. salary: the annual salary, split by the pay group''s schedule';
comment on column employee.status is
  'applicant = entered and waiting on approval; nobody is paid until active';

-- A change to someone's pay or pay group waits on approval, then applies.
create table employee_change (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  entity_id    uuid not null references entity(id),
  employee_id  uuid not null references employee(id),
  before       jsonb not null,
  after        jsonb not null,
  effective_on date not null,
  reason       text not null,
  status       text not null default 'pending'
                 check (status in ('pending','applied','rejected','cancelled')),
  requested_by uuid not null references app_user(id),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz
);

create index employee_change_scope on employee_change (entity_id, status);
create unique index employee_change_one_pending on employee_change (employee_id)
  where status = 'pending';

-- Vendors: where to send mail and payment, and who answers the phone. The
-- phone on file is the number a bank-detail change is called back on.
alter table vendor
  add column address_line1 text,
  add column address_line2 text,
  add column city          text,
  add column state         text,
  add column postal_code   text,
  add column remit_to      text,
  add column contact_name  text,
  add column contact_phone text,
  add column contact_email text;

alter table vendor_bank_account
  add column bank_name        text,
  add column callback_note    text;

-- Details that were never approved are marked so, not left pending forever.
alter table vendor_bank_account drop constraint vendor_bank_account_status_check;
alter table vendor_bank_account add constraint vendor_bank_account_status_check
  check (status in ('pending','current','superseded','rejected'));

comment on column vendor_bank_account.account_ref is
  'where the full numbers are kept (secrets vault or the bank''s own payee record), never the numbers';

-- Missing statement days count from an account's first statement, and an
-- account with none shows as such rather than as thirty missing days. This is
-- the rule the screens have used since the first screen shipped.
create or replace view statement_gaps as
with active as (
  select ba.id, ba.entity_id, ba.name, ba.bank_name,
         greatest(current_date - 30, ba.opened_on,
                  (select min(s.statement_date) from bank_statement s where s.bank_account_id = ba.id)) as since
    from bank_account ba
   where ba.status = 'active'
     and exists (select 1 from bank_statement s where s.bank_account_id = ba.id)
),
days as (
  select a.id, a.entity_id, a.name, a.bank_name,
         generate_series(a.since, current_date - 1, interval '1 day')::date as d
    from active a
)
select days.entity_id,
       days.id   as bank_account_id,
       days.name as account_name,
       days.bank_name,
       days.d    as missing_on,
       current_date - days.d as days_ago
  from days
 where extract(isodow from days.d) between 1 and 5
   and not exists (select 1 from bank_statement s
                    where s.bank_account_id = days.id and s.statement_date = days.d);
