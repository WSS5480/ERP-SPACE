-- 0004_store_banks.sql
-- A deposit account per store, at three different banks, alongside the one
-- company operating account plus payroll and tax.
--
-- Deposit-only: money comes in wherever is convenient and sweeps into the
-- single operating account, which is the only place it leaves from.
--
-- All three map to the same cash code. That is deliberate: it is the case
-- that broke the first version of the bank position view, so the seed keeps
-- it as a standing test.

begin;

update bank_account set is_default = true
 where entity_id = '22222222-2222-2222-2222-222222222222'
   and location_id is null
   and purpose in ('operating','payroll','tax');

insert into bank_account (tenant_id, entity_id, location_id, name, purpose, bank_name,
                          routing_last4, account_last4, account_ref, gl_account_id,
                          ach_origination_enabled, positive_pay, debit_block,
                          is_default, opened_on)
values
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '33333333-0000-0000-0000-000000000001','Enola deposits','deposit','First Valley Bank',
   '4021','2210','vault://pentex/enola-deposit',
   (select id from gl_account where tenant_id='11111111-1111-1111-1111-111111111111' and code='1010'),
   false, false, true, true, '2019-04-01'),
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '33333333-0000-0000-0000-000000000002','Palestine deposits','deposit','Pineywoods State Bank',
   '1177','8043','vault://pentex/palestine-deposit',
   (select id from gl_account where tenant_id='11111111-1111-1111-1111-111111111111' and code='1010'),
   false, false, true, true, '2021-06-14'),
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '33333333-0000-0000-0000-000000000003','Socorro deposits','deposit','Rio Commerce Bank',
   '6630','5512','vault://pentex/socorro-deposit',
   (select id from gl_account where tenant_id='11111111-1111-1111-1111-111111111111' and code='1010'),
   false, false, true, true, '2026-02-02');

-- What each bank will actually do for us. This is the whole point: the
-- method is a property of the bank, not a preference.
update bank_account set supports_zba = true
 where account_last4 = '2210';          -- Enola, same bank as operating
update bank_account set allows_ach_debit = true
 where account_last4 = '8043';          -- Palestine, debit authorisation on file
update bank_account set online_transfer_only = true
 where account_last4 = '5512';          -- Socorro, neither: somebody moves it

-- Every branch sweeps to zero into the one operating account, by whichever
-- method that bank supports.
insert into sweep_rule (entity_id, from_bank_account_id, to_bank_account_id,
                        mode, frequency, method, due_days, assigned_to)
select ba.entity_id, ba.id,
       (select o.id from bank_account o
         where o.entity_id = ba.entity_id and o.purpose = 'operating' and o.status = 'active'),
       'zero_balance', 'daily',
       case when ba.supports_zba     then 'bank_zba'
            when ba.allows_ach_debit then 'ach_pull'
            else 'manual' end,
       1,
       case when ba.supports_zba or ba.allows_ach_debit then null::uuid
            else '55555555-0000-0000-0000-000000000002'::uuid end   -- the controller owns the rest
  from bank_account ba
 where ba.entity_id = '22222222-2222-2222-2222-222222222222'
   and ba.purpose = 'deposit';

commit;
