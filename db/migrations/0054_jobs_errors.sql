-- The scheduler runs inside the web server (server/scheduler.ts) and records
-- every run; server errors get a short reference a person can read out.
--
-- job_run: one row per job per run, with its outcome. job_run_item: what the
-- run did for each company (an owner sees only their own company's items).
-- server_error: a failure the server could not turn into a sentence, with a
-- six-character reference shown to the person ("ref ABC123"). Messages and
-- stacks are stored redacted (no tokens, emails, card or account numbers).
-- Nothing here is deleted.

create table if not exists job_run (
  id          uuid primary key default gen_random_uuid(),
  job         text not null check (job ~ '^[a-z_]{2,40}$'),
  trigger     text not null default 'interval' check (trigger in ('interval','manual','cron')),
  runner      text not null default '',
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running','ok','partial','failed')),
  summary     text,
  error       text,
  detail      jsonb not null default '{}'::jsonb,
  check (status = 'running' or finished_at is not null)
);
create index if not exists job_run_recent on job_run (job, started_at desc);

create table if not exists job_run_item (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references job_run(id),
  tenant_id  uuid references tenant(id),
  entity_id  uuid references entity(id),
  ok         boolean not null,
  note       text not null default '',
  at         timestamptz not null default now()
);
create index if not exists job_run_item_run on job_run_item (run_id);
create index if not exists job_run_item_entity on job_run_item (entity_id, at desc);

create table if not exists server_error (
  id         uuid primary key default gen_random_uuid(),
  ref        text not null unique check (ref ~ '^[A-Z0-9]{6}$'),
  at         timestamptz not null default now(),
  kind       text not null check (kind in ('request','unhandled_rejection','uncaught_exception','job')),
  method     text,
  path       text,
  status     integer,
  message    text not null,
  stack      text,
  -- plain references (no keys), so an error log outlives a demo reset
  tenant_ref uuid,
  entity_ref uuid,
  who        text,
  alerted    boolean not null default false
);
create index if not exists server_error_recent on server_error (at desc);
