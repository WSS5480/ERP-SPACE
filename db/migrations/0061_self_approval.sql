-- A one-person company can finish its approvals.
--
-- The maker is never the checker (0002). But in a company where the owner is
-- the only person who could decide a step, every request the owner makes
-- (a vendor, a bill over the limit, a payment run, payroll, a hire, a bank
-- change, a journal, a period) waited forever. Now the owner may decide their
-- own request's step when no one else in the company holds that step's role,
-- the owner role or the controller role. The step is marked self_approved, and the code writes an
-- audit row "self-approved: no other approver". The moment a second person
-- who could decide it exists, the old rule is back.

alter table approval_step add column if not exists self_approved boolean not null default false;

create or replace function approval_step_guard() returns trigger
language plpgsql as $$
declare
  v_maker  uuid;
  v_entity uuid;
  v_dupe   int;
begin
  if new.actor_id is null then
    return new;
  end if;

  select maker_id, entity_id into v_maker, v_entity from approval_request where id = new.request_id;
  -- self_approved marks the maker's own decision and nothing else (it also lifts the two-steps rule below)
  if new.self_approved and v_maker is distinct from new.actor_id then
    raise exception 'only the maker''s own decision is marked self-approved (user %)', new.actor_id
      using errcode = 'check_violation';
  end if;
  if v_maker = new.actor_id then
    if not new.self_approved then
      raise exception 'maker cannot approve their own request (user %)', new.actor_id
        using errcode = 'check_violation';
    end if;
    -- only the owner, and only when nobody else could decide this step
    if not exists (
      select 1 from role_grant g join app_user u on u.id = g.app_user_id join entity e on e.id = v_entity
       where g.app_user_id = new.actor_id and g.role = 'owner'
         and (g.entity_id = v_entity or (g.entity_id is null and u.tenant_id = e.tenant_id))) then
      raise exception 'only the owner may approve their own request (user %)', new.actor_id
        using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from role_grant g join app_user u on u.id = g.app_user_id join entity e on e.id = v_entity
       where u.id <> new.actor_id and u.status = 'active' and g.role in (new.required_role, 'owner', 'controller')
         and (g.entity_id = v_entity or (g.entity_id is null and u.tenant_id = e.tenant_id))) then
      raise exception 'someone else in this company can approve it, so the maker may not (user %)', new.actor_id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  select count(*) into v_dupe
    from approval_step
   where request_id = new.request_id
     and actor_id = new.actor_id
     and not self_approved
     and id <> new.id;
  if v_dupe > 0 then
    raise exception 'one person cannot decide two steps of the same request'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;
