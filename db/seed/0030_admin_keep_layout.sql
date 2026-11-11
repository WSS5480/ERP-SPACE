-- The placeholder companies count as companies that existed before 0049:
-- keep what each one saw (migration 0050, admin_keep_layout), for the demo
-- tenants only -- this file also runs when an operator resets the demo, and
-- must never touch a customer's company.
with e as (
  select e.id,
         (select count(*) from entity x where x.tenant_id = e.tenant_id and x.status <> 'closed') companies,
         (select count(*) from location l where l.entity_id = e.id and l.status = 'active' and l.kind not in ('web','office')) locations,
         not exists (select 1 from entity_module m where m.entity_id = e.id) all_on,
         exists (select 1 from entity_module m where m.entity_id = e.id and m.module = 'group' and m.enabled) group_on,
         exists (select 1 from entity_module m where m.entity_id = e.id and m.module = 'edi' and m.enabled) edi_on,
         exists (select 1 from ic_document d where d.from_entity_id = e.id or d.to_entity_id = e.id) ic_data,
         exists (select 1 from store_order s where s.entity_id = e.id) so_data
    from entity e
   where e.status <> 'closed'
     and e.tenant_id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d')
), keep as (
  select id from e
   where (companies <= 1 and (all_on or group_on or ic_data))
      or (locations <= 1 and (all_on or edi_on or so_data))
)
insert into entity_setting (entity_id, key, value, set_by, from_pack)
select id, 'admin.layout', '"multi"'::jsonb, 'migration 0050 (kept what this company saw before)', false from keep
on conflict (entity_id, key) do nothing;
