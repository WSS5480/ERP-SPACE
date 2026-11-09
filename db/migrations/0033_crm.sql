-- 0033_crm.sql
-- Marketing, customer management and the lead tracker. The customer is the
-- shared spine's one customer row; everything here hangs off it: a profile
-- (tags, preferences, household), consent per channel with where and when
-- it was given, notes, leads and their pipeline, tasks and appointments,
-- segments, campaigns and their messages, and coupon codes the register and
-- the web store can redeem.
--
-- Rules this file sets:
--   1. consent is a history, never edited: the latest row per channel is the answer
--   2. a text or call goes out only on an explicit opt-in; nothing goes to an opt-out
--   3. a coupon is redeemed once per order (database-unique), so a retry never double-counts
--   4. a merged customer keeps its row (inactive, pointing at the survivor); the merge is recorded

-- ------------------------------------------------------- module and role --
-- Added to whatever the checks already allow, so other modules' additions survive.
do $$
declare d text;
begin
  select pg_get_constraintdef(oid) into d from pg_constraint where conname = 'entity_module_module_check';
  if d is not null and d not like '%''crm''%' then
    execute 'alter table entity_module drop constraint entity_module_module_check';
    execute 'alter table entity_module add constraint entity_module_module_check '
      || replace(d, 'ARRAY[', 'ARRAY[''crm''::text, ');
  end if;
  select pg_get_constraintdef(oid) into d from pg_constraint where conname = 'role_grant_role_check';
  if d is not null and d not like '%''marketing''%' then
    execute 'alter table role_grant drop constraint role_grant_role_check';
    execute 'alter table role_grant add constraint role_grant_role_check '
      || replace(d, 'ARRAY[', 'ARRAY[''marketing''::text, ');
  end if;
end $$;

-- Companies that already chose their modules get CRM where they sell to people.
insert into entity_module (entity_id, module, enabled, changed_by)
select distinct entity_id, 'crm', true, 'migration 0033' from entity_module
 where module in ('pos','shop') and enabled
on conflict do nothing;

-- ------------------------------------------------------------ the person --
create table crm_household (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  name       text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table crm_profile (
  customer_id  uuid primary key references customer(id),
  entity_id    uuid not null references entity(id),
  household_id uuid references crm_household(id),
  tags         text[] not null default '{}',
  styles       text[] not null default '{}',          -- 'modern', 'farmhouse', 'coastal'
  rooms        text[] not null default '{}',          -- 'living room', 'bedroom'
  budget_minor bigint check (budget_minor is null or budget_minor >= 0),
  birthday     date,
  preferred_channel text check (preferred_channel in ('email','sms','call')),
  merged_into  uuid references customer(id),
  updated_at   timestamptz not null default now()
);
create index crm_profile_entity on crm_profile (entity_id);
create index crm_profile_tags on crm_profile using gin (tags);

create table crm_relation (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  customer_id uuid not null references customer(id),
  related_id  uuid not null references customer(id),
  relation    text not null check (length(trim(relation)) between 1 and 40),   -- 'spouse', 'designer', 'landlord'
  created_at  timestamptz not null default now(),
  check (customer_id <> related_id),
  unique (customer_id, related_id)
);

create table crm_consent (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  customer_id uuid not null references customer(id),
  channel     text not null check (channel in ('email','sms','call')),
  status      text not null check (status in ('opt_in','opt_out')),
  source      text not null check (length(trim(source)) between 1 and 60),   -- 'web_form', 'pos', 'staff', 'unsubscribe link', 'STOP reply'
  captured_at timestamptz not null default now(),
  captured_by uuid references app_user(id),
  evidence    text                                                         -- form wording, message id
);
create index crm_consent_latest on crm_consent (entity_id, customer_id, channel, captured_at desc);

create or replace function crm_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% rows are a history and are never changed; add a new one', tg_table_name;
end $$;
create trigger crm_consent_append_only before update or delete on crm_consent
  for each row execute function crm_append_only();

create table crm_note (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  customer_id uuid references customer(id),
  lead_id     uuid,
  body        text not null check (length(trim(body)) between 1 and 2000),
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now()
);
create index crm_note_customer on crm_note (entity_id, customer_id, created_at desc);

-- ------------------------------------------------------------- campaigns --
create table crm_segment (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  name        text not null check (length(trim(name)) between 1 and 80),
  filter      jsonb not null default '{}'::jsonb,
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  unique (entity_id, name)
);

create table crm_campaign (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  name         text not null check (length(trim(name)) between 1 and 80),
  channel      text not null check (channel in ('email','sms')),
  segment_id   uuid references crm_segment(id),
  subject      text,
  body         text not null check (length(trim(body)) between 1 and 4000),
  cost_minor   bigint not null default 0 check (cost_minor >= 0),
  status       text not null default 'draft' check (status in ('draft','scheduled','sent','cancelled')),
  scheduled_at timestamptz,
  sent_at      timestamptz,
  utm_campaign text,
  created_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  check (channel <> 'email' or coalesce(trim(subject),'') <> ''),
  unique (entity_id, name)
);

-- Every message a campaign (or a person) sends, one per recipient. With the
-- 'record' provider nothing leaves the building; the row is the seam.
create table crm_message (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  campaign_id  uuid references crm_campaign(id),
  customer_id  uuid references customer(id),
  lead_id      uuid,
  channel      text not null check (channel in ('email','sms')),
  to_ref       text not null,                      -- masked address
  subject      text,
  body         text not null,
  status       text not null check (status in ('queued','sent','delivered','opened','suppressed','failed')),
  reason       text,                               -- why suppressed or failed
  send_after   timestamptz not null default now(), -- quiet hours push this forward
  sent_at      timestamptz,
  delivered_at timestamptz,
  opened_at    timestamptz,
  provider     text not null default 'record',
  unsub_token  text not null unique check (unsub_token ~ '^[A-Za-z0-9_-]{20,64}$'),
  created_at   timestamptz not null default now(),
  check (status <> 'suppressed' or reason is not null)
);
create index crm_message_campaign on crm_message (entity_id, campaign_id, status);
create index crm_message_due on crm_message (entity_id, send_after) where status = 'queued';
create unique index crm_message_once on crm_message (campaign_id, customer_id) where campaign_id is not null;

create table crm_coupon (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  code            text not null check (code ~ '^[A-Z0-9-]{3,24}$'),
  campaign_id     uuid references crm_campaign(id),
  kind            text not null check (kind in ('percent','amount')),
  pct_bps         integer check (pct_bps between 1 and 5000),
  amount_minor    bigint check (amount_minor > 0),
  min_spend_minor bigint not null default 0 check (min_spend_minor >= 0),
  starts_on       date not null,
  ends_on         date not null,
  max_uses        integer check (max_uses > 0),
  once_per_customer boolean not null default true,
  channels        text[] not null default '{pos,web}',
  active          boolean not null default true,
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now(),
  check (ends_on >= starts_on),
  check ((kind = 'percent' and pct_bps is not null and amount_minor is null) or (kind = 'amount' and amount_minor is not null and pct_bps is null)),
  check (channels <@ array['pos','web']::text[] and cardinality(channels) > 0),
  unique (entity_id, code)
);

create table crm_coupon_redemption (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  coupon_id      uuid not null references crm_coupon(id),
  sales_order_id uuid not null references sales_order(id),
  customer_id    uuid references customer(id),
  channel        text not null check (channel in ('pos','web')),
  discount_minor bigint not null check (discount_minor >= 0),
  redeemed_by    uuid references app_user(id),
  redeemed_at    timestamptz not null default now(),
  unique (coupon_id, sales_order_id)
);
create index crm_redemption_customer on crm_coupon_redemption (coupon_id, customer_id);

-- ------------------------------------------------------------------ leads --
create table crm_assignment_rule (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  name        text not null check (length(trim(name)) between 1 and 80),
  location_id uuid references location(id),        -- null: any store
  source      text,                                 -- null: any source
  members     uuid[] not null check (cardinality(members) > 0),
  next_index  integer not null default 0 check (next_index >= 0),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index crm_rule_entity on crm_assignment_rule (entity_id) where active;

create table crm_lead (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  number          text not null,
  source          text not null check (source in ('walk_in','phone','web_form','quote_request','abandoned_cart','referral','campaign','other')),
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  campaign_id     uuid references crm_campaign(id),
  referred_by     uuid references customer(id),
  name            text not null check (length(trim(name)) between 1 and 80),
  email           text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone           text,
  interest        text,
  items           jsonb not null default '[]'::jsonb,      -- [{productId, choices, qty}] for the quote
  estimate_minor  bigint not null default 0 check (estimate_minor >= 0),
  customer_id     uuid references customer(id),            -- matched or converted
  duplicate_of    uuid references customer(id),            -- a likely match nobody has confirmed
  location_id     uuid references location(id),
  assigned_to     uuid references app_user(id),
  stage           text not null default 'new' check (stage in ('new','contacted','appointment','quoted','won','lost')),
  lost_reason     text,
  next_follow_up_at timestamptz,
  sales_order_id  uuid references sales_order(id),
  external_ref    text,                                    -- 'cart:<site>:<id>' so a cart is captured once
  consent         jsonb not null default '{}'::jsonb,      -- {"email": "opt_in", "sms": "opt_in"} given on a form, applied when the lead becomes a customer
  first_response_at timestamptz,
  won_at          timestamptz,
  lost_at         timestamptz,
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (stage <> 'lost' or coalesce(trim(lost_reason),'') <> ''),
  check (email is not null or phone is not null or source in ('walk_in','referral')),
  unique (entity_id, number)
);
create unique index crm_lead_external on crm_lead (entity_id, external_ref) where external_ref is not null;
create index crm_lead_pipeline on crm_lead (entity_id, stage, assigned_to);
create index crm_lead_followup on crm_lead (entity_id, next_follow_up_at) where stage not in ('won','lost');

create table crm_lead_event (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  lead_id    uuid not null references crm_lead(id),
  kind       text not null,          -- 'created', 'assigned', 'stage', 'converted', 'note'
  detail     text,
  by_user    uuid references app_user(id),
  at         timestamptz not null default now()
);
create index crm_lead_event_lead on crm_lead_event (lead_id, at);

-- ------------------------------------------------------- tasks, bookings --
create table crm_task (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  assigned_to  uuid not null references app_user(id),
  kind         text not null check (kind in ('call','text','email','appointment','todo')),
  title        text not null check (length(trim(title)) between 1 and 140),
  notes        text,
  due_at       timestamptz not null,
  ends_at      timestamptz,                         -- appointments
  location_id  uuid references location(id),       -- appointments: which showroom
  customer_id  uuid references customer(id),
  lead_id      uuid references crm_lead(id),
  auto         boolean not null default false,      -- made by a follow-up rule
  done_at      timestamptz,
  done_by      uuid references app_user(id),
  outcome      text,
  cancelled_at timestamptz,
  created_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  check (kind <> 'appointment' or (ends_at is not null and ends_at > due_at and location_id is not null))
);
create index crm_task_open on crm_task (entity_id, assigned_to, due_at) where done_at is null and cancelled_at is null;

-- ------------------------------------------------------------- merges --
create table crm_merge (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  survivor_id uuid not null references customer(id),
  merged_id   uuid not null references customer(id),
  moved       jsonb not null,                      -- {"sales_order.customer_id": 3, ...}
  reason      text not null check (length(trim(reason)) > 0),
  merged_by   uuid references app_user(id),
  merged_at   timestamptz not null default now(),
  check (survivor_id <> merged_id)
);
create trigger crm_merge_append_only before update or delete on crm_merge
  for each row execute function crm_append_only();

alter table crm_note add constraint crm_note_lead foreign key (lead_id) references crm_lead(id);
alter table crm_message add constraint crm_message_lead foreign key (lead_id) references crm_lead(id);
