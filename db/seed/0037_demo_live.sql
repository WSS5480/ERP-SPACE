-- The demo is a trading business that has gone live (0066): ERP setup's
-- setup approvals never apply to it. Runs again on every Reset demo, which
-- removes the demo's go-live rows with the rest of its rows. Demo tenants only.
insert into company_go_live (tenant_id, entity_id, by_label, kind)
select e.tenant_id, e.id, 'demo (a trading business)', 'demo' from entity e join tenant t on t.id = e.tenant_id
 where t.kind = 'demo'
   and e.tenant_id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d')
on conflict (entity_id) do nothing;
