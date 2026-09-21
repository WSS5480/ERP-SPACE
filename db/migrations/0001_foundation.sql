-- 0001_foundation.sql
-- Tenants, entities, the dimensions every posting carries, the chart of
-- accounts, periods, people, and the append-only audit log.
--
-- Rules this file enforces, in order of how expensive they are to retrofit:
--   1. tenant sits above entity; nothing joins across tenants
--   2. every posting carries entity, and may carry location / department /
--      profit object -- the profit object is the vertical-configurable one
--   3. money is never stored here; see 0004 and 0005 (integer minor units)
--   4. the audit log cannot be updated or deleted, by anyone

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tenants --

create table tenant (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  vertical            text not null default 'rto'
                        check (vertical in ('rto','retail','trucking','services')),
  -- the label layer: the same tables read differently per vertical
  location_label      text not null default 'Store',
  profit_object_label text not null default 'Store',
  aging_label         text not null default 'Back balances',
  created_at          timestamptz not null default now()
);

comment on column tenant.aging_label is
  'Back balances (rto) / Receivables (retail) / Settlements (trucking)';

-- --------------------------------------------------------------- entities --

create table entity (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenant(id),
  name                  text not null,
  legal_name            text not null,
  ein_ref               text,          -- key into the secrets store, never the EIN
  ein_last4             text check (ein_last4 ~ '^[0-9]{4}$'),
  fiscal_year_end_month smallint not null default 12
                          check (fiscal_year_end_month between 1 and 12),
  base_currency         char(3) not null default 'USD',
  status                text not null default 'active'
                          check (status in ('active','dormant','closed')),
  created_at            timestamptz not null default now(),
  unique (tenant_id, name)
);

create index entity_tenant on entity (tenant_id);

-- ------------------------------------------------------------- dimensions --

create table location (
  id        uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entity(id),
  code      text not null,
  name      text not null,
  state     char(2),
  opened_on date,
  status    text not null default 'active' check (status in ('active','closed')),
  unique (entity_id, code)
);

create table department (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  code      text not null,
  name      text not null,
  unique (tenant_id, code)
);

-- The vertical-configurable analysis unit. A store for retail, a truck for
-- trucking, a job for services. The ledger never knows which it is.
create table profit_object (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  kind        text not null check (kind in ('store','truck','job','route','other')),
  code        text not null,
  name        text not null,
  location_id uuid references location(id),
  status      text not null default 'active' check (status in ('active','retired')),
  unique (entity_id, code)
);

create index profit_object_entity on profit_object (entity_id);

-- ------------------------------------------------------ chart of accounts --

create table gl_account (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  code           text not null,
  name           text not null,
  account_type   text not null
                   check (account_type in ('asset','liability','equity','revenue','expense')),
  normal_balance char(1) not null check (normal_balance in ('D','C')),
  is_postable    boolean not null default true,
  unique (tenant_id, code)
);

-- Entities may use different subsets of one shared numbering.
create table entity_gl_account (
  entity_id     uuid not null references entity(id),
  gl_account_id uuid not null references gl_account(id),
  active        boolean not null default true,
  primary key (entity_id, gl_account_id)
);

-- ----------------------------------------------------------------- periods --

create table fiscal_period (
  id        uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entity(id),
  starts_on date not null,
  ends_on   date not null,
  status    text not null default 'open'
              check (status in ('open','soft_locked','closed')),
  locked_at timestamptz,
  locked_by uuid,
  unique (entity_id, starts_on),
  check (ends_on >= starts_on)
);

comment on column fiscal_period.status is
  'soft_locked reopens for a late adjustment; closed does not';

-- ------------------------------------------------------- people and roles --

create table app_user (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id),
  email      text not null,
  name       text not null,
  status     text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now()
);

create unique index app_user_email_key on app_user (tenant_id, lower(email));

-- A grant with entity_id null covers every entity in the tenant.
create table role_grant (
  id          uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references app_user(id),
  entity_id   uuid references entity(id),
  role        text not null
                check (role in ('owner','controller','ap_clerk','approver','viewer')),
  granted_at  timestamptz not null default now(),
  granted_by  uuid references app_user(id)
);

create unique index role_grant_key on role_grant
  (app_user_id, coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), role);

-- --------------------------------------------------------------- audit log --

create table audit_event (
  id          bigserial primary key,
  tenant_id   uuid not null,
  entity_id   uuid,
  at          timestamptz not null default now(),
  actor_kind  text not null check (actor_kind in ('user','agent','system')),
  actor_id    uuid,
  actor_label text not null,
  table_name  text not null,
  row_id      text not null,
  action      text not null check (action in ('insert','update','delete','transition')),
  before      jsonb,
  after       jsonb,
  reason      text,
  source_ref  text
);

create index audit_event_row  on audit_event (table_name, row_id, at desc);
create index audit_event_scope on audit_event (tenant_id, at desc);

-- Append only. Not a convention -- a rule the database keeps.
create or replace function audit_is_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_event is append-only (attempted %)', tg_op;
end $$;

create trigger audit_event_no_change
  before update or delete on audit_event
  for each row execute function audit_is_append_only();

-- Who is acting, for triggers that write audit rows. The API sets this per
-- transaction; an agent sets it to its own label and gets no extra powers.
create or replace function erp_actor_label() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('erp.actor_label', true), ''), 'system')
$$;

create or replace function erp_actor_kind() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('erp.actor_kind', true), ''), 'system')
$$;

create or replace function erp_actor_id() returns uuid
language sql stable as $$
  select nullif(current_setting('erp.actor_id', true), '')::uuid
$$;
