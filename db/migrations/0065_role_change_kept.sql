-- Review of 0063 (Nov 11 2026): a role taken away by changing the grant,
-- not deleting it, is a role taken away too.
--
-- 0063 keeps a role_removal row when a grant is deleted or a person stops
-- being active, so the owner's digest can show a role removed in the 24 hours
-- before a self-approval. The app only ever deletes grants, but a grant
-- changed in place (its role, or the company it is for, moved to a sibling)
-- removes the old role from that company just the same, and was not kept.
-- Kept now, at commit like the others, unless the old grant is back by then.

create or replace function role_grant_changed() returns trigger
language plpgsql as $$
declare u record;
begin
  -- still held as it was (changed back, or re-granted) by commit: not a removal
  if exists (select 1 from role_grant g where g.app_user_id = old.app_user_id and g.role = old.role
              and g.entity_id is not distinct from old.entity_id) then
    return null;
  end if;
  select tenant_id, name into u from app_user where id = old.app_user_id;
  if u.tenant_id is null then
    return null;
  end if;
  insert into role_removal (tenant_id, entity_id, app_user_id, user_name, role, kind, by_label)
  values (u.tenant_id, old.entity_id, old.app_user_id, u.name, old.role, 'grant_removed',
          nullif(current_setting('erp.actor_label', true), ''));
  return null;
end $$;

create constraint trigger role_grant_changed after update of role, entity_id, app_user_id on role_grant
  deferrable initially deferred for each row
  when (old.role is distinct from new.role or old.entity_id is distinct from new.entity_id or old.app_user_id is distinct from new.app_user_id)
  execute function role_grant_changed();
