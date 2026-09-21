-- 0011_reconciliation.sql
-- Automatic bank reconciliation, matched against the POS feed.
--
-- The POS knows what was taken at each store each day and roughly when it
-- should land. The bank says what actually arrived. Matching those two is
-- most of a daily close, and almost all of it can be done without a person.
--
-- Four matchers, run in order of how certain they are:
--   exact      one statement line, one expectation, same amount
--   tolerance  same within a band -- a card settlement arriving net of fees
--   batch      several days' takings settled in one credit
--   manual     a person decided, and the system records who
--
-- What does not match is the output. An unmatched line is a question, and
-- the point of the run is to end the day with a short list of them.

alter table bank_account
  add column fee_gl_account_id uuid references gl_account(id),
  add column settlement_days   smallint not null default 1
    check (settlement_days between 0 and 10);

comment on column bank_account.settlement_days is
  'how long after the business date money normally lands; cash next day, cards later';

-- ------------------------------------------------------------- the feed --

create table pos_deposit (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  entity_id       uuid not null references entity(id),
  location_id     uuid not null references location(id),
  bank_account_id uuid not null references bank_account(id),
  business_date   date not null,
  method          text not null check (method in ('cash','card','ach','check')),
  amount_minor    bigint not null check (amount_minor > 0),
  expected_on     date not null,
  source_ref      text not null,
  status          text not null default 'open'
                    check (status in ('open','matched','short','over','written_off')),
  imported_at     timestamptz not null default now(),
  unique (entity_id, source_ref)
);

create index pos_deposit_open on pos_deposit (bank_account_id, expected_on)
  where status = 'open';

comment on table pos_deposit is
  'what the POS says should reach the bank; the bank says what did';

-- --------------------------------------------------------------- the run --

create table reconciliation_run (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  entity_id         uuid not null references entity(id),
  bank_account_id   uuid not null references bank_account(id),
  bank_statement_id uuid references bank_statement(id),
  ran_at            timestamptz not null default now(),
  ran_by            uuid references app_user(id),
  actor_kind        text not null default 'system'
                      check (actor_kind in ('user','agent','system')),
  lines_total       integer not null default 0,
  lines_matched     integer not null default 0,
  variance_minor    bigint  not null default 0
);

create table reconciliation_match (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid references reconciliation_run(id) on delete set null,
  bank_statement_line_id uuid not null references bank_statement_line(id),
  matched_kind           text not null
                           check (matched_kind in ('pos_deposit','payment','bank_transfer','journal_line')),
  matched_id             uuid not null,
  amount_minor           bigint not null,
  variance_minor         bigint not null default 0,
  method                 text not null
                           check (method in ('exact','tolerance','batch','manual')),
  confidence_bps         integer not null default 10000
                           check (confidence_bps between 0 and 10000),
  variance_journal_entry_id uuid references journal_entry(id),
  matched_by             uuid references app_user(id),
  created_at             timestamptz not null default now()
);

-- One statement line may take several expectations (a batched settlement),
-- but an expectation is only ever matched once.
create unique index reconciliation_match_once
  on reconciliation_match (matched_kind, matched_id);

create index reconciliation_match_line on reconciliation_match (bank_statement_line_id);

-- Keep the statement line's own status in step with its matches.
create or replace function reconciliation_match_sync() returns trigger
language plpgsql as $$
begin
  update bank_statement_line
     set match_status = case when new.method = 'manual' then 'manual' else 'auto' end,
         matched_at = now()
   where id = new.bank_statement_line_id;

  if new.matched_kind = 'pos_deposit' then
    update pos_deposit
       set status = case when new.variance_minor = 0 then 'matched'
                         when new.variance_minor < 0 then 'short'
                         else 'over' end
     where id = new.matched_id;
  end if;

  return new;
end $$;

create trigger reconciliation_match_sync_trg
  after insert on reconciliation_match
  for each row execute function reconciliation_match_sync();

-- ------------------------------------------------------------- the views --

-- The output of a run: the questions, not the answers.
create view unmatched_bank_lines as
select bs.bank_account_id,
       ba.entity_id,
       ba.name        as account_name,
       bsl.id         as statement_line_id,
       bsl.posted_on,
       bsl.description,
       bsl.amount_minor,
       current_date - bsl.posted_on as days_open
  from bank_statement_line bsl
  join bank_statement bs on bs.id = bsl.bank_statement_id
  join bank_account   ba on ba.id = bs.bank_account_id
 where bsl.match_status = 'unmatched';

create view unmatched_pos_deposits as
select pd.entity_id,
       pd.bank_account_id,
       l.name         as location_name,
       pd.business_date,
       pd.method,
       pd.amount_minor,
       pd.expected_on,
       current_date - pd.expected_on as days_late
  from pos_deposit pd
  join location l on l.id = pd.location_id
 where pd.status = 'open';

create view reconciliation_summary as
select rr.entity_id,
       ba.name            as account_name,
       ba.bank_name,
       rr.ran_at::date    as ran_on,
       rr.lines_total,
       rr.lines_matched,
       rr.lines_total - rr.lines_matched as lines_open,
       case when rr.lines_total = 0 then 0
            else round(100.0 * rr.lines_matched / rr.lines_total, 1) end as matched_pct,
       rr.variance_minor
  from reconciliation_run rr
  join bank_account ba on ba.id = rr.bank_account_id;
