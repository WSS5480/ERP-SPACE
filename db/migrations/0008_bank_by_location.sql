-- 0008_bank_by_location.sql
-- A company can have many locations, each with its own account, often at a
-- different bank. Local deposits are a store-level fact; payroll and tax
-- reserves stay at company level.
--
-- This migration also fixes something 0006 got wrong. Bank balances were
-- derived from the cash GL account, which works only while one account maps
-- to one cash code. The moment three stores deposit into three banks that
-- all roll up to 1010, that view stops being able to tell them apart. So a
-- journal line now names the bank account it moved, and reconciliation reads
-- that instead.

-- --------------------------------------------------- accounts by location --

alter table bank_account add column location_id uuid references location(id);
alter table bank_account add column is_default boolean not null default false;

comment on column bank_account.location_id is
  'null means company-level: payroll, tax reserve, sweep';

-- The location has to belong to the same company as the account.
create or replace function bank_account_location_matches() returns trigger
language plpgsql as $$
declare v_entity uuid;
begin
  if new.location_id is null then return new; end if;
  select entity_id into v_entity from location where id = new.location_id;
  if v_entity is distinct from new.entity_id then
    raise exception 'that location belongs to a different company'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger bank_account_location_matches_trg
  before insert or update on bank_account
  for each row execute function bank_account_location_matches();

-- One default account per purpose, per location. Company-level defaults use
-- the all-zero uuid so the same index covers both cases.
create unique index bank_account_default_key on bank_account
  (entity_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), purpose)
  where is_default;

-- ------------------------------------------------- cash moves by account --

alter table journal_line add column bank_account_id uuid references bank_account(id);

create index journal_line_bank on journal_line (bank_account_id)
  where bank_account_id is not null;

-- If a line names a bank account, it must be posting to that account's own
-- cash code. Otherwise the reconciliation and the ledger disagree, quietly.
create or replace function journal_line_bank_matches() returns trigger
language plpgsql as $$
declare v_gl uuid;
begin
  if new.bank_account_id is null then return new; end if;
  select gl_account_id into v_gl from bank_account where id = new.bank_account_id;
  if v_gl is distinct from new.gl_account_id then
    raise exception 'line posts to a different account than the bank account''s cash code'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger journal_line_bank_matches_trg
  before insert on journal_line
  for each row execute function journal_line_bank_matches();

-- ------------------------------------------------------------- the views --

drop view bank_position;

create view bank_position as
select ba.entity_id,
       ba.id           as bank_account_id,
       ba.location_id,
       l.name          as location_name,
       ba.name,
       ba.purpose,
       ba.bank_name,
       ba.routing_last4,
       ba.account_last4,
       ba.ach_origination_enabled,
       coalesce(sum(jl.debit_minor - jl.credit_minor), 0) as ledger_balance_minor,
       (select bs.closing_balance_minor
          from bank_statement bs
         where bs.bank_account_id = ba.id
         order by bs.statement_date desc limit 1)         as last_statement_minor
  from bank_account ba
  left join location    l  on l.id = ba.location_id
  left join journal_line jl on jl.bank_account_id = ba.id
 where ba.status = 'active'
 group by ba.id, ba.entity_id, ba.location_id, l.name, ba.name, ba.purpose,
          ba.bank_name, ba.routing_last4, ba.account_last4, ba.ach_origination_enabled;

-- How many banks, and where. The question an owner asks before a treasury
-- conversation and nobody can usually answer quickly.
create view banking_footprint as
select ba.entity_id,
       ba.bank_name,
       count(*)                                          as accounts,
       count(distinct ba.location_id)                    as locations,
       count(*) filter (where ba.ach_origination_enabled) as ach_enabled,
       count(*) filter (where ba.positive_pay)            as positive_pay
  from bank_account ba
 where ba.status = 'active'
 group by ba.entity_id, ba.bank_name;
