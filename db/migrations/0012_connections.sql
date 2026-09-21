-- 0012_connections.sql
-- How data gets in, and how it gets back out.
--
-- Every module needs the same four answers: what is this data, where does it
-- come from, how does it arrive, and what happened the last time it tried.
-- Answering that once means a new source is a row and a parser, not a project.
--
-- Five channels, each with real plumbing behind it:
--
--   manual_upload  a person drops a file on a screen
--   sftp           we fetch from, or deliver to, a directory on a schedule
--   email          it arrives as an attachment at an address we own
--   api            we call them on a schedule
--   webhook        they call us when something happens
--
-- The rules the database holds, so no screen has to remember them:
--
--   a connection can only use a channel its source actually declares
--   a pull channel needs a schedule; a push channel must not carry one
--   an email channel with no allowed senders is refused outright
--   an SFTP or API channel with no credential reference is refused
--   no secret is ever stored here, only a reference to one
--   the same file twice is one ingest, not two
--   nothing fails silently: a file that cannot be parsed is quarantined with a
--   reason, never dropped
--
-- The last two are the ones that matter at 2am. A duplicate statement that
-- posts twice and a bank feed that quietly stopped three weeks ago are the
-- two ways an automated back office lies to you.

-- ------------------------------------------------------------ the registry --

-- What kinds of data this system knows how to move. Adding one is a row here
-- plus a handler in code; the rest of the machinery is already built.
create table ingest_source (
  code        text primary key,
  name        text not null,
  direction   text not null check (direction in ('inbound','outbound')),
  handler     text not null,
  description text not null,
  is_active   boolean not null default true
);

comment on table ingest_source is
  'the catalogue of things that flow in or out; handler names the module that consumes or produces them';

-- Which channels each source supports, and whether we go and get it or it
-- comes to us. A connection may not use a pair that is not declared here.
create table source_channel (
  source_code text not null references ingest_source(code) on delete cascade,
  channel     text not null
                check (channel in ('manual_upload','sftp','email','api','webhook')),
  mode        text not null check (mode in ('pull','push')),
  formats     text[] not null default '{}',
  notes       text,
  primary key (source_code, channel)
);

-- ---------------------------------------------------------- the connection --

create table connection (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  entity_id       uuid references entity(id),
  source_code     text not null,
  channel         text not null,
  name            text not null,

  -- what this connection is about, when it speaks for one counterparty
  bank_account_id uuid references bank_account(id),
  vendor_id       uuid references vendor(id),
  location_id     uuid references location(id),

  -- channel-specific settings: host, port, path, glob, endpoint, mailbox.
  -- Secrets never live here; see credential_ref.
  config          jsonb not null default '{}'::jsonb,
  credential_ref  text,

  -- pull channels only
  schedule_cron   text,
  timezone        text not null default 'UTC',

  -- email channels only: nobody else may put a file into this company
  allowed_senders text[],

  status          text not null default 'draft'
                    check (status in ('draft','active','paused','failed','retired')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error      text,
  consecutive_failures integer not null default 0,

  created_at      timestamptz not null default now(),
  created_by      uuid references app_user(id),

  foreign key (source_code, channel) references source_channel(source_code, channel),
  unique (entity_id, source_code, channel, name)
);

create index connection_due on connection (source_code, status) where status = 'active';

comment on column connection.credential_ref is
  'a key into a secrets store that does not exist yet; deliberately not the secret';

-- A connection has to make sense for the channel it claims.
create or replace function connection_shape() returns trigger
language plpgsql as $$
declare
  m text;
begin
  select mode into m
    from source_channel
   where source_code = new.source_code and channel = new.channel;

  if m = 'pull' and (new.schedule_cron is null or btrim(new.schedule_cron) = '') then
    raise exception '% over % is a pull channel and needs a schedule', new.source_code, new.channel;
  end if;

  if m = 'push' and new.schedule_cron is not null then
    raise exception '% over % is a push channel; nothing here polls it', new.source_code, new.channel;
  end if;

  -- An address anyone may send to is an invoice-fraud inbox, not a connection.
  if new.channel = 'email'
     and (new.allowed_senders is null or cardinality(new.allowed_senders) = 0) then
    raise exception 'an email connection needs an allowed sender list';
  end if;

  if new.channel in ('sftp','api') and (new.credential_ref is null or btrim(new.credential_ref) = '') then
    raise exception '% needs a credential reference', new.channel;
  end if;

  if new.channel = 'sftp'
     and (new.config->>'host' is null or new.config->>'path' is null) then
    raise exception 'an sftp connection needs a host and a path';
  end if;

  if new.channel = 'api' and new.config->>'endpoint' is null then
    raise exception 'an api connection needs an endpoint';
  end if;

  -- A connection cannot speak for another company's bank account.
  if new.bank_account_id is not null and new.entity_id is not null then
    if not exists (select 1 from bank_account
                    where id = new.bank_account_id and entity_id = new.entity_id) then
      raise exception 'that bank account belongs to a different company';
    end if;
  end if;

  return new;
end $$;

create trigger connection_shape_trg
  before insert or update on connection
  for each row execute function connection_shape();

-- Config is for settings. If it looks like a secret, it does not belong here.
create or replace function connection_no_secrets() returns trigger
language plpgsql as $$
declare
  k text;
begin
  for k in select jsonb_object_keys(new.config)
  loop
    if lower(k) ~ '(password|passwd|secret|private_key|privatekey|api_key|apikey|token|credential)' then
      raise exception 'config may not hold %; store it in the secrets store and reference it', k;
    end if;
  end loop;
  return new;
end $$;

create trigger connection_no_secrets_trg
  before insert or update on connection
  for each row execute function connection_no_secrets();

-- ----------------------------------------------------------------- the run --

create table ingest_run (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references connection(id),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  trigger       text not null check (trigger in ('schedule','manual','webhook','retry')),
  actor_kind    text not null default 'system'
                  check (actor_kind in ('user','agent','system')),
  ran_by        uuid references app_user(id),
  files_seen    integer not null default 0,
  files_new     integer not null default 0,
  files_failed  integer not null default 0,
  outcome       text check (outcome in ('ok','partial','failed')),
  error         text
);

create index ingest_run_recent on ingest_run (connection_id, started_at desc);

-- ---------------------------------------------------------------- the file --

create table inbound_file (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  connection_id uuid not null references connection(id),
  run_id        uuid references ingest_run(id),
  source_code   text not null references ingest_source(code),

  -- where it came from, in that channel's own terms
  origin        text not null,
  origin_detail jsonb not null default '{}'::jsonb,

  received_at   timestamptz not null default now(),
  byte_size     bigint not null check (byte_size >= 0),
  sha256        text not null check (length(sha256) = 64),
  content_type  text,
  format        text,
  storage_ref   text,

  status        text not null default 'received'
                  check (status in ('received','parsing','parsed','applied','quarantined','ignored')),
  quarantine_reason text,
  parsed_at     timestamptz,
  applied_at    timestamptz,
  rows_parsed   integer,

  -- the same bytes arriving twice on the same connection is one ingest
  unique (connection_id, sha256)
);

create index inbound_file_open on inbound_file (source_code, status)
  where status in ('received','parsing','quarantined');

comment on table inbound_file is
  'everything that arrived, from any channel, in one shape; the parser decides what it means';

create or replace function inbound_file_rules() returns trigger
language plpgsql as $$
declare
  csource text;
begin
  select source_code into csource from connection where id = new.connection_id;
  if csource is distinct from new.source_code then
    raise exception 'this connection carries %, not %', csource, new.source_code;
  end if;

  if new.status = 'quarantined'
     and (new.quarantine_reason is null or btrim(new.quarantine_reason) = '') then
    raise exception 'a quarantined file needs a reason, or nobody can clear it';
  end if;

  return new;
end $$;

create trigger inbound_file_rules_trg
  before insert or update on inbound_file
  for each row execute function inbound_file_rules();

-- ------------------------------------------------------------ what goes out --

create table outbound_file (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  connection_id uuid not null references connection(id),
  source_code   text not null references ingest_source(code),
  subject_kind  text check (subject_kind in ('payment_run','payroll_run','positive_pay','tax_filing')),
  subject_id    uuid,
  format        text not null,
  byte_size     bigint,
  sha256        text,
  storage_ref   text,
  status        text not null default 'built'
                  check (status in ('built','approved','sent','acknowledged','failed')),
  built_at      timestamptz not null default now(),
  built_by      uuid references app_user(id),
  approved_by   uuid references app_user(id),
  sent_at       timestamptz,
  acknowledged_at timestamptz,
  ack_ref       text,
  error         text
);

-- Money leaving needs two people, same as the run that created it.
create or replace function outbound_file_two_people() returns trigger
language plpgsql as $$
begin
  if new.status in ('approved','sent','acknowledged')
     and new.subject_kind in ('payment_run','payroll_run')
     and (new.approved_by is null or new.approved_by = new.built_by) then
    raise exception 'a % file cannot be released by whoever built it', new.subject_kind;
  end if;
  return new;
end $$;

create trigger outbound_file_two_people_trg
  before insert or update on outbound_file
  for each row execute function outbound_file_two_people();

-- --------------------------------------------------------------- the views --

-- A feed that stopped is the failure nobody notices. This is how you notice.
create view connection_health as
select c.id            as connection_id,
       c.entity_id,
       c.name,
       c.source_code,
       c.channel,
       c.status,
       c.last_success_at,
       c.consecutive_failures,
       c.last_error,
       case
         when c.status <> 'active'                      then c.status
         when c.last_success_at is null                 then 'never run'
         when c.consecutive_failures >= 3               then 'failing'
         when c.last_success_at < now() - interval '3 days' then 'stale'
         else 'healthy'
       end            as verdict,
       case when c.last_success_at is null then null
            else (current_date - c.last_success_at::date) end as days_since_success
  from connection c;

create view quarantined_files as
select f.id           as file_id,
       f.tenant_id,
       c.entity_id,
       c.name         as connection_name,
       f.source_code,
       c.channel,
       f.origin,
       f.received_at,
       f.quarantine_reason,
       current_date - f.received_at::date as days_open
  from inbound_file f
  join connection c on c.id = f.connection_id
 where f.status = 'quarantined';

create view ingest_backlog as
select c.entity_id,
       f.source_code,
       count(*) filter (where f.status = 'received')    as waiting,
       count(*) filter (where f.status = 'parsed')      as parsed_not_applied,
       count(*) filter (where f.status = 'quarantined') as quarantined
  from inbound_file f
  join connection c on c.id = f.connection_id
 group by c.entity_id, f.source_code;

-- ------------------------------------------------- what this system moves --
--
-- Inbound first. Every row here is a thing the ERP can be handed, and every
-- channel beside it is plumbing that exists rather than plumbing that is
-- planned.

insert into ingest_source (code, name, direction, handler, description) values
  ('bank_statement',     'Bank statement',         'inbound',  'statements',
   'daily or intraday activity from a bank, in whatever dialect it speaks'),
  ('pos_deposit',        'POS takings',            'inbound',  'reconcile',
   'what each store took and when it should reach the bank'),
  ('invoice',            'Supplier invoice',       'inbound',  'invoice',
   'a bill, however it arrives: emailed PDF, EDI, a portal export, a scan'),
  ('vendor_import',      'Vendor master import',   'inbound',  'vendors',
   'names, terms, remit-to and coding, loaded in bulk'),
  ('payroll_return',     'Payroll provider return','inbound',  'payroll',
   'registers, tax deposits and filings coming back from the provider'),
  ('payment_ack',        'Payment acknowledgement','inbound',  'banking',
   'accepted, returned and rejected items from a payment file we sent'),
  ('franchise_statement','Franchise statement',    'inbound',  'franchise',
   'royalty and ad-fund statements, to reconcile against what was owed'),
  ('lease_schedule',     'Lease or loan schedule', 'inbound',  'leases',
   'payment schedules, escalations and covenant terms'),
  ('payment_file',       'Payment file',           'outbound', 'banking',
   'ACH and other disbursement files leaving for the bank'),
  ('positive_pay',       'Positive pay file',      'outbound', 'banking',
   'the cheque register the bank matches presentments against'),
  ('payroll_submit',     'Payroll submission',     'outbound', 'payroll',
   'hours and the approved register going out to the provider'),
  ('tax_filing',         'Tax filing',             'outbound', 'tax',
   'returns and deposits handed to the filing provider');

insert into source_channel (source_code, channel, mode, formats, notes) values
  ('bank_statement','manual_upload','push', '{bai2,ofx,qfx,csv,mt940}', 'a person exports from online banking and drops the file'),
  ('bank_statement','sftp',         'pull', '{bai2,csv,mt940}',         'the bank leaves a file every morning'),
  ('bank_statement','email',        'push', '{ofx,csv,pdf}',            'small banks that only email a statement'),
  ('bank_statement','api',          'pull', '{json}',                   'direct or via an aggregator'),

  ('pos_deposit','manual_upload','push', '{csv,xlsx}', 'the daily export, dropped by a manager'),
  ('pos_deposit','sftp',         'pull', '{csv}',      'the POS drops takings nightly'),
  ('pos_deposit','api',          'pull', '{json}',     'polled per store per day'),
  ('pos_deposit','webhook',      'push', '{json}',     'the POS calls us at close of day'),

  ('invoice','manual_upload','push', '{pdf,csv,xml}', 'drag it onto the payables queue'),
  ('invoice','email',        'push', '{pdf,xml}',     'the A/P inbox; senders are allow-listed'),
  ('invoice','sftp',         'pull', '{edi,csv,xml}', 'larger suppliers drop files'),
  ('invoice','api',          'pull', '{json}',        'supplier portals'),

  ('vendor_import','manual_upload','push', '{csv,xlsx}', 'the one-off load out of the old system'),
  ('vendor_import','api',          'pull', '{json}',     'ongoing sync where one exists'),

  ('payroll_return','sftp',         'pull', '{csv,pdf}', 'registers and filings back from the provider'),
  ('payroll_return','api',          'pull', '{json}',    'where the provider has one'),
  ('payroll_return','manual_upload','push', '{csv,pdf}', 'the fallback that always works'),

  ('payment_ack','sftp',   'pull', '{ack,csv,nacha}', 'returns and rejects'),
  ('payment_ack','api',    'pull', '{json}',          'status polling'),
  ('payment_ack','webhook','push', '{json}',          'the bank calls us on a return'),

  ('franchise_statement','email',        'push', '{pdf,csv}', 'the franchisor emails a statement'),
  ('franchise_statement','manual_upload','push', '{pdf,csv}', 'downloaded from the franchisor portal'),
  ('franchise_statement','api',          'pull', '{json}',    'if the portal ever offers one'),

  ('lease_schedule','manual_upload','push', '{csv,pdf}', 'entered once, then generates payables'),

  ('payment_file','sftp','push', '{nacha,csv}', 'the disbursement file goes to the bank'),
  ('payment_file','api', 'push', '{json}',      'origination by API where the bank supports it'),

  ('positive_pay','sftp','push', '{csv,fixed}', 'issued cheques, sent the moment a run is released'),
  ('positive_pay','api', 'push', '{json}',      'same, by API'),

  ('payroll_submit','api', 'push', '{json}', 'hours and the approved register'),
  ('payroll_submit','sftp','push', '{csv}',  'for providers that take a file'),

  ('tax_filing','api','push', '{json}', 'returns and deposits to the filing provider');
