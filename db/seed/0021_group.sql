-- 0021_group.sql
-- PLACEHOLDER. A second company under the demo client, so group accounting
-- (consolidation, sibling links, inter-company documents) has two sets of
-- books to work across: a Texas company with a showroom and a warehouse.
-- It has no products or stock of its own yet; a cross-company transfer
-- brings both. Nothing here is a real record.

begin;

-- The inter-company accounts (the setup packs carry them too).
insert into gl_account (tenant_id, code, name, account_type, normal_balance) values
  ('11111111-1111-1111-1111-111111111111', '1195', 'Due from related companies', 'asset', 'D'),
  ('11111111-1111-1111-1111-111111111111', '2190', 'Due to related companies', 'liability', 'C'),
  ('11111111-1111-1111-1111-111111111111', '4090', 'Inter-company sales', 'revenue', 'C'),
  ('11111111-1111-1111-1111-111111111111', '5090', 'Inter-company cost of sales', 'expense', 'D')
on conflict (tenant_id, code) do nothing;
insert into entity_gl_account (entity_id, gl_account_id)
select '22222222-2222-2222-2222-222222222222', id from gl_account
 where tenant_id = '11111111-1111-1111-1111-111111111111' and code in ('1195','2190','4090','5090')
on conflict do nothing;

insert into entity (id, tenant_id, name, legal_name, fiscal_year_end_month)
values ('a2a2a2a2-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
        'Demo Furniture Texas, LLC', 'Demo Furniture Texas, LLC', 12);

insert into location (id, entity_id, code, name, state, kind, tax_rate_bps, geo, address) values
  ('a2a2a2a2-0000-0000-0000-000000000001', 'a2a2a2a2-2222-2222-2222-222222222222', 'TYL', 'Tyler', 'TX', 'store', 825,
   point(-95.3011, 32.3513), '{"line1":"400 Broadway Ave","city":"Tyler","state":"TX","postal":"75701"}'),
  ('a2a2a2a2-0000-0000-0000-000000000002', 'a2a2a2a2-2222-2222-2222-222222222222', 'TXW', 'Texas warehouse', 'TX', 'warehouse', 0,
   point(-95.4000, 32.3000), '{"line1":"9 Depot Rd","city":"Tyler","state":"TX","postal":"75702"}');

insert into profit_object (entity_id, kind, code, name, location_id) values
  ('a2a2a2a2-2222-2222-2222-222222222222', 'store', 'TYL', 'Tyler', 'a2a2a2a2-0000-0000-0000-000000000001');

-- The client's chart is shared; this company uses all of it.
insert into entity_gl_account (entity_id, gl_account_id)
select 'a2a2a2a2-2222-2222-2222-222222222222', id from gl_account
 where tenant_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

insert into fiscal_period (entity_id, starts_on, ends_on, status)
select 'a2a2a2a2-2222-2222-2222-222222222222', d::date, (d + interval '1 month - 1 day')::date,
       case when d < date_trunc('month', current_date) then 'soft_locked' else 'open' end
  from generate_series(date_trunc('month', current_date) - interval '11 months',
                       date_trunc('month', current_date) + interval '1 month', interval '1 month') d;

insert into bank_account (id, tenant_id, entity_id, name, purpose, bank_name, routing_last4, account_last4, account_ref,
                          gl_account_id, ach_origination_enabled, opened_on)
values ('a2a2a2a2-0000-0000-0000-0000000000b1', '11111111-1111-1111-1111-111111111111', 'a2a2a2a2-2222-2222-2222-222222222222',
        'Operating', 'operating', 'Lone Star Bank', '1130', '4471', 'vault://demo-tx/operating',
        (select id from gl_account where tenant_id = '11111111-1111-1111-1111-111111111111' and code = '1010'), false, '2024-02-01');

-- The controller keeps both companies' books; Tina keeps only the Texas one.
insert into app_user (id, tenant_id, email, name) values
  ('55555555-0000-0000-0000-000000000041', '11111111-1111-1111-1111-111111111111', 'tina.tx@example.com', 'Tina (Texas controller)');
insert into role_grant (app_user_id, entity_id, role) values
  ('55555555-0000-0000-0000-000000000002', 'a2a2a2a2-2222-2222-2222-222222222222', 'controller'),
  ('55555555-0000-0000-0000-000000000041', 'a2a2a2a2-2222-2222-2222-222222222222', 'controller');

-- Opening capital, so the Texas books are not empty.
do $$
declare je uuid;
  ent constant uuid := 'a2a2a2a2-2222-2222-2222-222222222222';
  ten constant uuid := '11111111-1111-1111-1111-111111111111';
begin
  insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description, actor_kind)
  values (ten, ent, (select id from fiscal_period where entity_id = ent and current_date between starts_on and ends_on),
          current_date, 'opening', 'Opening capital', 'system') returning id into je;
  insert into journal_line (journal_entry_id, seq, gl_account_id, bank_account_id, debit_minor, memo)
  values (je, 1, (select id from gl_account where tenant_id = ten and code = '1010'), 'a2a2a2a2-0000-0000-0000-0000000000b1', 5000000, 'owner capital');
  insert into journal_line (journal_entry_id, seq, gl_account_id, credit_minor, memo)
  values (je, 2, (select id from gl_account where tenant_id = ten and code = '3000'), 5000000, 'owner capital');
end $$;

commit;
