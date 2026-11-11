-- The demo never calls a real outside system on its own: after every demo reset, its vendor
-- feeds run on demand only, its EDI partners are off and its pull connections paused (as
-- migration 0059 did on live). Demo tenants only.
update vendor_feed f set every_hours = null, schedule_cron = null
  from entity e join tenant t on t.id = e.tenant_id
 where f.entity_id = e.id and t.id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d') and (f.every_hours is not null or f.schedule_cron is not null);

update edi_partner p set edi_enabled = false, transport = 'manual'
  from entity e join tenant t on t.id = e.tenant_id
 where p.entity_id = e.id and t.id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d') and (p.edi_enabled or p.transport <> 'manual');

update connection c set status = 'paused'
  from tenant t, source_channel sc
 where t.id = c.tenant_id and t.id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d') and sc.source_code = c.source_code and sc.channel = c.channel
   and sc.mode = 'pull' and c.status = 'active';
