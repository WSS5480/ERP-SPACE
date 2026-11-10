-- Placeholder trade program for the demo furniture company: a TRADE price
-- list priced by rule (living room at cost + 35%, everything else at retail
-- less 20%) and one application waiting for review.
insert into price_list (entity_id, code, name)
select '22222222-2222-2222-2222-222222222222', 'TRADE', 'Trade pricing'
 where exists (select 1 from entity where id = '22222222-2222-2222-2222-222222222222')
on conflict (entity_id, code) do nothing;

insert into price_list_rule (entity_id, price_list_id, category, basis, bps, updated_by)
select l.entity_id, l.id, r.category, r.basis, r.bps, 'seed'
  from price_list l cross join (values ('Living room', 'cost_plus', 3500), (null, 'retail_less', 2000)) r(category, basis, bps)
 where l.entity_id = '22222222-2222-2222-2222-222222222222' and l.code = 'TRADE'
   and not exists (select 1 from price_list_rule x where x.price_list_id = l.id and coalesce(x.category, '') = coalesce(r.category, '') and x.active);

insert into trade_application (entity_id, number, company_name, kind, contact_name, email, phone, resale_number, resale_state, resale_expires, address, notes)
select '22222222-2222-2222-2222-222222222222', 'TA-DEMO-1', 'Susquehanna Interiors', 'designer', 'Morgan Lee', 'morgan@susquehanna-interiors.example',
       '7175550123', 'PA-75-1234567', 'PA', (current_date + 365), '{"line1":"41 Front St","city":"Harrisburg","state":"PA","postal":"17101"}',
       'Residential designer; two to three client projects a quarter.'
 where exists (select 1 from entity where id = '22222222-2222-2222-2222-222222222222')
   and not exists (select 1 from trade_application where entity_id = '22222222-2222-2222-2222-222222222222' and number = 'TA-DEMO-1');
