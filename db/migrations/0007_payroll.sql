-- 0007_payroll.sql
-- Payroll: time, gross, the register, approval, and the payment. Tax
-- calculation and tax filing are NOT here -- they are bought, because the
-- penalties land on the employer and the rates move constantly. What this
-- schema keeps is the provider's answer and what we did with it.
--
-- Nothing in this file is rent-to-own specific. It runs for a retailer, a
-- haulier or a services firm; only the profit object means something
-- different.

create table pay_group (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  entity_id       uuid not null references entity(id),
  name            text not null,
  frequency       text not null
                    check (frequency in ('weekly','biweekly','semimonthly','monthly')),
  bank_account_id uuid not null references bank_account(id),
  overtime_after_hours numeric(5,2) not null default 40,
  overtime_multiplier  numeric(4,2) not null default 1.5,
  status          text not null default 'active' check (status in ('active','inactive')),
  unique (entity_id, name)
);

create table employee (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  entity_id           uuid not null references entity(id),
  pay_group_id        uuid references pay_group(id),
  app_user_id         uuid references app_user(id),
  employee_no         text not null,
  first_name          text not null,
  last_name           text not null,
  tax_id_ref          text,          -- secrets store key; no identifier is held here
  hired_on            date not null,
  terminated_on       date,
  status              text not null default 'active'
                        check (status in ('applicant','active','leave','terminated')),
  pay_type            text not null check (pay_type in ('hourly','salary')),
  base_rate_minor     bigint not null check (base_rate_minor >= 0),
  work_state          char(2) not null,
  comp_class_code     text,          -- workers' comp class sits on the person
  profit_object_id    uuid references profit_object(id),
  department_id       uuid references department(id),
  unique (entity_id, employee_no)
);

create index employee_scope on employee (entity_id, status);

comment on column employee.comp_class_code is
  'on the employee, not the policy, so audit exposure is a report not a scramble';

create table pay_period (
  id           uuid primary key default gen_random_uuid(),
  pay_group_id uuid not null references pay_group(id),
  starts_on    date not null,
  ends_on      date not null,
  pay_date     date not null,
  status       text not null default 'open'
                 check (status in ('open','timecards_approved','built','released','posted','cancelled')),
  unique (pay_group_id, starts_on),
  check (ends_on >= starts_on)
);

create table timecard (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references employee(id),
  pay_period_id    uuid not null references pay_period(id),
  worked_on        date not null,
  hours            numeric(6,2) not null check (hours >= 0),
  profit_object_id uuid references profit_object(id),
  source           text not null default 'clock'
                     check (source in ('clock','manual','import','schedule')),
  status           text not null default 'recorded'
                     check (status in ('recorded','exception','approved','rejected')),
  unique (employee_id, pay_period_id, worked_on)
);

create table timecard_exception (
  id          uuid primary key default gen_random_uuid(),
  timecard_id uuid not null references timecard(id) on delete cascade,
  kind        text not null check (kind in
                ('missed_punch','over_threshold','no_break','outside_schedule','pto_without_balance')),
  detail      text,
  resolved_by uuid references app_user(id),
  resolved_at timestamptz
);

create table pto_ledger (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references employee(id),
  occurred_on  date not null,
  kind         text not null check (kind in ('accrual','taken','adjustment','payout')),
  hours        numeric(6,2) not null,
  pay_period_id uuid references pay_period(id),
  note         text
);

create index pto_ledger_employee on pto_ledger (employee_id, occurred_on);

-- --------------------------------------------------- deductions and benefits --

-- Money leaving payroll that is not wages. Each has its own payee, its own
-- schedule and its own penalty regime -- late retirement deferrals are a
-- Department of Labor matter, not a bookkeeping slip.
create table deduction_type (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  code            text not null,
  name            text not null,
  kind            text not null check (kind in
                    ('retirement','health','dental','vision','hsa','fsa','garnishment','child_support','union','other')),
  payee_vendor_id uuid references vendor(id),
  employer_match  boolean not null default false,
  remit_within_days smallint not null default 7,
  gl_account_id   uuid not null references gl_account(id),
  unique (tenant_id, code)
);

create table employee_deduction (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references employee(id),
  deduction_type_id uuid not null references deduction_type(id),
  amount_minor      bigint check (amount_minor is null or amount_minor >= 0),
  percent_bps       integer check (percent_bps is null or percent_bps between 0 and 10000),
  employer_match_bps integer check (employer_match_bps is null or employer_match_bps between 0 and 10000),
  priority          smallint not null default 100,   -- garnishments order by statute
  effective_from    date not null,
  effective_to      date,
  check (amount_minor is not null or percent_bps is not null)
);

-- ------------------------------------------------------------ the run --

create table payroll_run (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  entity_id           uuid not null references entity(id),
  pay_period_id       uuid not null references pay_period(id),
  bank_account_id     uuid not null references bank_account(id),
  status              text not null default 'building'
                        check (status in ('building','pending_release','released','posted','cancelled')),
  gross_minor         bigint not null default 0,
  employee_tax_minor  bigint not null default 0,
  employer_tax_minor  bigint not null default 0,
  deductions_minor    bigint not null default 0,
  net_minor           bigint not null default 0,
  tax_provider        text,          -- who calculated and who will file
  tax_provider_ref    text,
  built_by            uuid not null references app_user(id),
  released_by         uuid references app_user(id),
  released_at         timestamptz,
  created_at          timestamptz not null default now(),
  unique (pay_period_id)
);

-- Released by someone other than whoever built it. The engine enforces it too.
alter table payroll_run add constraint payroll_run_two_people
  check (released_by is null or released_by <> built_by);

create table payroll_line (
  id                 uuid primary key default gen_random_uuid(),
  payroll_run_id     uuid not null references payroll_run(id) on delete cascade,
  employee_id        uuid not null references employee(id),
  profit_object_id   uuid references profit_object(id),
  department_id      uuid references department(id),
  regular_hours      numeric(7,2) not null default 0,
  overtime_hours     numeric(7,2) not null default 0,
  gross_minor        bigint not null check (gross_minor >= 0),
  employee_tax_minor bigint not null default 0,
  employer_tax_minor bigint not null default 0,
  deductions_minor   bigint not null default 0,
  net_minor          bigint not null,
  comp_class_code    text,
  unique (payroll_run_id, employee_id)
);

-- net = gross - employee tax - deductions. Not a convention.
alter table payroll_line add constraint payroll_line_nets
  check (net_minor = gross_minor - employee_tax_minor - deductions_minor);

create table payroll_deduction (
  id                 uuid primary key default gen_random_uuid(),
  payroll_line_id    uuid not null references payroll_line(id) on delete cascade,
  deduction_type_id  uuid not null references deduction_type(id),
  amount_minor       bigint not null check (amount_minor >= 0),
  employer_match_minor bigint not null default 0 check (employer_match_minor >= 0),
  unique (payroll_line_id, deduction_type_id)
);

-- What was deducted against what was actually sent. This reconciliation is
-- the control that catches the rest.
create table deduction_remittance (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  deduction_type_id   uuid not null references deduction_type(id),
  payroll_run_id      uuid references payroll_run(id),
  deducted_minor      bigint not null default 0,
  employer_match_minor bigint not null default 0,
  remitted_minor      bigint not null default 0,
  due_on              date not null,
  invoice_id          uuid references invoice(id),
  status              text not null default 'due'
                        check (status in ('due','remitted','late','disputed')),
  unique (payroll_run_id, deduction_type_id)
);

create index deduction_remittance_due on deduction_remittance (entity_id, status, due_on);

-- What the annual workers' comp audit asks for, as a query rather than a scramble.
create view comp_exposure as
select pl.comp_class_code,
       pr.entity_id,
       date_trunc('year', pp.pay_date)::date as year,
       count(distinct pl.employee_id)        as employees,
       sum(pl.gross_minor)                   as payroll_minor
  from payroll_line pl
  join payroll_run pr on pr.id = pl.payroll_run_id
  join pay_period  pp on pp.id = pr.pay_period_id
 where pr.status = 'posted'
 group by pl.comp_class_code, pr.entity_id, date_trunc('year', pp.pay_date);
