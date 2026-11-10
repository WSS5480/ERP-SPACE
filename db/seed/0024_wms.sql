-- 0024_wms.sql
-- PLACEHOLDER. The demo furniture company ships its transfers in two steps
-- (ship, on the road, receive) and keeps goods on the road in their own
-- account, 1310 Inventory in transit, as it always has. A new company
-- starts with one-step transfers and in-transit value left in 1300 until
-- someone changes it under Warehouse, Containers and prep, Settings.

begin;

insert into entity_setting (entity_id, key, value, set_by, from_pack)
select e.id, k.key, k.value, 'seed', false
  from entity e
  cross join (values ('inventory.transfers_two_step', 'true'::jsonb), ('inventory.in_transit_gl', '"1310"'::jsonb)) k(key, value)
 where e.id = '22222222-2222-2222-2222-222222222222'
on conflict (entity_id, key) do nothing;

commit;
