-- The demo never calls a real outside system on its own (live runs with
-- ERP_SEED=placeholder, so the demo tenants exist there, and the scheduler now
-- runs inside the server). For the demo tenants only:
--   vendor feeds run on demand only (no every_hours, no schedule_cron) -- the
--     seeded "Ashley quantities ATP" feed called a real vendor API every 24h;
--   EDI partners are off (edi_enabled false, transport manual);
--   pull connections are paused.
-- The scheduler also skips the demo's feeds, EDI and pulls ("demo: skipped"),
-- and seed 0036 does the same after every demo reset. A person can still run
-- one by hand. Nothing outside the demo changes.

update vendor_feed f set every_hours = null, schedule_cron = null
  from entity e join tenant t on t.id = e.tenant_id
 where f.entity_id = e.id and t.kind = 'demo' and (f.every_hours is not null or f.schedule_cron is not null);

update edi_partner p set edi_enabled = false, transport = 'manual'
  from entity e join tenant t on t.id = e.tenant_id
 where p.entity_id = e.id and t.kind = 'demo' and (p.edi_enabled or p.transport <> 'manual');

update connection c set status = 'paused'
  from tenant t, source_channel sc
 where t.id = c.tenant_id and t.kind = 'demo' and sc.source_code = c.source_code and sc.channel = c.channel
   and sc.mode = 'pull' and c.status = 'active';
