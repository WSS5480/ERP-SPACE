-- 0099_inventory_opening.sql
-- PLACEHOLDER. Runs after every module's demo seed: stock other seeds added
-- after 0013 (the web store's items, for one) comes onto the books at cost the
-- same way 0013 brought on the rest.

begin;

-- Opening inventory at cost: every product with stock and no cost pool yet
-- gets one (at the catalog cost), and the ledger gets the same value, so the
-- warehouse tie-out (stock at cost = GL 1300 + 1310) holds from the start.
do $$
declare
  ent constant uuid := '22222222-2222-2222-2222-222222222222';
  ten constant uuid := '11111111-1111-1111-1111-111111111111';
  je uuid; tot bigint; n int := 1; r record;
begin
  create temp table opening_stock on commit drop as
    select s.product_id, s.location_id, s.on_hand, round(s.on_hand * p.cost_minor)::bigint value_minor
      from stock_level s join product p on p.id = s.product_id
     where s.entity_id = ent and s.on_hand <> 0
       and not exists (select 1 from inv_cost ic where ic.entity_id = ent and ic.product_id = s.product_id);
  insert into inv_cost (entity_id, product_id, qty, value_minor)
    select ent, product_id, sum(on_hand), sum(value_minor) from opening_stock group by product_id;
  select coalesce(sum(value_minor), 0) into tot from opening_stock;
  if tot <> 0 then
    insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description, actor_kind)
    values (ten, ent, (select id from fiscal_period where entity_id = ent and current_date between starts_on and ends_on),
            current_date, 'opening', 'Opening inventory at cost', 'system') returning id into je;
    for r in select o.location_id, sum(o.value_minor) v from opening_stock o group by o.location_id having sum(o.value_minor) <> 0 loop
      insert into journal_line (journal_entry_id, seq, gl_account_id, profit_object_id, debit_minor, memo)
      values (je, n, (select id from gl_account where tenant_id = ten and code = '1300'),
              (select id from profit_object where entity_id = ent and location_id = r.location_id and status = 'active' limit 1), r.v, 'opening stock');
      n := n + 1;
    end loop;
    insert into journal_line (journal_entry_id, seq, gl_account_id, credit_minor, memo)
    values (je, n, (select id from gl_account where tenant_id = ten and code = '3000'), tot, 'opening stock');
  end if;
end $$;

commit;
