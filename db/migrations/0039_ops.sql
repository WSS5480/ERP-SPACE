-- 0039_ops.sql
-- Operations: loading the truck against a piece-by-piece manifest, dock
-- staging lanes, the truck's weight in booking capacity, haul-away and
-- recycling, vendor debit memos in payables, and time off with holiday lists.
--
-- Rules the database holds:
--   1. a delivery window cannot be booked past its weight cap (same as stops,
--      pieces, cube and crew minutes), unless a dispatcher overrides it
--   2. a staging lane holds one route a day; a route has one lane
--   3. a piece marked short says why
--   4. a debit memo is applied for no more than it is worth, and a bill is
--      reduced by memos for no more than its total
--   5. a manual debit memo is approved by someone other than whoever wrote it
--   6. leave is approved or declined by someone other than the person asking
--   7. nothing here is deleted: lines are cancelled, memos voided, requests
--      cancelled, load items marked removed

create or replace function ops_no_delete() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are never deleted; cancel, void or mark them instead', tg_table_name;
end $$;

-- ================================================= 1. weight at booking --
alter table delivery_window add column weight_cap_lb numeric(8,0) check (weight_cap_lb >= 0);

create or replace function delivery_stop_capacity() returns trigger
language plpgsql as $$
declare w record; t record;
begin
  if tg_op = 'DELETE' then raise exception 'stops are never deleted; cancel it with a reason'; end if;
  if new.window_id is null or new.scheduled_on is null or new.status = 'cancelled' or new.over_capacity_ok then return new; end if;
  if tg_op = 'UPDATE' and new.window_id = old.window_id and new.scheduled_on = old.scheduled_on
     and old.status <> 'cancelled' and new.pieces <= old.pieces and new.cube_ft <= old.cube_ft
     and new.service_min <= old.service_min and new.weight_lb <= old.weight_lb then
    return new;
  end if;
  select * into w from delivery_window where id = new.window_id and entity_id = new.entity_id for update;
  if w.id is null then raise exception 'that delivery window belongs to another company'; end if;
  select count(*) n, coalesce(sum(pieces),0) pcs, coalesce(sum(cube_ft),0) cube, coalesce(sum(service_min),0) lab,
         coalesce(sum(weight_lb),0) wt
    into t from delivery_stop
   where entity_id = new.entity_id and window_id = new.window_id and scheduled_on = new.scheduled_on
     and status <> 'cancelled' and not over_capacity_ok and id <> new.id;
  if w.stops_cap is not null and t.n + 1 > w.stops_cap then
    raise exception 'the % window on % is full; it takes % stops', w.label, to_char(new.scheduled_on, 'Mon DD'), w.stops_cap;
  end if;
  if w.pieces_cap is not null and t.pcs + new.pieces > w.pieces_cap then
    raise exception 'the % window on % has room for % more pieces, not %', w.label, to_char(new.scheduled_on, 'Mon DD'), greatest(w.pieces_cap - t.pcs, 0), new.pieces;
  end if;
  if w.cube_cap is not null and t.cube + new.cube_ft > w.cube_cap then
    raise exception 'the % window on % has % cubic feet left, not %', w.label, to_char(new.scheduled_on, 'Mon DD'), greatest(w.cube_cap - t.cube, 0), new.cube_ft;
  end if;
  if w.weight_cap_lb is not null and t.wt + new.weight_lb > w.weight_cap_lb then
    raise exception 'the % window on % can carry % lb more, not % lb', w.label, to_char(new.scheduled_on, 'Mon DD'), greatest(w.weight_cap_lb - t.wt, 0), new.weight_lb;
  end if;
  if w.labor_min_cap is not null and t.lab + new.service_min > w.labor_min_cap then
    raise exception 'the % window on % has % crew minutes left, not %', w.label, to_char(new.scheduled_on, 'Mon DD'), greatest(w.labor_min_cap - t.lab, 0), new.service_min;
  end if;
  return new;
end $$;

-- ================================================ 2. dock staging lanes --
create table dock_lane (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  dc_location_id uuid not null references location(id),
  code           text not null,
  name           text not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (entity_id, dc_location_id, code)
);
create trigger dock_lane_keep before delete on dock_lane for each row execute function ops_no_delete();

create table route_lane (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  route_id    uuid not null references delivery_route(id),
  lane_id     uuid not null references dock_lane(id),
  day         date not null,
  assigned_by uuid references app_user(id),
  assigned_at timestamptz not null default now(),
  released_at timestamptz
);
create unique index route_lane_live_lane on route_lane (lane_id, day) where released_at is null;
create unique index route_lane_live_route on route_lane (route_id) where released_at is null;
create trigger route_lane_keep before delete on route_lane for each row execute function ops_no_delete();

-- ===================================================== 3. load manifest --
-- One row per piece going on the truck: a labelled carton of a serialized
-- unit, or one of the pieces of a stocked line. Loaded last stop first.
create table route_load_item (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  route_id     uuid not null references delivery_route(id),
  stop_id      uuid not null references delivery_stop(id),
  stop_line_id uuid not null references delivery_stop_line(id),
  piece_id     uuid references inv_piece(id),
  ordinal      smallint not null default 1 check (ordinal >= 1),
  label        text not null,            -- the piece's barcode, or the SKU for unlabelled stock
  description  text not null,
  carton       text,                     -- "2 of 3 · Back cushions"
  stop_seq     smallint not null,
  load_group   smallint not null,        -- 1 = loads first (the last stop)
  status       text not null default 'pending' check (status in ('pending','loaded','short','removed')),
  out_of_order boolean not null default false,
  loaded_at    timestamptz,
  loaded_by    uuid references app_user(id),
  short_reason text,
  marked_by    uuid references app_user(id),
  created_at   timestamptz not null default now(),
  check (status <> 'short' or coalesce(trim(short_reason),'') <> ''),
  check (status <> 'loaded' or loaded_at is not null)
);
create unique index route_load_item_key on route_load_item
  (route_id, stop_line_id, coalesce(piece_id, '00000000-0000-0000-0000-000000000000'::uuid), ordinal) where status <> 'removed';
create index route_load_item_route on route_load_item (entity_id, route_id, load_group, status);
create trigger route_load_item_keep before delete on route_load_item for each row execute function ops_no_delete();

-- ================================================ 4. haul-away, recycling --
create table haul_away_rate (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  category       text not null check (category in ('mattress','box_spring','sofa','chair','recliner','table','appliance','other')),
  label          text not null,
  fee_product_id uuid references product(id),       -- a fee product; its sale posts with the delivery
  fee_minor      bigint not null default 0 check (fee_minor >= 0),   -- per piece taken
  est_weight_lb  numeric(8,1) not null default 0 check (est_weight_lb >= 0),
  active         boolean not null default true,
  unique (entity_id, category)
);

-- A state's recycling program (mattress stewardship and the like). Where a
-- state has none, report_required is false and the log is kept anyway.
create table recycling_program (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  state           char(2) not null,
  name            text not null,
  categories      text[] not null default '{mattress,box_spring}',
  program_fee_minor bigint not null default 0 check (program_fee_minor >= 0),   -- per unit, where the state charges one
  report_required boolean not null default false,
  active          boolean not null default true,
  unique (entity_id, state)
);

create table haul_away_disposal (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  number         text not null,
  dc_location_id uuid not null references location(id),
  disposed_on    date not null,
  method         text not null check (method in ('recycler','landfill','donation')),
  facility       text not null,
  weight_lb      numeric(9,1) not null check (weight_lb >= 0),
  certificate_no text,
  state          char(2) not null,
  note           text,
  created_by     uuid references app_user(id),
  created_at     timestamptz not null default now(),
  unique (entity_id, number),
  check (method <> 'recycler' or coalesce(trim(certificate_no),'') <> '')
);
create trigger haul_away_disposal_keep before delete on haul_away_disposal for each row execute function ops_no_delete();

create table stop_haul_away (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  stop_id          uuid not null references delivery_stop(id),
  category         text not null,
  description      text not null,
  qty              numeric(8,2) not null check (qty > 0),
  fee_minor        bigint not null default 0 check (fee_minor >= 0),     -- per piece
  fee_line_id      uuid references sales_order_line(id),
  trade_in_minor   bigint not null default 0 check (trade_in_minor >= 0),
  trade_in_line_id uuid references sales_order_line(id),
  state            char(2) not null,
  status           text not null default 'planned' check (status in ('planned','taken','not_taken','cancelled')),
  taken_qty        numeric(8,2) check (taken_qty >= 0),
  weight_lb        numeric(8,1) check (weight_lb >= 0),
  photo            text check (photo is null or ((photo like 'https://%' or photo like 'data:image/%') and length(photo) <= 2000000)),
  taken_note       text,
  taken_at         timestamptz,
  taken_by         uuid references app_user(id),
  disposal_id      uuid references haul_away_disposal(id),
  cancel_reason    text,
  created_by       uuid references app_user(id),
  created_at       timestamptz not null default now(),
  check (status <> 'taken' or (taken_qty > 0 and photo is not null)),
  check (taken_qty is null or taken_qty <= qty),
  check (status <> 'cancelled' or coalesce(trim(cancel_reason),'') <> ''),
  check (disposal_id is null or status = 'taken')
);
create index stop_haul_away_stop on stop_haul_away (entity_id, stop_id);
create index stop_haul_away_open on stop_haul_away (entity_id, status) where disposal_id is null;
create trigger stop_haul_away_keep before delete on stop_haul_away for each row execute function ops_no_delete();

-- ================================================ 5. vendor debit memos --
create table vendor_debit_memo (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  entity_id         uuid not null references entity(id),
  vendor_id         uuid not null references vendor(id),
  number            text not null,
  source            text not null check (source in ('service_chargeback','damaged_on_receipt','price_difference','short_shipped','other')),
  reason            text not null check (length(trim(reason)) >= 3),
  amount_minor      bigint not null check (amount_minor > 0),
  offset_code       text not null,            -- the GL account the 1150 debit was offset to
  memo_date         date not null,
  status            text not null default 'pending_approval'
                      check (status in ('pending_approval','open','applied','rejected','void')),
  invoice_id        uuid references invoice(id),          -- the bill it is about, if any
  purchase_order_id uuid references purchase_order(id),
  service_cost_id   uuid references service_cost(id),
  service_ticket_id uuid references service_ticket(id),
  vendor_ref        text,                                 -- the vendor's RA or credit number
  journal_entry_id  uuid references journal_entry(id),
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now(),
  decided_by        uuid references app_user(id),
  decided_at        timestamptz,
  decision_note     text,
  void_reason       text,
  unique (entity_id, number),
  check (decided_by is null or created_by is null or decided_by <> created_by or source = 'service_chargeback'),
  check (status <> 'rejected' or coalesce(trim(decision_note),'') <> ''),
  check (status <> 'void' or coalesce(trim(void_reason),'') <> ''),
  check (status in ('pending_approval','rejected') or journal_entry_id is not null)
);
create unique index vendor_debit_memo_cost on vendor_debit_memo (service_cost_id) where service_cost_id is not null;
create index vendor_debit_memo_vendor on vendor_debit_memo (entity_id, vendor_id, status);
create trigger vendor_debit_memo_keep before delete on vendor_debit_memo for each row execute function ops_no_delete();

create table vendor_memo_application (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  memo_id          uuid not null references vendor_debit_memo(id),
  invoice_id       uuid not null references invoice(id),
  amount_minor     bigint not null check (amount_minor > 0),
  journal_entry_id uuid not null references journal_entry(id),
  applied_by       uuid references app_user(id),
  applied_at       timestamptz not null default now()
);
create index vendor_memo_application_memo on vendor_memo_application (memo_id);
create index vendor_memo_application_invoice on vendor_memo_application (invoice_id);
create trigger vendor_memo_application_keep before update or delete on vendor_memo_application for each row execute function ops_no_delete();

create or replace function vendor_memo_application_rules() returns trigger
language plpgsql as $$
declare m record; i record; used bigint; reduced bigint;
begin
  select * into m from vendor_debit_memo where id = new.memo_id and entity_id = new.entity_id for update;
  if m.id is null then raise exception 'that debit memo belongs to another company'; end if;
  if m.status <> 'open' then raise exception 'debit memo % is %; only an open memo is applied', m.number, replace(m.status, '_', ' '); end if;
  select * into i from invoice where id = new.invoice_id and entity_id = new.entity_id for update;
  if i.id is null then raise exception 'that bill belongs to another company'; end if;
  if i.vendor_id <> m.vendor_id then raise exception 'debit memo % is for another vendor', m.number; end if;
  select coalesce(sum(amount_minor),0) into used from vendor_memo_application where memo_id = m.id;
  if used + new.amount_minor > m.amount_minor then
    raise exception 'debit memo % has % left to apply, not %', m.number, to_char((m.amount_minor - used) / 100.0, 'FM999,999,990.00'), to_char(new.amount_minor / 100.0, 'FM999,999,990.00');
  end if;
  select coalesce(sum(amount_minor),0) into reduced from vendor_memo_application where invoice_id = i.id;
  if reduced + new.amount_minor > i.total_minor then
    raise exception 'that bill has % left after credits; a memo cannot take it below zero', to_char((i.total_minor - reduced) / 100.0, 'FM999,999,990.00');
  end if;
  return new;
end $$;
create trigger vendor_memo_application_rules before insert on vendor_memo_application
  for each row execute function vendor_memo_application_rules();

-- ================================================ 6. time off, holidays --
create table leave_type (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  code           text not null,
  name           text not null,
  kind           text not null check (kind in ('vacation','sick','unpaid','other')),
  paid           boolean not null default true,
  accrual        text not null default 'none' check (accrual in ('none','per_hour','per_period')),
  accrue_hours   numeric(6,3) not null default 0 check (accrue_hours >= 0),   -- hours earned per unit
  per_hours      numeric(6,2) check (per_hours > 0),                          -- per_hour: per this many hours worked
  cap_hours      numeric(7,2) check (cap_hours >= 0),                         -- the balance never accrues past this
  allow_negative boolean not null default false,
  active         boolean not null default true,
  unique (entity_id, code),
  check (kind <> 'unpaid' or not paid),
  check (accrual <> 'per_hour' or per_hours is not null)
);

create table leave_request (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  employee_id    uuid not null references employee(id),
  leave_type_id  uuid not null references leave_type(id),
  starts_on      date not null,
  ends_on        date not null,
  hours_per_day  numeric(5,2) not null default 8 check (hours_per_day > 0 and hours_per_day <= 24),
  total_hours    numeric(7,2) not null check (total_hours > 0),
  note           text,
  status         text not null default 'requested' check (status in ('requested','approved','declined','cancelled')),
  requested_by   uuid references app_user(id),
  requested_at   timestamptz not null default now(),
  decided_by     uuid references app_user(id),
  decided_at     timestamptz,
  decision_note  text,
  cancelled_by   uuid references app_user(id),
  cancelled_at   timestamptz,
  cancel_reason  text,
  check (ends_on >= starts_on),
  check (ends_on - starts_on <= 62),
  check (status <> 'declined' or coalesce(trim(decision_note),'') <> ''),
  check (status <> 'cancelled' or coalesce(trim(cancel_reason),'') <> '')
);
create index leave_request_person on leave_request (entity_id, employee_id, starts_on);
create index leave_request_open on leave_request (entity_id, status, starts_on);
create trigger leave_request_keep before delete on leave_request for each row execute function ops_no_delete();

create or replace function leave_request_rules() returns trigger
language plpgsql as $$
declare who uuid;
begin
  if new.status in ('approved','declined') and new.status is distinct from old.status then
    select app_user_id into who from employee where id = new.employee_id and entity_id = new.entity_id;
    if who is not null and new.decided_by = who then
      raise exception 'nobody approves or declines their own time off; another manager does';
    end if;
  end if;
  return new;
end $$;
create trigger leave_request_rules before update on leave_request for each row execute function leave_request_rules();

-- The days a request covers, and the payroll earning that pays each (paid leave, hourly).
create table leave_request_day (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  request_id  uuid not null references leave_request(id),
  day         date not null,
  hours       numeric(5,2) not null check (hours > 0),
  earning_id  uuid references payroll_earning(id),
  unique (request_id, day)
);
create trigger leave_request_day_keep before delete on leave_request_day for each row execute function ops_no_delete();

create table leave_ledger (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  employee_id   uuid not null references employee(id),
  leave_type_id uuid not null references leave_type(id),
  occurred_on   date not null,
  kind          text not null check (kind in ('accrual','taken','adjustment','reversal')),
  hours         numeric(7,3) not null check (hours <> 0),
  pay_period_id uuid references pay_period(id),
  request_id    uuid references leave_request(id),
  note          text,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  check (kind <> 'adjustment' or coalesce(trim(note),'') <> '')
);
create unique index leave_ledger_accrual_once on leave_ledger (employee_id, leave_type_id, pay_period_id) where kind = 'accrual';
create index leave_ledger_person on leave_ledger (entity_id, employee_id, leave_type_id);
create trigger leave_ledger_keep before update or delete on leave_ledger for each row execute function ops_no_delete();

create table company_holiday (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  day          date not null,
  name         text not null,
  store_closed boolean not null default true,
  paid         boolean not null default true,
  hours        numeric(5,2) not null default 8 check (hours > 0 and hours <= 24),
  blackout_id  uuid references delivery_blackout(id),
  created_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  unique (entity_id, day)
);
create trigger company_holiday_keep before delete on company_holiday for each row execute function ops_no_delete();

create table holiday_pay (
  entity_id   uuid not null references entity(id),
  holiday_id  uuid not null references company_holiday(id),
  employee_id uuid not null references employee(id),
  earning_id  uuid not null references payroll_earning(id),
  primary key (holiday_id, employee_id)
);
