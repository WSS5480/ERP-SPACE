-- 0013_statement_intake.sql
-- Bank statements, arriving by any of the four channels, landing as one shape.
--
-- A statement is the same fact however it reaches us: a file a manager
-- exported at the branch, a file the bank drops on SFTP at 6am, an email from
-- a small bank that offers nothing else, or an API call. The dialect differs.
-- What we store does not.
--
-- Two problems this migration exists to solve, both of which are the kind that
-- balance perfectly while being wrong:
--
--   Overlapping windows. Almost every bank's daily file repeats the last two
--   or three days. Ingest it naively and every transaction posts twice. A line
--   is therefore fingerprinted by account, date, amount and reference, and the
--   database refuses the second copy. The ingest reports what it saw and what
--   was actually new.
--
--   Missing days. A feed that stops is invisible if you only ever look at what
--   arrived. statement_gaps lists the days an active account has no statement
--   for, so a silence shows up as a row.

-- Where a statement came from, so any line can be traced to the bytes.
alter table bank_statement
  add column inbound_file_id uuid references inbound_file(id),
  add column sequence_no     integer,
  add column channel         text
    check (channel in ('manual_upload','sftp','email','api','webhook'));

comment on column bank_statement.sequence_no is
  'intraday files for the same date, in the order the bank numbered them';

create unique index bank_statement_once
  on bank_statement (bank_account_id, statement_date, coalesce(sequence_no, 0));

-- Lines carry the account directly, and what the bank actually said.
alter table bank_statement_line
  add column bank_account_id uuid references bank_account(id),
  add column raw             jsonb,
  add column fingerprint     text;

comment on column bank_statement_line.raw is
  'the record as the bank sent it; the parser is a reading, this is the source';

-- The same transaction cannot enter twice, whatever file carried it.
create unique index bank_statement_line_once
  on bank_statement_line (bank_account_id, fingerprint)
  where fingerprint is not null;

create or replace function bank_statement_line_stamp() returns trigger
language plpgsql as $$
declare
  acct uuid;
begin
  select bs.bank_account_id into acct
    from bank_statement bs where bs.id = new.bank_statement_id;

  if new.bank_account_id is null then
    new.bank_account_id := acct;
  elsif new.bank_account_id <> acct then
    raise exception 'this line names an account its statement does not belong to';
  end if;

  if new.fingerprint is null then
    new.fingerprint := encode(sha256(convert_to(
      coalesce(acct::text,'') || '|' ||
      coalesce(new.posted_on::text,'') || '|' ||
      coalesce(new.amount_minor::text,'') || '|' ||
      coalesce(nullif(btrim(new.external_ref), ''), btrim(coalesce(new.description,''))),
      'UTF8')), 'hex');
  end if;

  return new;
end $$;

create trigger bank_statement_line_stamp_trg
  before insert on bank_statement_line
  for each row execute function bank_statement_line_stamp();

-- A statement delivered over a connection must be for that connection's account.
create or replace function bank_statement_provenance() returns trigger
language plpgsql as $$
declare
  conn_account uuid;
  conn_source  text;
begin
  if new.inbound_file_id is null then
    return new;
  end if;

  select c.bank_account_id, c.source_code
    into conn_account, conn_source
    from inbound_file f
    join connection c on c.id = f.connection_id
   where f.id = new.inbound_file_id;

  if conn_source is distinct from 'bank_statement' then
    raise exception 'that file did not arrive as a bank statement';
  end if;

  if conn_account is not null and conn_account <> new.bank_account_id then
    raise exception 'that connection delivers statements for a different account';
  end if;

  return new;
end $$;

create trigger bank_statement_provenance_trg
  before insert or update on bank_statement
  for each row execute function bank_statement_provenance();

-- --------------------------------------------------------------- the views --

-- Days an active account has no statement for. A feed that quietly stopped
-- shows up here as a run of rows rather than as nothing at all.
create view statement_gaps as
with active as (
  select ba.id, ba.entity_id, ba.name, ba.bank_name,
         greatest(
           coalesce((select max(statement_date) from bank_statement s where s.bank_account_id = ba.id),
                    current_date - 30),
           current_date - 30) as since
    from bank_account ba
   where ba.status = 'active'
),
days as (
  select a.id, a.entity_id, a.name, a.bank_name,
         generate_series(a.since, current_date - 1, interval '1 day')::date as d
    from active a
)
select days.entity_id,
       days.id   as bank_account_id,
       days.name as account_name,
       days.bank_name,
       days.d    as missing_on,
       current_date - days.d as days_ago
  from days
 where extract(isodow from days.d) between 1 and 5
   and not exists (select 1 from bank_statement s
                    where s.bank_account_id = days.id and s.statement_date = days.d);

-- What each account's intake looks like: how it arrives, when it last did,
-- and whether anything is stuck.
create view statement_intake as
select ba.entity_id,
       ba.id            as bank_account_id,
       ba.name          as account_name,
       ba.bank_name,
       c.id             as connection_id,
       c.channel,
       c.status         as connection_status,
       c.last_success_at,
       (select max(s.statement_date) from bank_statement s where s.bank_account_id = ba.id)
                        as through,
       (select count(*) from inbound_file f
         where f.connection_id = c.id and f.status = 'quarantined') as quarantined
  from bank_account ba
  left join connection c
         on c.bank_account_id = ba.id and c.source_code = 'bank_statement'
 where ba.status = 'active';
