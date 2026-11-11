-- The last two one-person dead ends (Nov 11 2026), on 0063's rule.
--
-- 1. Releasing a payment or payroll run: whoever built it never released it
--    (payment_run_two_people, payroll_run_two_people). Now the owner may
--    release their own run when nobody else in the company could release it:
--    no other active owner or controller, nor anyone holding a releasing role
--    (payment runs: approver or A/P clerk; payroll: HR). The run is marked
--    self_released; the code asks for the run's total typed and writes the
--    audit row; the owner's digest lists it.
-- 2. Letting a bill through the gates: whoever entered a bill never let it
--    through (that was the code's rule only). The bill now records who
--    accepted it (accepted_by), and the database holds both rules: not the
--    person who entered it, unless it is the owner's self_accepted decision
--    when no other owner or controller is active here.
-- Support mode never does either (self_approve_refusal sees erp.support).

alter table payment_run add column if not exists self_released boolean not null default false;
alter table payroll_run add column if not exists self_released boolean not null default false;

alter table payment_run drop constraint payment_run_two_people;
alter table payment_run add constraint payment_run_two_people
  check (released_by is null or self_released or released_by <> built_by);
alter table payroll_run drop constraint payroll_run_two_people;
alter table payroll_run add constraint payroll_run_two_people
  check (released_by is null or self_released or released_by <> built_by);

/** A run released by its own builder: only marked so, and only when may_self_approve says so. TG_ARGV[0]: the releasing roles. */
create or replace function self_released_guard() returns trigger
language plpgsql as $$
declare
  v_why text;
begin
  if not new.self_released then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.self_released and new.released_by is not distinct from old.released_by then
    return new;   -- released and checked already; posting it later is not a new release
  end if;
  if new.released_by is null or new.released_by is distinct from new.built_by then
    raise exception 'only the builder''s own release is marked self-released (user %)', new.released_by
      using errcode = 'check_violation';
  end if;
  v_why := self_approve_refusal(new.entity_id, new.released_by, string_to_array(tg_argv[0], ','));
  if v_why is not null then
    raise exception '% (user %)', v_why, new.released_by using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger payment_run_self_released before insert or update on payment_run
  for each row execute function self_released_guard('approver,ap_clerk');
create trigger payroll_run_self_released before insert or update on payroll_run
  for each row execute function self_released_guard('hr');

-- --------------------------------------------------------- bills at the gates --

alter table invoice add column if not exists accepted_by uuid references app_user(id);
alter table invoice add column if not exists accepted_at timestamptz;
alter table invoice add column if not exists self_accepted boolean not null default false;

create or replace function invoice_accept_guard() returns trigger
language plpgsql as $$
declare
  v_why text;
begin
  if new.accepted_by is null or (tg_op = 'UPDATE' and new.accepted_by is not distinct from old.accepted_by
                                  and new.self_accepted is not distinct from old.self_accepted) then
    return new;
  end if;
  if new.self_accepted then
    if new.accepted_by is distinct from new.created_by then
      raise exception 'only the maker''s own decision is marked self-approved (user %)', new.accepted_by
        using errcode = 'check_violation';
    end if;
    v_why := self_approve_refusal(new.entity_id, new.accepted_by, array['controller']);
    if v_why is not null then
      raise exception '% (user %)', v_why, new.accepted_by using errcode = 'check_violation';
    end if;
  elsif new.accepted_by = new.created_by then
    raise exception 'whoever entered a bill cannot also let it through the gates (user %)', new.accepted_by
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger invoice_accept_guard before insert or update on invoice
  for each row execute function invoice_accept_guard();
