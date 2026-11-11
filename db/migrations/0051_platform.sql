-- 0051_platform.sql
-- The ERP as a product sold to many businesses (SaaS).
--
-- Two kinds of user:
--   platform operators -- the developer team. They sign in with ERP_LOGINS
--     (name:key, in the server's environment, never here), run the Operator
--     console and may enter a customer's tenant in support mode, which is
--     recorded (platform_support_session, platform_audit).
--   customer users -- real accounts that belong to ONE tenant
--     (platform_login, one per app_user). Email and a scrypt password hash
--     with its own salt; invites, password resets and sign-in codes are
--     single-use tokens of which only a hash is kept.
--
-- Tenants gain a kind (customer, or demo: the sample data a prospect can be
-- shown), a status (suspended customers cannot sign in; their data is kept)
-- and a plan. The tenants the placeholder seeds made (Demo Furniture Co and
-- Rio Freight) become the demo, so a live database that ran with
-- ERP_SEED=placeholder keeps its sample data as the demo and nothing else.
--
-- Per-tenant API tokens (platform_api_token) let a tenant owner connect an
-- integration without the install-wide ERP_API_TOKEN; only the hash is kept.

alter table tenant
  add column if not exists kind text not null default 'customer' check (kind in ('customer','demo')),
  add column if not exists status text not null default 'active' check (status in ('active','suspended')),
  add column if not exists plan text not null default 'standard',
  add column if not exists status_reason text,
  add column if not exists status_changed_at timestamptz,
  add column if not exists status_changed_by text,
  add column if not exists last_activity_at timestamptz,
  add column if not exists created_by text;

comment on column tenant.kind is
  'customer: a business that bought the ERP; demo: sample data for showing it (reset from db/seed by the Operator console)';

-- The sample data that is already here is the demo.
update tenant set kind = 'demo', plan = 'demo'
 where id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d');

-- ------------------------------------------------------------ customer users --

create table platform_login (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  app_user_id      uuid not null unique references app_user(id),
  email            text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  kind             text not null default 'customer' check (kind in ('customer','prospect')),
  status           text not null default 'invited' check (status in ('invited','active','disabled')),
  -- scrypt$N$r$p$<salt base64url>$<hash base64url>; the salt is the user's own
  pw_hash          text check (pw_hash is null or pw_hash like 'scrypt$%'),
  password_set_at  timestamptz,
  -- bumped on a password change, a reset, a disable or a suspension: every older session ends
  session_version  integer not null default 1,
  -- a sales prospect's demo login ends here
  expires_at       timestamptz,
  last_entity_id   uuid references entity(id),
  last_sign_in_at  timestamptz,
  created_at       timestamptz not null default now(),
  created_by       text not null default 'system',
  check (kind <> 'prospect' or expires_at is not null),
  check (status <> 'active' or pw_hash is not null)
);

-- One email signs in to one account, across every tenant.
create unique index platform_login_email_key on platform_login (email);
create index platform_login_tenant on platform_login (tenant_id);

-- Invites, password resets and emailed sign-in codes. Single use, short-lived,
-- only the sha256 kept.
create table platform_login_token (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  login_id    uuid not null references platform_login(id),
  purpose     text not null check (purpose in ('invite','reset','code')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  retired_at  timestamptz,
  tries       integer not null default 0,
  created_at  timestamptz not null default now(),
  created_by  text not null default 'system'
);

create index platform_login_token_login on platform_login_token (login_id, purpose) where used_at is null and retired_at is null;

-- ---------------------------------------------------------- tenant API tokens --

create table platform_api_token (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  name         text not null check (length(name) between 2 and 60),
  token_hash   text not null unique,
  prefix       text not null,
  status       text not null default 'active' check (status in ('active','revoked')),
  created_at   timestamptz not null default now(),
  created_by   text not null,
  revoked_at   timestamptz,
  revoked_by   text,
  replaced_by  uuid references platform_api_token(id),
  last_used_at timestamptz,
  check ((status = 'revoked') = (revoked_at is not null))
);

create index platform_api_token_tenant on platform_api_token (tenant_id);

-- -------------------------------------------------------------- support mode --

create table platform_support_session (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  operator    text not null,
  reason      text not null check (length(reason) between 3 and 500),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  ended_by    text
);

create index platform_support_open on platform_support_session (operator) where ended_at is null;

-- ------------------------------------------------------------ platform audit --

-- What operators do to customers (create, suspend, support, demo reset), and
-- what happens to accounts (invites, resets, sign-ins refused for a lock).
-- Append only, like audit_event, and never removed by a demo reset.
create table platform_audit (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       text not null,
  actor_kind  text not null check (actor_kind in ('operator','customer','token','system')),
  tenant_id   uuid,
  entity_id   uuid,
  support_id  uuid,
  action      text not null,
  detail      jsonb not null default '{}'::jsonb
);

create index platform_audit_tenant on platform_audit (tenant_id, at desc);

create or replace function platform_audit_is_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'platform_audit is append-only (attempted %)', tg_op;
end $$;

create trigger platform_audit_no_change
  before update or delete on platform_audit
  for each row execute function platform_audit_is_append_only();
