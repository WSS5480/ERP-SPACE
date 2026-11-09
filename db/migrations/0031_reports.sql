-- 0031_reports.sql
-- The report creator and editor. A report is a saved definition over one of
-- the curated datasets in packages/core/reports_datasets.ts -- never SQL a
-- person typed. Reports are versioned (every save is a new row in
-- report_version), shared privately, with roles, or with the whole company,
-- pinned to a person's Home, and scheduled. A scheduled run keeps what it
-- showed (report_snapshot) and prepares an email (report_delivery); there is
-- no mail service yet, so a delivery stays 'prepared' until one is wired in.
-- Nothing is deleted: removing a report sets its status, by its owner only.

-- Packs and the module switch know about reports.
alter table entity_module drop constraint entity_module_module_check;
alter table entity_module add constraint entity_module_module_check check (module in
  ('catalog','purchasing','inventory','pos','ar','workforce','fleet','shop','reports','service','crm'));
-- Companies that already chose their modules get reports switched on.
insert into entity_module (entity_id, module, enabled, changed_by)
select distinct entity_id, 'reports', true, 'migration 0031' from entity_module
on conflict do nothing;

create table report (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  name         text not null check (length(btrim(name)) between 1 and 120),
  description  text check (description is null or length(description) <= 500),
  folder       text not null default 'My reports' check (length(btrim(folder)) between 1 and 60),
  dataset      text not null check (dataset ~ '^[a-z][a-z0-9_]{0,40}$'),
  definition   jsonb not null,
  owner_id     uuid references app_user(id),          -- null: a starter the company was given
  shared       text not null default 'private' check (shared in ('private','roles','company')),
  share_roles  text[] not null default '{}',
  starter      text,                                    -- the starter it came from, so a pack adds it once
  version      integer not null default 1 check (version >= 1),
  schedule     jsonb,                                   -- {every, weekday|monthday, to: [person ids]}
  next_run_on  date,
  schedule_by  uuid references app_user(id),            -- runs as this person, with the roles they hold then
  status       text not null default 'active' check (status in ('active','deleted')),
  created_at   timestamptz not null default now(),
  created_by   uuid references app_user(id),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references app_user(id),
  deleted_at   timestamptz,
  deleted_by   uuid references app_user(id),
  unique (entity_id, starter),
  check (shared <> 'roles' or cardinality(share_roles) > 0),
  check (owner_id is not null or starter is not null),
  check ((schedule is null) = (next_run_on is null)),
  check (status = 'active' or deleted_at is not null)
);
create index report_entity on report (entity_id, status, folder);
create index report_due on report (next_run_on) where status = 'active' and schedule is not null;

create table report_version (
  entity_id   uuid not null references entity(id),
  report_id   uuid not null references report(id),
  version     integer not null,
  name        text not null,
  description text,
  definition  jsonb not null,
  changed_by  uuid references app_user(id),
  changed_at  timestamptz not null default now(),
  primary key (report_id, version)
);

-- Versions are history: never rewritten.
create function report_version_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'a saved version of a report is never changed; save a new one';
end $$;
create trigger report_version_no_change before update or delete on report_version
  for each row execute function report_version_immutable();

create table report_pin (
  entity_id   uuid not null references entity(id),
  report_id   uuid not null references report(id),
  app_user_id uuid not null references app_user(id),
  pinned_at   timestamptz not null default now(),
  primary key (report_id, app_user_id)
);

create table report_snapshot (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  report_id  uuid not null references report(id),
  version    integer not null,
  trigger    text not null check (trigger in ('schedule','manual')),
  run_by     uuid references app_user(id),
  run_at     timestamptz not null default now(),
  result     jsonb,
  row_count  integer not null default 0,
  problem    text,
  check ((result is null) <> (problem is null))
);
create index report_snapshot_report on report_snapshot (report_id, run_at desc);

create table report_delivery (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  report_id    uuid not null references report(id),
  snapshot_id  uuid not null references report_snapshot(id),
  channel      text not null default 'email' check (channel in ('email')),
  recipients   text[] not null default '{}',
  subject      text not null,
  status       text not null default 'prepared' check (status in ('prepared','sent','failed')),
  prepared_at  timestamptz not null default now(),
  sent_at      timestamptz,
  provider_ref text,
  problem      text,
  check (status <> 'sent' or sent_at is not null)
);
