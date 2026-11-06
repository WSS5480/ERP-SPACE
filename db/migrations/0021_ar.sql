-- 0021_ar.sql
-- Complete receivables: house accounts, customer invoices, payments on
-- account, store credit, statements, aging, late fees, collections,
-- write-offs and recoveries, in-house installment contracts, third-party
-- finance companies and their settlements, repossession records.
--
-- The rule this file is built around: every movement in accounts
-- receivable (GL 1100) is one row in ar_ledger, written in the same
-- transaction as the journal entry. A customer's balance, an invoice's open
-- amount, a contract's principal, the statement and the aging are all sums
-- of that one table, so the aging total ties to GL 1100 by construction --
-- and a difference on the tie-out means something posted to 1100 without
-- going through A/R, which is exactly what the tie-out is for.
--
-- Accounts (by code, from the tenant's chart):
--   1100 A/R customers        1110 receivable from finance companies
--   1190 allowance            2300 customer deposits     2320 store credit
--   4020 fees, finance charges and contract interest
--   6900 bad debt expense     6910 card and finance fees

-- ------------------------------------------------------------ settings --

create table ar_settings (
  entity_id            uuid primary key references entity(id),
  late_fee_enabled     boolean not null default true,
  late_fee_bps         integer not null default 150 check (late_fee_bps between 0 and 2500),  -- per month on the overdue balance
  late_fee_grace_days  smallint not null default 10 check (late_fee_grace_days between 0 and 90),
  late_fee_min_minor   bigint not null default 500 check (late_fee_min_minor >= 0),
  late_fee_max_minor   bigint check (late_fee_max_minor is null or late_fee_max_minor >= 0),
  default_terms_days   smallint not null default 30 check (default_terms_days between 0 and 180),
  writeoff_method      text not null default 'allowance' check (writeoff_method in ('allowance','direct')),
  call_after_days      smallint not null default 1 check (call_after_days >= 0),  -- on the call list this many days past due
  updated_at           timestamptz not null default now()
);

-- ----------------------------------------------------- customer account --
-- The spine's customer row holds credit_limit_minor, terms_days and status.
-- This row holds what only receivables cares about.

create table ar_account (
  entity_id        uuid not null references entity(id),
  customer_id      uuid primary key references customer(id),
  house_account    boolean not null default false,       -- may charge purchases to the account
  late_fees        boolean not null default true,
  statement_via    text not null default 'email' check (statement_via in ('email','mail','none')),
  collector_id     uuid references app_user(id),
  opened_by        uuid references app_user(id),
  opened_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index ar_account_entity on ar_account (entity_id);

create table ar_note (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  customer_id uuid not null references customer(id),
  body        text not null check (length(trim(body)) > 0),
  author_id   uuid references app_user(id),
  created_at  timestamptz not null default now()
);
create index ar_note_customer on ar_note (entity_id, customer_id, created_at desc);

-- A charge past the limit, or on an account on hold, needs an owner or
-- controller to say yes, with a reason, for one order and up to an amount.
create table ar_credit_override (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  customer_id    uuid not null references customer(id),
  sales_order_id uuid references sales_order(id),
  up_to_minor    bigint not null check (up_to_minor > 0),
  reason         text not null check (length(trim(reason)) >= 5),
  approved_by    uuid not null references app_user(id),
  created_at     timestamptz not null default now(),
  used_at        timestamptz,
  used_on_invoice_id uuid
);
create index ar_credit_override_open on ar_credit_override (entity_id, customer_id) where used_at is null;

-- --------------------------------------------------------- invoices --

create table customer_invoice (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references entity(id),
  number             text not null,
  kind               text not null default 'sale' check (kind in ('sale','late_fee','credit_memo')),
  customer_id        uuid references customer(id),           -- null only for a cash-and-carry sale
  sales_order_id     uuid references sales_order(id),
  location_id        uuid references location(id),
  journal_entry_id   uuid references journal_entry(id),
  invoice_date       date not null default current_date,
  due_date           date not null default current_date,
  subtotal_minor     bigint not null default 0,              -- revenue, after line discounts
  tax_minor          bigint not null default 0,
  total_minor        bigint not null default 0,              -- subtotal + tax
  deposit_applied_minor bigint not null default 0,           -- taken from deposits on hand (2300)
  charged_minor      bigint not null default 0,              -- what went to A/R (1100): total - deposits
  cost_minor         bigint not null default 0,
  status             text not null default 'open' check (status in ('open','paid','written_off','void')),
  memo               text,
  created_by         uuid references app_user(id),
  created_at         timestamptz not null default now(),
  unique (entity_id, number),
  check (total_minor = subtotal_minor + tax_minor),
  check (charged_minor = total_minor - deposit_applied_minor)
);
create index customer_invoice_customer on customer_invoice (entity_id, customer_id, invoice_date);
create index customer_invoice_order on customer_invoice (entity_id, sales_order_id);

create table customer_invoice_line (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  invoice_id          uuid not null references customer_invoice(id),
  sales_order_line_id uuid references sales_order_line(id),
  seq                 smallint not null,
  sku                 text,
  description         text not null,
  qty                 numeric(10,2) not null,
  unit_price_minor    bigint not null,
  discount_minor      bigint not null default 0,
  net_minor           bigint not null,
  tax_minor           bigint not null default 0,
  revenue_code        text not null,
  unique (invoice_id, seq)
);
-- A line handed over is invoiced once. A second call for the same line is refused.
create unique index customer_invoice_line_once on customer_invoice_line (sales_order_line_id)
  where sales_order_line_id is not null;

create or replace function customer_invoice_rules() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'invoices are never deleted; credit them instead';
  end if;
  if new.total_minor <> old.total_minor or new.charged_minor <> old.charged_minor
     or new.deposit_applied_minor <> old.deposit_applied_minor
     or new.customer_id is distinct from old.customer_id then
    raise exception 'an invoice''s amounts and customer cannot change; issue a credit memo';
  end if;
  return new;
end $$;
create trigger customer_invoice_rules before update or delete on customer_invoice
  for each row execute function customer_invoice_rules();

create or replace function no_change_rows() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are never changed or deleted; post a correcting row', tg_table_name;
end $$;
create trigger customer_invoice_line_frozen before update or delete on customer_invoice_line
  for each row execute function no_change_rows();

-- ------------------------------------------------- installment contracts --

create table ar_contract (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  number           text not null,
  customer_id      uuid not null references customer(id),
  invoice_id       uuid references customer_invoice(id),     -- the balance financed
  location_id      uuid references location(id),
  principal_minor  bigint not null check (principal_minor > 0),
  apr_bps          integer not null check (apr_bps between 0 and 9999),
  term_months      smallint not null check (term_months between 1 and 120),
  payment_minor    bigint not null check (payment_minor > 0),
  first_due_on     date not null,
  version          smallint not null default 1,
  status           text not null default 'active'
                     check (status in ('active','paid_off','defaulted','charged_off')),
  opened_by        uuid references app_user(id),
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  unique (entity_id, number)
);
create index ar_contract_customer on ar_contract (entity_id, customer_id);

create table ar_contract_installment (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  contract_id         uuid not null references ar_contract(id),
  version             smallint not null,
  seq                 smallint not null,
  due_on              date not null,
  payment_minor       bigint not null check (payment_minor >= 0),
  principal_minor     bigint not null check (principal_minor >= 0),
  interest_minor      bigint not null check (interest_minor >= 0),
  paid_principal_minor bigint not null default 0 check (paid_principal_minor >= 0),
  paid_interest_minor  bigint not null default 0 check (paid_interest_minor >= 0),
  status              text not null default 'due' check (status in ('due','paid','superseded')),
  unique (contract_id, version, seq),
  check (payment_minor = principal_minor + interest_minor),
  check (paid_principal_minor <= principal_minor and paid_interest_minor <= interest_minor)
);
create index ar_contract_installment_due on ar_contract_installment (entity_id, contract_id, status, due_on);

create table ar_contract_event (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  contract_id uuid not null references ar_contract(id),
  kind        text not null check (kind in ('opened','payment','payoff','deferred','extended','refinanced',
                                             'defaulted','charged_off','reinstated')),
  detail      jsonb not null default '{}'::jsonb,
  reason      text,
  by_id       uuid references app_user(id),
  at          timestamptz not null default now()
);
create index ar_contract_event_contract on ar_contract_event (contract_id, at);

-- Goods taken back on a defaulted contract. A record, not an accounting event.
create table ar_repossession (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  contract_id   uuid not null references ar_contract(id),
  status        text not null default 'requested'
                  check (status in ('requested','scheduled','recovered','not_recovered','closed')),
  items         text not null,
  scheduled_on  date,
  recovered_on  date,
  condition     text,
  notes         text,
  recorded_by   uuid references app_user(id),
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index ar_repossession_contract on ar_repossession (entity_id, contract_id);

-- -------------------------------------------------- payments on account --
-- A customer_receipt taken against the account rather than an order. It
-- posts to 1100 (and 2320 for any overpayment kept as store credit), not to
-- 2300 the way a deposit does.

create table ar_payment (
  receipt_id        uuid primary key references customer_receipt(id),
  entity_id         uuid not null references entity(id),
  customer_id       uuid not null references customer(id),
  to_account_minor  bigint not null check (to_account_minor >= 0),    -- applied + left unapplied (1100)
  to_credit_minor   bigint not null default 0 check (to_credit_minor >= 0), -- kept as store credit (2320)
  contract_id       uuid references ar_contract(id),
  interest_minor    bigint not null default 0 check (interest_minor >= 0),  -- contract interest (4020)
  journal_entry_id  uuid references journal_entry(id),
  created_at        timestamptz not null default now()
);
create index ar_payment_customer on ar_payment (entity_id, customer_id);

-- --------------------------------------------------------- the A/R ledger --

create table ar_ledger (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  customer_id      uuid references customer(id),
  invoice_id       uuid references customer_invoice(id),
  contract_id      uuid references ar_contract(id),
  receipt_id       uuid references customer_receipt(id),
  location_id      uuid references location(id),
  occurred_on      date not null default current_date,
  kind             text not null check (kind in ('invoice','late_fee','credit_memo','payment','unapplied','apply',
                                                 'to_store_credit','writeoff','recovery','contract')),
  amount_minor     bigint not null check (amount_minor <> 0),   -- + the customer owes more, - less
  memo             text,
  journal_entry_id uuid references journal_entry(id),           -- null for moves inside 1100 (apply, contract)
  created_by       uuid references app_user(id),
  created_at       timestamptz not null default now(),
  check (not (invoice_id is not null and contract_id is not null))
);
create index ar_ledger_customer on ar_ledger (entity_id, customer_id, occurred_on);
create index ar_ledger_invoice on ar_ledger (invoice_id);
create index ar_ledger_contract on ar_ledger (contract_id);
create trigger ar_ledger_frozen before update or delete on ar_ledger
  for each row execute function no_change_rows();

-- ----------------------------------------------------------- store credit --

create table store_credit_ledger (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  customer_id      uuid not null references customer(id),
  amount_minor     bigint not null check (amount_minor <> 0),    -- + issued; redemptions are store_credit receipts
  source           text not null check (source in ('overpayment','credit_balance','adjustment')),
  receipt_id       uuid references customer_receipt(id),
  journal_entry_id uuid references journal_entry(id),
  reason           text,
  created_by       uuid references app_user(id),
  created_at       timestamptz not null default now()
);
create index store_credit_customer on store_credit_ledger (entity_id, customer_id);
create trigger store_credit_ledger_frozen before update or delete on store_credit_ledger
  for each row execute function no_change_rows();

-- -------------------------------------------------------------- late fees --

create table ar_late_fee (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  invoice_id      uuid not null references customer_invoice(id),   -- the overdue invoice
  fee_invoice_id  uuid not null references customer_invoice(id),
  assessed_for    char(7) not null,                                -- 'YYYY-MM': once a month per invoice
  overdue_minor   bigint not null,
  fee_minor       bigint not null check (fee_minor > 0),
  created_at      timestamptz not null default now(),
  unique (invoice_id, assessed_for)
);

-- ---------------------------------------------------------- collections --

create table ar_collection_action (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  customer_id  uuid not null references customer(id),
  kind         text not null check (kind in ('call','visit','letter','sms','email','note')),
  outcome      text check (outcome in ('no_answer','left_message','promised','refused','disputed',
                                       'wrong_number','paid','callback','sent','other')),
  notes        text,
  callback_at  timestamptz,
  by_id        uuid references app_user(id),
  at           timestamptz not null default now()
);
create index ar_collection_action_customer on ar_collection_action (entity_id, customer_id, at desc);

create table ar_promise (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  customer_id    uuid not null references customer(id),
  promised_on    date not null,
  amount_minor   bigint not null check (amount_minor > 0),
  status         text not null default 'open' check (status in ('open','kept','broken','cancelled')),
  action_id      uuid references ar_collection_action(id),
  balance_at_promise_minor bigint not null,
  created_by     uuid references app_user(id),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);
create index ar_promise_open on ar_promise (entity_id, status, promised_on);

create table ar_template (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  code       text not null,
  channel    text not null check (channel in ('letter','sms','email')),
  name       text not null,
  subject    text,
  body       text not null,       -- {{name}} {{balance}} {{past_due}} {{days}} {{company}} {{number}}
  active     boolean not null default true,
  unique (entity_id, code)
);

-- What was sent. The provider is a seam: today it records "sent" and sends nothing.
create table ar_message (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  customer_id  uuid not null references customer(id),
  template_id  uuid references ar_template(id),
  channel      text not null check (channel in ('letter','sms','email')),
  to_address   text,
  subject      text,
  body         text not null,
  provider     text not null,
  provider_ref text,
  status       text not null default 'sent' check (status in ('sent','failed')),
  sent_by      uuid references app_user(id),
  sent_at      timestamptz not null default now()
);
create index ar_message_customer on ar_message (entity_id, customer_id, sent_at desc);

-- ------------------------------------------------------------ write-offs --

create table ar_writeoff (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  customer_id     uuid not null references customer(id),
  invoice_id      uuid references customer_invoice(id),
  contract_id     uuid references ar_contract(id),
  amount_minor    bigint not null check (amount_minor > 0),
  method          text not null check (method in ('allowance','direct')),   -- Dr 1190 or Dr 6900
  reason          text not null check (length(trim(reason)) >= 5),
  status          text not null default 'pending' check (status in ('pending','posted','rejected')),
  requested_by    uuid not null references app_user(id),
  requested_at    timestamptz not null default now(),
  decided_by      uuid references app_user(id),
  decided_at      timestamptz,
  decision_note   text,
  journal_entry_id uuid references journal_entry(id),
  recovered_minor bigint not null default 0 check (recovered_minor >= 0),
  check ((invoice_id is null) <> (contract_id is null)),
  -- the maker is never the checker
  check (decided_by is null or decided_by <> requested_by),
  check (recovered_minor <= amount_minor)
);
create index ar_writeoff_scope on ar_writeoff (entity_id, status);

create table ar_recovery (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  writeoff_id      uuid not null references ar_writeoff(id),
  receipt_id       uuid not null references customer_receipt(id),
  amount_minor     bigint not null check (amount_minor > 0),
  journal_entry_id uuid references journal_entry(id),
  by_id            uuid references app_user(id),
  at               timestamptz not null default now()
);

-- ---------------------------------------------- third-party finance --

create table finance_company (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  name         text not null,
  vendor_id    uuid references vendor(id),
  cascade_rank smallint not null default 1 check (cascade_rank between 1 and 20),   -- who is asked first
  default_fee_bps integer not null default 0 check (default_fee_bps between 0 and 5000),
  apply_url    text,                     -- the lender's application link, shown to staff and on the web
  status       text not null default 'active' check (status in ('active','inactive')),
  unique (entity_id, name)
);

create table finance_plan (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  company_id   uuid not null references finance_company(id),
  code         text not null,
  name         text not null,
  promo_months smallint not null default 0 check (promo_months between 0 and 120),
  customer_apr_bps integer check (customer_apr_bps between 0 and 9999),   -- what the customer is told
  fee_bps      integer not null check (fee_bps between 0 and 5000),         -- what the lender keeps
  min_amount_minor bigint not null default 0 check (min_amount_minor >= 0),
  max_amount_minor bigint check (max_amount_minor is null or max_amount_minor > 0),
  active       boolean not null default true,
  unique (company_id, code)
);

-- A lender's answer for one order. Declines move the cascade to the next lender.
create table finance_application (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  sales_order_id uuid references sales_order(id),
  customer_id    uuid not null references customer(id),
  company_id     uuid not null references finance_company(id),
  plan_id        uuid references finance_plan(id),
  requested_minor bigint not null check (requested_minor > 0),
  approved_minor bigint check (approved_minor is null or approved_minor >= 0),
  decision       text not null check (decision in ('approved','declined','pending')),
  reference      text,
  by_id          uuid references app_user(id),
  at             timestamptz not null default now()
);
create index finance_application_order on finance_application (entity_id, sales_order_id);

create table finance_settlement (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references entity(id),
  company_id         uuid not null references finance_company(id),
  reference          text not null,
  funded_on          date not null,
  gross_minor        bigint not null check (gross_minor > 0),      -- the sales in the batch
  expected_fee_minor bigint not null check (expected_fee_minor >= 0),
  funded_minor       bigint not null check (funded_minor > 0),     -- what the lender actually sent
  fee_minor          bigint not null check (fee_minor >= 0),       -- gross - funded, posted to 6910
  journal_entry_id   uuid references journal_entry(id),
  created_by         uuid references app_user(id),
  created_at         timestamptz not null default now(),
  unique (entity_id, company_id, reference),
  check (fee_minor = gross_minor - funded_minor)
);

-- A sale paid with a 'financing' receipt (which posts Dr 1110) and the lender owing it.
create table financed_sale (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references entity(id),
  receipt_id         uuid not null unique references customer_receipt(id),
  company_id         uuid not null references finance_company(id),
  plan_id            uuid references finance_plan(id),
  customer_id        uuid references customer(id),
  sales_order_id     uuid references sales_order(id),
  amount_minor       bigint not null check (amount_minor > 0),
  fee_bps            integer not null,
  expected_fee_minor bigint not null,
  status             text not null default 'awaiting_funding' check (status in ('awaiting_funding','funded')),
  settlement_id      uuid references finance_settlement(id),
  created_at         timestamptz not null default now()
);
create index financed_sale_open on financed_sale (entity_id, company_id, status);
