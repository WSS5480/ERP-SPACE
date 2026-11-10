-- Serial numbers and dye lots, label printing, and finance company settlement
-- reconciliation. Extends inventory (inv_piece), the EDI ship notice, the
-- catalog's price tags and A/R's third-party finance (financed_sale).
--
-- Accounts (by code; added to every client that has the retail chart):
--   1115 Finance company holdbacks receivable   what a lender kept back from a funding, until it releases it
--   6915 Finance company chargebacks             a lender took back a funded sale and we do not expect it again
-- Fees the lender keeps post to 6910 (Card and finance fees), as A/R already does.

-- ------------------------------------------------------------ serials and lots --

-- How a product's units are matched on one order: upholstery and leather by dye
-- lot, wood case goods by finish batch, anything else by batch. lot_group names
-- the cover or finish (pieces of one group on one order should share a lot);
-- left empty it is the product's collection and color.
alter table product add column lot_class text check (lot_class in ('dye_lot','finish_batch','batch'));
alter table product add column lot_group text check (lot_group is null or length(lot_group) <= 80);

-- Every carton of a unit carries the unit's vendor serial and lot.
alter table inv_piece add column serial_no text check (serial_no is null or serial_no ~ '^[\x21-\x7e]{1,60}$');
alter table inv_piece add column lot_code  text check (lot_code is null or lot_code ~ '^[\x20-\x7e]{1,40}$');
create unique index inv_piece_serial on inv_piece (entity_id, product_id, upper(serial_no), carton_seq) where serial_no is not null;
create index inv_piece_serial_search on inv_piece (entity_id, upper(serial_no)) where serial_no is not null;
create index inv_piece_lot_search on inv_piece (entity_id, upper(lot_code)) where lot_code is not null;

-- A lot for stock that is not tracked piece by piece is kept on the receipt line.
alter table goods_receipt_line add column lot_code text check (lot_code is null or lot_code ~ '^[\x20-\x7e]{1,40}$');

-- Serials and lots a vendor's ship notice (856 MAN / LIN / REF) said are coming
-- on a PO line. Receiving uses them when the dock does not scan its own.
create table inv_expected_serial (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  purchase_order_line_id uuid not null references purchase_order_line(id),
  serial_no     text check (serial_no is null or serial_no ~ '^[\x21-\x7e]{1,60}$'),
  lot_code      text check (lot_code is null or lot_code ~ '^[\x20-\x7e]{1,40}$'),
  source        text not null default 'asn',
  reference     text,                               -- the shipment id
  used_at       timestamptz,
  piece_label   text,
  created_at    timestamptz not null default now(),
  check (serial_no is not null or lot_code is not null)
);
create index inv_expected_serial_line on inv_expected_serial (entity_id, purchase_order_line_id) where used_at is null;

-- --------------------------------------------------------------------- labels --

-- What a company's labels look like: size, resolution and the fields printed.
create table label_template (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  kind        text not null check (kind in ('carton','bin','price_tag')),
  name        text not null check (length(name) between 1 and 60),
  width_in    numeric(4,2) not null check (width_in between 1 and 8),
  height_in   numeric(4,2) not null check (height_in between 0.5 and 12),
  dpi         smallint not null default 203 check (dpi in (203, 300, 600)),
  fields      text[] not null,
  is_default  boolean not null default false,
  active      boolean not null default true,
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  unique (entity_id, kind, name)
);
create unique index label_template_default on label_template (entity_id, kind) where is_default and active;

-- Thermal printers the owner set up. Only these are ever sent to, and only on a
-- private-network address: a request names a printer, never an address.
create table label_printer (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  name        text not null check (length(name) between 1 and 60),
  host        inet not null,
  port        integer not null default 9100 check (port between 9100 and 9109),
  location_id uuid references location(id),
  active      boolean not null default true,
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  unique (entity_id, name),
  -- 10/8, 172.16/12, 192.168/16 and IPv6 unique-local fc00::/7 only
  check (host << '10.0.0.0/8'::inet or host << '172.16.0.0/12'::inet or host << '192.168.0.0/16'::inet or host << 'fc00::/7'::inet),
  check (masklen(host) = case when family(host) = 4 then 32 else 128 end)
);

create table label_print_job (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  printer_id  uuid references label_printer(id),
  how         text not null check (how in ('network','download','browser')),
  source      text not null,
  labels      integer not null check (labels >= 0),
  bytes       integer not null default 0,
  status      text not null check (status in ('sent','failed','made')),
  error       text,
  by_user     uuid references app_user(id),
  at          timestamptz not null default now()
);
create index label_print_job_entity on label_print_job (entity_id, at desc);

-- ------------------------------------------------- finance company settlements --

-- How each lender's remittance file is laid out (like a bank feed's CSV mapping),
-- where their deposits land, and how far their fee may stray before it is flagged.
alter table finance_company add column remit_mapping jsonb;
alter table finance_company add column bank_account_id uuid references bank_account(id);
alter table finance_company add column fee_tolerance_minor bigint not null default 100 check (fee_tolerance_minor >= 0);
alter table finance_company add column chargeback_mode text not null default 'reopen' check (chargeback_mode in ('reopen','expense'));

-- What identifies a financed sale on the lender's file: their approval/auth code
-- and the last four of the customer's account with them (never the whole number).
alter table financed_sale add column auth_code text check (auth_code is null or auth_code ~ '^[\x21-\x7e]{1,40}$');
alter table financed_sale add column account_last4 text check (account_last4 is null or account_last4 ~ '^[0-9]{4}$');
alter table financed_sale add column funded_minor bigint not null default 0;
alter table financed_sale add column fee_taken_minor bigint not null default 0;
alter table financed_sale add column holdback_minor bigint not null default 0 check (holdback_minor >= 0);
alter table financed_sale add column holdback_open_minor bigint not null default 0 check (holdback_open_minor >= 0);
alter table financed_sale add column funded_on date;
alter table financed_sale add column chargeback_reason text;
alter table financed_sale add column chargeback_at timestamptz;
alter table financed_sale drop constraint financed_sale_status_check;
alter table financed_sale add constraint financed_sale_status_check check (status in ('awaiting_funding','funded','charged_off'));
alter table financed_sale add constraint financed_sale_holdback_check check (holdback_open_minor <= holdback_minor);
create index financed_sale_auth on financed_sale (entity_id, company_id, upper(auth_code)) where auth_code is not null;
-- The approval number taken at the register is the auth code the lender reports.
update financed_sale f set auth_code = upper(r.reference)
  from customer_receipt r where r.id = f.receipt_id and r.entity_id = f.entity_id and f.auth_code is null
   and r.reference ~ '^[\x21-\x7e]{1,40}$';

create table finance_remit_import (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  company_id    uuid not null references finance_company(id),
  number        text not null,
  filename      text,
  sha256        text not null,
  rows          integer not null default 0,
  matched       integer not null default 0,
  exceptions    integer not null default 0,
  net_minor     bigint not null default 0,      -- the whole file: what should reach the bank
  posted_minor  bigint not null default 0,      -- what has been posted to cash so far
  deposit_on    date,
  bank_statement_line_id uuid references bank_statement_line(id),
  imported_by   uuid references app_user(id),
  created_at    timestamptz not null default now(),
  unique (entity_id, number),
  unique (entity_id, company_id, sha256)
);

create table finance_remit_line (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  import_id     uuid not null references finance_remit_import(id),
  row_no        integer not null,
  kind          text not null check (kind in ('funding','holdback_release','chargeback')),
  txn_on        date,
  auth_code     text,
  account_last4 text check (account_last4 is null or account_last4 ~ '^[0-9]{4}$'),
  plan_code     text,
  gross_minor   bigint not null default 0,
  fee_minor     bigint not null default 0,
  holdback_minor bigint not null default 0,
  net_minor     bigint not null,
  reason        text,
  status        text not null check (status in ('posted','exception','dismissed')),
  exception     text,
  financed_sale_id uuid references financed_sale(id),
  expected_fee_minor bigint,
  fee_variance_minor bigint,
  fee_flag      boolean not null default false,
  chargeback_mode text check (chargeback_mode in ('reopen','expense')),
  journal_entry_id uuid references journal_entry(id),
  cash_line_id  uuid references journal_line(id),
  resolved_by   uuid references app_user(id),
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (import_id, row_no),
  check (status <> 'exception' or exception is not null),
  check (status <> 'posted' or financed_sale_id is not null)
);
create index finance_remit_line_open on finance_remit_line (entity_id, status);
create index finance_remit_line_sale on finance_remit_line (financed_sale_id);

-- ------------------------------------------------------------------- accounts --
do $$
declare t record; cur text; acct record;
begin
  for t in select id, name from tenant where exists (select 1 from gl_account g where g.tenant_id = tenant.id and g.code = '1110') loop
    for acct in select * from (values ('1115', 'Finance company holdbacks receivable', 'asset', 'D'),
                                      ('6915', 'Finance company chargebacks', 'expense', 'D')) v(code, name, typ, nb) loop
      select account_type into cur from gl_account where tenant_id = t.id and code = acct.code;
      if cur is null then
        insert into gl_account (tenant_id, code, name, account_type, normal_balance) values (t.id, acct.code, acct.name, acct.typ, acct.nb);
      elsif cur <> acct.typ then
        raise notice 'client % (%): account % is a % account, not %; finance settlements will refuse to post until it is renumbered', t.name, t.id, acct.code, cur, acct.name;
        continue;
      end if;
      insert into entity_gl_account (entity_id, gl_account_id)
      select e.id, g.id from entity e join gl_account g on g.tenant_id = e.tenant_id and g.code = acct.code where e.tenant_id = t.id
      on conflict do nothing;
    end loop;
  end loop;
end $$;
