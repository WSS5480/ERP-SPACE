-- The demo is a trading business: its companies do not show the setup
-- checklist on Home (it is still under Setup). This also runs when an operator
-- resets the demo, which removes the demo's dismissals with the rest of its rows.
insert into onboarding_dismissal (entity_id, dismissed_by)
select e.id, 'demo (a trading business)' from entity e
 where e.tenant_id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d')
   and not exists (select 1 from onboarding_dismissal d where d.entity_id = e.id and d.withdrawn_at is null);
