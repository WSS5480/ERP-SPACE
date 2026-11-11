-- Vendor files: catalogs, prices, inventory and EDI documents that a vendor
-- leaves on an SFTP server, answers from a plain HTTPS address, or emails.
--
-- They ride the existing connection pipeline (0012): one connection per
-- vendor server, carrying one or more kinds of file, each picked out by a
-- file-name pattern. Runs, de-duplication, quarantine and health are the
-- pipeline's own. What this adds:
--
--   a source, vendor_files, with its four channels
--   connection_secret: a connection's password, private key or token,
--     AES-256-GCM under ERP_SECRET_KEY (the vendor feeds' rule), write-only
--   sftp_host_pin: the server key a person saw on the first Test, for a
--     connection or an EDI trading partner; a different key is refused
--   inbound_file.note: what a file did, in words (EDI documents applied, ...)
--   inbound_mailbox: each company's own address for vendor email
--   inbound_mail_held: mail to that address from a sender no connection
--     knows, held for a person to assign or set aside
--
-- Nothing here is deleted; set-aside rows keep their reason.

insert into ingest_source (code, name, direction, handler, description) values
  ('vendor_files', 'Vendor files', 'inbound', 'vendor_files',
   'catalogs, prices, inventory and EDI documents a vendor drops on SFTP, serves over HTTPS or emails')
on conflict (code) do nothing;

insert into source_channel (source_code, channel, mode, formats, notes) values
  ('vendor_files', 'sftp',          'pull', '{csv,xlsx,json,x12,zip}', 'the vendor''s server, read on a schedule'),
  ('vendor_files', 'api',           'pull', '{csv,json,x12}',          'one HTTPS address that answers with a file'),
  ('vendor_files', 'email',         'push', '{csv,xlsx,x12,zip}',      'attachments mailed to the company''s vendor address'),
  ('vendor_files', 'manual_upload', 'push', '{csv,xlsx,json,x12,zip}', 'a person drops the vendor''s file')
on conflict (source_code, channel) do nothing;

-- A vendor-file connection belongs to one company and one of its vendors.
create or replace function connection_vendor_rules() returns trigger
language plpgsql as $$
begin
  if new.source_code = 'vendor_files' then
    if new.entity_id is null then
      raise exception 'a vendor file connection belongs to one company';
    end if;
    if new.vendor_id is null then
      raise exception 'a vendor file connection names its vendor';
    end if;
    if not exists (select 1 from vendor_entity ve where ve.vendor_id = new.vendor_id and ve.entity_id = new.entity_id) then
      raise exception 'that vendor is not set up for this company';
    end if;
  end if;
  return new;
end $$;
create trigger connection_vendor_rules_trg
  before insert or update on connection
  for each row execute function connection_vendor_rules();

create index if not exists connection_vendor on connection (entity_id, vendor_id) where vendor_id is not null;

-- ------------------------------------------------------------- secrets
create table connection_secret (
  connection_id uuid not null references connection(id),
  tenant_id     uuid not null references tenant(id),
  entity_id     uuid references entity(id),
  name          text not null check (name in ('password','privateKey','passphrase','token','apiKey')),
  iv            bytea not null check (octet_length(iv) = 12),
  ciphertext    bytea not null,
  tag           bytea not null check (octet_length(tag) = 16),
  updated_by    uuid references app_user(id),
  updated_at    timestamptz not null default now(),
  primary key (connection_id, name)
);
comment on table connection_secret is
  'sealed under ERP_SECRET_KEY with AAD connection:<id>:<name>; never returned, only whether it is set';

-- ------------------------------------------------------------- host keys
create table sftp_host_pin (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  entity_id     uuid not null references entity(id),
  owner_kind    text not null check (owner_kind in ('connection','edi_partner','vendor_feed')),
  owner_id      uuid not null,
  host          text not null,
  port          integer not null check (port between 1 and 65535),
  key_type      text not null,
  fingerprint   text not null check (fingerprint ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
  pinned_at     timestamptz not null default now(),
  pinned_by     uuid references app_user(id),
  pinned_by_name text,
  -- a different key the server showed since, waiting for the owner to trust it
  offered_type  text,
  offered_fingerprint text check (offered_fingerprint is null or offered_fingerprint ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
  offered_at    timestamptz,
  unique (owner_kind, owner_id)
);
comment on table sftp_host_pin is
  'the SSH server key recorded on the first successful Test; a run that meets another key is refused';

-- ---------------------------------------------------------- what a file did
alter table inbound_file add column if not exists note text;

-- ------------------------------------------------------------ inbound mail
create table inbound_mailbox (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  tenant_id   uuid not null references tenant(id),
  -- null: the company's general vendor address; a vendor: that vendor's own address
  vendor_id   uuid references vendor(id),
  mailbox_key text not null unique check (mailbox_key ~ '^[a-z0-9]{12,32}$'),
  created_at  timestamptz not null default now()
);
create unique index inbound_mailbox_one on inbound_mailbox (entity_id, vendor_id) nulls not distinct;
comment on table inbound_mailbox is
  'a vendor-mail address is <local>+<mailbox_key>@<domain> of ERP_INBOUND_EMAIL_ADDRESS: one per company, and one per vendor';

create table inbound_mail_held (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  entity_id    uuid not null references entity(id),
  received_at  timestamptz not null default now(),
  sender       text not null,
  subject      text,
  message_id   text,
  filename     text not null,
  content_type text,
  byte_size    bigint not null check (byte_size >= 0),
  sha256       text not null check (length(sha256) = 64),
  content      bytea,
  reason       text not null check (btrim(reason) <> ''),
  status       text not null default 'held' check (status in ('held','assigned','set_aside')),
  decided_at   timestamptz,
  decided_by   uuid references app_user(id),
  decided_by_name text,
  decision_note text,
  vendor_id    uuid references vendor(id),
  connection_id uuid references connection(id),
  inbound_file_id uuid references inbound_file(id),
  feed_id      uuid references vendor_feed(id),
  feed_run_id  uuid references vendor_feed_run(id),
  check (status = 'held' or decided_at is not null)
);
create index inbound_mail_held_open on inbound_mail_held (entity_id, received_at desc) where status = 'held';
create unique index inbound_mail_held_once on inbound_mail_held (entity_id, sha256, lower(sender)) where status = 'held';
comment on table inbound_mail_held is
  'attachments mailed to a company''s vendor address by a sender no vendor connection lists; nothing from them is read until a person assigns them';

-- An EDI partner's SFTP private key may carry a passphrase.
alter table edi_partner_secret drop constraint if exists edi_partner_secret_name_check;
alter table edi_partner_secret add constraint edi_partner_secret_name_check
  check (name in ('sftpPassword','sftpKey','sftpPassphrase','vanApiKey','vanToken','vanPassword','as2Password'));

-- ------------------------------------------------- vendor feeds by SFTP and email
-- A vendor feed (Catalog, Vendors, API setup) may now pull its file from the
-- vendor's SFTP server or take it from the vendor's email, through the same
-- mapping and ETL as an API feed. Each file a feed takes is remembered by its
-- checksum, so the same file is never applied twice.
alter table vendor_feed_secret drop constraint if exists vendor_feed_secret_name_check;
alter table vendor_feed_secret add constraint vendor_feed_secret_name_check
  check (name in ('apiKey','token','password','clientSecret','atpKeyCode','atpPassword','sftpPassword','sftpKey','sftpPassphrase'));

alter table vendor_feed_run drop constraint if exists vendor_feed_run_trigger_check;
alter table vendor_feed_run add constraint vendor_feed_run_trigger_check check (trigger in ('manual','schedule','email'));

create table vendor_feed_file (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  feed_id     uuid not null references vendor_feed(id),
  run_id      uuid references vendor_feed_run(id),
  via         text not null check (via in ('sftp','email')),
  name        text not null,
  byte_size   bigint not null check (byte_size >= 0),
  modified_at text,
  sha256      text not null check (length(sha256) = 64),
  sender      text,
  rows        integer,
  taken_at    timestamptz not null default now(),
  unique (feed_id, sha256)
);
create index vendor_feed_file_recent on vendor_feed_file (feed_id, taken_at desc);
comment on table vendor_feed_file is 'each file an SFTP or email-in vendor feed applied; a file seen again is not applied twice';
