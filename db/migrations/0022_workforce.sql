-- 0022_workforce.sql
-- Track payroll: a time clock that feeds the payroll timecards, shift
-- schedules per store and week, and sales commissions that feed the payroll
-- run as earnings.
--
-- How time reaches payroll: punches are the record; each day's worked hours
-- (ins to outs, less unpaid breaks) are written to the existing timecard row
-- for that person, pay period and day (source 'clock'), on the store's profit
-- object. A day still punched in is a timecard in 'exception' with a
-- missed_punch exception, so payroll cannot be built over it until the
-- person punches out or a manager enters the missing punch with a reason.
-- Approval stays where it is, in Payroll.
--
-- How commissions reach payroll: commissions are earned when a line is
-- handed over and invoiced (not when written), accrued Dr 6130 Cr 2160, and
-- approved per pay period. Approval writes payroll_earning rows, which the
-- payroll build adds to gross and the payroll posting debits to the account
-- the earning names (2160 for commission already accrued, 6130 for a draw
-- paid beyond commission) instead of wages. payroll_earning is deliberately
-- generic: a bonus or any other earning another module hands payroll uses
-- the same table.

-- -------------------------------------------------------------- settings --

create table workforce_settings (
  entity_id            uuid primary key references entity(id),
  timezone             text not null default 'America/New_York',
  missed_punch_hours   smallint not null default 12 check (missed_punch_hours between 4 and 24),
  max_shift_hours      smallint not null default 14 check (max_shift_hours between 4 and 24),
  updated_at           timestamptz not null default now()
);

-- A store's own clock: Socorro keeps Mountain time, Palestine Central.
create table workforce_location (
  location_id  uuid primary key references location(id),
  entity_id    uuid not null references entity(id),
  timezone     text not null
);

-- ----------------------------------------------------------------- punches --

create table time_punch (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  employee_id   uuid not null references employee(id),
  location_id   uuid not null references location(id),
  kind          text not null check (kind in ('in','out','break_start','break_end')),
  at            timestamptz not null,
  work_day      date not null,          -- the local day of the shift's 'in'; an overnight out belongs to it
  source        text not null check (source in ('phone','kiosk','manager')),
  geo           point,                  -- (lng, lat) from the phone, when it gave one
  recorded_by   uuid references app_user(id),
  reason        text,                   -- a manager's entry or edit says why
  replaces_id   uuid references time_punch(id),
  voided_at     timestamptz,
  voided_by     uuid references app_user(id),
  void_reason   text,
  created_at    timestamptz not null default now(),
  check (source <> 'manager' or length(trim(coalesce(reason,''))) >= 3),
  check (voided_at is null or length(trim(coalesce(void_reason,''))) >= 3)
);
create index time_punch_day on time_punch (entity_id, employee_id, work_day, at);
create index time_punch_open on time_punch (entity_id, at) where voided_at is null;

-- A punch is never changed or deleted: it is voided with a reason and, for an
-- edit, replaced by a manager's punch that names it.
create or replace function time_punch_rules() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'punches are never deleted; void it with a reason'; end if;
  if new.at <> old.at or new.kind <> old.kind or new.employee_id <> old.employee_id or new.work_day <> old.work_day
     or new.location_id <> old.location_id or (old.voided_at is not null) then
    raise exception 'a punch cannot be changed; void it and enter the right one';
  end if;
  return new;
end $$;
create trigger time_punch_rules before update or delete on time_punch
  for each row execute function time_punch_rules();

-- ------------------------------------------------------------------ shifts --

create table work_shift (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  location_id  uuid not null references location(id),
  employee_id  uuid not null references employee(id),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  role         text,                    -- 'Floor', 'Delivery', 'Opening'
  notes        text,
  status       text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  created_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '16 hours')
);
create index work_shift_week on work_shift (entity_id, location_id, starts_at);
create index work_shift_person on work_shift (entity_id, employee_id, starts_at);

-- ------------------------------------------------------------- commissions --

-- Who sold an order, and their share. POS writes it (same definition there).
create table if not exists sales_order_salesperson (
  entity_id      uuid not null references entity(id),
  sales_order_id uuid not null references sales_order(id),
  app_user_id    uuid not null references app_user(id),
  split_bps      integer not null check (split_bps between 1 and 10000),
  primary key (sales_order_id, app_user_id)
);

create table commission_plan (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  name       text not null,
  basis      text not null check (basis in ('sale','margin')),   -- % of the sale, or % of gross margin
  rate_bps   integer not null check (rate_bps between 0 and 10000),
  active     boolean not null default true,
  notes      text,
  unique (entity_id, name)
);

-- Rate steps by the salesperson's delivered sales so far this month.
create table commission_tier (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entity(id),
  plan_id           uuid not null references commission_plan(id),
  min_monthly_minor bigint not null check (min_monthly_minor >= 0),
  rate_bps          integer not null check (rate_bps between 0 and 10000),
  unique (plan_id, min_monthly_minor)
);

-- A different rate for a category or a vendor (mattresses pay more, say).
create table commission_rule (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  plan_id    uuid not null references commission_plan(id),
  category   text,
  vendor_id  uuid references vendor(id),
  rate_bps   integer not null check (rate_bps between 0 and 10000),
  check (category is not null or vendor_id is not null)
);

create table commission_assignment (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  app_user_id      uuid not null references app_user(id),
  plan_id          uuid not null references commission_plan(id),
  effective_from   date not null,
  effective_to     date,
  draw_minor       bigint not null default 0 check (draw_minor >= 0),   -- guaranteed per pay period
  draw_recoverable boolean not null default true,                       -- paid back out of later commission
  check (effective_to is null or effective_to >= effective_from)
);
create index commission_assignment_user on commission_assignment (entity_id, app_user_id, effective_from);

create table spiff (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  name         text not null,
  product_id   uuid references product(id),
  vendor_id    uuid references vendor(id),
  amount_minor bigint not null check (amount_minor > 0),    -- per unit sold
  starts_on    date not null,
  ends_on      date not null,
  active       boolean not null default true,
  check (product_id is not null or vendor_id is not null),
  check (ends_on >= starts_on)
);

create table commission_payout (
  id                     uuid primary key default gen_random_uuid(),
  entity_id              uuid not null references entity(id),
  pay_period_id          uuid not null references pay_period(id),
  app_user_id            uuid not null references app_user(id),
  employee_id            uuid not null references employee(id),
  commission_minor       bigint not null,            -- approved events this period (can be negative)
  carried_in_minor       bigint not null default 0,  -- chargebacks carried from before
  draw_minor             bigint not null default 0,  -- the guarantee
  recovered_minor        bigint not null default 0,  -- earlier draws paid back out of commission
  commission_paid_minor  bigint not null default 0,
  topup_minor            bigint not null default 0,  -- draw paid beyond commission
  payout_minor           bigint not null default 0,
  draw_balance_minor     bigint not null default 0,  -- draws still to recover, after this period
  carry_out_minor        bigint not null default 0,  -- chargebacks still to recover, after this period
  journal_entry_id       uuid references journal_entry(id),
  approved_by            uuid not null references app_user(id),
  approved_at            timestamptz not null default now(),
  unique (pay_period_id, app_user_id),
  check (payout_minor = commission_paid_minor + topup_minor)
);

create table commission_event (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  app_user_id         uuid not null references app_user(id),
  sales_order_id      uuid not null references sales_order(id),
  sales_order_line_id uuid not null references sales_order_line(id),
  kind                text not null check (kind in ('earned','chargeback','spiff','spiff_chargeback')),
  plan_id             uuid references commission_plan(id),
  spiff_id            uuid references spiff(id),
  location_id         uuid references location(id),
  split_bps           integer not null,
  sale_minor          bigint not null,     -- this person's share of the line's net sale
  cost_minor          bigint not null default 0,
  basis_minor         bigint not null,     -- what the rate was applied to
  rate_bps            integer not null default 0,
  amount_minor        bigint not null,     -- signed: a chargeback is negative
  earned_on           date not null,
  status              text not null default 'accrued' check (status in ('accrued','approved')),
  payout_id           uuid references commission_payout(id),
  journal_entry_id    uuid references journal_entry(id),
  created_at          timestamptz not null default now(),
  unique nulls not distinct (sales_order_line_id, app_user_id, kind, spiff_id)
);
create index commission_event_user on commission_event (entity_id, app_user_id, earned_on);
create index commission_event_open on commission_event (entity_id, status);

-- --------------------------------------------- earnings handed to payroll --

create table payroll_earning (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  employee_id     uuid not null references employee(id),
  pay_period_id   uuid not null references pay_period(id),
  kind            text not null check (kind in ('commission','draw','bonus','other')),
  amount_minor    bigint not null check (amount_minor > 0),
  debit_code      text not null,          -- the GL account the payroll posting debits for it
  source_type     text,
  source_id       uuid,
  memo            text,
  status          text not null default 'approved' check (status in ('approved','cancelled')),
  payroll_run_id  uuid references payroll_run(id),
  payroll_line_id uuid references payroll_line(id),
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now()
);
create index payroll_earning_period on payroll_earning (entity_id, pay_period_id, status);
