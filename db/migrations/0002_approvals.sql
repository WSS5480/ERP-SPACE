-- 0002_approvals.sql
-- The approval engine, built once. Every module after this reuses it:
-- invoices, vendor banking, payment release, journals, period locks, payroll.
--
-- Policy is data, not code. Thresholds and step order live in rows so they
-- can differ per entity without a deploy.

create table approval_policy (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entity(id),
  subject_type      text not null,
  -- the policy applies at or above this amount; 0 means always
  min_amount_minor  bigint not null default 0 check (min_amount_minor >= 0),
  -- [{"seq":1,"role":"approver"},{"seq":2,"role":"controller"}]
  steps             jsonb not null,
  requires_callback boolean not null default false,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (entity_id, subject_type, min_amount_minor)
);

comment on column approval_policy.requires_callback is
  'vendor bank changes: a callback to a number already on file must be logged';

create table approval_request (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  entity_id    uuid not null references entity(id),
  subject_type text not null,
  subject_id   uuid not null,
  policy_id    uuid references approval_policy(id),
  amount_minor bigint,
  status       text not null default 'open'
                 check (status in ('open','approved','rejected','cancelled')),
  maker_id     uuid not null references app_user(id),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);

-- One open request per subject. A change after a decision opens a new one.
create unique index approval_request_open_key
  on approval_request (subject_type, subject_id) where status = 'open';

create index approval_request_scope on approval_request (entity_id, status);

create table approval_step (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references approval_request(id) on delete cascade,
  seq                smallint not null,
  required_role      text not null,
  decision           text check (decision in ('approved','rejected')),
  actor_id           uuid references app_user(id),
  decided_at         timestamptz,
  note               text,
  callback_logged_at timestamptz,
  unique (request_id, seq)
);

-- The maker can never be a checker, resolved by person rather than by role,
-- so granting yourself a second role changes nothing.
create or replace function approval_step_guard() returns trigger
language plpgsql as $$
declare
  v_maker uuid;
  v_dupe  int;
begin
  if new.actor_id is null then
    return new;
  end if;

  select maker_id into v_maker from approval_request where id = new.request_id;
  if v_maker = new.actor_id then
    raise exception 'maker cannot approve their own request (user %)', new.actor_id
      using errcode = 'check_violation';
  end if;

  select count(*) into v_dupe
    from approval_step
   where request_id = new.request_id
     and actor_id = new.actor_id
     and id <> new.id;
  if v_dupe > 0 then
    raise exception 'one person cannot decide two steps of the same request'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger approval_step_guard_trg
  before insert or update on approval_step
  for each row execute function approval_step_guard();

-- A decided request is immutable. Changing the subject opens a new request.
create or replace function approval_request_immutable() returns trigger
language plpgsql as $$
begin
  if old.status <> 'open' and new.status <> old.status then
    raise exception 'approval request % is already %', old.id, old.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger approval_request_immutable_trg
  before update on approval_request
  for each row execute function approval_request_immutable();
