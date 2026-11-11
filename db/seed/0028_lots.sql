-- Serials and lots, labels and finance settlements: demo data.
-- The placeholder clients' charts get the two settlement accounts (the
-- migration gives them to clients that existed before it ran), the demo
-- furniture's upholstery and case goods say how their lots are matched, and
-- the placeholder lender gets a settlement file layout.
do $$
declare t record; acct record; cur text;
begin
  -- demo tenants only: this file also runs when an operator resets the demo
  for t in select id from tenant where exists (select 1 from gl_account g where g.tenant_id = tenant.id and g.code = '1110')
             and id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d') loop
    for acct in select * from (values ('1115', 'Finance company holdbacks receivable', 'asset', 'D'),
                                      ('6915', 'Finance company chargebacks', 'expense', 'D'),
                                      ('2195', 'Unapplied finance deposits', 'liability', 'C')) v(code, name, typ, nb) loop
      select account_type into cur from gl_account where tenant_id = t.id and code = acct.code;
      if cur is null then
        insert into gl_account (tenant_id, code, name, account_type, normal_balance) values (t.id, acct.code, acct.name, acct.typ, acct.nb);
      end if;
      insert into entity_gl_account (entity_id, gl_account_id)
      select e.id, g.id from entity e join gl_account g on g.tenant_id = e.tenant_id and g.code = acct.code where e.tenant_id = t.id
      on conflict do nothing;
    end loop;
  end loop;
end $$;

-- Darcy (upholstery) by dye lot, Willowton (case goods) by finish batch.
update product set lot_class = 'dye_lot'
 where entity_id = '22222222-2222-2222-2222-222222222222' and sku in ('ASH-2930338', 'ASH-2930335');
update product set lot_class = 'finish_batch'
 where entity_id = '22222222-2222-2222-2222-222222222222' and sku in ('ASH-B192-31', 'ASH-B192-QBED');

update finance_company set remit_mapping = '{"date":"Funding Date","auth":"Auth Code","account":"Account","gross":"Sale Amount","fee":"Discount","holdback":"Holdback","net":"Net","kind":"Type","reason":"Reason","plan":"Plan","dateFormat":"MM/DD/YYYY"}'
 where entity_id = '22222222-2222-2222-2222-222222222222' and id = 'abab0000-0000-0000-0000-000000000002';
