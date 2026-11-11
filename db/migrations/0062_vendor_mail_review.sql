-- Vendor mail review, key changes by server, and held-mail limits.
--
-- Held mail remembers where it would have gone (the one connection or
-- email-in feed that lists its sender), so a person can Apply it in one tap
-- through the same mapping. A vendor can be set to have every message held
-- for review. A pinned SFTP key moved to another host or port is a changed
-- key (the owner trusts it), never a fresh start. Held mail keeps its content
-- 60 days (the record stays), and a client holds at most 200 messages or
-- 500 MB of content at once; past that the record is kept without content.

alter table inbound_mail_held add column if not exists suggest_connection_id uuid references connection(id);
alter table inbound_mail_held add column if not exists suggest_feed_id uuid references vendor_feed(id);
alter table inbound_mail_held add column if not exists content_purged_at timestamptz;
create index if not exists inbound_mail_held_content on inbound_mail_held (tenant_id) where content is not null;

-- "always hold" belongs to the vendor in this company, whether or not it has its own address yet
create table if not exists vendor_mail_rule (
  entity_id   uuid not null references entity(id),
  vendor_id   uuid not null references vendor(id),
  always_hold boolean not null default false,
  updated_by  uuid references app_user(id),
  updated_at  timestamptz not null default now(),
  primary key (entity_id, vendor_id)
);

alter table sftp_host_pin add column if not exists offered_host text;
alter table sftp_host_pin add column if not exists offered_port integer check (offered_port is null or offered_port between 1 and 65535);
