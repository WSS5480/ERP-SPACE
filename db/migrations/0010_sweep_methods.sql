-- 0010_sweep_methods.sql
-- Automate the concentration where the bank allows it, and make the rest a
-- tracked obligation rather than a habit.
--
-- Three ways money gets from a branch account to the operating account:
--
--   bank_zba  the bank does it overnight, same institution. We initiate
--             nothing; we learn it happened from the statement.
--   ach_pull  we originate a debit from the operating account against the
--             branch account. Automated by us, needs the branch bank to
--             allow debits and an authorisation on file.
--   manual    somebody signs in and moves it. Not automatable, so it gets a
--             due date, an owner and an overdue list.
--
-- The rule that matters: nothing posts to the ledger until the money has
-- actually moved. A sweep we assumed happened is a reconciliation break
-- three weeks later.

-- ------------------------------------------------- what each bank can do --

alter table bank_account
  add column supports_zba         boolean not null default false,
  add column allows_ach_debit     boolean not null default false,
  add column online_transfer_only boolean not null default false;

comment on column bank_account.supports_zba is
  'the bank concentrates automatically, normally only within one institution';
comment on column bank_account.allows_ach_debit is
  'we may originate a debit against this account, with authorisation on file';

-- --------------------------------------------------------------- the rule --

alter table sweep_rule
  add column method      text not null default 'manual'
                           check (method in ('bank_zba','ach_pull','manual')),
  add column due_days    smallint not null default 1 check (due_days >= 0),
  add column assigned_to uuid references app_user(id);

-- A rule cannot claim a method the accounts cannot perform.
create or replace function sweep_rule_method_supported() returns trigger
language plpgsql as $$
declare
  f record;
  t record;
begin
  select bank_name, supports_zba, allows_ach_debit into f
    from bank_account where id = new.from_bank_account_id;
  select bank_name, ach_origination_enabled into t
    from bank_account where id = new.to_bank_account_id;

  if new.method = 'bank_zba' then
    if not f.supports_zba then
      raise exception 'that branch account does not support a bank sweep'
        using errcode = 'check_violation';
    end if;
    if f.bank_name is distinct from t.bank_name then
      raise exception 'a bank sweep needs both accounts at the same institution (% and %)',
        f.bank_name, t.bank_name using errcode = 'check_violation';
    end if;
  elsif new.method = 'ach_pull' then
    if not f.allows_ach_debit then
      raise exception 'that branch account does not allow us to debit it'
        using errcode = 'check_violation';
    end if;
    if not t.ach_origination_enabled then
      raise exception 'the operating account cannot originate the debit'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.method = 'manual' and new.assigned_to is null then
    raise exception 'a manual sweep needs an owner, or nobody does it'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger sweep_rule_method_supported_trg
  before insert or update on sweep_rule
  for each row execute function sweep_rule_method_supported();

-- ----------------------------------------------------------- the movement --

alter table bank_transfer
  add column method            text not null default 'manual'
                                 check (method in ('bank_zba','ach_pull','manual')),
  add column due_on            date,
  add column assigned_to       uuid references app_user(id),
  add column confirmed_by      uuid references app_user(id),
  add column confirmed_at      timestamptz,
  add column statement_line_id uuid references bank_statement_line(id);

alter table bank_transfer drop constraint bank_transfer_status_check;
alter table bank_transfer add constraint bank_transfer_status_check
  check (status in ('expected','planned','sent','settled','failed','cancelled'));

comment on column bank_transfer.status is
  'expected = the bank will do it; planned = we or a person must; sent/settled = it moved';

-- Nothing carries a ledger entry until the money moved.
create or replace function bank_transfer_posting_rule() returns trigger
language plpgsql as $$
begin
  if new.journal_entry_id is not null and new.status not in ('sent','settled') then
    raise exception 'a transfer cannot post before it has moved (status %)', new.status
      using errcode = 'check_violation';
  end if;
  if new.status in ('sent','settled') and new.journal_entry_id is null then
    raise exception 'a transfer that moved must carry its ledger entry'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger bank_transfer_posting_rule_trg
  before insert or update on bank_transfer
  for each row execute function bank_transfer_posting_rule();

create index bank_transfer_open on bank_transfer (entity_id, status, due_on)
  where status in ('expected','planned');

-- ------------------------------------------------------------- the views --

-- What is automated, what is not, and what somebody has forgotten.
create view sweep_status as
select sr.entity_id,
       f.name                       as from_account,
       f.bank_name,
       l.name                       as location_name,
       sr.method,
       sr.method <> 'manual'        as automated,
       sr.assigned_to,
       coalesce(sum(bt.amount_minor) filter (where bt.status in ('expected','planned')), 0)
                                    as awaiting_minor,
       count(*) filter (where bt.status in ('expected','planned')
                          and bt.due_on < current_date) as overdue,
       max(bt.transfer_date) filter (where bt.status in ('sent','settled')) as last_swept_on
  from sweep_rule   sr
  join bank_account f on f.id = sr.from_bank_account_id
  left join location l on l.id = f.location_id
  left join bank_transfer bt on bt.sweep_rule_id = sr.id
 where sr.active
 group by sr.entity_id, f.name, f.bank_name, l.name, sr.method, sr.assigned_to;

-- How much of the concentration actually runs without a person.
create view sweep_automation as
select entity_id,
       count(*)                                    as branches,
       count(*) filter (where method = 'bank_zba') as by_the_bank,
       count(*) filter (where method = 'ach_pull') as by_us,
       count(*) filter (where method = 'manual')   as by_hand
  from sweep_rule
 where active
 group by entity_id;
