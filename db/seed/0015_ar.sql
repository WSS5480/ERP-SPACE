-- 0015_ar.sql
-- PLACEHOLDER receivables setup for the furniture demo: the late-fee policy,
-- two house accounts, collections templates, and two finance companies with
-- promotional plans. No balances: invoices, payments and contracts are made
-- by the A/R checks through the same functions a screen uses, so every
-- dollar in 1100 has its journal entry.

begin;

insert into ar_settings (entity_id, late_fee_enabled, late_fee_bps, late_fee_grace_days, late_fee_min_minor, late_fee_max_minor,
                         default_terms_days, writeoff_method, call_after_days)
values ('22222222-2222-2222-2222-222222222222', true, 150, 10, 500, 5000, 30, 'allowance', 1)
on conflict (entity_id) do nothing;

-- Chen Family and Riverside Apartments already carry a credit limit and
-- 30-day terms on the customer record; this makes them house accounts.
insert into ar_account (entity_id, customer_id, house_account, late_fees, statement_via, collector_id) values
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000003', true, true, 'email','55555555-0000-0000-0000-000000000017'),
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000005', true, false, 'mail','55555555-0000-0000-0000-000000000017')
on conflict (customer_id) do nothing;

insert into ar_note (entity_id, customer_id, body, author_id) values
  ('22222222-2222-2222-2222-222222222222','88888888-0000-0000-0000-000000000005',
   'Net 30 per the leasing office. Statements go to the accounts payable mailbox; PO number required on every invoice.',
   '55555555-0000-0000-0000-000000000017');

insert into ar_template (entity_id, code, channel, name, subject, body) values
  ('22222222-2222-2222-2222-222222222222','reminder-sms','sms','Friendly reminder (text)', null,
   'Hi {{name}}, this is {{company}}. Your account has {{past_due}} past due. Reply or call us to set up a payment. Reply STOP to opt out.'),
  ('22222222-2222-2222-2222-222222222222','reminder-email','email','Past-due reminder (email)', 'Your {{company}} account',
   'Dear {{name}},\n\nOur records show {{past_due}} past due on account {{number}}, with a total balance of {{balance}}. If you have already paid, thank you; otherwise please call us so we can help.\n\n{{company}}'),
  ('22222222-2222-2222-2222-222222222222','letter-30','letter','30-day letter', 'Account {{number}} is past due',
   '{{name}}\n\nAccount {{number}} is {{days}} days past due in the amount of {{past_due}}. Please contact our office within ten days to arrange payment.\n\n{{company}}'),
  ('22222222-2222-2222-2222-222222222222','letter-final','letter','Final notice', 'Final notice: account {{number}}',
   '{{name}}\n\nThis is a final notice. Account {{number}} has {{past_due}} past due ({{days}} days). If we do not hear from you, the account may be referred for further collection.\n\n{{company}}')
on conflict (entity_id, code) do nothing;

-- Two lenders, asked in this order. Names are made up.
insert into finance_company (id, entity_id, name, cascade_rank, default_fee_bps, apply_url) values
  ('abab0000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Prime Card Finance (placeholder)', 1, 600, 'https://example.com/apply/prime'),
  ('abab0000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','Second Look Lending (placeholder)', 2, 1200, 'https://example.com/apply/second-look');

insert into finance_plan (entity_id, company_id, code, name, promo_months, customer_apr_bps, fee_bps, min_amount_minor, max_amount_minor) values
  ('22222222-2222-2222-2222-222222222222','abab0000-0000-0000-0000-000000000001','P12','12 months no interest', 12, 2999, 600, 49900, null),
  ('22222222-2222-2222-2222-222222222222','abab0000-0000-0000-0000-000000000001','P24','24 months equal payments', 24, 999, 950, 150000, null),
  ('22222222-2222-2222-2222-222222222222','abab0000-0000-0000-0000-000000000002','L18','18-month lease-to-own', 18, null, 1200, 30000, 500000);

commit;
