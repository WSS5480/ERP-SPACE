-- 0024_wms.sql
-- PLACEHOLDER. Every seeded company is one that "exists today": it ships
-- transfers in two steps (ship, on the road, receive) through 1310
-- Inventory in transit, as migration 0038 sets for real companies. Only a
-- brand-new company made without a pack starts one-step, in 1300.

begin;

insert into entity_setting (entity_id, key, value, set_by, from_pack)
select e.id, k.key, k.value, 'seed', false
  from entity e
  cross join (values ('inventory.transfers_two_step', 'true'::jsonb), ('inventory.in_transit_gl', '"1310"'::jsonb)) k(key, value)
on conflict (entity_id, key) do nothing;

commit;
