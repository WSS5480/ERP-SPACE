-- 0025_ar_integration.sql
-- A/R with every module running together.
--
-- Opening receivables brought over by Setup (opening_receivable, posted
-- Dr 1100 / Cr 3000) become open invoices of kind 'opening', each with its
-- ar_ledger row on the same journal entry, so the aging, statements,
-- payments on account and collections all carry them and the aging still
-- ties to GL 1100. Setup's importer calls ar.adoptOpeningBalances; the
-- backfill below adopts any already imported.

alter table customer_invoice drop constraint customer_invoice_kind_check;
alter table customer_invoice add constraint customer_invoice_kind_check
  check (kind in ('sale','late_fee','credit_memo','opening'));
alter table customer_invoice add column opening_receivable_id uuid unique references opening_receivable(id);

alter table ar_ledger drop constraint ar_ledger_kind_check;
alter table ar_ledger add constraint ar_ledger_kind_check
  check (kind in ('invoice','late_fee','credit_memo','payment','unapplied','apply',
                  'to_store_credit','writeoff','recovery','contract','opening'));

with ins as (
  insert into customer_invoice (entity_id, number, kind, customer_id, journal_entry_id, invoice_date, due_date,
                                subtotal_minor, tax_minor, total_minor, deposit_applied_minor, charged_minor, status, memo,
                                opening_receivable_id, location_id)
  select o.entity_id, o.reference, 'opening', o.customer_id, o.journal_entry_id, o.as_of, coalesce(o.due_on, o.as_of),
         o.amount_minor, 0, o.amount_minor, 0, o.amount_minor, 'open', 'Opening balance from the old system', o.id,
         (select home_location_id from customer cu where cu.id = o.customer_id)
    from opening_receivable o
   where not exists (select 1 from customer_invoice i where i.opening_receivable_id = o.id)
  returning id, entity_id, customer_id, journal_entry_id, invoice_date, charged_minor, location_id, number
)
insert into ar_ledger (entity_id, customer_id, invoice_id, location_id, occurred_on, kind, amount_minor, memo, journal_entry_id)
select entity_id, customer_id, id, location_id, invoice_date, 'opening', charged_minor, 'opening balance ' || number, journal_entry_id from ins;
