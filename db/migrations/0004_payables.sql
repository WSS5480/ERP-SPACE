-- 0004_payables.sql
-- Intake, the two classes of payable, three-way match for merchandise, and
-- payment runs. Money is bigint minor units throughout -- never a float.
--
-- Operating payables  : no PO, matched against a template and a tolerance band
-- Merchandise payables: always a PO and a receipt, matched unit by unit,
--                       and nothing pays until the match clears

-- ----------------------------------------------------------------- intake --

create table intake_document (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  entity_id   uuid references entity(id),
  channel     text not null check (channel in
                ('email','forward','upload','mobile','portal','edi','paper')),
  received_at timestamptz not null default now(),
  sender      text,
  sha256      text not null,
  storage_key text not null,
  status      text not null default 'received'
                check (status in ('received','extracted','duplicate','discarded')),
  unique (tenant_id, sha256)          -- the same file twice is one document
);

comment on index intake_document_tenant_id_sha256_key is
  'deduplication runs at the door, before extraction';

-- ------------------------------------------------- purchase and receiving --

create table purchase_order (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  entity_id     uuid not null references entity(id),
  vendor_id     uuid not null references vendor(id),
  number        text not null,
  ordered_on    date not null,
  profit_object_id uuid references profit_object(id),
  status        text not null default 'open'
                  check (status in ('open','received','closed','cancelled')),
  created_by    uuid references app_user(id),
  unique (entity_id, number)
);

create table purchase_order_line (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_order(id) on delete cascade,
  seq               smallint not null,
  description       text not null,
  quantity          numeric(12,3) not null check (quantity > 0),
  unit_price_minor  bigint not null check (unit_price_minor >= 0),
  gl_account_id     uuid not null references gl_account(id),
  agreement_ref     text,        -- set when this is a customer special order
  unique (purchase_order_id, seq)
);

create table goods_receipt (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_order(id),
  received_on       date not null,
  received_by       uuid references app_user(id),
  note              text
);

create table goods_receipt_line (
  id                     uuid primary key default gen_random_uuid(),
  goods_receipt_id       uuid not null references goods_receipt(id) on delete cascade,
  purchase_order_line_id uuid not null references purchase_order_line(id),
  quantity               numeric(12,3) not null check (quantity > 0),
  unit_ids               text[] not null default '{}'   -- serialised units
);

-- --------------------------------------------------------------- invoices --

create table invoice (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  entity_id           uuid not null references entity(id),
  vendor_id           uuid not null references vendor(id),
  kind                text not null check (kind in ('operating','merchandise','reimbursement')),
  reference           text,
  invoice_date        date not null,
  due_date            date,
  total_minor         bigint not null,
  currency            char(3) not null default 'USD',
  status              text not null default 'captured' check (status in
                        ('captured','extracted','matched','validated','pending',
                         'exception','held','approved','scheduled','paid','rejected')),
  intake_document_id  uuid references intake_document(id),
  purchase_order_id   uuid references purchase_order(id),
  template_id         uuid references vendor_template(id),
  confidence_bps      integer check (confidence_bps between 0 and 10000),
  scheduled_pay_date  date,
  created_by          uuid references app_user(id),
  created_at          timestamptz not null default now()
);

-- The honest re-send. The fuzzy check lives in code and can only hold, not reject.
create unique index invoice_vendor_reference_key
  on invoice (entity_id, vendor_id, reference) where reference is not null;

create index invoice_queue on invoice (entity_id, status, invoice_date);

-- Merchandise always has a purchase order behind it.
alter table invoice add constraint invoice_merchandise_needs_po
  check (kind <> 'merchandise' or purchase_order_id is not null);

create table invoice_line (
  id                     uuid primary key default gen_random_uuid(),
  invoice_id             uuid not null references invoice(id) on delete cascade,
  seq                    smallint not null,
  gl_account_id          uuid not null references gl_account(id),
  profit_object_id       uuid references profit_object(id),
  department_id          uuid references department(id),
  purchase_order_line_id uuid references purchase_order_line(id),
  description            text,
  amount_minor           bigint not null,
  unique (invoice_id, seq)
);

-- Lines must sum to the header. Deferred, so a multi-line insert is fine.
create or replace function invoice_lines_balance() returns trigger
language plpgsql as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
  v_total   bigint;
  v_lines   bigint;
begin
  select total_minor into v_total from invoice where id = v_invoice;
  if v_total is null then return null; end if;      -- invoice deleted with it
  select coalesce(sum(amount_minor),0) into v_lines
    from invoice_line where invoice_id = v_invoice;
  if v_lines <> v_total then
    raise exception 'invoice % lines sum to % but the header says %',
      v_invoice, v_lines, v_total using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger invoice_lines_balance_trg
  after insert or update or delete on invoice_line
  deferrable initially deferred
  for each row execute function invoice_lines_balance();

create table invoice_extraction (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null references invoice(id) on delete cascade,
  field          text not null,
  value          text,
  confidence_bps integer not null check (confidence_bps between 0 and 10000),
  model_version  text,
  unique (invoice_id, field)
);

comment on table invoice_extraction is
  'the why behind an automated posting: which field, what confidence, which model';

-- ---------------------------------------------------------------- payment --

create table payment_run (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  entity_id   uuid not null references entity(id),
  method      text not null check (method in ('ach','check','card','fuel_account')),
  pay_date    date not null,
  status      text not null default 'building'
                check (status in ('building','pending_release','released','settled','cancelled')),
  built_by    uuid not null references app_user(id),
  released_by uuid references app_user(id),
  released_at timestamptz,
  file_key    text,
  created_at  timestamptz not null default now()
);

-- Built and released are different people. The engine enforces it; so does this.
alter table payment_run add constraint payment_run_two_people
  check (released_by is null or released_by <> built_by);

create table payment (
  id             uuid primary key default gen_random_uuid(),
  payment_run_id uuid not null references payment_run(id) on delete cascade,
  invoice_id     uuid not null references invoice(id),
  amount_minor   bigint not null check (amount_minor > 0),
  status         text not null default 'planned'
                   check (status in ('planned','sent','cleared','returned','voided')),
  unique (payment_run_id, invoice_id)
);
