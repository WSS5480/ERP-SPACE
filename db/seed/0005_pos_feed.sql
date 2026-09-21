-- 0005_pos_feed.sql
-- A week of POS takings at one store, and the bank statement that answers
-- it. Built to exercise every matcher and to leave exactly one question.
--
--   Mon cash    412.60   lands next day, exact
--   Tue card  1,284.00   lands net of 1.9% fees, tolerance
--   Wed cash    268.40  \
--   Thu cash    331.10  /  banked together on Friday, batch
--   plus one credit nobody expected, which stays unmatched

begin;

-- Card fees are a real cost, so they need somewhere to land.
insert into gl_account (tenant_id, code, name, account_type, normal_balance)
values ('11111111-1111-1111-1111-111111111111','6350','Card processing fees','expense','D');

insert into entity_gl_account (entity_id, gl_account_id)
select '22222222-2222-2222-2222-222222222222', id
  from gl_account
 where tenant_id = '11111111-1111-1111-1111-111111111111' and code = '6350';

update bank_account
   set fee_gl_account_id = (select id from gl_account
                             where tenant_id = '11111111-1111-1111-1111-111111111111'
                               and code = '6350'),
       settlement_days = 2
 where account_last4 = '8043';        -- Palestine, the store in this example

-- ------------------------------------------------------------- the feed --

insert into pos_deposit (tenant_id, entity_id, location_id, bank_account_id,
                         business_date, method, amount_minor, expected_on, source_ref)
select '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222222',
       '33333333-0000-0000-0000-000000000002',
       (select id from bank_account where account_last4 = '8043'),
       d.business_date, d.method, d.amount_minor, d.expected_on, d.source_ref
  from (values
    ((date_trunc('month', current_date) + interval '7 days')::date,  'cash',  41260,
     (date_trunc('month', current_date) + interval '8 days')::date,  'POS-PAL-1001'),
    ((date_trunc('month', current_date) + interval '8 days')::date,  'card', 128400,
     (date_trunc('month', current_date) + interval '10 days')::date, 'POS-PAL-1002'),
    ((date_trunc('month', current_date) + interval '9 days')::date,  'cash',  26840,
     (date_trunc('month', current_date) + interval '11 days')::date, 'POS-PAL-1003'),
    ((date_trunc('month', current_date) + interval '10 days')::date, 'cash',  33110,
     (date_trunc('month', current_date) + interval '11 days')::date, 'POS-PAL-1004')
  ) as d(business_date, method, amount_minor, expected_on, source_ref);

-- ---------------------------------------------------------- the statement --

insert into bank_statement (id, bank_account_id, statement_date,
                            opening_balance_minor, closing_balance_minor, source)
values ('ff000000-0000-0000-0000-000000000001',
        (select id from bank_account where account_last4 = '8043'),
        (date_trunc('month', current_date) + interval '12 days')::date,
        0, 227570, 'bai2');

insert into bank_statement_line (bank_statement_id, posted_on, description, amount_minor, external_ref)
values
  ('ff000000-0000-0000-0000-000000000001',
   (date_trunc('month', current_date) + interval '8 days')::date,
   'BRANCH DEPOSIT', 41260, 'DEP-88121'),
  -- 1,284.00 less 1.9% in card fees
  ('ff000000-0000-0000-0000-000000000001',
   (date_trunc('month', current_date) + interval '10 days')::date,
   'CARD SETTLEMENT', 125960, 'SET-40118'),
  -- Wednesday and Thursday banked together
  ('ff000000-0000-0000-0000-000000000001',
   (date_trunc('month', current_date) + interval '11 days')::date,
   'BRANCH DEPOSIT', 59950, 'DEP-88140'),
  -- and one nobody expected
  ('ff000000-0000-0000-0000-000000000001',
   (date_trunc('month', current_date) + interval '11 days')::date,
   'CREDIT ADJUSTMENT', 4000, 'ADJ-0091');

commit;
