-- 0009_one_operating_account.sql
-- One operating account per company. Stores keep local accounts, but those
-- are deposit-only and sweep into the operating account; everything is paid
-- from the one place.
--
-- This is the concentration model, and the reason for it is control rather
-- than tidiness: one account to reconcile daily, one ACH origination
-- relationship, one exposure limit, one positive-pay file. Money comes in
-- wherever it is convenient and leaves from exactly one place.

-- 'deposit' is now its own purpose, distinct from 'operating'.
alter table bank_account drop constraint bank_account_purpose_check;
alter table bank_account add constraint bank_account_purpose_check
  check (purpose in ('operating','deposit','payroll','tax','sweep','escrow','merchant'));

-- Anything that sat at a location was a local depository all along.
update bank_account set purpose = 'deposit'
 where location_id is not null and purpose = 'operating';

-- At most one operating account per company. Not a convention.
create unique index bank_account_one_operating on bank_account (entity_id)
  where purpose = 'operating' and status = 'active';

comment on index bank_account_one_operating is
  'the concentration account: money leaves from here and nowhere else';

-- A deposit account never disburses. Replaces the 0006 version.
create or replace function payment_run_bank_matches() returns trigger
language plpgsql as $$
declare
  v_entity  uuid;
  v_purpose text;
  v_ach     boolean;
  v_limit   bigint;
  v_total   bigint;
begin
  if new.bank_account_id is null then
    raise exception 'a payment run must name the bank account it draws on'
      using errcode = 'check_violation';
  end if;

  select entity_id, purpose, ach_origination_enabled, ach_exposure_limit_minor
    into v_entity, v_purpose, v_ach, v_limit
    from bank_account where id = new.bank_account_id;

  if v_entity is distinct from new.entity_id then
    raise exception 'bank account belongs to a different company'
      using errcode = 'check_violation';
  end if;

  if v_purpose = 'deposit' then
    raise exception 'a deposit account cannot disburse; it sweeps to the operating account'
      using errcode = 'check_violation';
  end if;

  if new.method = 'ach' and not v_ach then
    raise exception 'this account is not enabled for ACH origination'
      using errcode = 'check_violation';
  end if;

  if new.status in ('pending_release','released') and v_limit is not null then
    select coalesce(sum(amount_minor),0) into v_total
      from payment where payment_run_id = new.id;
    if v_total > v_limit then
      raise exception 'run of % exceeds the bank exposure limit of %', v_total, v_limit
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

-- ----------------------------------------------------------------- sweeps --

create table sweep_rule (
  id                   uuid primary key default gen_random_uuid(),
  entity_id            uuid not null references entity(id),
  from_bank_account_id uuid not null references bank_account(id),
  to_bank_account_id   uuid not null references bank_account(id),
  mode                 text not null default 'zero_balance'
                         check (mode in ('zero_balance','target_balance','manual')),
  target_balance_minor bigint not null default 0 check (target_balance_minor >= 0),
  frequency            text not null default 'daily'
                         check (frequency in ('daily','weekly','monthly','manual')),
  active               boolean not null default true,
  unique (from_bank_account_id)
);

-- A sweep goes to the one operating account, and never to itself.
create or replace function sweep_rule_target() returns trigger
language plpgsql as $$
declare v_purpose text; v_entity uuid;
begin
  if new.from_bank_account_id = new.to_bank_account_id then
    raise exception 'a sweep cannot target its own account' using errcode = 'check_violation';
  end if;
  select purpose, entity_id into v_purpose, v_entity
    from bank_account where id = new.to_bank_account_id;
  if v_purpose <> 'operating' then
    raise exception 'sweeps concentrate into the operating account, not a % account', v_purpose
      using errcode = 'check_violation';
  end if;
  if v_entity is distinct from new.entity_id then
    raise exception 'sweep crosses companies' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger sweep_rule_target_trg
  before insert or update on sweep_rule
  for each row execute function sweep_rule_target();

create table bank_transfer (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenant(id),
  entity_id            uuid not null references entity(id),
  from_bank_account_id uuid not null references bank_account(id),
  to_bank_account_id   uuid not null references bank_account(id),
  amount_minor         bigint not null check (amount_minor > 0),
  transfer_date        date not null,
  sweep_rule_id        uuid references sweep_rule(id),
  journal_entry_id     uuid references journal_entry(id),
  status               text not null default 'planned'
                         check (status in ('planned','sent','settled','failed')),
  created_by           uuid references app_user(id),
  created_at           timestamptz not null default now(),
  check (from_bank_account_id <> to_bank_account_id)
);

create index bank_transfer_scope on bank_transfer (entity_id, transfer_date);

-- Transfers are their own kind of ledger source.
alter table journal_entry drop constraint journal_entry_source_type_check;
alter table journal_entry add constraint journal_entry_source_type_check
  check (source_type in ('invoice','payment','payroll','depreciation','accrual',
                         'intercompany','manual','reversal','opening','transfer','deposit'));

-- What is sitting out at the branches, waiting to come in.
create view uncollected_deposits as
select ba.entity_id,
       ba.id            as bank_account_id,
       ba.name,
       ba.bank_name,
       l.name           as location_name,
       coalesce(sum(jl.debit_minor - jl.credit_minor), 0) as balance_minor,
       sr.id            as sweep_rule_id,
       sr.frequency
  from bank_account ba
  left join location    l  on l.id = ba.location_id
  left join journal_line jl on jl.bank_account_id = ba.id
  left join sweep_rule  sr on sr.from_bank_account_id = ba.id and sr.active
 where ba.purpose = 'deposit' and ba.status = 'active'
 group by ba.id, ba.entity_id, ba.name, ba.bank_name, l.name, sr.id, sr.frequency;
