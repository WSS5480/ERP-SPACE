-- 0005_ledger.sql
-- The general ledger. Nothing here is editable: a correction posts a
-- reversal. Every entry names the thing that caused it, so a trial balance
-- line drills to an invoice, its approval and who released the payment.

create table journal_entry (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  entity_id      uuid not null references entity(id),
  period_id      uuid not null references fiscal_period(id),
  posting_date   date not null,
  source_type    text not null check (source_type in
                   ('invoice','payment','payroll','depreciation','accrual',
                    'intercompany','manual','reversal','opening')),
  source_id      uuid,
  description    text not null,
  reversal_of_id uuid references journal_entry(id),
  posted_at      timestamptz not null default now(),
  posted_by      uuid references app_user(id),
  actor_kind     text not null default 'system'
                   check (actor_kind in ('user','agent','system'))
);

create index journal_entry_scope on journal_entry (entity_id, posting_date);
create index journal_entry_source on journal_entry (source_type, source_id);

create table journal_line (
  id               uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references journal_entry(id) on delete cascade,
  seq              smallint not null,
  gl_account_id    uuid not null references gl_account(id),
  profit_object_id uuid references profit_object(id),
  department_id    uuid references department(id),
  debit_minor      bigint not null default 0 check (debit_minor  >= 0),
  credit_minor     bigint not null default 0 check (credit_minor >= 0),
  memo             text,
  unique (journal_entry_id, seq),
  -- a line is one side or the other, never both and never neither
  check ((debit_minor = 0) <> (credit_minor = 0))
);

create index journal_line_account on journal_line (gl_account_id);

-- Debits equal credits. Deferred, so the lines can be inserted one at a time.
create or replace function journal_entry_balances() returns trigger
language plpgsql as $$
declare
  v_entry uuid := coalesce(new.journal_entry_id, old.journal_entry_id);
  v_dr    bigint;
  v_cr    bigint;
begin
  if not exists (select 1 from journal_entry where id = v_entry) then
    return null;
  end if;
  select coalesce(sum(debit_minor),0), coalesce(sum(credit_minor),0)
    into v_dr, v_cr
    from journal_line where journal_entry_id = v_entry;
  if v_dr <> v_cr then
    raise exception 'journal entry % is out of balance: debits % credits %',
      v_entry, v_dr, v_cr using errcode = 'check_violation';
  end if;
  if v_dr = 0 then
    raise exception 'journal entry % has no lines', v_entry
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger journal_entry_balances_trg
  after insert or update or delete on journal_line
  deferrable initially deferred
  for each row execute function journal_entry_balances();

-- Posting into a closed period is refused. A soft-locked period reopens for
-- the day, which is what makes a continuous close possible.
create or replace function journal_period_open() returns trigger
language plpgsql as $$
declare v_status text;
begin
  select status into v_status from fiscal_period where id = new.period_id;
  if v_status = 'closed' then
    raise exception 'period % is closed', new.period_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger journal_period_open_trg
  before insert on journal_entry
  for each row execute function journal_period_open();

-- Ledger entries are immutable. Corrections reverse.
create or replace function journal_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'journal entries are immutable -- post a reversal instead'
    using errcode = 'check_violation';
end $$;

create trigger journal_entry_immutable_trg
  before update or delete on journal_entry
  for each row execute function journal_immutable();

create trigger journal_line_immutable_trg
  before update or delete on journal_line
  for each row execute function journal_immutable();

-- ------------------------------------------------------------- the views --

create view trial_balance as
select je.entity_id,
       fp.starts_on                          as period_start,
       ga.code                               as account_code,
       ga.name                               as account_name,
       ga.account_type,
       sum(jl.debit_minor)                   as debit_minor,
       sum(jl.credit_minor)                  as credit_minor,
       sum(jl.debit_minor - jl.credit_minor) as balance_minor
  from journal_line  jl
  join journal_entry je on je.id = jl.journal_entry_id
  join fiscal_period fp on fp.id = je.period_id
  join gl_account    ga on ga.id = jl.gl_account_id
 group by je.entity_id, fp.starts_on, ga.code, ga.name, ga.account_type;

create view ap_aging as
select i.entity_id,
       i.vendor_id,
       v.legal_name,
       i.id            as invoice_id,
       i.reference,
       i.invoice_date,
       i.due_date,
       i.total_minor,
       i.status,
       greatest(0, current_date - i.due_date) as days_past_due
  from invoice i
  join vendor v on v.id = i.vendor_id
 where i.status in ('approved','scheduled','pending','validated','held','exception');
