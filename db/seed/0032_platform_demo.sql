-- 0032_platform_demo.sql
-- The placeholder tenants are the demo (migration 0051 marks them on a
-- database that was seeded before it ran; this marks them on a fresh one).
-- The Operator console's "Reset demo" reloads every seed file into these
-- tenants only.

begin;

update tenant set kind = 'demo', plan = 'demo'
 where id in ('11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d');

commit;
