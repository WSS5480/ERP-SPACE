-- 0029_cfg_review.sql
-- PLACEHOLDER. The Hudson sectional and its pieces are upholstery: matched by dye lot (configurator review).
begin;
update product set lot_class = 'dye_lot'
 where entity_id = '22222222-2222-2222-2222-222222222222' and lot_class is null
   and (id = 'c0c00000-0000-0000-0000-000000000001'
        or id in (select product_id from sectional_piece where entity_id = '22222222-2222-2222-2222-222222222222'));
commit;
