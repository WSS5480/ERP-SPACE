-- 0023_fleet.sql
-- Fleet and delivery: the trucks, the people who drive them, where we
-- deliver and when, the stops booked against that capacity, the routes the
-- stops are loaded onto, and what happened at each door.
--
-- Rules the database holds (because breaking them costs money or safety):
--   1. a truck with a failed safety item on its inspection is out of service
--      until a manager -- not the driver who found it -- clears it
--   2. an out-of-service truck cannot be put on a route, loaded or sent out
--   3. a driver whose licence has expired (or is the wrong class for the
--      truck) cannot be put on a route
--   4. a zone/window/day cannot be booked past its capacity (stops, pieces,
--      cube, labour minutes) unless a dispatcher overrides it with a reason
--   5. a locked (loaded) route's stop order does not change
--   6. an odometer never goes backwards
--   7. one order line is on at most one live stop
-- Nothing is deleted: stops and routes are cancelled, inspections cleared.

-- ------------------------------------------------------------- settings --
create table fleet_setting (
  entity_id          uuid primary key references entity(id),
  time_zone          text not null default 'America/New_York',
  avg_mph            numeric(5,1) not null default 30 check (avg_mph > 0),
  road_factor        numeric(4,2) not null default 1.30 check (road_factor >= 1),
  route_start        time not null default '07:30',
  route_end          time not null default '18:30',
  base_service_min   smallint not null default 10 check (base_service_min >= 0),
  per_piece_min      smallint not null default 4 check (per_piece_min >= 0),
  per_stair_piece_min smallint not null default 3 check (per_stair_piece_min >= 0),
  labor_cost_hour_minor bigint not null default 2200 check (labor_cost_hour_minor >= 0),
  fuel_price_minor   bigint not null default 389 check (fuel_price_minor >= 0),   -- per gallon, when no fuel log
  booking_lead_days  smallint not null default 1 check (booking_lead_days >= 0),
  link_valid_days    smallint not null default 14 check (link_valid_days > 0)
);

-- ------------------------------------------------------------- vehicles --
create table vehicle (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  unit_no          text not null,
  vin_last6        text not null check (vin_last6 ~ '^[A-HJ-NPR-Z0-9]{6}$'),   -- never the full VIN
  plate            text,
  plate_state      char(2),
  kind             text not null check (kind in ('box_truck','van','pickup','straight_truck','tractor','trailer')),
  make_model       text,
  model_year       smallint check (model_year between 1980 and 2100),
  home_location_id uuid not null references location(id),
  cube_ft          numeric(8,1) not null check (cube_ft > 0),
  max_weight_lb    numeric(8,0) not null check (max_weight_lb > 0),
  max_stops        smallint not null default 14 check (max_stops > 0),
  crew_size        smallint not null default 2 check (crew_size between 1 and 4),
  mpg              numeric(4,1) not null default 9 check (mpg > 0),
  requires_cdl     boolean not null default false,
  status           text not null default 'active' check (status in ('active','out_of_service','retired')),
  oos_reason       text,
  odometer_mi      integer not null default 0 check (odometer_mi >= 0),
  geotab_device_id text,              -- integration seam only; the feed writes odometer and position
  created_at       timestamptz not null default now(),
  unique (entity_id, unit_no),
  check (status <> 'out_of_service' or coalesce(trim(oos_reason),'') <> '')
);
create unique index vehicle_geotab on vehicle (entity_id, geotab_device_id) where geotab_device_id is not null;

create table vehicle_odometer (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  vehicle_id  uuid not null references vehicle(id),
  reading_mi  integer not null check (reading_mi >= 0),
  read_at     timestamptz not null default now(),
  source      text not null check (source in ('manual','dvir','fuel','service','route','geotab')),
  recorded_by uuid references app_user(id)
);
create index vehicle_odometer_vehicle on vehicle_odometer (vehicle_id, read_at desc);

create or replace function vehicle_odometer_rules() returns trigger
language plpgsql as $$
declare cur integer;
begin
  select odometer_mi into cur from vehicle where id = new.vehicle_id and entity_id = new.entity_id for update;
  if cur is null then raise exception 'that vehicle belongs to another company'; end if;
  if new.reading_mi < cur then
    raise exception 'an odometer reading of % is below the last one (%); odometers do not go backwards', new.reading_mi, cur;
  end if;
  update vehicle set odometer_mi = new.reading_mi where id = new.vehicle_id;
  return new;
end $$;
create trigger vehicle_odometer_rules before insert on vehicle_odometer
  for each row execute function vehicle_odometer_rules();

create table maintenance_schedule (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  vehicle_id    uuid not null references vehicle(id),
  task          text not null,                 -- 'Oil and filter', 'Annual DOT inspection'
  every_miles   integer check (every_miles > 0),
  every_days    integer check (every_days > 0),
  last_done_mi  integer not null default 0,
  last_done_on  date not null default current_date,
  active        boolean not null default true,
  check (every_miles is not null or every_days is not null)
);
create index maintenance_schedule_vehicle on maintenance_schedule (entity_id, vehicle_id);

create table service_record (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  vehicle_id    uuid not null references vehicle(id),
  schedule_id   uuid references maintenance_schedule(id),
  performed_on  date not null,
  odometer_mi   integer check (odometer_mi >= 0),
  vendor_name   text,
  description   text not null,
  cost_minor    bigint not null default 0 check (cost_minor >= 0),
  recorded_by   uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index service_record_vehicle on service_record (entity_id, vehicle_id, performed_on desc);

create table fuel_log (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  vehicle_id  uuid not null references vehicle(id),
  driver_id   uuid references app_user(id),
  filled_on   date not null default current_date,
  gallons     numeric(7,2) not null check (gallons > 0),
  cost_minor  bigint not null check (cost_minor > 0),
  odometer_mi integer check (odometer_mi >= 0),
  station     text,
  created_at  timestamptz not null default now()
);
create index fuel_log_vehicle on fuel_log (entity_id, vehicle_id, filled_on desc);

-- ------------------------------------------------- drivers and helpers --
-- A person with the driver role. A helper rides along and lifts; only a
-- driver with a current licence of the right class is put behind the wheel.
create table driver_profile (
  entity_id        uuid not null references entity(id),
  app_user_id      uuid not null references app_user(id),
  kind             text not null default 'driver' check (kind in ('driver','helper')),
  license_class    text check (license_class in ('A','B','C','D')),
  license_state    char(2),
  license_last4    text check (license_last4 ~ '^[A-Z0-9]{4}$'),
  license_expires  date,
  medical_expires  date,
  phone            text,
  default_helper_id uuid references app_user(id),
  hourly_cost_minor bigint check (hourly_cost_minor >= 0),
  active           boolean not null default true,
  primary key (entity_id, app_user_id),
  check (kind = 'helper' or (license_class is not null and license_expires is not null)),
  check (default_helper_id is distinct from app_user_id)
);

-- ------------------------------------------------- pre-trip inspections --
create table dvir (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  vehicle_id    uuid not null references vehicle(id),
  driver_id     uuid not null references app_user(id),
  kind          text not null default 'pre_trip' check (kind in ('pre_trip','post_trip')),
  odometer_mi   integer check (odometer_mi >= 0),
  items         jsonb not null,                -- [{code,label,safety,ok,note}]
  defects       smallint not null default 0 check (defects >= 0),
  safety_failed boolean not null default false,
  status        text not null check (status in ('passed','defects_noted','failed','cleared')),
  submitted_at  timestamptz not null default now(),
  cleared_by    uuid references app_user(id),
  cleared_at    timestamptz,
  clear_note    text,
  check (status <> 'cleared' or (cleared_by is not null and coalesce(trim(clear_note),'') <> '')),
  check (cleared_by is distinct from driver_id)          -- the driver who found it does not clear it
);
create index dvir_vehicle on dvir (entity_id, vehicle_id, submitted_at desc);

create or replace function dvir_rules() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'inspections are never deleted'; end if;
  if tg_op = 'INSERT' then
    if new.safety_failed then
      update vehicle set status = 'out_of_service',
             oos_reason = 'Failed ' || replace(new.kind,'_','-') || ' inspection'
       where id = new.vehicle_id and entity_id = new.entity_id and status <> 'retired';
    end if;
    return new;
  end if;
  -- updates: only clearing a failed inspection
  if new.items <> old.items or new.safety_failed <> old.safety_failed or new.vehicle_id <> old.vehicle_id
     or new.driver_id <> old.driver_id then
    raise exception 'an inspection is a record; it cannot be edited, only cleared';
  end if;
  if new.status = 'cleared' and old.status <> 'failed' then
    raise exception 'only a failed inspection is cleared';
  end if;
  return new;
end $$;
create trigger dvir_rules before insert or update or delete on dvir
  for each row execute function dvir_rules();

-- A truck comes back into service only when no failed inspection is open.
create or replace function vehicle_rules() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'vehicles are never deleted; retire it'; end if;
  if new.status = 'active' and old.status = 'out_of_service'
     and exists (select 1 from dvir d where d.vehicle_id = new.id and d.status = 'failed') then
    raise exception 'unit % has a failed inspection; a manager has to clear it before it goes back in service', new.unit_no;
  end if;
  if new.status = 'active' then new.oos_reason := null; end if;
  return new;
end $$;
create trigger vehicle_rules before update or delete on vehicle
  for each row execute function vehicle_rules();

-- --------------------------------------------------------- zones/windows --
create table delivery_zone (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  code           text not null,
  name           text not null,
  dc_location_id uuid not null references location(id),
  postal_codes   text[] not null check (cardinality(postal_codes) > 0),
  days           smallint[] not null default '{1,2,3,4,5,6}' check (days <@ '{0,1,2,3,4,5,6}'::smallint[] and cardinality(days) > 0),
  fee_minor      bigint not null default 0 check (fee_minor >= 0),
  active         boolean not null default true,
  unique (entity_id, code)
);
create index delivery_zone_postal on delivery_zone using gin (postal_codes);

-- A postal code is in one active zone per company, so a booking has one answer.
create or replace function delivery_zone_rules() returns trigger
language plpgsql as $$
declare dup text;
begin
  if new.active then
    select z.code into dup from delivery_zone z
     where z.entity_id = new.entity_id and z.active and z.id <> new.id and z.postal_codes && new.postal_codes limit 1;
    if dup is not null then
      raise exception 'a postal code in zone % is already in zone %; a postal code belongs to one zone', new.code, dup;
    end if;
  end if;
  return new;
end $$;
create trigger delivery_zone_rules before insert or update on delivery_zone
  for each row execute function delivery_zone_rules();

create table delivery_window (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  zone_id        uuid not null references delivery_zone(id),
  label          text not null,                -- '8–12'
  starts         time not null,
  ends           time not null,
  stops_cap      smallint check (stops_cap >= 0),
  pieces_cap     smallint check (pieces_cap >= 0),
  cube_cap       numeric(8,1) check (cube_cap >= 0),
  labor_min_cap  integer check (labor_min_cap >= 0),
  active         boolean not null default true,
  check (ends > starts),
  unique (zone_id, starts)
);

create table delivery_blackout (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  zone_id    uuid references delivery_zone(id),    -- null = every zone
  day        date not null,
  reason     text not null
);
create index delivery_blackout_day on delivery_blackout (entity_id, day);

-- ------------------------------------------------------------- routes --
create table delivery_route (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  number          text not null,
  route_on        date not null,
  dc_location_id  uuid not null references location(id),
  vehicle_id      uuid references vehicle(id),
  driver_id       uuid references app_user(id),
  helper_id       uuid references app_user(id),
  status          text not null default 'draft'
                    check (status in ('draft','locked','in_progress','completed','cancelled')),
  start_min       smallint not null default 450,     -- minutes after midnight the truck leaves
  planned_miles   numeric(8,1) not null default 0,
  planned_minutes integer not null default 0,
  actual_miles    numeric(8,1),
  start_odometer  integer,
  end_odometer    integer,
  locked_at       timestamptz,
  locked_by       uuid references app_user(id),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (entity_id, number),
  check (helper_id is null or helper_id is distinct from driver_id),
  check (status in ('draft','cancelled') or (vehicle_id is not null and driver_id is not null))
);
create unique index delivery_route_vehicle_day on delivery_route (entity_id, vehicle_id, route_on)
  where status <> 'cancelled' and vehicle_id is not null;
create unique index delivery_route_driver_day on delivery_route (entity_id, driver_id, route_on)
  where status <> 'cancelled' and driver_id is not null;
create index delivery_route_day on delivery_route (entity_id, route_on, dc_location_id);

create or replace function delivery_route_rules() returns trigger
language plpgsql as $$
declare v record; d record; h record; entering boolean;
begin
  if tg_op = 'DELETE' then raise exception 'routes are never deleted; cancel it'; end if;
  if new.status in ('cancelled','completed') then return new; end if;
  entering := tg_op = 'INSERT' or (new.status in ('locked','in_progress') and new.status is distinct from old.status);
  if new.vehicle_id is not null and (entering or new.vehicle_id is distinct from old.vehicle_id) then
    select * into v from vehicle where id = new.vehicle_id and entity_id = new.entity_id;
    if v.id is null then raise exception 'that vehicle belongs to another company'; end if;
    if v.status <> 'active' then
      raise exception 'unit % is %; it cannot go on a route', v.unit_no,
        case v.status when 'out_of_service' then 'out of service (' || coalesce(v.oos_reason,'no reason') || ')' else v.status end;
    end if;
  end if;
  if new.driver_id is not null and (entering or new.driver_id is distinct from old.driver_id
       or new.route_on is distinct from old.route_on or new.vehicle_id is distinct from old.vehicle_id) then
    select p.*, u.name into d from driver_profile p join app_user u on u.id = p.app_user_id
     where p.entity_id = new.entity_id and p.app_user_id = new.driver_id;
    if d.app_user_id is null or not d.active then raise exception 'that person is not set up as an active driver'; end if;
    if d.kind <> 'driver' then raise exception '% is a helper, not a licensed driver', d.name; end if;
    if d.license_expires < new.route_on then
      raise exception '%''s licence expired on %; renew it before assigning a route', d.name, to_char(d.license_expires, 'Mon DD, YYYY');
    end if;
    if new.vehicle_id is not null and exists (select 1 from vehicle x where x.id = new.vehicle_id and x.requires_cdl)
       and d.license_class not in ('A','B') then
      raise exception '% holds a class % licence; this truck needs a CDL (class A or B)', d.name, d.license_class;
    end if;
  end if;
  if new.helper_id is not null and (tg_op = 'INSERT' or new.helper_id is distinct from old.helper_id) then
    select p.*, u.name into h from driver_profile p join app_user u on u.id = p.app_user_id
     where p.entity_id = new.entity_id and p.app_user_id = new.helper_id;
    if h.app_user_id is null or not h.active then raise exception 'that helper is not set up on the delivery crew'; end if;
  end if;
  return new;
end $$;
create trigger delivery_route_rules before insert or update or delete on delivery_route
  for each row execute function delivery_route_rules();

-- -------------------------------------------------------------- stops --
create table delivery_stop (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  number          text not null,
  kind            text not null check (kind in ('delivery','pickup','service','will_call')),
  sales_order_id  uuid references sales_order(id),
  customer_id     uuid references customer(id),
  address_id      uuid references customer_address(id),
  dc_location_id  uuid not null references location(id),
  zone_id         uuid references delivery_zone(id),
  window_id       uuid references delivery_window(id),
  scheduled_on    date,
  status          text not null default 'scheduled'
                    check (status in ('scheduled','arrived','delivered','partial','failed','cancelled')),
  pieces          smallint not null default 0 check (pieces >= 0),
  cube_ft         numeric(8,1) not null default 0 check (cube_ft >= 0),
  weight_lb       numeric(8,0) not null default 0 check (weight_lb >= 0),
  service_min     smallint not null default 0 check (service_min >= 0),
  over_capacity_ok boolean not null default false,
  override_reason text,
  route_id        uuid references delivery_route(id),
  seq             smallint,
  eta_min         smallint,                     -- minutes after midnight the crew should start at the door
  arrived_at      timestamptz,
  completed_at    timestamptz,
  completed_by    uuid references app_user(id),
  exception       text check (exception in ('refused','damaged','not_home','partial','other')),
  exception_reason text,
  pod_recipient   text,
  pod_signature   text check (pod_signature is null or (pod_signature like 'data:image/%' and length(pod_signature) <= 400000)),
  pod_photos      text[] not null default '{}',
  notes           text,
  problem         text,                          -- service call: what is wrong
  cancel_reason   text,
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now(),
  unique (entity_id, number),
  check (kind = 'will_call' or address_id is not null),
  check (kind <> 'service' or coalesce(trim(problem),'') <> ''),
  check (not over_capacity_ok or coalesce(trim(override_reason),'') <> ''),
  check (status <> 'cancelled' or coalesce(trim(cancel_reason),'') <> ''),
  check (status <> 'failed' or coalesce(trim(exception_reason),'') <> ''),
  check (route_id is null or kind <> 'will_call')
);
create index delivery_stop_day on delivery_stop (entity_id, scheduled_on, status);
create index delivery_stop_route on delivery_stop (route_id, seq);
create index delivery_stop_order on delivery_stop (sales_order_id);

create table delivery_stop_line (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  stop_id             uuid not null references delivery_stop(id),
  sales_order_line_id uuid references sales_order_line(id),
  description         text not null,
  qty                 numeric(10,2) not null check (qty > 0),
  pieces              smallint not null default 1 check (pieces >= 0),
  outcome             text not null default 'pending'
                        check (outcome in ('pending','delivered','picked_up','refused','damaged','not_delivered','cancelled')),
  flagged_for_warehouse boolean not null default false,
  note                text
);
create index delivery_stop_line_stop on delivery_stop_line (stop_id);
create unique index delivery_stop_line_live on delivery_stop_line (sales_order_line_id)
  where outcome = 'pending' and sales_order_line_id is not null;

-- Capacity: what a zone's window can take on a day. Locks the window row so
-- two bookings at once cannot both take the last slot.
create or replace function delivery_stop_capacity() returns trigger
language plpgsql as $$
declare w record; t record;
begin
  if tg_op = 'DELETE' then raise exception 'stops are never deleted; cancel it with a reason'; end if;
  if new.window_id is null or new.scheduled_on is null or new.status = 'cancelled' or new.over_capacity_ok then return new; end if;
  if tg_op = 'UPDATE' and new.window_id = old.window_id and new.scheduled_on = old.scheduled_on
     and old.status <> 'cancelled' and new.pieces <= old.pieces and new.cube_ft <= old.cube_ft
     and new.service_min <= old.service_min then
    return new;
  end if;
  select * into w from delivery_window where id = new.window_id and entity_id = new.entity_id for update;
  if w.id is null then raise exception 'that delivery window belongs to another company'; end if;
  select count(*) n, coalesce(sum(pieces),0) pcs, coalesce(sum(cube_ft),0) cube, coalesce(sum(service_min),0) lab
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
  if w.labor_min_cap is not null and t.lab + new.service_min > w.labor_min_cap then
    raise exception 'the % window on % has % crew minutes left, not %', w.label, to_char(new.scheduled_on, 'Mon DD'), greatest(w.labor_min_cap - t.lab, 0), new.service_min;
  end if;
  return new;
end $$;
create trigger delivery_stop_capacity before insert or update or delete on delivery_stop
  for each row execute function delivery_stop_capacity();

-- A loaded route's order is fixed: the truck was packed in reverse of it.
create or replace function delivery_stop_route_lock() returns trigger
language plpgsql as $$
begin
  if (new.route_id is distinct from old.route_id or new.seq is distinct from old.seq)
     and exists (select 1 from delivery_route r where r.id in (old.route_id, new.route_id)
                  and r.status in ('locked','in_progress','completed')) then
    raise exception 'that route is locked (the truck is loaded); unlock it before moving stops';
  end if;
  return new;
end $$;
create trigger delivery_stop_route_lock before update on delivery_stop
  for each row execute function delivery_stop_route_lock();

-- ------------------------------------------------ self-scheduling links --
-- The customer gets a link carrying a random token; only its hash is kept.
create table delivery_link (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  sales_order_id uuid not null references sales_order(id),
  token_sha256   text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at     timestamptz not null,
  used_at        timestamptz,
  revoked_at     timestamptz,
  created_by     uuid references app_user(id),
  created_at     timestamptz not null default now()
);
create index delivery_link_order on delivery_link (entity_id, sales_order_id);

-- ----------------------------------------------- customer notifications --
create table customer_message (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  stop_id      uuid references delivery_stop(id),
  sales_order_id uuid references sales_order(id),
  customer_id  uuid references customer(id),
  kind         text not null check (kind in ('confirmation','day_before','en_route','delivered','exception','schedule_link','rescheduled','cancelled')),
  channel      text not null check (channel in ('sms','email')),
  to_addr      text not null,
  body         text not null,
  provider     text not null default 'log',
  status       text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  provider_ref text,
  error        text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index customer_message_stop on customer_message (entity_id, stop_id, created_at);
create unique index customer_message_day_before on customer_message (stop_id, kind) where kind in ('day_before','confirmation') and status <> 'failed';
