-- 0042_tax_upgrade.sql
-- Upgrading a live company to tax by jurisdiction.
--
-- 1. A store that charges tax but never had its state filled in can't be taxed
--    by jurisdiction. Where every other store of that company is in one state,
--    that is the state; then it gets its single-rate stand-in like the rest.
--    (Any left without a state are refused at the register in plain words, and
--    Business setup now asks for the state.)
-- 2. Tax collected before this upgrade has no per-jurisdiction rows. The day
--    tracking began is kept per company, so a filing that spans the upgrade
--    shows that earlier tax as its own line (file it from the GL) instead of
--    a difference.

update location x set state = s.state /* unscoped: one-time upgrade across companies */
  from (select entity_id, min(upper(coalesce(state, address->>'state'))) state
          from location
         where kind in ('store','outlet') and coalesce(state, address->>'state') ~* '^[A-Z]{2}$'
         group by entity_id
        having count(distinct upper(coalesce(state, address->>'state'))) = 1) s
 where x.entity_id = s.entity_id and x.kind in ('store','outlet') and x.tax_rate_bps > 0
   and coalesce(nullif(trim(x.state), ''), nullif(trim(x.address->>'state'), '')) is null;

select tax_make_standins();

create table tax_tracking_start (
  entity_id  uuid primary key references entity(id),
  since      date not null
);
insert into tax_tracking_start (entity_id, since)
select e.id, current_date from entity e /* unscoped: one row per company */
on conflict do nothing;
