-- 0035_group.sql
-- Group accounting: a client (tenant) that runs several companies (entities)
-- under one owner. Consolidated statements, sibling customer and vendor
-- links, inter-company documents in matching pairs, and the net-to-zero
-- check with a settle action.
--
-- Rules the database holds:
--   1. every movement in Due from related companies (1195) and Due to related
--      companies (2190) made by the group module is one ic_ledger row, naming
--      the company on the other side, in the same transaction as its journal
--      entry -- so a pair's balances are sums of that table and tie to the GL
--   2. ic_ledger and settlements are history: never edited, never deleted
--   3. an inter-company document names two different companies of one client
--   4. a sibling link is one customer per (company, sibling) and one vendor per sibling
-- Money is bigint minor units.

-- ------------------------------------------------------------- module --
-- Added to whatever the check already allows, so other modules' additions survive.
do $$
declare d text;
begin
  select pg_get_constraintdef(oid) into d from pg_constraint where conname = 'entity_module_module_check';
  if d is not null and d not like '%''group''%' then
    execute 'alter table entity_module drop constraint entity_module_module_check';
    execute 'alter table entity_module add constraint entity_module_module_check '
      || replace(d, 'ARRAY[', 'ARRAY[''group''::text, ');
  end if;
end $$;

-- Companies that already chose their modules get group accounting (it shows only with a sibling).
insert into entity_module (entity_id, module, enabled, changed_by)
select distinct entity_id, 'group', true, 'migration 0035' from entity_module
on conflict do nothing;

-- ------------------------------------------------------- the accounts --
-- Every client that has a chart gets the four inter-company accounts, used by each of its companies.
insert into gl_account (tenant_id, code, name, account_type, normal_balance)
select t.id, a.code, a.name, a.type, a.nb
  from tenant t
  cross join (values ('1195', 'Due from related companies', 'asset', 'D'),
                     ('2190', 'Due to related companies', 'liability', 'C'),
                     ('4090', 'Inter-company sales', 'revenue', 'C'),
                     ('5090', 'Inter-company cost of sales', 'expense', 'D')) a(code, name, type, nb)
 where exists (select 1 from gl_account g where g.tenant_id = t.id)
on conflict (tenant_id, code) do nothing;
insert into entity_gl_account (entity_id, gl_account_id)
select e.id, g.id from entity e join gl_account g on g.tenant_id = e.tenant_id
 where g.code in ('1195','2190','4090','5090')
on conflict do nothing;

-- ------------------------------------------------------ sibling links --
alter table customer add column related_entity_id uuid references entity(id);
create unique index customer_related_entity on customer (entity_id, related_entity_id) where related_entity_id is not null;
alter table customer add constraint customer_not_itself check (related_entity_id is distinct from entity_id);

alter table vendor add column related_entity_id uuid references entity(id);
create unique index vendor_related_entity on vendor (tenant_id, related_entity_id) where related_entity_id is not null;

-- ----------------------------------------------------------- settings --
create table group_setting (
  tenant_id       uuid primary key references tenant(id),
  transfer_basis  text not null default 'cost' check (transfer_basis in ('cost','cost_plus')),
  markup_bps      integer not null default 0 check (markup_bps between 0 and 10000),
  updated_by      uuid references app_user(id),
  updated_at      timestamptz not null default now(),
  check (transfer_basis = 'cost_plus' or markup_bps = 0)
);

-- ----------------------------------------------------- the documents --
-- One row per matching pair: the sales invoice in the company that sold or
-- billed, the bill in the company that bought or was billed.
create table ic_document (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  number              text not null,
  kind                text not null check (kind in ('goods','service')),
  from_entity_id      uuid not null references entity(id),     -- sells / bills
  to_entity_id        uuid not null references entity(id),     -- buys / is billed
  description         text not null,
  amount_minor        bigint not null check (amount_minor > 0), -- at transfer price
  cost_minor          bigint not null default 0 check (cost_minor >= 0),
  basis               text not null default 'cost' check (basis in ('cost','cost_plus','agreed')),
  markup_bps          integer not null default 0,
  transfer_id         uuid references inv_transfer(id),        -- the sender's transfer
  to_transfer_id      uuid references inv_transfer(id),        -- the receiver's copy
  customer_invoice_id uuid references customer_invoice(id),
  invoice_id          uuid references invoice(id),
  from_entry_id       uuid references journal_entry(id),
  to_entry_id         uuid references journal_entry(id),
  status              text not null default 'open' check (status in ('open','settled')),
  settlement_id       uuid,
  doc_date            date not null default current_date,
  created_by          uuid references app_user(id),
  created_at          timestamptz not null default now(),
  unique (from_entity_id, number),              -- numbered in the selling company
  check (from_entity_id <> to_entity_id)
);
create index ic_document_from on ic_document (from_entity_id, status);
create index ic_document_to on ic_document (to_entity_id, status);

create or replace function ic_document_same_client() returns trigger language plpgsql as $$
begin
  if (select count(*) from entity where id in (new.from_entity_id, new.to_entity_id) and tenant_id = new.tenant_id) <> 2 then
    raise exception 'an inter-company document is between two companies of the same client';
  end if;
  if tg_op = 'UPDATE' and (new.amount_minor <> old.amount_minor or new.from_entity_id <> old.from_entity_id
                           or new.to_entity_id <> old.to_entity_id or new.cost_minor <> old.cost_minor) then
    raise exception 'an inter-company document''s amounts and companies cannot change; settle it or bill a correction';
  end if;
  return new;
end $$;
create trigger ic_document_same_client before insert or update on ic_document
  for each row execute function ic_document_same_client();
create trigger ic_document_never_deleted before delete on ic_document
  for each row execute function no_change_rows();

-- The documents in AR and AP point back to their pair, so payables and
-- receivables can tell them apart (a sibling's bill is settled in Group, not a payment run).
alter table customer_invoice add column ic_document_id uuid references ic_document(id);
alter table invoice add column ic_document_id uuid references ic_document(id);
create index invoice_ic_document on invoice (ic_document_id) where ic_document_id is not null;

-- A transfer to another company of the client.
alter table inv_transfer add column to_entity_id uuid references entity(id);
alter table inv_transfer add column from_entity_id uuid references entity(id);   -- set on the receiver's copy

-- --------------------------------------------------------- settlements --
create table ic_settlement (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  number              text not null,
  payer_entity_id     uuid not null references entity(id),
  payee_entity_id     uuid not null references entity(id),
  amount_minor        bigint not null check (amount_minor >= 0),   -- cash that moved
  payer_difference_minor bigint not null default 0,                -- written off in the payer's books
  payee_difference_minor bigint not null default 0,                -- written off in the payee's books
  reason              text,
  payer_entry_id      uuid references journal_entry(id),
  payee_entry_id      uuid references journal_entry(id),
  settled_on          date not null default current_date,
  created_by          uuid references app_user(id),
  created_at          timestamptz not null default now(),
  unique (payer_entity_id, number),             -- numbered in the paying company
  check (payer_entity_id <> payee_entity_id),
  check ((payer_difference_minor = 0 and payee_difference_minor = 0) or coalesce(trim(reason), '') <> '')
);
create trigger ic_settlement_frozen before update or delete on ic_settlement
  for each row execute function no_change_rows();
alter table ic_document add constraint ic_document_settlement_fk foreign key (settlement_id) references ic_settlement(id);

-- ------------------------------------------------------ the sub-ledger --
-- One row per movement in 1195 / 2190 that the group module posts, signed
-- debit minus credit, naming the company on the other side.
create table ic_ledger (
  id                     bigserial primary key,
  entity_id              uuid not null references entity(id),
  counterparty_entity_id uuid not null references entity(id),
  account_code           text not null check (account_code in ('1195','2190')),
  amount_minor           bigint not null check (amount_minor <> 0),
  occurred_on            date not null,
  kind                   text not null check (kind in ('document','settlement','adjustment')),
  document_id            uuid references ic_document(id),
  settlement_id          uuid references ic_settlement(id),
  journal_entry_id       uuid not null references journal_entry(id),
  memo                   text,
  created_by             uuid references app_user(id),
  created_at             timestamptz not null default now(),
  check (entity_id <> counterparty_entity_id)
);
create index ic_ledger_pair on ic_ledger (entity_id, counterparty_entity_id, occurred_on);
create trigger ic_ledger_frozen before update or delete on ic_ledger
  for each row execute function no_change_rows();
