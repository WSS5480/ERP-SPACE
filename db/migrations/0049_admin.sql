-- 0049_admin.sql
-- The admin layer: every service a company can switch on or off, and one
-- place to connect everything outside (email, texts, card payments, maps,
-- marketplaces...). See packages/core/services.ts and packages/core/messaging.ts.
--
-- The rules the database holds:
--   1. a switch hides a service's screens; it never stops the service: no
--      data, job or posting looks at entity_module except the screens
--   2. no secret is stored in a connection's settings (a trigger refuses
--      secret-looking keys); secrets are AES-256-GCM sealed in
--      admin_connection_secret, bound to their connection and name
--   3. one live connection of a kind per company, and one for the whole client
--   4. nothing is deleted: a connection is turned off, a message is kept with
--      its status; a message carrying a sign-in code keeps the code redacted

-- ------------------------------------------------------ 1. every service
alter table entity_module drop constraint if exists entity_module_module_check;
alter table entity_module add constraint entity_module_module_check check (module in (
  'catalog','purchasing','inventory','pos','ar','workforce','fleet','shop','crm','service','reports','group','edi',
  'wms','salestax','loading','haulaway','memos','timeoff','lots','labels','settlements','trade','projects',
  'sectionals','asis','storeorders','leads','marketing','aisle','myday','payroll'));

-- A company that already chose its modules gets a switch for each new service,
-- set the way its screens showed until now (the module they rode on), so
-- nothing appears or disappears today.
insert into entity_module (entity_id, module, enabled, changed_by)
select m.entity_id, s.service, m.enabled, 'migration 0049'
  from entity_module m
  join (values ('wms','inventory'), ('loading','fleet'), ('haulaway','fleet'), ('timeoff','workforce'),
               ('lots','inventory'), ('labels','inventory'), ('settlements','ar'), ('trade','crm'), ('projects','crm'),
               ('sectionals','catalog'), ('asis','inventory'), ('storeorders','edi'), ('leads','crm'), ('marketing','crm'),
               ('aisle','shop'), ('myday','crm')) s(service, rode_on) on s.rode_on = m.module
on conflict do nothing;
insert into entity_module (entity_id, module, enabled, changed_by)
select distinct m.entity_id, s.service, true, 'migration 0049'
  from entity_module m cross join (values ('salestax'), ('memos'), ('payroll')) s(service)
on conflict do nothing;

-- ------------------------------------------------- 2. outside connections
-- One row per kind (email, sms, card, maps, plaid, amazon, ...) per company,
-- or with no company for the whole client; a company's own row wins.
create table admin_connection (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  entity_id      uuid references entity(id),                     -- null: the whole client
  kind           text not null check (kind ~ '^[a-z][a-z0-9_]{1,30}$'),
  provider       text not null check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  settings       jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  active         boolean not null default true,
  status         text not null default 'saved' check (status in ('saved','connected','failing','off')),
  last_error     text,
  last_tested_at timestamptz,
  last_ok_at     timestamptz,
  updated_by     uuid references app_user(id),
  updated_by_name text,
  updated_at     timestamptz not null default now(),
  check (active = (status <> 'off'))
);
create unique index admin_connection_one_live on admin_connection
  (tenant_id, coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), kind) where active;
create index admin_connection_kind on admin_connection (tenant_id, kind);

create or replace function admin_connection_no_secrets() returns trigger
language plpgsql as $$
declare k text;
begin
  for k in select jsonb_object_keys(new.settings) loop
    if lower(k) ~ '(password|passwd|secret|private_?key|api_?key|token|credential|passphrase)' then
      raise exception 'connection settings may not hold %; type it into the secret boxes instead', k;
    end if;
  end loop;
  return new;
end $$;
create trigger admin_connection_no_secrets before insert or update on admin_connection
  for each row execute function admin_connection_no_secrets();

-- Write-only secrets, bound to their connection and name (the AAD).
create table admin_connection_secret (
  connection_id uuid not null references admin_connection(id),
  tenant_id     uuid not null references tenant(id),
  name          text not null check (name ~ '^[a-zA-Z][a-zA-Z0-9_]{1,40}$'),
  iv            bytea not null check (octet_length(iv) = 12),
  ciphertext    bytea not null,
  tag           bytea not null check (octet_length(tag) = 16),
  set_by        uuid references app_user(id),
  set_at        timestamptz not null default now(),
  cleared_at    timestamptz,                                     -- cleared, not deleted
  primary key (connection_id, name)
);

-- ------------------------------------------------ 3. what went out, and how
create table outbound_message (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  channel       text not null check (channel in ('email','sms','webhook')),
  purpose       text not null check (purpose ~ '^[a-z][a-z_]{1,30}$'),   -- trade_code, purchase_order, delivery, report, tear_sheet, test...
  to_addr       text not null,
  subject       text,
  body          text not null,                                  -- a code in it is kept as ******
  redacted      boolean not null default false,
  resendable    boolean not null default true,
  connection_id uuid references admin_connection(id),
  provider      text not null,                                  -- smtp, sendgrid, twilio, ... or 'none' (logged, not sent)
  status        text not null default 'queued' check (status in ('queued','sent','failed','logged')),
  provider_ref  text,
  error         text,
  source_table  text,
  source_id     uuid,
  resend_of     uuid references outbound_message(id),
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  check (status <> 'sent' or sent_at is not null),
  check (not redacted or not resendable)
);
create index outbound_message_recent on outbound_message (entity_id, created_at desc);
