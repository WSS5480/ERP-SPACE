-- Accounting periods that open on their own, month-end and year-end close, and
-- store-local business dates.
--
-- Safe on a live database: every change adds (columns, tables, functions), and
-- the only rows written are months for the demo tenants and the demo's 3900.
--
-- 1. The clock. erp_now() is now(), unless a check pinned the clock for its
--    transaction (set_config('erp.now', ...), done by db.tx when the clock is
--    pinned). business_today(entity, location) is the local date there.
-- 2. Time zones. location.time_zone and entity.time_zone (both optional). A
--    store's zone is its own, else the time clock's for that store, else the
--    company's, else the time clock's or delivery settings' company zone, else
--    the zone of the store's (or company's) state, else New York.
-- 3. Periods. period_event logs every period opened (by hand or on its own),
--    closed and reopened; fiscal_year_close keeps the year-end closing journal
--    and its reversal. A closed period refuses postings in a sentence.

-- ------------------------------------------------------------------ clock --
create or replace function erp_now() returns timestamptz
language sql stable as $$
  select coalesce(nullif(current_setting('erp.now', true), '')::timestamptz, now())
$$;

-- The zone most of a state keeps (the whole country: 50 states and DC).
create or replace function state_time_zone(st text) returns text
language sql immutable as $$
  select case upper(coalesce(st, ''))
    when 'AL' then 'America/Chicago'     when 'AK' then 'America/Anchorage'  when 'AZ' then 'America/Phoenix'
    when 'AR' then 'America/Chicago'     when 'CA' then 'America/Los_Angeles' when 'CO' then 'America/Denver'
    when 'CT' then 'America/New_York'    when 'DE' then 'America/New_York'   when 'DC' then 'America/New_York'
    when 'FL' then 'America/New_York'    when 'GA' then 'America/New_York'   when 'HI' then 'Pacific/Honolulu'
    when 'ID' then 'America/Boise'       when 'IL' then 'America/Chicago'    when 'IN' then 'America/Indiana/Indianapolis'
    when 'IA' then 'America/Chicago'     when 'KS' then 'America/Chicago'    when 'KY' then 'America/New_York'
    when 'LA' then 'America/Chicago'     when 'ME' then 'America/New_York'   when 'MD' then 'America/New_York'
    when 'MA' then 'America/New_York'    when 'MI' then 'America/Detroit'    when 'MN' then 'America/Chicago'
    when 'MS' then 'America/Chicago'     when 'MO' then 'America/Chicago'    when 'MT' then 'America/Denver'
    when 'NE' then 'America/Chicago'     when 'NV' then 'America/Los_Angeles' when 'NH' then 'America/New_York'
    when 'NJ' then 'America/New_York'    when 'NM' then 'America/Denver'     when 'NY' then 'America/New_York'
    when 'NC' then 'America/New_York'    when 'ND' then 'America/Chicago'    when 'OH' then 'America/New_York'
    when 'OK' then 'America/Chicago'     when 'OR' then 'America/Los_Angeles' when 'PA' then 'America/New_York'
    when 'RI' then 'America/New_York'    when 'SC' then 'America/New_York'   when 'SD' then 'America/Chicago'
    when 'TN' then 'America/Chicago'     when 'TX' then 'America/Chicago'    when 'UT' then 'America/Denver'
    when 'VT' then 'America/New_York'    when 'VA' then 'America/New_York'   when 'WA' then 'America/Los_Angeles'
    when 'WV' then 'America/New_York'    when 'WI' then 'America/Chicago'    when 'WY' then 'America/Denver'
    else null end
$$;

-- Declared immutable so a check constraint may use it; the zone database only changes with a Postgres upgrade.
create or replace function valid_time_zone(tz text) returns boolean
language plpgsql immutable as $$
begin
  if tz is null then return true; end if;
  if tz !~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2}$' then return false; end if;
  perform now() at time zone tz;
  return true;
exception when others then
  return false;
end $$;

alter table entity   add column if not exists time_zone text;
alter table location add column if not exists time_zone text;
do $$ begin
  alter table entity add constraint entity_time_zone_valid check (valid_time_zone(time_zone));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table location add constraint location_time_zone_valid check (valid_time_zone(time_zone));
exception when duplicate_object then null; end $$;
comment on column location.time_zone is 'the store''s own zone; empty means the company''s (business_tz)';
comment on column entity.time_zone is 'the company''s zone; stores without their own use it (business_tz)';

create or replace function business_tz(p_entity uuid, p_location uuid default null) returns text
language sql stable as $$
  select coalesce(
    (select nullif(l.time_zone, '') from location l where l.id = p_location and l.entity_id = p_entity),
    (select nullif(wl.timezone, '') from workforce_location wl where wl.location_id = p_location and wl.entity_id = p_entity),
    (select nullif(e.time_zone, '') from entity e where e.id = p_entity),
    (select nullif(ws.timezone, '') from workforce_settings ws where ws.entity_id = p_entity),
    (select nullif(fs.time_zone, '') from fleet_setting fs where fs.entity_id = p_entity),
    state_time_zone((select l.state from location l where l.id = p_location and l.entity_id = p_entity)),
    state_time_zone((select e.state from entity e where e.id = p_entity)),
    state_time_zone((select l.state from location l where l.entity_id = p_entity and l.status = 'active' and l.state is not null
                      order by (l.kind in ('store','outlet')) desc, l.code limit 1)),
    'America/New_York')
$$;

create or replace function business_today(p_entity uuid, p_location uuid default null) returns date
language sql stable as $$
  select (erp_now() at time zone business_tz(p_entity, p_location))::date
$$;

-- ---------------------------------------------------------------- periods --
alter table journal_entry drop constraint journal_entry_source_type_check;
alter table journal_entry add constraint journal_entry_source_type_check
  check (source_type in ('invoice','payment','payroll','depreciation','accrual',
                         'intercompany','manual','reversal','opening','transfer','deposit',
                         'sale','receipt','refund','inventory','commission','ar','fleet','finance','service','closing'));

alter table fiscal_period add column if not exists closed_reason text;

create table if not exists period_event (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  period_id   uuid references fiscal_period(id),
  kind        text not null check (kind in ('auto_opened','opened','closed','reopened','year_closed','year_reopened')),
  starts_on   date not null,
  ends_on     date not null,
  reason      text,
  detail      jsonb not null default '{}'::jsonb,
  by_label    text not null,
  by_user     uuid references app_user(id),
  at          timestamptz not null default now(),
  check (kind not in ('reopened','year_reopened') or coalesce(trim(reason), '') <> '')
);
create index if not exists period_event_entity on period_event (entity_id, at desc);

create or replace function period_event_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'the period log is kept as written' using errcode = 'check_violation';
end $$;
drop trigger if exists period_event_append_only_trg on period_event;
create trigger period_event_append_only_trg before update or delete on period_event
  for each row execute function period_event_append_only();

create table if not exists fiscal_year_close (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entity(id),
  fy_start          date not null,
  fy_end            date not null,
  journal_entry_id  uuid references journal_entry(id),
  reversal_entry_id uuid references journal_entry(id),
  retained_code     text not null,
  net_income_minor  bigint not null default 0,
  status            text not null default 'closed' check (status in ('closed','reopened')),
  closed_by         text not null,
  closed_at         timestamptz not null default now(),
  reopened_by       text,
  reopened_at       timestamptz,
  reopen_reason     text,
  check (status = 'closed' or (reversal_entry_id is not null or journal_entry_id is null) and coalesce(trim(reopen_reason), '') <> '')
);
-- one live close per company and year; a reopened one stays as history
create unique index if not exists fiscal_year_close_live on fiscal_year_close (entity_id, fy_end) where status = 'closed';

-- A closed period refuses a posting in words a person can act on.
create or replace function journal_period_open() returns trigger
language plpgsql as $$
declare v_status text; v_start date;
begin
  select status, starts_on into v_status, v_start from fiscal_period where id = new.period_id;
  if v_status = 'closed' then
    raise exception 'the books for % are closed, so nothing can be posted on %. An owner can reopen the month in Books, Periods (with a reason), or post it on a day in an open month.',
      to_char(v_start, 'FMMonth YYYY'), new.posting_date
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ------------------------------------------------- retained earnings, demo --
-- The year-end close posts to 3900. Packs now carry it; the demo's clients get it here if they lack it.
insert into gl_account (tenant_id, code, name, account_type, normal_balance)
select t.id, '3900', 'Retained earnings', 'equity', 'C' from tenant t
 where t.kind = 'demo' and not exists (select 1 from gl_account g where g.tenant_id = t.id and g.code = '3900');
insert into entity_gl_account (entity_id, gl_account_id)
select e.id, g.id from entity e join tenant t on t.id = e.tenant_id join gl_account g on g.tenant_id = t.id and g.code = '3900'
 where t.kind = 'demo'
on conflict do nothing;

-- The demo's months run out (Rio Freight's at the end of November 2026): open every month from the
-- demo's last one to three months ahead. Customers' companies get theirs from the daily period job.
with x as (
  insert into fiscal_period (entity_id, starts_on, ends_on, status)
  select e.id, d::date, (d + interval '1 month - 1 day')::date, 'open'
    from entity e join tenant t on t.id = e.tenant_id
    cross join lateral generate_series(
      coalesce((select max(p.starts_on) from fiscal_period p where p.entity_id = e.id) + interval '1 month', date_trunc('month', current_date)),
      date_trunc('month', current_date) + interval '3 months', interval '1 month') d
   where t.kind = 'demo' and e.status = 'active'
     and not exists (select 1 from fiscal_period p where p.entity_id = e.id
                      and daterange(p.starts_on, p.ends_on, '[]') && daterange(d::date, (d + interval '1 month - 1 day')::date, '[]'))
  on conflict (entity_id, starts_on) do nothing
  returning id, entity_id, starts_on, ends_on
)
insert into period_event (entity_id, period_id, kind, starts_on, ends_on, reason, by_label)
select x.entity_id, x.id, 'auto_opened', x.starts_on, x.ends_on, 'migration 0053: the demo keeps three months ahead open', 'migration' from x;
