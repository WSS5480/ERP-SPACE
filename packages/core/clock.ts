// The business date: what day it is at the store, not in UTC.
//
// A sale rung up at 7:30 pm in a Central-time store on the 31st is the 31st's
// sale, although UTC has already moved on to the 1st. Every business date --
// postings, documents, due dates, aging, a report's "as of" -- comes from
// today(c, scope or entity, location?). Timestamps (created_at, sent_at, a
// punch's instant) stay UTC.
//
// The zone is the store's own (location.time_zone), else the company's
// (entity.time_zone), with the time clock's and delivery settings' zones and
// the state as fallbacks: the database function business_tz() says the order,
// so SQL (business_today()) and code agree.
//
// Checks may pin the clock (pinClock): db.tx then sets erp.now for the
// transaction, so erp_now() and business_today() in SQL see the same instant.

import type { Client, Scope } from "./db.ts";

let pinned: number | null = null;

/** Pin the clock to an instant (checks only); null lets it run again. */
export function pinClock(at: Date | string | null): void {
  pinned = at === null ? null : new Date(at).getTime();
  if (pinned !== null && Number.isNaN(pinned)) throw new Error("pinClock needs a valid instant");
}
/** The pinned instant as ISO text, or null when the clock runs. */
export const pinnedIso = (): string | null => (pinned === null ? null : new Date(pinned).toISOString());
/** Now: the real clock, or the pinned one. */
export const now = (): Date => new Date(pinned ?? Date.now());

const FMT = new Map<string, Intl.DateTimeFormat>();
/** The calendar day (YYYY-MM-DD) at this instant in this zone. */
export function localDay(tz: string, at: Date = now()): string {
  let f = FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    FMT.set(tz, f);
  }
  return f.format(at);
}

/** The hour (0-23) at this instant in this zone. */
export function localHour(tz: string, at: Date = now()): number {
  return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(at));
}

/** Is this an IANA zone name the runtime knows (America/Chicago)? */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** The zone most of each state keeps: all 50 states and DC (the same list as state_time_zone() in SQL). */
export const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles",
  CO: "America/Denver", CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago",
  OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York", WI: "America/Chicago",
  WY: "America/Denver",
};
/** When nothing at all is set. */
export const DEFAULT_TZ = "America/New_York";
export const tzForState = (st: string | null | undefined): string | null => STATE_TZ[String(st ?? "").trim().toUpperCase()] ?? null;

const entityOf = (s: Scope | string) => (typeof s === "string" ? s : s.entityId);

/** The business time zone of a company, or of one of its stores. */
export async function timeZoneFor(c: Client, scopeOrEntity: Scope | string, locationId?: string | null): Promise<string> {
  const r = await c.query<{ tz: string }>(`select business_tz($1::uuid, $2::uuid) tz /* unscoped: keyed by the entity argument */`,
    [entityOf(scopeOrEntity), locationId ?? null]);
  return r.rows[0]?.tz || DEFAULT_TZ;
}

/** Today's business date (YYYY-MM-DD) for a company, or one of its stores. */
export async function today(c: Client, scopeOrEntity: Scope | string, locationId?: string | null): Promise<string> {
  return localDay(await timeZoneFor(c, scopeOrEntity, locationId));
}

/** The first of this month, at the company or store. */
export async function monthStart(c: Client, scopeOrEntity: Scope | string, locationId?: string | null): Promise<string> {
  return (await today(c, scopeOrEntity, locationId)).slice(0, 8) + "01";
}

/** Day arithmetic on YYYY-MM-DD, calendar days, no zones involved. */
export function addDays(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
