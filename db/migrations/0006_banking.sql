-- 0006_banking.sql
-- Many banks inside one company, and many companies each with their own.
--
-- A bank account belongs to exactly one entity and maps to exactly one cash
-- account in the ledger, so a payment credits the right cash -- which is the
-- whole point of separating operating from payroll from tax.

create table bank_account (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenant(id),
  entity_id               uuid not null references entity(id),
  name                    text not null,
  purpose                 text not null
                            check (purpose in ('operating','payroll','tax','sweep','escrow','merchant')),
  bank_name               text not null,
  routing_last4           text not null check (routing_last4 ~ '^[0-9]{4}$'),
  account_last4           text not null check (account_last4 ~ '^[0-9]{4}$'),
  account_ref             text not null,        -- secrets store key, never the number
  gl_account_id           uuid not null references gl_account(id),
  ach_origination_enabled boolean not null default false,
  ach_company_id_ref      text,
  ach_exposure_limit_minor bigint check (ach_exposure_limit_minor is null or ach_exposure_limit_minor > 0),
  positive_pay            boolean not null default false,
  debit_block             boolean not null default false,
  status                  text not null default 'active'
                            check (status in ('active','closed')),
  opened_on               date,
  unique (entity_id, name)
);

create index bank_account_entity on bank_account (entity_id, purpose);

comment on column bank_account.ach_exposure_limit_minor is
  'the bank''s cap on one origination file; a run over it is split or refused';

-- A payment run draws on exactly one account, and that account is the
-- entity's own. Before this, a run only knew its method.
alter table payment_run add column bank_account_id uuid references bank_account(id);

create or replace function payment_run_bank_matches() returns trigger
language plpgsql as $$
declare
  v_entity uuid;
  v_ach    boolean;
  v_limit  bigint;
  v_total  bigint;
begin
  if new.bank_account_id is null then
    raise exception 'a payment run must name the bank account it draws on'
      using errcode = 'check_violation';
  end if;

  select entity_id, ach_origination_enabled, ach_exposure_limit_minor
    into v_entity, v_ach, v_limit
    from bank_account where id = new.bank_account_id;

  if v_entity is distinct from new.entity_id then
    raise exception 'bank account belongs to a different company'
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

create trigger payment_run_bank_matches_trg
  before insert or update on payment_run
  for each row execute function payment_run_bank_matches();

-- ------------------------------------------------------- reconciliation --

create table bank_statement (
  id                    uuid primary key default gen_random_uuid(),
  bank_account_id       uuid not null references bank_account(id),
  statement_date        date not null,
  opening_balance_minor bigint not null,
  closing_balance_minor bigint not null,
  source                text not null default 'bai2' check (source in ('bai2','ofx','csv','manual')),
  imported_at           timestamptz not null default now(),
  unique (bank_account_id, statement_date)
);

create table bank_statement_line (
  id                 uuid primary key default gen_random_uuid(),
  bank_statement_id  uuid not null references bank_statement(id) on delete cascade,
  posted_on          date not null,
  description        text not null,
  amount_minor       bigint not null,          -- signed: negative is money out
  external_ref       text,
  match_status       text not null default 'unmatched'
                       check (match_status in ('unmatched','auto','manual','ignored')),
  matched_journal_line_id uuid references journal_line(id),
  matched_payment_id      uuid references payment(id),
  matched_at         timestamptz
);

create index bank_statement_line_open on bank_statement_line (bank_statement_id, match_status);

comment on column bank_statement_line.match_status is
  'auto = cleared inside tolerance by the nightly run; manual = a person decided';

-- Cash by account, which a single cash line in the trial balance cannot show.
create view bank_position as
select ba.entity_id,
       ba.id   as bank_account_id,
       ba.name,
       ba.purpose,
       ba.bank_name,
       ba.account_last4,
       coalesce(sum(jl.debit_minor - jl.credit_minor), 0) as ledger_balance_minor,
       (select bs.closing_balance_minor
          from bank_statement bs
         where bs.bank_account_id = ba.id
         order by bs.statement_date desc limit 1)         as last_statement_minor
  from bank_account ba
  left join journal_line  jl on jl.gl_account_id = ba.gl_account_id
  left join journal_entry je on je.id = jl.journal_entry_id and je.entity_id = ba.entity_id
 where ba.status = 'active'
 group by ba.id, ba.entity_id, ba.name, ba.purpose, ba.bank_name, ba.account_last4;
