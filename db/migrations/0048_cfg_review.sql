-- 0048_cfg_review.sql
-- Configurator review fixes (extends 0043 and the trade module's 0044).
--   1. a room project item can be a sectional: it keeps the build (layout or
--      pieces, cover, each piece's options) so the project can be ordered
--   2. sectional pieces are dye-lot classed like their family (see lots, 0045)

alter table room_project_item add column if not exists sectional jsonb;
alter table room_project_item drop constraint if exists room_project_item_sectional_shape;
alter table room_project_item add constraint room_project_item_sectional_shape
  check (sectional is null or jsonb_typeof(sectional) = 'object');
