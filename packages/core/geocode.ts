// Geocoding: an address in, a map point out. One seam, so the provider can
// change without touching routing. The default is the US Census Geocoder --
// free, no key, US addresses only. fetch is injectable (tests have no
// internet), and every call gives up after 8 seconds.
//
// Results are cached on customer_address (geo, geo_source, geo_at). A failed
// lookup is remembered in geo_error, so routing says why a stop has no point
// instead of guessing one. Nothing here ever returns 0,0 for "unknown".

import { q, type Client } from "./db.ts";

export class GeocodeError extends Error {}

export type Hit = { lng: number; lat: number; matched: string };
export type FetchLike = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface Geocoder {
  name: "census" | "other";
  /** a point, or null when the service answered but found no such address; throws when it could not answer */
  locate(oneLine: string): Promise<Hit | null>;
}

export const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

export function censusGeocoder(fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike, timeoutMs = 8000): Geocoder {
  return {
    name: "census",
    async locate(oneLine: string) {
      const url = `${CENSUS_URL}?address=${encodeURIComponent(oneLine)}&benchmark=Public_AR_Current&format=json`;
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => { ac.abort(); rej(new GeocodeError(`the map service did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} second${timeoutMs > 1500 ? "s" : ""}`)); }, timeoutMs);
      });
      try {
        const res = await Promise.race([fetchFn(url, { signal: ac.signal, headers: { accept: "application/json" } }), timeout]);
        if (!res.ok) throw new GeocodeError(`the map service answered ${res.status}`);
        const body = await Promise.race([res.json(), timeout]) as { result?: { addressMatches?: { coordinates?: { x?: number; y?: number }; matchedAddress?: string }[] } };
        const m = body?.result?.addressMatches?.[0];
        if (!m) return null;
        const lng = Number(m.coordinates?.x), lat = Number(m.coordinates?.y);
        if (!Number.isFinite(lng) || !Number.isFinite(lat) || (lng === 0 && lat === 0)) return null;
        return { lng, lat, matched: String(m.matchedAddress ?? oneLine) };
      } catch (e) {
        if (e instanceof GeocodeError) throw e;
        throw new GeocodeError(`the map service could not be reached (${(e as Error).message})`);
      } finally { clearTimeout(timer); }
    },
  };
}

let current: Geocoder = censusGeocoder();
export function setGeocoder(g: Geocoder) { current = g; }
export function geocoder(): Geocoder { return current; }
/** A company's own map provider (Admin, Connections) when it has one; set by messaging.ts. */
let forEntity: ((c: Client, entityId: string) => Promise<Geocoder | null>) | null = null;
export function setGeocoderFor(f: typeof forEntity) { forEntity = f; }

export type GeoResult = { ok: true; lng: number; lat: number; source: string } | { ok: false; reason: string };

/**
 * Find an address's point and cache it. Unless forced, an address that
 * already has a point is left alone, and one that failed in the last day is
 * not looked up again (so a bad address does not cost 8 seconds per build).
 */
export async function geocodeAddress(c: Client, entityId: string, addressId: string, force = false): Promise<GeoResult> {
  const r = await q<{ line1: string; line2: string | null; city: string; state: string; postal: string; lng: number | null; lat: number | null;
    geo_source: string | null; geo_error: string | null; recent: boolean }>(c, `
    select line1, line2, city, state, postal, geo[0] lng, geo[1] lat, geo_source, geo_error, coalesce(geo_at > now() - interval '1 day', false) recent
      from customer_address where entity_id = $1 and id = $2`, [entityId, addressId]);
  if (!r.length) return { ok: false, reason: "no such address" };
  const a = r[0];
  if (!force && a.lng != null) return { ok: true, lng: Number(a.lng), lat: Number(a.lat), source: a.geo_source ?? "seed" };
  if (!force && a.geo_error && a.recent) return { ok: false, reason: a.geo_error };
  const oneLine = `${a.line1}, ${a.city}, ${a.state} ${a.postal}`;
  let hit: Hit | null = null, reason = "";
  let g = current;
  try { g = (forEntity ? await forEntity(c, entityId) : null) ?? current; } catch (e) { reason = (e as Error).message; }
  try { hit = await g.locate(oneLine); if (!hit) reason = "the map service found no such address"; }
  catch (e) { reason = (e as Error).message; }
  if (hit) {
    await c.query(`update customer_address set geo = point($3, $4), geo_source = $5, geo_at = now(), geo_error = null where entity_id = $1 and id = $2`,
      [entityId, addressId, hit.lng, hit.lat, g.name]);
    return { ok: true, lng: hit.lng, lat: hit.lat, source: g.name };
  }
  await c.query(`update customer_address set geo_at = now(), geo_error = $3 where entity_id = $1 and id = $2`, [entityId, addressId, reason.slice(0, 300)]);
  return { ok: false, reason };
}

/** A dispatcher placed it on the map by hand. */
export async function setManualGeo(c: Client, entityId: string, addressId: string, lat: number, lng: number): Promise<void> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
    throw new GeocodeError("give a real latitude and longitude, like 40.2601, -76.9336");
  }
  const r = await q(c, `update customer_address set geo = point($3, $4), geo_source = 'manual', geo_at = now(), geo_error = null
                         where entity_id = $1 and id = $2 returning id`, [entityId, addressId, lng, lat]);
  if (!r.length) throw new GeocodeError("no such address");
}
