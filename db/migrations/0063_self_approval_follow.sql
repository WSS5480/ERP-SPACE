-- Self-approval, followed through (Nov 11 2026).
--
-- 0061 let the owner of a one-person company decide their own approval
-- request. This carries the same rule to the four maker-checker flows that
-- live outside the approval engine and dead-ended the same way:
--
--   stock count approval   inv_count           (0019; approving role store_manager)
--   A/R write-offs         ar_writeoff         (0021; controller)
--   vendor debit memos     vendor_debit_memo   (0039/0041; controller or approver)
--   time off               leave_request       (0039/0041; hr or store_manager)
--
-- Each gets a self_approved column; its maker-checker check now reads
-- "... or self_approved"; and a trigger allows self_approved only when the
-- decider is the maker, holds owner, and no other active person in the company
-- holds owner, controller or the flow's own approving role. The rule is one
-- function, may_self_approve(entity, user, roles), which 0061's approval-step
-- guard now uses too; self_approve_refusal() says why not, in words.
--
-- Support mode: an operator acting as the owner never self-approves. The code
-- refuses it; the transaction also carries erp.support (set by db.tx for a
-- support session), so these functions refuse it as well.
--
-- Also here: role_removal (a role taken away, kept for the owner's daily
-- digest) and owner_notification (the digest itself, shown on Home).
-- Nothing is deleted.

-- ------------------------------------------------------------ the one rule --

/** Why this user may not decide their own request here, or null when they may. */
create or replace function self_approve_refusal(p_entity uuid, p_user uuid, p_roles text[]) returns text
language sql stable as $$
  select case
    when coalesce(current_setting('erp.support', true), '') <> ''
      then 'support mode never self-approves for the owner; the owner decides it signed in as themselves'
    when not exists (
      select 1 from role_grant g join app_user u on u.id = g.app_user_id join entity e on e.id = p_entity
       where g.app_user_id = p_user and g.role = 'owner'
         and (g.entity_id = p_entity or (g.entity_id is null and u.tenant_id = e.tenant_id)))
      then 'only the owner may approve their own request'
    when exists (
      select 1 from role_grant g join app_user u on u.id = g.app_user_id join entity e on e.id = p_entity
       where u.id <> p_user and u.status = 'active'
         and g.role = any (array['owner', 'controller'] || coalesce(p_roles, '{}'::text[]))
         and (g.entity_id = p_entity or (g.entity_id is null and u.tenant_id = e.tenant_id)))
      then 'someone else in this company can approve it, so the maker may not'
    else null
  end
$$;

create or replace function may_self_approve(p_entity uuid, p_user uuid, p_roles text[]) returns boolean
language sql stable as $$ select self_approve_refusal(p_entity, p_user, p_roles) is null $$;

create or replace function may_self_approve(p_entity uuid, p_user uuid, p_role text) returns boolean
language sql stable as $$ select self_approve_refusal(p_entity, p_user, array[p_role]) is null $$;

-- ------------------------------------------- 0061's guard, on the one rule --

create or replace function approval_step_guard() returns trigger
language plpgsql as $$
declare
  v_maker  uuid;
  v_entity uuid;
  v_dupe   int;
  v_why    text;
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
    v_why := self_approve_refusal(v_entity, new.actor_id, array[new.required_role]);
    if v_why is not null then
      raise exception '% (user %)', v_why, new.actor_id using errcode = 'check_violation';
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

-- ------------------------------------------------------- the four flows --

alter table inv_count         add column if not exists self_approved boolean not null default false;
alter table ar_writeoff       add column if not exists self_approved boolean not null default false;
alter table vendor_debit_memo add column if not exists self_approved boolean not null default false;
alter table leave_request     add column if not exists self_approved boolean not null default false;

alter table inv_count drop constraint inv_count_check;
alter table inv_count add constraint inv_count_maker_checker
  check (decided_by is null or self_approved or (decided_by <> created_by and decided_by is distinct from submitted_by));

alter table ar_writeoff drop constraint ar_writeoff_check1;
alter table ar_writeoff add constraint ar_writeoff_maker_checker
  check (decided_by is null or self_approved or decided_by <> requested_by);

alter table vendor_debit_memo drop constraint vendor_debit_memo_maker_checker;
alter table vendor_debit_memo add constraint vendor_debit_memo_maker_checker
  check (decided_by is null or created_by is null or self_approved or decided_by <> created_by);

/**
 * The shared guard for a flow's self_approved row: only on the decision, only
 * by the maker, only when may_self_approve says so. TG_ARGV[0] names the
 * flow's approving roles (comma-separated); the maker columns differ per table.
 */
create or replace function self_approved_guard() returns trigger
language plpgsql as $$
declare
  v_roles  text[] := string_to_array(tg_argv[0], ',');
  v_maker  boolean;
  v_why    text;
begin
  if not new.self_approved then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.self_approved and new.decided_by is not distinct from old.decided_by then
    return new;   -- already decided and checked; a later change (applied, voided, recovered) is not a new decision
  end if;
  if new.decided_by is null then
    raise exception 'only a decision is marked self-approved' using errcode = 'check_violation';
  end if;
  v_maker := case tg_table_name
    when 'inv_count'         then new.decided_by = (to_jsonb(new)->>'created_by')::uuid or new.decided_by = (to_jsonb(new)->>'submitted_by')::uuid
    when 'ar_writeoff'       then new.decided_by = (to_jsonb(new)->>'requested_by')::uuid
    when 'vendor_debit_memo' then new.decided_by = (to_jsonb(new)->>'created_by')::uuid
    when 'leave_request'     then new.decided_by = (to_jsonb(new)->>'requested_by')::uuid
    else false end;
  if not coalesce(v_maker, false) then
    raise exception 'only the maker''s own decision is marked self-approved (user %)', new.decided_by
      using errcode = 'check_violation';
  end if;
  v_why := self_approve_refusal(new.entity_id, new.decided_by, v_roles);
  if v_why is not null then
    raise exception '% (user %)', v_why, new.decided_by using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger inv_count_self_approved before insert or update on inv_count
  for each row execute function self_approved_guard('store_manager');
create trigger ar_writeoff_self_approved before insert or update on ar_writeoff
  for each row execute function self_approved_guard('controller');
create trigger vendor_debit_memo_self_approved before insert or update on vendor_debit_memo
  for each row execute function self_approved_guard('controller,approver');
create trigger leave_request_self_approved before insert or update on leave_request
  for each row execute function self_approved_guard('hr,store_manager');

-- Time off: nobody decides their own, and whoever entered it does not decide
-- it, unless it is the owner's own self-approved decision (checked above).
create or replace function leave_request_rules() returns trigger
language plpgsql as $$
declare who uuid;
begin
  if new.status in ('approved','declined') and new.status is distinct from old.status then
    if new.self_approved then
      return new;   -- leave_request_self_approved has checked the maker and may_self_approve
    end if;
    select app_user_id into who from employee where id = new.employee_id and entity_id = new.entity_id;
    if who is not null and new.decided_by = who then
      raise exception 'nobody approves or declines their own time off; another manager does';
    end if;
    if new.decided_by is not null and new.decided_by = new.requested_by then
      raise exception 'whoever entered a time-off request does not decide it; another manager does';
    end if;
  end if;
  return new;
end $$;

-- ------------------------------------------------------- roles taken away --

-- A role taken away (a grant removed for good, or a person's account no
-- longer active), kept so the owner's digest can show a role removed in the
-- 24 hours before a self-approval: removing the only other approver is how
-- self-approval would be reached on purpose. Written at commit by deferred
-- triggers, so "replace all of someone's roles" logs only what is really gone.
create table role_removal (
  id           bigserial primary key,
  tenant_id    uuid not null references tenant(id),
  entity_id    uuid,                          -- null: a client-wide grant
  app_user_id  uuid not null,
  user_name    text,
  role         text not null,
  kind         text not null check (kind in ('grant_removed','person_inactive')),
  removed_at   timestamptz not null default now(),
  by_label     text
);
create index role_removal_tenant on role_removal (tenant_id, removed_at);

create or replace function role_removal_keep() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger role_removal_keep before update or delete on role_removal
  for each row execute function role_removal_keep();

create or replace function role_grant_removed() returns trigger
language plpgsql as $$
declare u record;
begin
  -- re-granted in the same transaction (a "set roles" that kept it): not a removal
  if exists (select 1 from role_grant g where g.app_user_id = old.app_user_id and g.role = old.role
              and g.entity_id is not distinct from old.entity_id) then
    return null;
  end if;
  select tenant_id, name into u from app_user where id = old.app_user_id;
  if u.tenant_id is null then
    return null;
  end if;
  insert into role_removal (tenant_id, entity_id, app_user_id, user_name, role, kind, by_label)
  values (u.tenant_id, old.entity_id, old.app_user_id, u.name, old.role, 'grant_removed',
          nullif(current_setting('erp.actor_label', true), ''));
  return null;
end $$;
create constraint trigger role_grant_removed after delete on role_grant
  deferrable initially deferred for each row execute function role_grant_removed();

create or replace function app_user_inactive() returns trigger
language plpgsql as $$
begin
  if old.status = 'active' and new.status <> 'active'
     and (select status from app_user where id = new.id) <> 'active' then
    insert into role_removal (tenant_id, entity_id, app_user_id, user_name, role, kind, by_label)
    select new.tenant_id, g.entity_id, new.id, new.name, g.role, 'person_inactive', nullif(current_setting('erp.actor_label', true), '')
      from role_grant g where g.app_user_id = new.id;
  end if;
  return null;
end $$;
create constraint trigger app_user_inactive after update of status on app_user
  deferrable initially deferred for each row execute function app_user_inactive();

-- -------------------------------------------------- the owner's digest --

create table owner_notification (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  entity_id           uuid not null references entity(id),
  kind                text not null check (kind in ('self_approval_digest')),
  for_day             date not null,               -- the company's business day it was made
  window_start        timestamptz not null,
  window_end          timestamptz not null,
  title               text not null,
  body                text not null,               -- the plain text (also the email)
  items               jsonb not null default '[]', -- each self-approval
  removals            jsonb not null default '[]', -- roles removed in the 24 hours before one
  emailed_message_id  uuid references outbound_message(id),
  created_at          timestamptz not null default now(),
  unique (entity_id, kind, for_day)
);
create index owner_notification_recent on owner_notification (entity_id, created_at desc);

create trigger owner_notification_keep before delete on owner_notification
  for each row execute function role_removal_keep();
