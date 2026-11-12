-- Setup mode approvals (Nov 12 2026). "YES. FOR EVERY NEW CUSTOMER BEFORE GO LIVE."
--
-- The ERP team onboards a new customer from the Operator console in support
-- mode. Support mode never self-approves for the owner (0063), so a vendor the
-- operator added for a one-owner store waited until the owner signed in, and
-- nothing behind it (catalog connections) could be set up. Now, until the
-- company goes live, an operator in support mode (or the install-wide API
-- token acting as a person, which counts as support) may approve SETUP records
-- directly:
--
--   vendor          a new vendor (still pending: never approved before)
--   employee        a new hire (still an applicant)
--
-- (Journal entries and periods were dropped in review: no flow opens those
-- requests.) Never money movement or bank details: vendor bank accounts,
-- bills, payment runs, payroll, releases, write-offs, debit memos and stock
-- counts keep 0063's rule (support mode never decides them for the owner).
--
-- Setup mode ends at whichever comes first: the owner pressing Go live, the
-- company beginning to trade, or 60 days after its first setup approval
-- (setup_window_end()). The install-wide token must say why
-- (x-erp-reason, carried as erp.support_reason) to make a setup approval.
--
-- Go-live is now a recorded moment (company_go_live, one row per company,
-- append-only): the owner presses Go live on the checklist once the go-live
-- check passes, after ticking that they reviewed what ERP setup approved. From
-- then on setup approvals end for that company for good; nothing can take
-- the row back. A company that has begun trading is treated as live too, so a
-- customer that trades without pressing the button does not keep the window
-- open.
--
-- The rule is the shared one: self_approve_refusal() gains an overload that
-- also names the request's subject; in support mode it answers with
-- setup_approve_refusal(), otherwise with 0063's rule. The approval-step guard
-- calls it for every step marked as a setup approval.

-- ------------------------------------------------------------- go-live --

create table company_go_live (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  entity_id       uuid not null unique references entity(id),
  went_live_at    timestamptz not null default now(),
  by_label        text not null,
  by_id           uuid references app_user(id),
  kind            text not null default 'owner' check (kind in ('owner', 'migration', 'demo')),
  setup_items     int not null default 0,         -- what ERP setup had approved when it went live
  reviewed_setup  boolean not null default false  -- the owner ticked "I've reviewed what ERP setup approved"
);

-- Go-live is never undone: no update, no delete (role_removal_keep says "<table> is append-only").
create trigger company_go_live_keep before update or delete on company_go_live
  for each row execute function role_removal_keep();

-- nor emptied (row triggers do not see truncate)
create trigger company_go_live_no_truncate before truncate on company_go_live
  for each statement execute function role_removal_keep();

/**
 * Has this company begun trading: money in or out, or a sale, posted in its
 * books (review of 0066: a deposit, a web order paid, a bill, a payroll or an
 * A/R payment counts, not only a handed-over sale). Setup-only entries
 * (opening balances, opening stock, corrections, transfers) do not.
 */
create or replace function company_traded(p_entity uuid) returns boolean
language sql stable as $$
  select exists (select 1 from journal_entry je where je.entity_id = p_entity
                  and je.source_type in ('sale', 'receipt', 'refund', 'deposit', 'ar', 'finance', 'invoice', 'payment', 'payroll', 'service', 'commission', 'fleet'))
$$;

/** Has this company gone live: the owner pressed Go live, or it has begun trading? */
create or replace function company_went_live(p_entity uuid) returns boolean
language sql stable as $$
  select exists (select 1 from company_go_live g where g.entity_id = p_entity) or company_traded(p_entity)
$$;

-- Companies already trading when this runs are live (their onboarding is over): the same test as company_went_live().
insert into company_go_live (tenant_id, entity_id, by_label, kind)
select e.tenant_id, e.id, 'migration 0066 (already trading)', 'migration' from entity e
 where company_traded(e.id);

-- ------------------------------------------------------ the setup rule --

-- the setup marking on an approval step (described with the guard below; needed here by setup_window_end)
alter table approval_step add column if not exists setup_session text;   -- the support session id, or 'install-token'
alter table approval_step add column if not exists setup_by text;        -- the operator, filled by the guard from the session
alter table approval_step add column if not exists setup_reason text;    -- the support session's reason, or the install token's x-erp-reason

/** When this company's setup mode ends by the calendar: 60 days after ERP setup's first setup approval (null: none yet). */
create or replace function setup_window_end(p_entity uuid) returns timestamptz
language sql stable as $$
  select min(s.decided_at) + interval '60 days'
    from approval_step s join approval_request r on r.id = s.request_id
   where r.entity_id = p_entity and s.setup_session is not null and s.decided_at is not null
$$;

/**
 * Why ERP setup (support mode, p_support naming the support session or
 * 'install-token') may not decide this request here, or null when it may.
 * The code asks the same function, so the screen, the server and the
 * database never disagree.
 */
create or replace function setup_approve_refusal(p_entity uuid, p_user uuid, p_roles text[], p_subject_type text, p_subject_id uuid, p_support text)
returns text
language plpgsql stable as $$
declare
  v_tenant uuid;
  v_end    timestamptz;
begin
  if coalesce(p_support, '') = '' then
    return 'setup approvals are made only by ERP setup, in support mode';
  end if;
  if p_subject_type is null or p_subject_type not in ('vendor', 'employee') then
    return 'support mode never self-approves for the owner: ERP setup approves only setup records (a new vendor, a new hire), and this one waits for the owner';
  end if;
  if company_went_live(p_entity) then
    return 'support mode never self-approves for the owner: this company has gone live, so ERP setup no longer approves anything for it; the owner decides it signed in as themselves';
  end if;
  v_end := setup_window_end(p_entity);
  if v_end is not null and erp_now() > v_end then
    return 'support mode never self-approves for the owner: ERP setup''s 60 days for this company ended on ' || to_char(v_end at time zone business_tz(p_entity), 'Mon FMDD, YYYY')
        || ' (they start at its first setup approval); the owner decides it signed in as themselves';
  end if;
  select tenant_id into v_tenant from entity where id = p_entity;
  if p_support <> 'install-token' then
    if p_support !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from platform_support_session s
                       where s.id = p_support::uuid and s.tenant_id = v_tenant and s.ended_at is null
                         and s.started_at > now() - interval '12 hours') then
      return 'the support session making this approval is not open for this customer';
    end if;
  end if;
  if p_user is null or not exists (
      select 1 from role_grant g join app_user u on u.id = g.app_user_id
       where g.app_user_id = p_user and u.status = 'active'
         and g.role = any (array['owner'] || coalesce(p_roles, '{}'::text[]))
         and (g.entity_id = p_entity or (g.entity_id is null and u.tenant_id = v_tenant))) then
    return 'ERP setup approves acting as the owner (or someone holding the step''s role)';
  end if;
  if p_subject_type = 'vendor' and not exists (
      select 1 from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = p_entity
       where v.id = p_subject_id and v.status = 'pending'
         and not exists (select 1 from approval_request r where r.subject_type = 'vendor' and r.subject_id = v.id and r.status = 'approved')) then
    return 'ERP setup approves only a new vendor (one never approved before); changes to a vendor wait for the owner';
  end if;
  if p_subject_type = 'employee' and not exists (
      select 1 from employee e where e.id = p_subject_id and e.entity_id = p_entity and e.status = 'applicant') then
    return 'ERP setup approves only a new hire; changes to someone already hired wait for the owner';
  end if;
  return null;
end $$;

/**
 * 0063's rule, told what the request is about. In support mode the answer is
 * setup_approve_refusal() (null: ERP setup may decide it before go-live);
 * otherwise it is self_approve_refusal(entity, user, roles) unchanged.
 */
create or replace function self_approve_refusal(p_entity uuid, p_user uuid, p_roles text[], p_subject_type text, p_subject_id uuid) returns text
language sql stable as $$
  select case
    when coalesce(current_setting('erp.support', true), '') <> ''
      then setup_approve_refusal(p_entity, p_user, p_roles, p_subject_type, p_subject_id, current_setting('erp.support', true))
    else self_approve_refusal(p_entity, p_user, p_roles)
  end
$$;

create or replace function may_self_approve(p_entity uuid, p_user uuid, p_roles text[], p_subject_type text, p_subject_id uuid) returns boolean
language sql stable as $$ select self_approve_refusal(p_entity, p_user, p_roles, p_subject_type, p_subject_id) is null $$;

-- --------------------------------------------- the step, marked as setup --

alter table approval_step add column if not exists setup_session text;   -- the support session id, or 'install-token'
alter table approval_step add column if not exists setup_by text;        -- the operator, filled by the guard from the session
alter table approval_step add column if not exists setup_reason text;    -- the support session's reason
alter table approval_step add constraint approval_step_setup_not_self check (not (self_approved and setup_session is not null));

create or replace function approval_step_guard() returns trigger
language plpgsql as $$
declare
  v_maker  uuid;
  v_entity uuid;
  v_type   text;
  v_subj   uuid;
  v_dupe   int;
  v_why    text;
  v_sess   record;
begin
  if new.actor_id is null then
    if new.setup_session is not null then
      raise exception 'only a decision is marked as a setup approval' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- a decided step keeps its marking (a later write to it is not a new decision)
  if tg_op = 'UPDATE' and old.actor_id is not null and new.actor_id is not distinct from old.actor_id
     and new.setup_session is not distinct from old.setup_session and new.self_approved is not distinct from old.self_approved then
    return new;
  end if;

  select maker_id, entity_id, subject_type, subject_id into v_maker, v_entity, v_type, v_subj from approval_request where id = new.request_id;

  -- ERP setup, before go-live: the shared rule told the subject, under the session making it
  if new.setup_session is not null then
    -- Go live (onboarding.goLive) locks the company row for update: a setup approval waits for it and then sees
    -- the go-live, or go-live waits for the approval and then lists it (no write skew between the two).
    perform 1 from entity where id = v_entity for share;
    if new.setup_session is distinct from nullif(current_setting('erp.support', true), '') then
      raise exception 'a setup approval is marked with the support session making it' using errcode = 'check_violation';
    end if;
    v_why := self_approve_refusal(v_entity, new.actor_id, array[new.required_role], v_type, v_subj);
    if v_why is not null then
      raise exception '% (user %)', v_why, new.actor_id using errcode = 'check_violation';
    end if;
    if new.setup_session = 'install-token' then
      -- the install-wide token says why, in its x-erp-reason header (carried as erp.support_reason)
      if length(trim(coalesce(current_setting('erp.support_reason', true), ''))) < 3 then
        raise exception 'the install-wide API token must say why (an x-erp-reason header) to approve during setup' using errcode = 'check_violation';
      end if;
      new.setup_by := 'install-wide API token';
      new.setup_reason := left(trim(current_setting('erp.support_reason', true)), 500);
    else
      select operator, reason into v_sess from platform_support_session where id = new.setup_session::uuid;
      new.setup_by := v_sess.operator;
      new.setup_reason := v_sess.reason;
    end if;
    return new;
  end if;

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
     and setup_session is null
     and id <> new.id;
  if v_dupe > 0 then
    raise exception 'one person cannot decide two steps of the same request'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create index if not exists approval_step_setup on approval_step (decided_at) where setup_session is not null;

-- ------------------------------------- API tokens made in support mode --
-- Review of 0066: a tenant API token made (or rotated) by an operator in
-- support mode is not support mode when it is used, so it could act as the
-- owner. Making and rotating tokens is now refused in support mode; any made
-- before are flagged on the customer's platform log for the ERP team to
-- revoke with the owner.
insert into platform_audit (actor, actor_kind, tenant_id, support_id, action, detail)
select 'migration 0066', 'system', a.tenant_id, a.support_id, 'token.made_in_support',
       jsonb_build_object('tokenId', a.detail->>'id', 'name', a.detail->>'name', 'by', a.actor, 'at', a.at,
                          'active', exists (select 1 from platform_api_token k where k.id::text = a.detail->>'id' and k.status = 'active'),
                          'note', 'made in support mode; revoke it with the owner unless they asked for it')
  from platform_audit a
 where a.action in ('token.create') and a.support_id is not null;
