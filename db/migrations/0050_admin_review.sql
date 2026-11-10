-- 0050_admin_review.sql
-- Review fixes for the admin layer (0049).
--   1. the outbox: a message can be 'sending' (claimed by the sender after
--      commit), with when it was claimed and how many tries it has had
--   2. no existing company loses a screen: one that saw Group or Store orders
--      before 0049 (or has inter-company or store-order records) keeps the
--      "several stores" layout, so the single-store rule hides nothing it had

-- ------------------------------------------------------------- 1. outbox
alter table outbound_message drop constraint outbound_message_status_check;
alter table outbound_message add constraint outbound_message_status_check
  check (status in ('queued','sending','sent','failed','logged'));
alter table outbound_message add column claimed_at timestamptz;
alter table outbound_message add column attempts integer not null default 0 check (attempts >= 0);
create index outbound_message_due on outbound_message (created_at) where status in ('queued','sending');

-- ------------------------------------------- 2. keep what companies saw
-- Called here for every company that exists now, and callable again (the
-- checks run it); a company that already has a layout choice is left alone.
create or replace function admin_keep_layout() returns integer
language plpgsql as $$
declare n integer;
begin
  with e as (
    select e.id,
           (select count(*) from entity x where x.tenant_id = e.tenant_id and x.status <> 'closed') companies,
           (select count(*) from location l where l.entity_id = e.id and l.status = 'active' and l.kind not in ('web','office')) locations,
           not exists (select 1 from entity_module m where m.entity_id = e.id) all_on,
           exists (select 1 from entity_module m where m.entity_id = e.id and m.module = 'group' and m.enabled) group_on,
           exists (select 1 from entity_module m where m.entity_id = e.id and m.module = 'edi' and m.enabled) edi_on,
           exists (select 1 from ic_document d where d.from_entity_id = e.id or d.to_entity_id = e.id) ic_data,
           exists (select 1 from store_order s where s.entity_id = e.id) so_data
      from entity e where e.status <> 'closed'
  ), keep as (
    select id from e
     where (companies <= 1 and (all_on or group_on or ic_data))
        or (locations <= 1 and (all_on or edi_on or so_data))
  ), ins as (
    insert into entity_setting (entity_id, key, value, set_by, from_pack)
    select id, 'admin.layout', '"multi"'::jsonb, 'migration 0050 (kept what this company saw before)', false from keep
    on conflict (entity_id, key) do nothing
    returning entity_id
  )
  select count(*) into n from ins;
  return n;
end $$;

select admin_keep_layout();
