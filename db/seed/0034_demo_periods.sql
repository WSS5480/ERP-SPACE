-- The demo keeps three months ahead open (the daily period job does the same for
-- every company; this makes a fresh or reset demo start that way). Demo tenants only.
with x as (
  insert into fiscal_period (entity_id, starts_on, ends_on, status)
  select e.id, d::date, (d + interval '1 month - 1 day')::date, 'open'
    from entity e
    cross join lateral generate_series(
      coalesce((select max(p.starts_on) from fiscal_period p where p.entity_id = e.id) + interval '1 month', date_trunc('month', current_date)),
      date_trunc('month', current_date) + interval '3 months', interval '1 month') d
   where e.tenant_id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d') and e.status = 'active'
     and not exists (select 1 from fiscal_period p where p.entity_id = e.id
                      and daterange(p.starts_on, p.ends_on, '[]') && daterange(d::date, (d + interval '1 month - 1 day')::date, '[]'))
  on conflict (entity_id, starts_on) do nothing
  returning id, entity_id, starts_on, ends_on
)
insert into period_event (entity_id, period_id, kind, starts_on, ends_on, reason, by_label)
select x.entity_id, x.id, 'auto_opened', x.starts_on, x.ends_on, 'demo seed: three months ahead open', 'seed' from x;

-- The demo's clients carry 3900 Retained earnings for the year-end close.
insert into gl_account (tenant_id, code, name, account_type, normal_balance)
select t.id, '3900', 'Retained earnings', 'equity', 'C' from tenant t
 where t.id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d')
   and not exists (select 1 from gl_account g where g.tenant_id = t.id and g.code = '3900');
insert into entity_gl_account (entity_id, gl_account_id)
select e.id, g.id from entity e join gl_account g on g.tenant_id = e.tenant_id and g.code = '3900'
 where e.tenant_id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d')
on conflict do nothing;
