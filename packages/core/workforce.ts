// Workforce: the time clock, shift schedules, and sales commissions, all
// feeding the existing payroll.
//
// Time: punches are the record. Each day's hours (ins to outs, less unpaid
// breaks) land on the payroll timecard for that person, pay period and day,
// on the store's profit object. A day still punched in is a timecard in
// 'exception' with a missed_punch exception, so a payroll cannot be built
// over it. A manager fixes a punch by voiding it and entering the right one,
// with a reason; nobody edits their own time.
//
// Commissions: earned when a line is handed over and invoiced (the invoice
// date), never when written. Plans pay a % of the sale or of the gross
// margin, stepped by the month's delivered volume, with category and vendor
// rates and spiffs by SKU or vendor for a date range; a sale split between
// salespeople splits everything. A return or cancel charges back what was
// paid. Accrued Dr 6130 Cr 2160; approved per pay period into payroll as
// earnings, with a draw guaranteed and (if recoverable) paid back out of
// later commission.

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { post, profitObjectFor, type PostLine } from "./posting.ts";
import { format, mulBps } from "./money.ts";

export class WorkforceError extends Error {}
const need = (cond: unknown, msg: string): asserts cond => { if (!cond) throw new WorkforceError(msg); };
const B = (v: string | number | bigint | null | undefined) => BigInt(v ?? 0);
const today = () => new Date().toISOString().slice(0, 10);
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ================================================================= the clock

export type PunchKind = "in" | "out" | "break_start" | "break_end";
const KIND_WORDS: Record<PunchKind, string> = { in: "punch in", out: "punch out", break_start: "start a break", break_end: "end a break" };

/**
 * A time from a form. With a zone (an ISO instant) it is taken as is; a bare
 * "2026-11-06T09:00" from a phone's date and time pickers is read in the
 * store's own time zone, so a manager in another state enters Enola's 9 a.m.
 */
export async function instantAt(c: Client, entityId: string, locationId: string, v: string): Promise<Date> {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) {
    const tz = await timezoneFor(c, entityId, locationId);
    const r = await one<{ t: string }>(c, `select to_char(($1::timestamp at time zone $2) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') t /* unscoped: arithmetic */`, [v, tz]);
    return new Date(r.t);
  }
  return new Date(v);
}

export async function timezoneFor(c: Client, entityId: string, locationId: string): Promise<string> {
  const r = await q<{ tz: string }>(c, `
    select coalesce((select timezone from workforce_location where location_id = $2 and entity_id = $1),
                    (select timezone from workforce_settings where entity_id = $1), 'America/New_York') tz`, [entityId, locationId]);
  return r[0].tz;
}

async function settingsOf(c: Client, entityId: string) {
  const r = await q<{ missed_punch_hours: number; max_shift_hours: number; timezone: string }>(c,
    `select missed_punch_hours, max_shift_hours, timezone from workforce_settings where entity_id = $1`, [entityId]);
  return r[0] ?? { missed_punch_hours: 12, max_shift_hours: 14, timezone: "America/New_York" };
}

export async function employeeOf(c: Client, entityId: string, id: string) {
  const r = await q<{ id: string; app_user_id: string | null; first_name: string; last_name: string; status: string; pay_group_id: string | null;
    pay_type: string; profit_object_id: string | null }>(c,
    `select id, app_user_id, first_name, last_name, status, pay_group_id, pay_type, profit_object_id from employee where id = $1 and entity_id = $2`, [id, entityId]);
  need(r.length, "no such employee");
  return { ...r[0], name: `${r[0].first_name} ${r[0].last_name}` };
}

type P = { id: string; kind: PunchKind; at: string; ms: number };

/**
 * Walk a day's punches in time order. Returns the minutes worked from
 * completed in/out pairs less breaks, whether the day is still open, and
 * the first thing out of order, if any.
 */
export function walkDay(punches: P[]): { minutes: number; open: boolean; problem: string | null; openSince: string | null } {
  let state: "off" | "on" | "break" = "off";
  let inAt = 0, breakAt = 0, breakMin = 0, minutes = 0, openSince: string | null = null;
  for (const p of [...punches].sort((a, b) => a.ms - b.ms)) {
    const t = p.ms;
    if (p.kind === "in") {
      if (state !== "off") return { minutes, open: true, problem: "punched in twice without punching out", openSince };
      state = "on"; inAt = t; breakMin = 0; openSince = p.at;
    } else if (p.kind === "break_start") {
      if (state !== "on") return { minutes, open: state !== "off", problem: state === "off" ? "a break started while not punched in" : "a break started during a break", openSince };
      state = "break"; breakAt = t;
    } else if (p.kind === "break_end") {
      if (state !== "break") return { minutes, open: state !== "off", problem: "a break ended that had not started", openSince };
      state = "on"; breakMin += (t - breakAt) / 60000;
    } else {
      if (state === "off") return { minutes, open: false, problem: "punched out without punching in", openSince };
      if (state === "break") return { minutes, open: true, problem: "punched out during a break; end the break first", openSince };
      minutes += (t - inAt) / 60000 - breakMin;
      state = "off"; openSince = null;
    }
  }
  return { minutes, open: state !== "off", problem: null, openSince };
}

async function dayPunches(c: Client, entityId: string, employeeId: string, day: string): Promise<P[]> {
  return q<P>(c, `select id, kind, at::text at, (extract(epoch from at) * 1000)::float8 ms from time_punch where entity_id = $1 and employee_id = $2 and work_day = $3 and voided_at is null order by at, created_at`,
    [entityId, employeeId, day]);
}

/**
 * Write one person's day to the payroll timecard. Hours are minutes over 60,
 * to the hundredth. A day still open is an exception, which blocks payroll
 * until it is closed.
 */
export async function feedDay(c: Client, scope: Scope, employeeId: string, day: string): Promise<{ hours: number; status: string; timecardId: string | null }> {
  const e = await employeeOf(c, scope.entityId, employeeId);
  const punches = await dayPunches(c, scope.entityId, employeeId, day);
  const w = walkDay(punches);
  need(!w.problem, `${e.name} on ${day}: ${w.problem}`);
  need(e.pay_group_id, `${e.name} is not in a pay group, so their time has nowhere to go; put them in one under Payroll`);
  const pp = await q<{ id: string; status: string }>(c, `
    select pp.id, pp.status from pay_period pp join pay_group pg on pg.id = pp.pay_group_id and pg.entity_id = $1
     where pp.pay_group_id = $2 and $3::date between pp.starts_on and pp.ends_on and pp.status <> 'cancelled'`, [scope.entityId, e.pay_group_id, day]);
  need(pp.length, `no pay period covers ${day} for ${e.name}'s pay group; open one under Payroll`);
  need(["open", "timecards_approved"].includes(pp[0].status), `the pay period holding ${day} is ${pp[0].status.replace("_", " ")}, so its time is closed`);
  const hours = Math.round(w.minutes / 60 * 100) / 100;
  const existing = await q<{ id: string; status: string; source: string }>(c, `
    select t.id, t.status, t.source from timecard t join employee e on e.id = t.employee_id and e.entity_id = $1
     where t.employee_id = $2 and t.pay_period_id = $3 and t.worked_on = $4`, [scope.entityId, employeeId, pp[0].id, day]);
  if (existing[0]?.status === "approved") throw new WorkforceError(`${e.name}'s time for ${day} is already approved in payroll; a payroll person has to reopen it first`);
  if (!punches.length && !existing.length) return { hours: 0, status: "none", timecardId: null };
  // The store worked at: the day's first punch.
  const loc = punches[0] ? (await one<{ location_id: string }>(c, `select location_id from time_punch where id = $1 and entity_id = $2`, [punches[0].id, scope.entityId])).location_id : null;
  const po = (loc ? await profitObjectFor(c, scope.entityId, loc) : null) ?? e.profit_object_id;
  const status = w.open ? "exception" : "recorded";
  let id: string;
  if (existing.length) {
    id = existing[0].id;
    await c.query(`update timecard t set hours = $2, status = $3, profit_object_id = $4, source = 'clock'
                    from employee e where e.id = t.employee_id and e.entity_id = $5 and t.id = $1`, [id, hours, status, po, scope.entityId]);
  } else {
    id = (await one<{ id: string }>(c, `insert into timecard (employee_id, pay_period_id, worked_on, hours, profit_object_id, source, status)
                                         values ($1,$2,$3,$4,$5,'clock',$6) returning id`, [employeeId, pp[0].id, day, hours, po, status])).id;
  }
  if (w.open) {
    const has = await q(c, `select 1 from timecard_exception x join timecard t on t.id = x.timecard_id join employee e on e.id = t.employee_id and e.entity_id = $2
                              where x.timecard_id = $1 and x.kind = 'missed_punch' and x.resolved_at is null`, [id, scope.entityId]);
    if (!has.length) await c.query(`insert into timecard_exception (timecard_id, kind, detail) values ($1,'missed_punch',$2)`,
      [id, `still punched in since ${w.openSince}; punch out, or a manager enters the missing punch`]);
  } else {
    await c.query(`update timecard_exception x set resolved_by = $2, resolved_at = now()
                    from timecard t join employee e on e.id = t.employee_id and e.entity_id = $3
                   where t.id = x.timecard_id and x.timecard_id = $1 and x.kind = 'missed_punch' and x.resolved_at is null`,
      [id, scope.actor.id || null, scope.entityId]);
  }
  return { hours, status, timecardId: id };
}

/**
 * A punch. For yourself from a phone, at now; for someone else it is a
 * manager's entry and needs a reason (the caller checks the role). The day's
 * order is checked after the punch is placed, so a missing punch can be
 * entered in the middle of a day.
 */
export async function punch(c: Client, scope: Scope, p: {
  employeeId: string; locationId: string; kind: PunchKind; at?: string | null; source: "phone" | "kiosk" | "manager"; reason?: string | null;
  geo?: { lng: number; lat: number } | null; byId: string;
}) {
  need(["in", "out", "break_start", "break_end"].includes(p.kind), "that is not a punch");
  const e = await employeeOf(c, scope.entityId, p.employeeId);
  need(e.status === "active", `${e.name} is not an active employee`);
  need(e.pay_type === "hourly", `${e.name} is salaried and does not punch a clock`);
  const loc = await q(c, `select 1 from location where id = $1 and entity_id = $2`, [p.locationId, scope.entityId]);
  need(loc.length, "pick the store");
  const at = p.at ? await instantAt(c, scope.entityId, p.locationId, p.at) : new Date();
  need(!Number.isNaN(at.getTime()), "that is not a time");
  need(at.getTime() <= Date.now() + 120000, "a punch cannot be in the future");
  if (p.source === "manager") need((p.reason ?? "").trim().length >= 3, "a manager's entry needs a reason");
  else need(Math.abs(at.getTime() - Date.now()) < 5 * 60000, "a punch from a phone is for now; a manager enters an earlier time");
  // Serialise one person's punches.
  await c.query(`select id from employee where id = $1 and entity_id = $2 for update`, [p.employeeId, scope.entityId]);
  const tz = await timezoneFor(c, scope.entityId, p.locationId);
  const s = await settingsOf(c, scope.entityId);
  let day: string;
  if (p.kind === "in") {
    day = (await one<{ d: string }>(c, `select ($1::timestamptz at time zone $2)::date::text d /* unscoped: arithmetic */`, [at.toISOString(), tz])).d;
  } else {
    const r = await q<{ work_day: string; ms: number }>(c, `
      select work_day::text, (extract(epoch from at) * 1000)::float8 ms from time_punch where entity_id = $1 and employee_id = $2 and kind = 'in' and voided_at is null
         and at <= $3 order by at desc limit 1`, [scope.entityId, p.employeeId, at.toISOString()]);
    need(r.length, `${e.name} has to punch in before they can ${KIND_WORDS[p.kind]}`);
    need(at.getTime() - r[0].ms <= s.max_shift_hours * 3600000,
      `${e.name}'s last punch in was over ${s.max_shift_hours} hours before that; a manager enters the missing punch`);
    day = r[0].work_day;
  }
  if (p.kind === "in") {
    const off = await leaveOn(c, scope.entityId, p.employeeId, day);
    if (p.source !== "manager") need(!off, `${e.name} is on approved ${off?.name.toLowerCase()} on ${day}; a manager takes the time off back before they clock in`);
    // a full paid day off is paid once: not as leave and as worked time too
    else need(!off || !off.paid || off.hours < off.dayHours, `${e.name} has a full paid day of ${off?.name.toLowerCase()} on ${day}; take the time off back before entering time for that day`);
  }
  const geo = p.geo && Number.isFinite(p.geo.lng) && Number.isFinite(p.geo.lat) ? `(${p.geo.lng},${p.geo.lat})` : null;
  const r = await one<{ id: string }>(c, `
    insert into time_punch (entity_id, employee_id, location_id, kind, at, work_day, source, geo, recorded_by, reason)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [scope.entityId, p.employeeId, p.locationId, p.kind, at.toISOString(), day, p.source, geo, p.byId, p.reason?.trim() || null]);
  const fed = await feedDay(c, scope, p.employeeId, day);
  return { punchId: r.id, workDay: day, ...fed };
}

/** Void a punch, or replace it with the right time. A manager, with a reason. */
export async function fixPunch(c: Client, scope: Scope, punchId: string, f: { at?: string | null; reason: string; byId: string }) {
  const r = await q<{ id: string; employee_id: string; location_id: string; kind: PunchKind; work_day: string; voided_at: string | null; app_user_id: string | null }>(c, `
    select tp.id, tp.employee_id, tp.location_id, tp.kind, tp.work_day::text, tp.voided_at, e.app_user_id
      from time_punch tp join employee e on e.id = tp.employee_id where tp.id = $1 and tp.entity_id = $2 for update of tp`, [punchId, scope.entityId]);
  need(r.length, "no such punch");
  const x = r[0];
  need(!x.voided_at, "that punch is already voided");
  need(f.reason.trim().length >= 3, "a change to someone's time needs a reason");
  need(x.app_user_id !== f.byId, "nobody changes their own time; another manager does");
  await c.query(`update time_punch set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1 and entity_id = $4`,
    [punchId, f.byId, f.reason.trim(), scope.entityId]);
  let replacement: string | null = null;
  if (f.at) {
    const at = await instantAt(c, scope.entityId, x.location_id, f.at);
    need(!Number.isNaN(at.getTime()) && at.getTime() <= Date.now() + 120000, "the new time has to be a time, and not in the future");
    const tz = await timezoneFor(c, scope.entityId, x.location_id);
    const day = x.kind === "in" ? (await one<{ d: string }>(c, `select ($1::timestamptz at time zone $2)::date::text d /* unscoped: arithmetic */`, [at.toISOString(), tz])).d : x.work_day;
    replacement = (await one<{ id: string }>(c, `
      insert into time_punch (entity_id, employee_id, location_id, kind, at, work_day, source, recorded_by, reason, replaces_id)
      values ($1,$2,$3,$4,$5,$6,'manager',$7,$8,$9) returning id`,
      [scope.entityId, x.employee_id, x.location_id, x.kind, at.toISOString(), day, f.byId, f.reason.trim(), punchId])).id;
    if (day !== x.work_day) await feedDay(c, scope, x.employee_id, day);
  }
  const fed = await feedDay(c, scope, x.employee_id, x.work_day);
  await audit(c, scope, { table: "time_punch", rowId: punchId, action: "transition", after: { voided: true, replacement }, reason: f.reason });
  return { replacementId: replacement, ...fed };
}

/** Where everyone stands right now, and today's hours. */
export async function clockBoard(c: Client, entityId: string, locationId: string | null) {
  return q<{ employee_id: string; name: string; position: string | null; app_user_id: string | null; last_kind: string | null; last_at: string | null;
    location: string | null; today_hours: string | null }>(c, `
    select e.id employee_id, e.first_name || ' ' || e.last_name name, e.position, e.app_user_id,
           lp.kind last_kind, lp.at::text last_at, lo.name location,
           (select t.hours from timecard t where t.employee_id = e.id and t.worked_on = lp.work_day limit 1)::text today_hours
      from employee e
      left join lateral (select kind, at, work_day, location_id from time_punch p where p.entity_id = $1 and p.employee_id = e.id and p.voided_at is null
                          order by at desc limit 1) lp on true
      left join location lo on lo.id = lp.location_id
     where e.entity_id = $1 and e.status = 'active' and e.pay_type = 'hourly'
       and ($2::uuid is null or lp.location_id = $2 or e.profit_object_id in (select id from profit_object where entity_id = $1 and location_id = $2))
     order by (lp.kind in ('in','break_start','break_end')) desc nulls last, e.last_name, e.first_name`, [entityId, locationId]);
}

/**
 * Time a manager needs to look at: days still open (still on the clock, or
 * a missed punch once it is older than the setting), and punches entered or
 * changed by a manager this pay period.
 */
export async function exceptions(c: Client, entityId: string) {
  const s = await settingsOf(c, entityId);
  const open = await q<{ timecard_id: string; employee_id: string; name: string; worked_on: string; hours: string; detail: string | null; open_since: string | null; open_ms: number | null }>(c, `
    select t.id timecard_id, e.id employee_id, e.first_name || ' ' || e.last_name name, t.worked_on::text, t.hours::text, x.detail,
           (select max(p.at)::text from time_punch p where p.entity_id = $1 and p.employee_id = e.id and p.work_day = t.worked_on
              and p.kind = 'in' and p.voided_at is null) open_since,
           (select (extract(epoch from max(p.at)) * 1000)::float8 from time_punch p where p.entity_id = $1 and p.employee_id = e.id and p.work_day = t.worked_on
              and p.kind = 'in' and p.voided_at is null) open_ms
      from timecard t join employee e on e.id = t.employee_id and e.entity_id = $1
      join timecard_exception x on x.timecard_id = t.id and x.resolved_at is null
     where t.status = 'exception' order by t.worked_on, e.last_name`, [entityId]);
  const now = Date.now();
  return open.map((o) => {
    const since = o.open_ms ?? now;
    const missed = now - since > s.missed_punch_hours * 3600000;
    return { ...o, missed, label: missed ? "Missed punch" : "Still on the clock" };
  });
}

export async function punchesFor(c: Client, entityId: string, employeeId: string, from: string, to: string) {
  return q(c, `select tp.id, tp.kind, tp.at::text, tp.work_day::text, tp.source, tp.reason, tp.voided_at::text, tp.void_reason, lo.name location, u.name recorded_by
                 from time_punch tp join location lo on lo.id = tp.location_id left join app_user u on u.id = tp.recorded_by
                where tp.entity_id = $1 and tp.employee_id = $2 and tp.work_day between $3::date and $4::date order by tp.at, tp.created_at`,
    [entityId, employeeId, from, to]);
}

/** Approved time off (leave module) covering a person's day, by its type's name. */
async function leaveOn(c: Client, entityId: string, employeeId: string, day: string): Promise<{ name: string; paid: boolean; hours: number; dayHours: number } | null> {
  const r = await q<{ name: string; paid: boolean; hours: string; day_hours: string }>(c, `
    select t.name, t.paid, d.hours, greatest(r.hours_per_day, 8) day_hours from leave_request_day d join leave_request r on r.id = d.request_id join leave_type t on t.id = r.leave_type_id
     where d.entity_id = $1 and r.employee_id = $2 and d.day = $3::date and r.status = 'approved' and d.returned_at is null limit 1`, [entityId, employeeId, day]);
  return r[0] ? { name: r[0].name, paid: r[0].paid, hours: Number(r[0].hours), dayHours: Number(r[0].day_hours) } : null;
}

// ================================================================= shifts

export async function addShift(c: Client, scope: Scope, s: { locationId: string; employeeId: string; startsAt: string; endsAt: string; role?: string | null; notes?: string | null }) {
  const e = await employeeOf(c, scope.entityId, s.employeeId);
  need(e.status === "active", `${e.name} is not an active employee`);
  const loc = await q(c, `select 1 from location where id = $1 and entity_id = $2`, [s.locationId, scope.entityId]);
  need(loc.length, "pick the store");
  const a = (await instantAt(c, scope.entityId, s.locationId, s.startsAt)).getTime(), b = (await instantAt(c, scope.entityId, s.locationId, s.endsAt)).getTime();
  need(Number.isFinite(a) && Number.isFinite(b), "a shift needs a start and an end");
  need(b > a, "a shift ends after it starts");
  need(b - a <= 16 * 3600000, "a shift is 16 hours at most");
  const clash = await q<{ name: string }>(c, `
    select lo.name from work_shift w join location lo on lo.id = w.location_id
     where w.entity_id = $1 and w.employee_id = $2 and w.status = 'scheduled' and w.starts_at < $4 and w.ends_at > $3`,
    [scope.entityId, s.employeeId, new Date(a).toISOString(), new Date(b).toISOString()]);
  need(!clash.length, `${e.name} is already on a shift then${clash[0] ? ` at ${clash[0].name}` : ""}`);
  const tz = await timezoneFor(c, scope.entityId, s.locationId);
  const onDay = (await one<{ d: string }>(c, `select ($1::timestamptz at time zone $2)::date::text d /* unscoped: arithmetic */`, [new Date(a).toISOString(), tz])).d;
  const off = await leaveOn(c, scope.entityId, s.employeeId, onDay);
  need(!off, `${e.name} has approved ${off?.name.toLowerCase()} on ${onDay}; take the time off back first, or schedule someone else`);
  const r = await one<{ id: string }>(c, `
    insert into work_shift (entity_id, location_id, employee_id, starts_at, ends_at, role, notes, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [scope.entityId, s.locationId, s.employeeId, new Date(a).toISOString(), new Date(b).toISOString(), s.role?.trim() || null, s.notes?.trim() || null, scope.actor.id || null]);
  return r.id;
}

export async function cancelShift(c: Client, scope: Scope, id: string) {
  const r = await q<{ status: string }>(c, `select status from work_shift where id = $1 and entity_id = $2`, [id, scope.entityId]);
  need(r.length, "no such shift");
  need(r[0].status === "scheduled", "that shift is already cancelled");
  await c.query(`update work_shift set status = 'cancelled' where id = $1 and entity_id = $2`, [id, scope.entityId]);
}

/** One store's week: shifts by day, and scheduled hours by person. */
export async function week(c: Client, entityId: string, locationId: string, weekStart: string) {
  need(isDay(weekStart), "pick the week");
  const tz = await timezoneFor(c, entityId, locationId);
  const rows = await q<{ id: string; employee_id: string; name: string; on_day: string; starts: string; ends: string; hours: string; role: string | null; notes: string | null;
    starts_at: string; ends_at: string }>(c, `
    select w.id, w.employee_id, e.first_name || ' ' || e.last_name name,
           (w.starts_at at time zone $4)::date::text on_day, to_char(w.starts_at at time zone $4, 'HH24:MI') starts, to_char(w.ends_at at time zone $4, 'HH24:MI') ends,
           round(extract(epoch from (w.ends_at - w.starts_at)) / 3600.0, 2)::text hours, w.role, w.notes, w.starts_at::text, w.ends_at::text
      from work_shift w join employee e on e.id = w.employee_id
     where w.entity_id = $1 and w.location_id = $2 and w.status = 'scheduled'
       and (w.starts_at at time zone $4)::date between $3::date and $3::date + 6
     order by w.starts_at, e.last_name`, [entityId, locationId, weekStart, tz]);
  const byPerson = new Map<string, { employee_id: string; name: string; hours: number; shifts: number }>();
  for (const r of rows) {
    const x = byPerson.get(r.employee_id) ?? { employee_id: r.employee_id, name: r.name, hours: 0, shifts: 0 };
    x.hours = Math.round((x.hours + Number(r.hours)) * 100) / 100; x.shifts++;
    byPerson.set(r.employee_id, x);
  }
  return { timezone: tz, weekStart, shifts: rows, people: [...byPerson.values()].sort((a, b) => b.hours - a.hours) };
}

// ============================================================ commissions

type Plan = { id: string; basis: "sale" | "margin"; rate_bps: number; tiers: { min: bigint; rate: number }[]; rules: { category: string | null; vendor_id: string | null; rate_bps: number }[] };

async function planFor(c: Client, entityId: string, userId: string, on: string, cache: Map<string, Plan | null>): Promise<(Plan & { assignment: string }) | null> {
  const a = await q<{ id: string; plan_id: string }>(c, `
    select a.id, a.plan_id from commission_assignment a join commission_plan p on p.id = a.plan_id and p.active
     where a.entity_id = $1 and a.app_user_id = $2 and a.effective_from <= $3::date and (a.effective_to is null or a.effective_to >= $3::date)
     order by a.effective_from desc limit 1`, [entityId, userId, on]);
  if (!a.length) return null;
  if (!cache.has(a[0].plan_id)) {
    const p = await one<{ id: string; basis: "sale" | "margin"; rate_bps: number }>(c, `select id, basis, rate_bps from commission_plan where id = $1 and entity_id = $2`, [a[0].plan_id, entityId]);
    const tiers = await q<{ min_monthly_minor: string; rate_bps: number }>(c, `select min_monthly_minor, rate_bps from commission_tier where plan_id = $1 and entity_id = $2 order by min_monthly_minor`, [p.id, entityId]);
    const rules = await q<{ category: string | null; vendor_id: string | null; rate_bps: number }>(c, `select category, vendor_id, rate_bps from commission_rule where plan_id = $1 and entity_id = $2`, [p.id, entityId]);
    cache.set(p.id, { ...p, tiers: tiers.map((t) => ({ min: B(t.min_monthly_minor), rate: t.rate_bps })), rules });
  }
  const p = cache.get(a[0].plan_id)!;
  return p ? { ...p, assignment: a[0].id } : null;
}

/** The rate for one line: a vendor rule, then a category rule, then the month's tier, then the plan's own rate. */
export function rateFor(plan: { rate_bps: number; tiers: { min: bigint; rate: number }[]; rules: { category: string | null; vendor_id: string | null; rate_bps: number }[] },
  line: { category: string | null; vendor_id: string | null }, monthVolume: bigint): number {
  const v = plan.rules.find((r) => r.vendor_id && r.vendor_id === line.vendor_id);
  if (v) return v.rate_bps;
  const cat = plan.rules.find((r) => r.category && line.category && r.category.toLowerCase() === line.category.toLowerCase());
  if (cat) return cat.rate_bps;
  let rate = plan.rate_bps;
  for (const t of plan.tiers) if (monthVolume >= t.min) rate = t.rate;
  return rate;
}

/** Each salesperson's share of an order: the split rows, or the order's salesperson for all of it. */
async function splitsOf(c: Client, entityId: string, orderId: string, salespersonId: string | null) {
  const r = await q<{ app_user_id: string; split_bps: number }>(c,
    `select app_user_id, split_bps from sales_order_salesperson where entity_id = $1 and sales_order_id = $2 order by split_bps desc, app_user_id`, [entityId, orderId]);
  if (r.length) return r;
  return salespersonId ? [{ app_user_id: salespersonId, split_bps: 10000 }] : [];
}

/**
 * Earn commission on lines handed over and invoiced, and charge back lines
 * returned or cancelled after they earned. Safe to run any number of times:
 * each line earns once per salesperson and is charged back once. Posts the
 * accrual (Dr 6130 Cr 2160, by store) in one entry. With an order named,
 * only that order (POS and delivery can call it on hand-over).
 */
export async function accrueCommissions(c: Client, scope: Scope, opts: { orderId?: string | null } = {}) {
  const lines = await q<{ line_id: string; order_id: string; salesperson_id: string | null; location_id: string; ordered_on: string; earned_on: string;
    net_minor: string; qty: string; cost_minor: string | null; product_id: string | null; category: string | null; vendor_id: string | null }>(c, `
    select l.id line_id, so.id order_id, so.salesperson_id, so.location_id, so.ordered_at::date::text ordered_on,
           coalesce(i.invoice_date, so.ordered_at::date)::text earned_on,
           coalesce(il.net_minor, round(l.qty * l.unit_price_minor)::bigint - l.discount_minor)::text net_minor, l.qty, p.cost_minor, l.product_id, p.category, p.vendor_id
      from sales_order_line l
      join sales_order so on so.id = l.sales_order_id
      left join customer_invoice_line il on il.sales_order_line_id = l.id
      left join customer_invoice i on i.id = il.invoice_id
      left join product p on p.id = l.product_id
     -- invoiced lines earn; a return rung as its own negative line (POS returns, never invoiced) charges back
     where l.entity_id = $1 and l.line_status in ('fulfilled','returned','cancelled')
       and (il.id is not null or (l.qty < 0 and l.line_status = 'returned' and l.product_id is not null))
       and ($2::uuid is null or so.id = $2)
       and not exists (select 1 from commission_event ev where ev.entity_id = $1 and ev.sales_order_line_id = l.id and ev.kind = 'earned')
     order by i.invoice_date, so.ordered_at, l.seq`, [scope.entityId, opts.orderId ?? null]);
  const cache = new Map<string, Plan | null>();
  const fresh: { amount: bigint; location: string }[] = [];
  const ids: string[] = [];
  let earned = 0, spiffs = 0, chargebacks = 0, skipped = 0;
  for (const l of lines) {
    const splits = await splitsOf(c, scope.entityId, l.order_id, l.salesperson_id);
    if (!splits.length) { skipped++; continue; }
    const net = B(l.net_minor);
    const cost = BigInt(Math.round(Number(l.qty) * Number(l.cost_minor ?? 0)));
    for (const sp of splits) {
      const plan = await planFor(c, scope.entityId, sp.app_user_id, l.earned_on, cache);
      if (!plan) { skipped++; continue; }
      const share = (x: bigint) => { const r = x * BigInt(sp.split_bps); return (r >= 0n ? r + 5000n : r - 5000n) / 10000n; };
      const sale = share(net), costShare = share(cost);
      const basis = plan.basis === "margin" ? sale - costShare : sale;
      const vol = await one<{ v: string }>(c, `select coalesce(sum(sale_minor),0)::text v from commission_event where entity_id = $1 and app_user_id = $2
          and kind in ('earned','chargeback') and date_trunc('month', earned_on) = date_trunc('month', $3::date)`, [scope.entityId, sp.app_user_id, l.earned_on]);
      const rate = rateFor(plan, l, B(vol.v) + sale);
      const amount = mulBps(basis, rate);
      const ev = await one<{ id: string }>(c, `
        insert into commission_event (entity_id, app_user_id, sales_order_id, sales_order_line_id, kind, plan_id, location_id, split_bps,
                                      sale_minor, cost_minor, basis_minor, rate_bps, amount_minor, earned_on)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [scope.entityId, sp.app_user_id, l.order_id, l.line_id, net < 0n ? "chargeback" : "earned", plan.id, l.location_id, sp.split_bps,
         sale.toString(), costShare.toString(), basis.toString(), rate, amount.toString(), l.earned_on]);
      // A negative line (a return rung as its own line) is recorded as a chargeback, and also marks the line as handled.
      if (net < 0n) {
        await c.query(`insert into commission_event (entity_id, app_user_id, sales_order_id, sales_order_line_id, kind, plan_id, location_id, split_bps,
                         sale_minor, basis_minor, amount_minor, earned_on) values ($1,$2,$3,$4,'earned',$5,$6,$7,0,0,0,$8)`,
          [scope.entityId, sp.app_user_id, l.order_id, l.line_id, plan.id, l.location_id, sp.split_bps, l.earned_on]);
        chargebacks++;
      } else earned++;
      ids.push(ev.id); fresh.push({ amount, location: l.location_id });
      // Spiffs: by SKU or vendor, for a sale written inside the spiff's dates.
      const sp2 = await q<{ id: string; amount_minor: string }>(c, `
        select id, amount_minor from spiff where entity_id = $1 and active and $2::date between starts_on and ends_on
           and (product_id = $3 or (vendor_id is not null and vendor_id = $4))`, [scope.entityId, l.ordered_on, l.product_id, l.vendor_id]);
      for (const s of sp2) {
        const amt = share(BigInt(Math.round(Number(l.qty) * Number(s.amount_minor))));
        if (amt === 0n) continue;
        const x = await one<{ id: string }>(c, `
          insert into commission_event (entity_id, app_user_id, sales_order_id, sales_order_line_id, kind, spiff_id, location_id, split_bps,
                                        sale_minor, basis_minor, amount_minor, earned_on)
          values ($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9,$10) returning id`,
          [scope.entityId, sp.app_user_id, l.order_id, l.line_id, amt < 0n ? "spiff_chargeback" : "spiff", s.id, l.location_id, sp.split_bps, amt.toString(), l.earned_on]);
        ids.push(x.id); fresh.push({ amount: amt, location: l.location_id }); spiffs++;
      }
    }
  }
  // Chargebacks: a line that earned and was then returned or cancelled gives it back.
  const back = await q<{ id: string; app_user_id: string; sales_order_id: string; sales_order_line_id: string; kind: string; plan_id: string | null; spiff_id: string | null;
    location_id: string | null; split_bps: number; sale_minor: string; cost_minor: string; basis_minor: string; rate_bps: number; amount_minor: string }>(c, `
    select ev.* from commission_event ev
      join sales_order_line l on l.id = ev.sales_order_line_id
      join sales_order so on so.id = l.sales_order_id
     where ev.entity_id = $1 and ev.kind in ('earned','spiff') and ev.amount_minor <> 0
       and (l.line_status in ('returned','cancelled') or so.status = 'cancelled')
       and ($2::uuid is null or so.id = $2)
       and not exists (select 1 from commission_event cb where cb.entity_id = $1 and cb.sales_order_line_id = ev.sales_order_line_id
                         and cb.app_user_id = ev.app_user_id and cb.kind = case ev.kind when 'earned' then 'chargeback' else 'spiff_chargeback' end
                         and cb.spiff_id is not distinct from ev.spiff_id)`, [scope.entityId, opts.orderId ?? null]);
  for (const ev of back) {
    const x = await one<{ id: string }>(c, `
      insert into commission_event (entity_id, app_user_id, sales_order_id, sales_order_line_id, kind, plan_id, spiff_id, location_id, split_bps,
                                    sale_minor, cost_minor, basis_minor, rate_bps, amount_minor, earned_on)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [scope.entityId, ev.app_user_id, ev.sales_order_id, ev.sales_order_line_id, ev.kind === "earned" ? "chargeback" : "spiff_chargeback", ev.plan_id, ev.spiff_id,
       ev.location_id, ev.split_bps, (-B(ev.sale_minor)).toString(), (-B(ev.cost_minor)).toString(), (-B(ev.basis_minor)).toString(), ev.rate_bps,
       (-B(ev.amount_minor)).toString(), today()]);
    ids.push(x.id); fresh.push({ amount: -B(ev.amount_minor), location: ev.location_id ?? "" }); chargebacks++;
  }
  // The accrual, by store.
  let je: string | null = null;
  const byLoc = new Map<string, bigint>();
  for (const f of fresh) byLoc.set(f.location, (byLoc.get(f.location) ?? 0n) + f.amount);
  const postLines: PostLine[] = [];
  for (const [loc, amt] of byLoc) {
    if (amt === 0n) continue;
    const po = loc ? await profitObjectFor(c, scope.entityId, loc) : null;
    if (amt > 0n) postLines.push({ code: "6130", debit: amt, profitObjectId: po }, { code: "2160", credit: amt, profitObjectId: po });
    else postLines.push({ code: "2160", debit: -amt, profitObjectId: po }, { code: "6130", credit: -amt, profitObjectId: po });
  }
  if (postLines.length) {
    je = await post(c, scope, { date: today(), sourceType: "commission", sourceId: opts.orderId ?? null,
      description: `Commissions accrued: ${earned} earned, ${spiffs} spiffs, ${chargebacks} charged back`, lines: postLines });
    await c.query(`update commission_event set journal_entry_id = $2 where entity_id = $3 and id = any($1)`, [ids, je, scope.entityId]);
  }
  const total = fresh.reduce((a, f) => a + f.amount, 0n);
  return { earned, spiffs, chargebacks, skipped, totalMinor: total, journalEntryId: je };
}

/**
 * Approve one pay period's commissions for the salespeople paid in it. Each
 * person's approved commission (less chargebacks carried in) pays first any
 * recoverable draw still owed; a draw tops pay up to the guarantee. The
 * result goes to payroll as earnings: commission debits 2160 (it was
 * accrued), a draw beyond commission debits 6130, and a recovered draw is
 * Dr 2160 Cr 6130 now.
 */
export async function approveCommissions(c: Client, scope: Scope, payPeriodId: string, approverId: string) {
  const pp = await q<{ id: string; pay_group_id: string; starts_on: string; ends_on: string; status: string }>(c, `
    select pp.id, pp.pay_group_id, pp.starts_on::text, pp.ends_on::text, pp.status from pay_period pp
      join pay_group pg on pg.id = pp.pay_group_id and pg.entity_id = $2 where pp.id = $1`, [payPeriodId, scope.entityId]);
  need(pp.length, "no such pay period");
  const period = pp[0];
  need(["open", "timecards_approved"].includes(period.status), `that pay period is ${period.status.replace("_", " ")}; commissions go on an open one`);
  const people = await q<{ employee_id: string; app_user_id: string; name: string; profit_object_id: string | null }>(c, `
    select e.id employee_id, e.app_user_id, e.first_name || ' ' || e.last_name name, e.profit_object_id from employee e
     where e.entity_id = $1 and e.pay_group_id = $2 and e.status = 'active' and e.app_user_id is not null`, [scope.entityId, period.pay_group_id]);
  const out: { name: string; commission: bigint; payout: bigint; topup: bigint; recovered: bigint; drawBalance: bigint }[] = [];
  let recoveredTotal = 0n;
  const recoveryLines: PostLine[] = [];
  for (const p of people) {
    const done = await q(c, `select 1 from commission_payout where entity_id = $1 and pay_period_id = $2 and app_user_id = $3`, [scope.entityId, payPeriodId, p.app_user_id]);
    if (done.length) continue;
    const ev = await one<{ s: string; n: number }>(c, `select coalesce(sum(amount_minor),0)::text s, count(*)::int n from commission_event
        where entity_id = $1 and app_user_id = $2 and status = 'accrued' and earned_on <= $3::date`, [scope.entityId, p.app_user_id, period.ends_on]);
    const asg = await q<{ draw_minor: string; draw_recoverable: boolean }>(c, `
      select draw_minor, draw_recoverable from commission_assignment where entity_id = $1 and app_user_id = $2
         and effective_from <= $3::date and (effective_to is null or effective_to >= $3::date) order by effective_from desc limit 1`,
      [scope.entityId, p.app_user_id, period.ends_on]);
    const draw = B(asg[0]?.draw_minor);
    if (ev.n === 0 && draw === 0n) continue;
    const prev = await q<{ draw_balance_minor: string; carry_out_minor: string }>(c, `
      select draw_balance_minor, carry_out_minor from commission_payout where entity_id = $1 and app_user_id = $2 order by approved_at desc limit 1`,
      [scope.entityId, p.app_user_id]);
    const owedDraw = B(prev[0]?.draw_balance_minor), carryIn = B(prev[0]?.carry_out_minor);
    const commission = B(ev.s);
    let eff = commission - carryIn, carryOut = 0n;
    if (eff < 0n) { carryOut = -eff; eff = 0n; }
    const recoverable = asg[0]?.draw_recoverable ?? true;
    const recovered = recoverable ? (owedDraw < eff ? owedDraw : eff) : 0n;
    const paid = eff - recovered;
    const topup = draw > paid ? draw - paid : 0n;
    const payout = paid + topup;
    const balance = recoverable ? owedDraw - recovered + topup : 0n;
    const po = await one<{ id: string }>(c, `
      insert into commission_payout (entity_id, pay_period_id, app_user_id, employee_id, commission_minor, carried_in_minor, draw_minor, recovered_minor,
                                     commission_paid_minor, topup_minor, payout_minor, draw_balance_minor, carry_out_minor, approved_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [scope.entityId, payPeriodId, p.app_user_id, p.employee_id, commission.toString(), carryIn.toString(), draw.toString(), recovered.toString(),
       paid.toString(), topup.toString(), payout.toString(), balance.toString(), carryOut.toString(), approverId]);
    await c.query(`update commission_event set status = 'approved', payout_id = $4 where entity_id = $1 and app_user_id = $2 and status = 'accrued' and earned_on <= $3::date`,
      [scope.entityId, p.app_user_id, period.ends_on, po.id]);
    const earn = async (kind: string, amt: bigint, code: string, memo: string) => {
      if (amt <= 0n) return;
      await c.query(`insert into payroll_earning (entity_id, employee_id, pay_period_id, kind, amount_minor, debit_code, source_type, source_id, memo, created_by)
                     values ($1,$2,$3,$4,$5,$6,'commission_payout',$7,$8,$9)`,
        [scope.entityId, p.employee_id, payPeriodId, kind, amt.toString(), code, po.id, memo, approverId]);
    };
    await earn("commission", paid, "2160", "commission earned on delivered sales");
    await earn("draw", topup, "6130", "draw against commission");
    if (recovered > 0n) {
      recoveredTotal += recovered;
      recoveryLines.push({ code: "2160", debit: recovered, profitObjectId: p.profit_object_id, memo: `${p.name}: draw recovered` },
                         { code: "6130", credit: recovered, profitObjectId: p.profit_object_id });
    }
    out.push({ name: p.name, commission, payout, topup, recovered, drawBalance: balance });
  }
  if (recoveryLines.length) {
    const je = await post(c, scope, { date: today(), sourceType: "commission", sourceId: payPeriodId,
      description: `Draws recovered from commission, ${format(recoveredTotal)}`, lines: recoveryLines });
    await c.query(`update commission_payout set journal_entry_id = $2 where entity_id = $3 and pay_period_id = $1 and recovered_minor > 0 and journal_entry_id is null`,
      [payPeriodId, je, scope.entityId]);
  }
  const unpaid = await q<{ name: string; s: string }>(c, `
    select u.name, sum(ev.amount_minor)::text s from commission_event ev join app_user u on u.id = ev.app_user_id
     where ev.entity_id = $1 and ev.status = 'accrued' and ev.earned_on <= $2::date
       and not exists (select 1 from employee e where e.entity_id = $1 and e.app_user_id = ev.app_user_id and e.status = 'active')
     group by u.name`, [scope.entityId, period.ends_on]);
  return { approved: out, notOnPayroll: unpaid };
}

/** One salesperson's statement for a pay period: every line, the draw, and what payroll pays. */
export async function commissionStatement(c: Client, entityId: string, payPeriodId: string, userId: string) {
  const pp = await one<{ starts_on: string; ends_on: string; pay_date: string }>(c, `
    select pp.starts_on::text, pp.ends_on::text, pp.pay_date::text from pay_period pp join pay_group pg on pg.id = pp.pay_group_id and pg.entity_id = $2
     where pp.id = $1`, [payPeriodId, entityId]);
  const payout = await q(c, `select * from commission_payout where entity_id = $1 and pay_period_id = $2 and app_user_id = $3`, [entityId, payPeriodId, userId]);
  const lines = await q<{ kind: string; order_number: string; description: string; earned_on: string; split_bps: number; sale_minor: string; basis_minor: string;
    rate_bps: number; amount_minor: string; status: string; spiff: string | null }>(c, `
    select ev.kind, so.number order_number, l.description, ev.earned_on::text, ev.split_bps, ev.sale_minor, ev.basis_minor, ev.rate_bps, ev.amount_minor, ev.status,
           s.name spiff
      from commission_event ev join sales_order so on so.id = ev.sales_order_id join sales_order_line l on l.id = ev.sales_order_line_id
      left join spiff s on s.id = ev.spiff_id
     where ev.entity_id = $1 and ev.app_user_id = $2 and ev.amount_minor <> 0
       and (ev.payout_id = $3 or ($3::uuid is null and ev.status = 'accrued' and ev.earned_on <= $4::date))
     order by ev.earned_on, so.number`, [entityId, userId, (payout[0] as { id?: string } | undefined)?.id ?? null, pp.ends_on]);
  const u = await one<{ name: string }>(c, `select name from app_user where id = $1 /* unscoped: a person's name */`, [userId]);
  return { name: u.name, period: pp, payout: payout[0] ?? null, lines,
    totalMinor: lines.reduce((a, l) => a + B(l.amount_minor), 0n) };
}

/** Written against delivered, and margin, by salesperson for a date range. */
export async function leaderboard(c: Client, entityId: string, from: string, to: string) {
  need(isDay(from) && isDay(to) && from <= to, "pick a start and an end date");
  const written = await q<{ app_user_id: string; written: string; orders: number }>(c, `
    with s as (
      select so.id, so.subtotal_minor - so.discount_minor net, coalesce(x.app_user_id, so.salesperson_id) app_user_id, coalesce(x.split_bps, 10000) split_bps
        from sales_order so left join sales_order_salesperson x on x.sales_order_id = so.id and x.entity_id = $1
       where so.entity_id = $1 and so.status not in ('draft','cancelled') and so.ordered_at::date between $2::date and $3::date)
    select app_user_id, (sum(net * split_bps) / 10000)::bigint::text written, count(distinct id)::int orders from s where app_user_id is not null group by app_user_id`,
    [entityId, from, to]);
  const delivered = await q<{ app_user_id: string; delivered: string; cost: string; commission: string }>(c, `
    select app_user_id, coalesce(sum(sale_minor) filter (where kind in ('earned','chargeback')),0)::text delivered,
           coalesce(sum(cost_minor) filter (where kind in ('earned','chargeback')),0)::text cost, coalesce(sum(amount_minor),0)::text commission
      from commission_event where entity_id = $1 and earned_on between $2::date and $3::date group by app_user_id`, [entityId, from, to]);
  const ids = [...new Set([...written.map((w) => w.app_user_id), ...delivered.map((d) => d.app_user_id)])];
  const names = ids.length ? await q<{ id: string; name: string }>(c, `select id, name from app_user where id = any($1) /* unscoped: names of the people listed */`, [ids]) : [];
  const rows = ids.map((id) => {
    const w = written.find((x) => x.app_user_id === id), d = delivered.find((x) => x.app_user_id === id);
    const del = B(d?.delivered), cost = B(d?.cost);
    return { appUserId: id, name: names.find((n) => n.id === id)?.name ?? "?", writtenMinor: B(w?.written), orders: w?.orders ?? 0,
      deliveredMinor: del, marginMinor: del - cost, marginPct: del > 0n ? Math.round(Number((del - cost) * 10000n / del)) / 100 : null,
      commissionMinor: B(d?.commission) };
  });
  return rows.sort((a, b) => (b.deliveredMinor > a.deliveredMinor ? 1 : b.deliveredMinor < a.deliveredMinor ? -1 : Number(b.writtenMinor - a.writtenMinor)));
}
