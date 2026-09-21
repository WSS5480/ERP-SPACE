-- 0003_vendors.sql
-- The vendor master. One record per real company across every entity, so the
-- 1099 total and the duplicate check see all of it. Per-entity terms and
-- coding live in vendor_entity -- merging those two is the classic mistake.
--
-- Banking is versioned, never updated. Account numbers are not stored here;
-- only the last four and a reference into the secrets store.

create table vendor (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenant(id),
  legal_name         text not null,
  dba                text,
  tax_classification text check (tax_classification in
                       ('individual','sole_prop','partnership','c_corp','s_corp','llc','other')),
  is_1099            boolean not null default false,
  tin_ref            text,        -- secrets store key, never the TIN itself
  tin_last4          text check (tin_last4 ~ '^[0-9]{4}$'),
  w9_on_file         boolean not null default false,
  status             text not null default 'pending'
                       check (status in ('pending','active','hold','inactive')),
  created_at         timestamptz not null default now(),
  created_by         uuid references app_user(id),
  unique (tenant_id, legal_name)
);

comment on table vendor is 'shared across entities; see vendor_entity for per-company settings';

create table vendor_entity (
  id                  uuid primary key default gen_random_uuid(),
  vendor_id           uuid not null references vendor(id),
  entity_id           uuid not null references entity(id),
  terms_days          smallint not null default 30 check (terms_days >= 0),
  discount_pct_bps    integer not null default 0 check (discount_pct_bps >= 0),
  discount_days       smallint not null default 0 check (discount_days >= 0),
  default_gl_account_id    uuid references gl_account(id),
  default_profit_object_id uuid references profit_object(id),
  status              text not null default 'active'
                        check (status in ('active','hold','inactive')),
  unique (vendor_id, entity_id)
);

-- Versioned. A change inserts a new row and supersedes the old one; nothing
-- is overwritten, and every version keeps the approval that allowed it.
create table vendor_bank_account (
  id                 uuid primary key default gen_random_uuid(),
  vendor_id          uuid not null references vendor(id),
  version            integer not null check (version > 0),
  account_ref        text not null,   -- secrets store key
  routing_last4      text not null check (routing_last4 ~ '^[0-9]{4}$'),
  account_last4      text not null check (account_last4 ~ '^[0-9]{4}$'),
  status             text not null default 'pending'
                       check (status in ('pending','current','superseded')),
  approval_request_id uuid references approval_request(id),
  effective_from     timestamptz,
  hold_until         timestamptz,     -- cooling-off before the first payment
  created_at         timestamptz not null default now(),
  created_by         uuid references app_user(id),
  unique (vendor_id, version)
);

-- Exactly one current set of banking details per vendor.
create unique index vendor_bank_current on vendor_bank_account (vendor_id)
  where status = 'current';

create table vendor_document (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references vendor(id),
  kind        text not null check (kind in ('w9','coi','credit_application','contract','other')),
  storage_key text not null,
  issued_on   date,
  expires_on  date,
  created_at  timestamptz not null default now()
);

create index vendor_document_expiry on vendor_document (expires_on)
  where expires_on is not null;

-- Built from history, not hand-written. After three clean invoices with
-- consistent coding, the system proposes one; inside its band an invoice
-- skips matching entirely.
create table vendor_template (
  id                   uuid primary key default gen_random_uuid(),
  vendor_entity_id     uuid not null references vendor_entity(id),
  gl_account_id        uuid not null references gl_account(id),
  profit_object_id     uuid references profit_object(id),
  department_id        uuid references department(id),
  expected_amount_minor bigint,
  tolerance_bps        integer not null default 1500 check (tolerance_bps between 0 and 10000),
  cadence              text check (cadence in ('weekly','monthly','quarterly','annual','irregular')),
  built_from_count     integer not null default 0,
  status               text not null default 'proposed'
                         check (status in ('proposed','active','paused')),
  created_at           timestamptz not null default now(),
  unique (vendor_entity_id, gl_account_id, profit_object_id)
);

comment on column vendor_template.tolerance_bps is
  'basis points; 1500 = an invoice within 15% of expected posts without review';
