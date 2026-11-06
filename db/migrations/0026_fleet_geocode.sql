-- 0026_fleet_geocode.sql
-- Where an address is on the map, and how we know. Seeds wrote geo by hand;
-- new customers get it from the geocoder (US Census by default) when a
-- delivery is booked or a route is built, or from a dispatcher who finds it
-- on a map. An address with no point is never routed -- it is not at 0,0.

alter table customer_address
  add column geo_source text check (geo_source in ('seed','census','manual','other')),
  add column geo_at     timestamptz,                -- when geo was set, or when the last lookup was tried
  add column geo_error  text;                       -- why the last lookup found nothing

update customer_address set geo_source = 'seed', geo_at = now() where geo is not null and geo_source is null;

-- A manual or looked-up point must be a real place on Earth.
alter table customer_address add constraint customer_address_geo_range
  check (geo is null or (geo[0] between -180 and 180 and geo[1] between -90 and 90 and not (geo[0] = 0 and geo[1] = 0)));
