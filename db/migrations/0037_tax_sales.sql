-- 0037_tax_sales.sql
-- Sales tax by jurisdiction, the special-order deposit minimum, quote stock
-- holds, and tear sheets. Extends setup, pos, ar and reports; no new module.
--
-- Rules here:
--   1. A sale's tax is a stack of jurisdictions (state, county, city, special
--      district), each with its own rate over time and its own say on
--      whether delivery, labor and protection plans are taxable.
--   2. Where the goods are handed over decides the stack: the store for
--      take-with and pickup, the ship-to address for delivery when the
--      company sources by destination (tax_setting), the store when by origin.
--   3. Every line's tax is kept per jurisdiction (sales_order_line_tax), so a
--      filing can be made and tied to GL 2100. A return reverses the same rows.
--   4. An exemption certificate belongs to one customer, names its state and
--      may expire; an expired one is refused at the register.
--   5. A store with no jurisdictions keeps its single location rate as one
--      'combined' jurisdiction at exactly that rate. Every store that already
--      has a rate gets it here, so adding a statewide jurisdiction later never
--      quietly lowers an existing store's tax.

-- ------------------------------------------------------------- settings --
create table tax_setting (
  entity_id  uuid primary key references entity(id),
  sourcing   text not null default 'destination' check (sourcing in ('origin','destination')),
  set_by     text,
  set_at     timestamptz not null default now()
);

alter table pos_setting
  add column special_order_deposit_bps integer not null default 5000 check (special_order_deposit_bps between 0 and 10000),
  add column stocked_deposit_bps        integer not null default 0    check (stocked_deposit_bps between 0 and 10000),
  add column quote_holds_allowed        boolean not null default false,
  add column quote_hold_max_days        integer not null default 3    check (quote_hold_max_days between 1 and 30);

-- --------------------------------------------------------- jurisdictions --
create table tax_jurisdiction (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  code            text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  name            text not null check (trim(name) <> ''),
  level           text not null check (level in ('state','county','city','special','combined')),
  state           char(2) not null check (state ~ '^[A-Z]{2}$'),
  -- Goods are always taxed where a jurisdiction taxes at all; these three can be either.
  taxes_delivery  boolean not null default true,
  taxes_labor     boolean not null default false,
  taxes_warranty  boolean not null default true,
  filing_ref      text,                                  -- the account or permit number it is filed under
  note            text,
  -- set when this is the single-rate stand-in for a store that has no jurisdictions
  for_location_id uuid references location(id),
  active          boolean not null default true,
  created_by      text,
  created_at      timestamptz not null default now(),
  unique (entity_id, code)
);
create unique index tax_jurisdiction_one_standin on tax_jurisdiction (for_location_id) where for_location_id is not null;

create table tax_rate (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  jurisdiction_id uuid not null references tax_jurisdiction(id),
  rate_bps        integer not null check (rate_bps between 0 and 2000),
  effective_from  date not null,
  effective_to    date,
  note            text,
  created_by      text,
  created_at      timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (jurisdiction_id, effective_from)
);
create index tax_rate_lookup on tax_rate (entity_id, jurisdiction_id, effective_from desc);

-- Two rates of one jurisdiction never cover the same day.
create or replace function tax_rate_no_overlap() returns trigger language plpgsql as $$
begin
  if exists (select 1 from tax_rate r where r.jurisdiction_id = new.jurisdiction_id and r.id <> new.id
               and r.effective_from <= coalesce(new.effective_to, 'infinity'::date)
               and coalesce(r.effective_to, 'infinity'::date) >= new.effective_from) then
    raise exception 'that rate overlaps another rate of the same jurisdiction; end the old one first';
  end if;
  return new;
end $$;
create trigger tax_rate_no_overlap before insert or update on tax_rate for each row execute function tax_rate_no_overlap();

-- Where a jurisdiction applies: a whole state, one postal code in a state, or one named location.
create table tax_area (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  jurisdiction_id uuid not null references tax_jurisdiction(id),
  location_id     uuid references location(id),
  state           char(2) check (state ~ '^[A-Z]{2}$'),
  postal          text check (postal ~ '^[0-9]{5}$'),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  check ((location_id is not null) <> (state is not null)),
  check (postal is null or state is not null)
);
create unique index tax_area_unique on tax_area (jurisdiction_id, coalesce(location_id::text, ''), coalesce(state, ''), coalesce(postal, '')) where active;
create index tax_area_lookup on tax_area (entity_id, state, postal) where active;
create index tax_area_location on tax_area (entity_id, location_id) where active and location_id is not null;

-- ------------------------------------------------------ exemption papers --
create table tax_exemption_certificate (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  customer_id  uuid not null references customer(id),
  number       text not null check (trim(number) <> ''),
  state        char(2) not null check (state ~ '^[A-Z]{2}$'),
  reason       text not null check (reason in ('resale','government','nonprofit','agricultural','manufacturing','other')),
  expires_on   date,                                    -- null: does not expire
  status       text not null default 'active' check (status in ('active','void')),
  void_reason  text,
  created_by   text,
  created_at   timestamptz not null default now(),
  check (status <> 'void' or coalesce(trim(void_reason), '') <> ''),
  unique (entity_id, customer_id, number)
);
create index tax_cert_customer on tax_exemption_certificate (entity_id, customer_id);

alter table pos_order add column exemption_certificate_id uuid references tax_exemption_certificate(id);

-- ----------------------------------------------------- tax per line, per place --
create table sales_order_line_tax (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  sales_order_id      uuid not null references sales_order(id),
  sales_order_line_id uuid not null references sales_order_line(id),
  jurisdiction_id     uuid not null references tax_jurisdiction(id),
  kind                text not null default 'sale' check (kind in ('sale','return')),
  sourced             text not null check (sourced in ('origin','destination')),
  item_class          text not null check (item_class in ('goods','delivery','labor','warranty','other')),
  rate_bps            integer not null check (rate_bps between 0 and 2000),
  taxable_minor       bigint not null default 0,
  exempt_minor        bigint not null default 0,
  exempt_reason       text check (exempt_reason in ('resale','government','nonprofit','agricultural','manufacturing','other_certificate',
                                                    'item_not_taxable','delivery_exempt','labor_exempt','warranty_exempt','not_taxed')),
  tax_minor           bigint not null default 0,
  -- what this jurisdiction is owed on the line; differs from tax_minor only when another door
  -- (the web store, service, an import) charged a different amount than the stack gives
  owed_minor          bigint not null default 0,
  note                text,                                         -- e.g. ZIP not covered by local jurisdictions
  uncovered_postal    text,
  original_id         uuid references sales_order_line_tax(id),    -- a return row names the sale row it reverses
  posted_on           date,                                         -- the day it reached GL 2100 (sale handed over, or return)
  journal_entry_id    uuid references journal_entry(id),
  created_at          timestamptz not null default now(),
  check ((exempt_minor = 0) or exempt_reason is not null),
  check (kind = 'sale' or original_id is not null),
  check ((posted_on is null) = (journal_entry_id is null)),
  unique (sales_order_line_id, jurisdiction_id)
);
create index sales_order_line_tax_order on sales_order_line_tax (entity_id, sales_order_id);
create index sales_order_line_tax_posted on sales_order_line_tax (entity_id, posted_on) where posted_on is not null;

-- ---------------------------------------------- deposits and quote holds --
alter table pos_override drop constraint pos_override_kind_check;
alter table pos_override add constraint pos_override_kind_check
  check (kind in ('discount','below_cost','deposit','hold_extend'));

create table pos_quote_hold (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  sales_order_id uuid not null references sales_order(id),
  held_until     date not null,
  status         text not null default 'active' check (status in ('active','released','expired','converted','cancelled')),
  lines_held     integer not null default 0,
  requested_by   uuid references app_user(id),
  extended_by    uuid references app_user(id),
  extend_reason  text,
  ended_at       timestamptz,
  end_reason     text,
  created_at     timestamptz not null default now(),
  check ((status = 'active') = (ended_at is null)),
  check (extended_by is null or coalesce(trim(extend_reason), '') <> '')
);
create unique index pos_quote_hold_one_active on pos_quote_hold (sales_order_id) where status = 'active';
create index pos_quote_hold_due on pos_quote_hold (entity_id, held_until) where status = 'active';

-- ----------------------------------------------------------- tear sheets --
-- A link for the customer carries a random token; only its hash is kept.
create table tear_sheet_link (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  sales_order_id uuid references sales_order(id),
  product_id     uuid references product(id),
  customer_id    uuid references customer(id),
  token_sha256   text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  opened_count   integer not null default 0,
  created_by     uuid references app_user(id),
  created_at     timestamptz not null default now(),
  check ((sales_order_id is not null) <> (product_id is not null))
);
create index tear_sheet_link_order on tear_sheet_link (entity_id, sales_order_id);

alter table customer_message drop constraint customer_message_kind_check;
alter table customer_message add constraint customer_message_kind_check
  check (kind in ('confirmation','day_before','en_route','delivered','exception','schedule_link','rescheduled','cancelled','service_update','tear_sheet'));

-- ------------------------------------- existing stores keep their rate --
-- A store with a single rate and no jurisdiction of its own gets its stand-in now.
-- Kept as a function: setup calls the same rule for a store saved later.
create or replace function tax_make_standins(p_entity uuid default null, p_location uuid default null) returns integer language plpgsql as $$
declare
  l record;
  jid uuid;
  n integer := 0;
  st text;
  cd text;
begin
  for l in select x.id, x.entity_id, x.code, x.name, x.tax_rate_bps, upper(coalesce(x.state, x.address->>'state')) state
             from location x
            where x.kind in ('store','outlet') and x.status = 'active' and x.tax_rate_bps > 0
              and (p_entity is null or x.entity_id = p_entity)
              and (p_location is null or x.id = p_location)
              and not exists (select 1 from tax_jurisdiction j where j.for_location_id = x.id)
              and not exists (select 1 from tax_area a where a.location_id = x.id and a.active)
  loop
    st := l.state;
    continue when st is null or st !~ '^[A-Z]{2}$';
    cd := regexp_replace('LOC-' || upper(l.code), '[^A-Z0-9_-]', '-', 'g');
    if exists (select 1 from tax_jurisdiction j where j.entity_id = l.entity_id and j.code = cd) then
      cd := cd || '-' || upper(left(l.id::text, 4));
    end if;
    insert into tax_jurisdiction (entity_id, code, name, level, state, taxes_delivery, taxes_labor, taxes_warranty, for_location_id, note, created_by)
    values (l.entity_id, left(cd, 40), left(l.name || ' (single store rate)', 120), 'combined', st, true, true, true, l.id,
            'The store''s single sales tax rate, kept as one jurisdiction until local ones are set up.', 'migration')
    returning id into jid;
    insert into tax_rate (entity_id, jurisdiction_id, rate_bps, effective_from, note, created_by)
    values (l.entity_id, jid, l.tax_rate_bps, '2000-01-01', 'from the store''s rate', 'migration');
    insert into tax_area (entity_id, jurisdiction_id, location_id) values (l.entity_id, jid, l.id);
    n := n + 1;
  end loop;
  return n;
end $$;

select tax_make_standins();
