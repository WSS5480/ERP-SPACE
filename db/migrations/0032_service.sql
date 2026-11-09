-- 0032_service.sql
-- Service and repair: a customer's problem with something we sold, from the
-- first call (or web form, or a delivery that went wrong) to the fix, the
-- parts, the visits, who pays, and what it cost.
--
-- Rules the database holds:
--   1. a ticket moves only along the workflow (new -> triage -> awaiting parts
--      / scheduled -> in progress -> resolved -> closed), and every move is a
--      row in service_event with who and when -- no move without one
--   2. a resolved or closed ticket says how it was resolved; a ticket is
--      triaged with a coverage decision before work is scheduled or resolved
--   3. goodwill and $0 replacements carry a reason and the manager who allowed it
--   4. costs and events are records: never deleted, never edited
-- Money is bigint minor units. Every row carries entity_id.

-- ---------------------------------------------------- roles, modules, books --
alter table role_grant drop constraint role_grant_role_check;
alter table role_grant add constraint role_grant_role_check
  check (role in ('owner','controller','ap_clerk','approver','viewer',
                  'store_manager','sales','cashier','buyer','warehouse',
                  'dispatcher','driver','ar_clerk','hr','web_admin','technician'));

alter table entity_module drop constraint entity_module_module_check;
alter table entity_module add constraint entity_module_module_check
  check (module in ('catalog','purchasing','inventory','pos','ar','workforce','fleet','shop','service'));

alter table journal_entry drop constraint journal_entry_source_type_check;
alter table journal_entry add constraint journal_entry_source_type_check
  check (source_type in ('invoice','payment','payroll','depreciation','accrual',
                         'intercompany','manual','reversal','opening','transfer','deposit',
                         'sale','receipt','refund','inventory','commission','ar','fleet','finance','service'));

-- ------------------------------------------------------------ settings --
-- Manufacturer warranty, by vendor and/or category. The most specific rule
-- wins (vendor + category, then vendor, then category, then the default).
create table service_warranty_rule (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  vendor_id   uuid references vendor(id),
  category    text,
  months      smallint not null check (months between 0 and 240),
  covers      text[] not null default '{defect,warranty,assembly}'
                check (covers <@ '{damage_delivery,defect,warranty,protection_plan,assembly,comfort,other}'::text[]),
  note        text
);
create unique index service_warranty_rule_key on service_warranty_rule
  (entity_id, coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(category, ''));

-- Third-party service companies (a furniture repair tech, an appliance servicer).
create table service_provider (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  name        text not null,
  phone       text,
  email       text,
  vendor_id   uuid references vendor(id),        -- when they bill us through payables
  hourly_rate_minor bigint check (hourly_rate_minor >= 0),
  categories  text[] not null default '{}',
  active      boolean not null default true,
  unique (entity_id, name)
);

-- ------------------------------------------------------------- tickets --
create table service_ticket (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  number          text not null,
  source          text not null check (source in ('pos','web','phone','delivery','email','other')),
  status          text not null default 'new'
                    check (status in ('new','triage','awaiting_parts','scheduled','in_progress','resolved','closed','cancelled')),
  customer_id     uuid references customer(id),
  address_id      uuid references customer_address(id),
  contact_name    text,                         -- the web form, before we know who they are
  contact_phone   text,
  contact_email   text,
  sales_order_id  uuid references sales_order(id),
  sales_order_line_id uuid references sales_order_line(id),
  piece_label     text,                         -- the barcode on the carton, when there is one
  product_id      uuid references product(id),
  vendor_id       uuid references vendor(id),
  issue_type      text not null check (issue_type in ('damage_delivery','defect','warranty','protection_plan','assembly','comfort','other')),
  description     text not null check (length(trim(description)) >= 5),
  photos          text[] not null default '{}',
  priority        text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  sla_due_at      timestamptz not null,
  coverage        text check (coverage in ('manufacturer','protection_plan','goodwill','billable')),
  coverage_note   text,
  coverage_by     uuid references app_user(id),
  plan_line_id    uuid references sales_order_line(id),   -- the protection plan sold on the order
  technician_id   uuid references app_user(id),
  provider_id     uuid references service_provider(id),
  resolution_type text check (resolution_type in ('in_home_repair','replace_part','replace_item','credit_refund','pickup_repair','no_fault_found')),
  resolution_note text,
  service_order_id uuid references sales_order(id),       -- covered parts and replacements, at $0
  billing_order_id uuid references sales_order(id),       -- what the customer pays for
  damage_id       uuid,                                    -- inventory's damage record, when goods came back
  origin_stop_line_id uuid references delivery_stop_line(id),
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  closed_at       timestamptz,
  unique (entity_id, number),
  check (customer_id is not null or coalesce(trim(contact_name), '') <> ''),
  check (status not in ('resolved','closed') or resolution_type is not null),
  check (status in ('new','triage','cancelled') or coverage is not null),
  check (coverage is distinct from 'goodwill' or coalesce(trim(coverage_note), '') <> ''),
  check (photos is null or cardinality(photos) <= 12)
);
create index service_ticket_status on service_ticket (entity_id, status, sla_due_at);
create index service_ticket_customer on service_ticket (entity_id, customer_id);
create index service_ticket_vendor on service_ticket (entity_id, vendor_id);
create unique index service_ticket_origin on service_ticket (origin_stop_line_id) where origin_stop_line_id is not null and status <> 'cancelled';

-- Every step, with who and when. The trigger below refuses a status change
-- that skips the workflow, and writes this row itself.
create table service_event (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  ticket_id   uuid not null references service_ticket(id),
  at          timestamptz not null default now(),
  by_user     uuid references app_user(id),
  by_label    text not null,
  kind        text not null check (kind in ('status','note','coverage','assign','part','visit','cost','claim','billing','resolution','photo')),
  from_status text,
  to_status   text,
  note        text
);
create index service_event_ticket on service_event (ticket_id, at);

create or replace function service_ticket_flow() returns trigger
language plpgsql as $$
declare ok boolean; who uuid; lbl text;
begin
  if tg_op = 'DELETE' then raise exception 'service tickets are never deleted; cancel or close it'; end if;
  who := nullif(current_setting('erp.actor_id', true), '')::uuid;
  lbl := coalesce(nullif(current_setting('erp.actor_label', true), ''), 'system');
  if tg_op = 'INSERT' then
    if new.status <> 'new' then raise exception 'a ticket starts as new'; end if;
    return new;
  end if;
  new.updated_at := now();
  if new.status is distinct from old.status then
    ok := case old.status
      when 'new'            then new.status in ('triage','cancelled')
      when 'triage'         then new.status in ('awaiting_parts','scheduled','in_progress','resolved','cancelled')
      when 'awaiting_parts' then new.status in ('scheduled','in_progress','resolved','triage')
      when 'scheduled'      then new.status in ('in_progress','awaiting_parts','resolved','triage')
      when 'in_progress'    then new.status in ('awaiting_parts','scheduled','resolved')
      when 'resolved'       then new.status in ('closed','in_progress')
      else false end;
    if not ok then
      raise exception 'a ticket that is % cannot go to %', replace(old.status,'_',' '), replace(new.status,'_',' ');
    end if;
    if new.status = 'resolved' then new.resolved_at := now(); end if;
    if new.status = 'in_progress' and old.status = 'resolved' then new.resolved_at := null; end if;
    if new.status = 'closed' then new.closed_at := now(); end if;
    insert into service_event (entity_id, ticket_id, by_user, by_label, kind, from_status, to_status)
    values (new.entity_id, new.id, who, lbl, 'status', old.status, new.status);
  end if;
  if old.status = 'closed' and (new.coverage is distinct from old.coverage or new.resolution_type is distinct from old.resolution_type) then
    raise exception 'ticket % is closed', old.number;
  end if;
  return new;
end $$;
create trigger service_ticket_flow before insert or update or delete on service_ticket
  for each row execute function service_ticket_flow();

create or replace function service_ticket_opened() returns trigger
language plpgsql as $$
begin
  insert into service_event (entity_id, ticket_id, by_user, by_label, kind, to_status, note)
  values (new.entity_id, new.id, nullif(current_setting('erp.actor_id', true), '')::uuid,
          coalesce(nullif(current_setting('erp.actor_label', true), ''), 'system'), 'status', 'new', 'opened from ' || new.source);
  return null;
end $$;
create trigger service_ticket_opened after insert on service_ticket
  for each row execute function service_ticket_opened();

create or replace function service_record_only() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are records; they are never edited or deleted', tg_table_name;
end $$;
create trigger service_event_record_only before update or delete on service_event
  for each row execute function service_record_only();

-- ---------------------------------------------------------------- parts --
-- A part (or a replacement piece) is a line on the ticket's service order
-- ($0, covered) or billing order (billable). Purchasing orders it through
-- its special-order link; inventory receives and reserves it to that line.
create table service_part (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  ticket_id           uuid not null references service_ticket(id),
  sales_order_line_id uuid not null references sales_order_line(id) unique,
  product_id          uuid not null references product(id),
  qty                 numeric(10,2) not null check (qty > 0),
  kind                text not null default 'part' check (kind in ('part','replacement')),
  billable            boolean not null,
  approved_by         uuid references app_user(id),     -- a $0 replacement needs a manager
  approval_reason     text,
  used_at             timestamptz,
  cancelled_at        timestamptz,
  created_by          uuid references app_user(id),
  created_at          timestamptz not null default now(),
  check (kind <> 'replacement' or billable or (approved_by is not null and coalesce(trim(approval_reason),'') <> ''))
);
create index service_part_ticket on service_part (ticket_id);

-- --------------------------------------------------------------- visits --
create table service_visit (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  ticket_id     uuid not null references service_ticket(id),
  stop_id       uuid references delivery_stop(id) unique,   -- in-house: a fleet service stop
  provider_id   uuid references service_provider(id),       -- third party: their own appointment
  kind          text not null default 'repair' check (kind in ('repair','pickup')),
  scheduled_on  date,
  outcome       text check (outcome in ('fixed','needs_parts','needs_return','no_fault','not_home','other')),
  work_notes    text,
  minutes       integer check (minutes between 0 and 1440),
  technician_id uuid references app_user(id),
  completed_at  timestamptz,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  check (stop_id is not null or provider_id is not null),
  check (outcome is null or completed_at is not null)
);
create index service_visit_ticket on service_visit (ticket_id);

-- ---------------------------------------------------------------- costs --
-- What the service cost us, and who carries it. Posted when recorded:
--   charged to service expense   Dr 6150 warranty and service expense
--   charged back to the vendor   Dr 1150 vendor chargebacks receivable
--   credit side: in-house labour Cr 6155 service labour applied (out of wages)
--                third party     Cr 2050 accrued, until their bill comes through payables
--                parts used      Cr 5000 (they left stock as a $0 sale at cost)
create table service_cost (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  ticket_id      uuid not null references service_ticket(id),
  visit_id       uuid references service_visit(id),
  kind           text not null check (kind in ('labor','third_party','parts','replacement','other')),
  amount_minor   bigint not null check (amount_minor > 0),
  charge_to      text not null check (charge_to in ('service_expense','vendor')),
  note           text,
  journal_entry_id uuid references journal_entry(id),
  created_by     uuid references app_user(id),
  created_at     timestamptz not null default now()
);
create index service_cost_ticket on service_cost (ticket_id);
create trigger service_cost_record_only before update or delete on service_cost
  for each row execute function service_record_only();

-- Inventory's vendor claims tied to the ticket they came from.
create table service_claim (
  entity_id  uuid not null references entity(id),
  ticket_id  uuid not null references service_ticket(id),
  claim_id   uuid not null references inv_vendor_claim(id),
  primary key (ticket_id, claim_id)
);

-- ------------------------------------------------------- the web form --
-- Each public request is counted by a hash of the sender's address, so the
-- form can refuse floods without keeping anyone's IP.
create table service_web_hit (
  entity_id  uuid not null references entity(id),
  ip_hash    text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  at         timestamptz not null default now(),
  accepted   boolean not null
);
create index service_web_hit_recent on service_web_hit (entity_id, ip_hash, at desc);

-- Service updates go through the same customer message log (and provider seam) as delivery texts.
alter table customer_message drop constraint customer_message_kind_check;
alter table customer_message add constraint customer_message_kind_check
  check (kind in ('confirmation','day_before','en_route','delivered','exception','schedule_link','rescheduled','cancelled','service_update'));
