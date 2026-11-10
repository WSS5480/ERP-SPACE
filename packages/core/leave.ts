// Time off and holidays.
//
// Leave types (vacation, sick, unpaid, other) each accrue by a rule: so many
// hours per hours worked, or per pay period, never past a cap. The balance is
// a ledger (accruals, time taken, adjustments, reversals), never a number
// that is edited.
//
// People ask for time off from their phone; a manager who is not them
// approves or declines. Approved leave is respected by the clock (no punching
// in from a phone on a day off) and the schedule (no shift on a day off; the
// shifts already there are cancelled on approval, and said so). Paid leave
// for hourly people becomes a payroll earning in the pay period of each day
// (salaried pay carries on as it is).
//
// Holiday lists are per company. A store-closed day is a delivery blackout
// (through fleet.addBlackout), and a paid holiday is holiday pay for hourly
// people in the pay period that holds it. A holiday that lands on approved
// leave gives the leave hours back (the day is paid once, as the holiday).
// A cancelled holiday releases its blackout and cancels holiday pay not yet
// in a payroll run; leave days it gave back stay given back.
//
// Paid once: a leave day with time already worked on it is refused (the
// person asks for the hours not worked instead, as a shorter day); a manager
// does not punch anyone in on a full paid leave day; and before a payroll run
// is built, each paid leave day's worked hours plus leave hours may not be
// more than the day's hours. Leave in a pay period that is already built or
// posted is refused, and paid leave for an hourly person with no pay group is
// refused -- hours are never taken that are never paid.

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { WorkforceError, cancelShift } from "./workforce.ts";
import { addBlackout } from "./fleet.ts";

const need = (cond: unknown, msg: string): asserts cond => { if (!cond) throw new WorkforceError(msg); };
const UUIDRX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUIDRX.test(v);
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const n = (v: unknown) => Number(v ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const addDays = (day: string, k: number) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const dayWords = (day: string) => new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
export const KINDS = ["vacation", "sick", "unpaid", "other"];

async function person(c: Client, entityId: string, employeeId: string) {
  need(isId(employeeId), "no such employee");
  const r = await q<{ id: string; name: string; app_user_id: string | null; status: string; pay_type: string; base_rate_minor: string; pay_group_id: string | null }>(c, `
    select id, first_name || ' ' || last_name name, app_user_id, status, pay_type, base_rate_minor, pay_group_id
      from employee where entity_id = $1 and id = $2`, [entityId, employeeId]);
  need(r.length, "no such employee");
  return r[0];
}

// --------------------------------------------------------------- types --

export async function leaveTypes(c: Client, entityId: string) {
  return q(c, `select id, code, name, kind, paid, accrual, accrue_hours::float accrue_hours, per_hours::float per_hours, cap_hours::float cap_hours,
                      allow_negative, active from leave_type where entity_id = $1 order by active desc, name`, [entityId]);
}

export async function saveLeaveType(c: Client, scope: Scope, b: { id?: string | null; code: string; name: string; kind: string; paid?: boolean;
  accrual?: string; accrueHours?: number; perHours?: number | null; capHours?: number | null; allowNegative?: boolean; active?: boolean }) {
  const code = String(b.code ?? "").trim().toUpperCase().slice(0, 12), name = String(b.name ?? "").trim().slice(0, 60);
  need(code && name, "a leave type needs a short code and a name");
  need(KINDS.includes(b.kind), "a leave type is vacation, sick, unpaid or other");
  const accrual = b.accrual ?? "none";
  need(["none", "per_hour", "per_period"].includes(accrual), "it accrues per hour worked, per pay period, or not at all");
  const paid = b.kind === "unpaid" ? false : b.paid !== false;
  const hours = Math.max(0, n(b.accrueHours));
  const per = b.perHours != null && String(b.perHours) !== "" ? n(b.perHours) : null;
  if (accrual === "per_hour") need(per && per > 0 && hours > 0, "say how many hours are earned for how many hours worked (1 for every 30)");
  if (accrual === "per_period") need(hours > 0, "say how many hours are earned each pay period");
  const cap = b.capHours != null && String(b.capHours) !== "" ? Math.max(0, n(b.capHours)) : null;
  const vals = [scope.entityId, code, name, b.kind, paid, accrual, hours, accrual === "per_hour" ? per : null, cap, b.allowNegative === true, b.active !== false];
  if (b.id) {
    need(isId(b.id), "no such leave type");
    const r = await q(c, `update leave_type set code=$2, name=$3, kind=$4, paid=$5, accrual=$6, accrue_hours=$7, per_hours=$8, cap_hours=$9, allow_negative=$10, active=$11
                           where entity_id = $1 and id = $12 returning id`, [...vals, b.id]);
    need(r.length, "no such leave type");
    return r[0];
  }
  const dup = await q(c, `select 1 from leave_type where entity_id = $1 and code = $2`, [scope.entityId, code]);
  need(!dup.length, `there is already a leave type ${code}`);
  return one(c, `insert into leave_type (entity_id, code, name, kind, paid, accrual, accrue_hours, per_hours, cap_hours, allow_negative, active)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, vals);
}

async function typeOf(c: Client, entityId: string, id: string) {
  need(isId(id), "pick the kind of time off");
  const r = await q<{ id: string; code: string; name: string; kind: string; paid: boolean; allow_negative: boolean; cap_hours: string | null; active: boolean }>(c,
    `select id, code, name, kind, paid, allow_negative, cap_hours, active from leave_type where entity_id = $1 and id = $2`, [entityId, id]);
  need(r.length, "pick the kind of time off");
  return r[0];
}

// ------------------------------------------------------------ balances --

async function balanceOf(c: Client, entityId: string, employeeId: string, typeId: string): Promise<number> {
  return n((await one<{ h: string }>(c, `select coalesce(sum(hours),0)::text h from leave_ledger where entity_id = $1 and employee_id = $2 and leave_type_id = $3`,
    [entityId, employeeId, typeId])).h);
}
async function pendingOf(c: Client, entityId: string, employeeId: string, typeId: string, exceptId: string | null = null): Promise<number> {
  return n((await one<{ h: string }>(c, `select coalesce(sum(total_hours),0)::text h from leave_request
     where entity_id = $1 and employee_id = $2 and leave_type_id = $3 and status = 'requested' and ($4::uuid is null or id <> $4)`,
    [entityId, employeeId, typeId, exceptId])).h);
}

export async function balances(c: Client, entityId: string, employeeId: string) {
  const p = await person(c, entityId, employeeId);
  const rows = await q<{ id: string; code: string; name: string; kind: string; paid: boolean; cap_hours: number | null; balance: number; pending: number; taken_ytd: number }>(c, `
    select t.id, t.code, t.name, t.kind, t.paid, t.cap_hours::float cap_hours,
           coalesce((select sum(l.hours) from leave_ledger l where l.entity_id = $1 and l.employee_id = $2 and l.leave_type_id = t.id),0)::float balance,
           coalesce((select sum(r.total_hours) from leave_request r where r.entity_id = $1 and r.employee_id = $2 and r.leave_type_id = t.id and r.status = 'requested'),0)::float pending,
           coalesce((select -sum(l.hours) from leave_ledger l where l.entity_id = $1 and l.employee_id = $2 and l.leave_type_id = t.id
                      and l.kind in ('taken','reversal') and extract(year from l.occurred_on) = extract(year from current_date)),0)::float taken_ytd
      from leave_type t where t.entity_id = $1 and t.active order by t.name`, [entityId, employeeId]);
  return { employee: { id: p.id, name: p.name }, types: rows.map((r) => ({ ...r, balance: r3(r.balance), available: r3(r.balance - r.pending) })) };
}

/** HR sets an opening balance or corrects one, with a reason. */
export async function adjust(c: Client, scope: Scope, b: { employeeId: string; leaveTypeId: string; hours: number; note: string; on?: string }) {
  await person(c, scope.entityId, b.employeeId);
  await typeOf(c, scope.entityId, b.leaveTypeId);
  const h = r3(n(b.hours));
  need(h !== 0 && Math.abs(h) <= 2000, "give the hours to add (or take off, as a negative)");
  need(String(b.note ?? "").trim().length >= 3, "say why the balance changes");
  const t = await typeOf(c, scope.entityId, b.leaveTypeId);
  if (h < 0 && !t.allow_negative) {
    const bal = await balanceOf(c, scope.entityId, b.employeeId, t.id);
    need(r3(bal + h) >= 0, `${t.name} cannot go below zero (the balance is ${r3(bal)} hours); turn on "may go negative" for it first`);
  }
  return one(c, `insert into leave_ledger (entity_id, employee_id, leave_type_id, occurred_on, kind, hours, note, created_by)
                 values ($1,$2,$3,$4,'adjustment',$5,$6,$7) returning id`,
    [scope.entityId, b.employeeId, b.leaveTypeId, isDay(b.on) ? b.on : new Date().toISOString().slice(0, 10), h, String(b.note).trim().slice(0, 300), scope.actor.id || null]);
}

/**
 * Accrue a pay period's leave for everyone in its pay group: per hour worked
 * from the period's timecards, or a flat amount per period; never past the
 * cap; once per person, type and period.
 */
export async function accrue(c: Client, scope: Scope, payPeriodId: string) {
  need(isId(payPeriodId), "pick the pay period");
  const pp = await q<{ id: string; pay_group_id: string; ends_on: string; status: string }>(c, `
    select pp.id, pp.pay_group_id, pp.ends_on::text ends_on, pp.status from pay_period pp join pay_group pg on pg.id = pp.pay_group_id and pg.entity_id = $1
     where pp.id = $2`, [scope.entityId, payPeriodId]);
  need(pp.length, "pick the pay period");
  need(pp[0].status !== "cancelled", "that pay period was cancelled");
  const types = await q<{ id: string; name: string; accrual: string; accrue_hours: string; per_hours: string | null; cap_hours: string | null }>(c, `
    select id, name, accrual, accrue_hours, per_hours, cap_hours from leave_type where entity_id = $1 and active and accrual <> 'none'`, [scope.entityId]);
  const people = await q<{ id: string; name: string; worked: string }>(c, `
    select e.id, e.first_name || ' ' || e.last_name name,
           coalesce((select sum(t.hours) from timecard t where t.employee_id = e.id and t.pay_period_id = $2 and t.status in ('recorded','approved')),0)::text worked
      from employee e where e.entity_id = $1 and e.pay_group_id = $3 and e.status = 'active' order by e.last_name`, [scope.entityId, payPeriodId, pp[0].pay_group_id]);
  const out: { employeeId: string; name: string; type: string; hours: number; capped: boolean }[] = [];
  for (const p of people) for (const t of types) {
    let h = t.accrual === "per_period" ? n(t.accrue_hours) : n(p.worked) * n(t.accrue_hours) / n(t.per_hours || 1);
    h = r3(h);
    if (h <= 0) continue;
    let capped = false;
    if (t.cap_hours != null) {
      const bal = await balanceOf(c, scope.entityId, p.id, t.id);
      const room = r3(n(t.cap_hours) - bal);
      if (room <= 0) continue;
      if (h > room) { h = room; capped = true; }
    }
    const r = await c.query(`insert into leave_ledger (entity_id, employee_id, leave_type_id, occurred_on, kind, hours, pay_period_id, note, created_by)
                             values ($1,$2,$3,$4,'accrual',$5,$6,$7,$8) on conflict do nothing`,
      [scope.entityId, p.id, t.id, pp[0].ends_on, h, payPeriodId, t.accrual === "per_hour" ? `${n(p.worked)} h worked` : "per pay period", scope.actor.id || null]);
    if (r.rowCount) out.push({ employeeId: p.id, name: p.name, type: t.name, hours: h, capped });
  }
  await audit(c, scope, { table: "leave_ledger", rowId: payPeriodId, action: "insert", after: { accrued: out.length } });
  return { accrued: out };
}

// ------------------------------------------------------------ requests --

async function holidayDays(c: Client, entityId: string, from: string, to: string): Promise<Set<string>> {
  const r = await q<{ d: string }>(c, `select day::text d from company_holiday where entity_id = $1 and day between $2::date and $3::date and cancelled_at is null`, [entityId, from, to]);
  return new Set(r.map((x) => x.d));
}

/** Ask for time off. For yourself from the phone; a manager may enter it for someone. */
export async function request(c: Client, scope: Scope, b: { employeeId: string; leaveTypeId: string; startsOn: string; endsOn?: string; hoursPerDay?: number; note?: string }) {
  const p = await person(c, scope.entityId, b.employeeId);
  need(p.status === "active", `${p.name} is not an active employee`);
  const t = await typeOf(c, scope.entityId, b.leaveTypeId);
  need(t.active, `${t.name} is not offered any more`);
  need(isDay(b.startsOn), "pick the first day off");
  const ends = isDay(b.endsOn) ? b.endsOn : b.startsOn;
  need(ends >= b.startsOn, "the last day off is on or after the first");
  need(addDays(b.startsOn, 62) >= ends, "a request covers two months at most; split it");
  const hpd = r2(n(b.hoursPerDay ?? 8));
  need(hpd > 0 && hpd <= 24, "hours a day are more than 0 and at most 24");
  const hol = await holidayDays(c, scope.entityId, b.startsOn, ends);
  const days: string[] = [];
  for (let d = b.startsOn; d <= ends; d = addDays(d, 1)) if (!hol.has(d)) days.push(d);
  need(days.length, "every one of those days is a company holiday already");
  const total = r2(days.length * hpd);
  const clash = await q<{ starts_on: string; status: string }>(c, `
    select starts_on::text, status from leave_request where entity_id = $1 and employee_id = $2 and status in ('requested','approved')
       and starts_on <= $4::date and ends_on >= $3::date limit 1`, [scope.entityId, b.employeeId, b.startsOn, ends]);
  need(!clash.length, `${p.name} already has time off ${clash[0]?.status} from ${clash[0] ? dayWords(clash[0].starts_on) : ""} that overlaps`);
  if (!t.allow_negative) {
    const avail = r3((await balanceOf(c, scope.entityId, b.employeeId, t.id)) - (await pendingOf(c, scope.entityId, b.employeeId, t.id)));
    need(avail >= total, `${p.name} has ${avail} hours of ${t.name.toLowerCase()} available, not ${total}`);
  }
  const r = await one<{ id: string }>(c, `
    insert into leave_request (entity_id, employee_id, leave_type_id, starts_on, ends_on, hours_per_day, total_hours, note, requested_by)
    values ($1,$2,$3,$4,$5,$6,$7,nullif($8,''),$9) returning id`,
    [scope.entityId, b.employeeId, t.id, b.startsOn, ends, hpd, total, String(b.note ?? "").trim().slice(0, 300), scope.actor.id || null]);
  for (const d of days) await c.query(`insert into leave_request_day (entity_id, request_id, day, hours) values ($1,$2,$3,$4)`, [scope.entityId, r.id, d, hpd]);
  await audit(c, scope, { table: "leave_request", rowId: r.id, action: "insert", after: { employee: p.name, type: t.code, from: b.startsOn, to: ends, hours: total } });
  return { id: r.id, totalHours: total, days: days.length };
}

type ReqRow = { id: string; employee_id: string; leave_type_id: string; starts_on: string; ends_on: string; total_hours: string; status: string; app_user_id: string | null; name: string;
  requested_by: string | null };
async function reqOf(c: Client, entityId: string, id: string): Promise<ReqRow> {
  need(isId(id), "no such request");
  const r = await q<ReqRow>(c, `
    select r.id, r.employee_id, r.leave_type_id, r.starts_on::text starts_on, r.ends_on::text ends_on, r.total_hours, r.status, e.app_user_id, r.requested_by,
           e.first_name || ' ' || e.last_name name
      from leave_request r join employee e on e.id = r.employee_id where r.entity_id = $1 and r.id = $2 for update of r`, [entityId, id]);
  need(r.length, "no such request");
  return r[0];
}

/** Pay a paid leave day to an hourly person, if the pay period that holds it is open. */
async function payDay(c: Client, scope: Scope, p: { id: string; pay_type: string; base_rate_minor: string; pay_group_id: string | null; name: string },
  day: { id: string; day: string; hours: string }, typeName: string, requestId: string, by: string | null) {
  if (p.pay_type !== "hourly" || !p.pay_group_id) return null;
  const pp = await q<{ id: string }>(c, `select pp.id from pay_period pp join pay_group pg on pg.id = pp.pay_group_id and pg.entity_id = $1
     where pp.pay_group_id = $2 and $3::date between pp.starts_on and pp.ends_on and pp.status in ('open','timecards_approved')`, [scope.entityId, p.pay_group_id, day.day]);
  if (!pp.length) return null;
  const amt = BigInt(Math.round(n(day.hours) * 100)) * BigInt(p.base_rate_minor) / 100n;
  if (amt <= 0n) return null;
  const e = await one<{ id: string }>(c, `
    insert into payroll_earning (entity_id, employee_id, pay_period_id, kind, amount_minor, debit_code, source_type, source_id, memo, created_by)
    values ($1,$2,$3,'other',$4,'6100','leave_request',$5,$6,$7) returning id`,
    [scope.entityId, p.id, pp[0].id, amt.toString(), requestId, `${typeName} ${day.day}, ${n(day.hours)} h`, by]);
  await c.query(`update leave_request_day set earning_id = $3 where entity_id = $1 and id = $2`, [scope.entityId, day.id, e.id]);
  return e.id;
}

/** A manager (never the person themself) approves or declines. Approving takes the hours, clears the schedule, and pays what is paid. */
export async function decide(c: Client, scope: Scope, id: string, d: { approve: boolean; note?: string }) {
  const r = await reqOf(c, scope.entityId, id);
  need(r.status === "requested", `that request is already ${r.status}`);
  need(!r.app_user_id || r.app_user_id !== scope.actor.id, "nobody approves or declines their own time off; another manager does");
  need(!r.requested_by || r.requested_by !== scope.actor.id, "whoever entered a time-off request does not decide it; another manager does");
  if (!d.approve) {
    need(String(d.note ?? "").trim().length >= 3, "say why the time off is declined");
    await c.query(`update leave_request set status = 'declined', decided_by = $3, decided_at = now(), decision_note = $4 where entity_id = $1 and id = $2`,
      [scope.entityId, id, scope.actor.id || null, String(d.note).trim().slice(0, 300)]);
    return { status: "declined" };
  }
  const t = await typeOf(c, scope.entityId, r.leave_type_id);
  const p = await person(c, scope.entityId, r.employee_id);
  if (!t.allow_negative) {
    const avail = r3((await balanceOf(c, scope.entityId, r.employee_id, t.id)) - (await pendingOf(c, scope.entityId, r.employee_id, t.id, id)));
    need(avail >= n(r.total_hours), `${r.name} has ${avail} hours of ${t.name.toLowerCase()} available, not ${n(r.total_hours)}`);
  }
  if (t.paid && p.pay_type === "hourly") {
    need(p.pay_group_id, `${r.name} is not in a pay group, so paid time off could never be paid; put them in one under Payroll first`);
    const closed = await q<{ day: string; status: string }>(c, `
      select d.day::text as day, pp.status from leave_request_day d
        join pay_period pp on pp.pay_group_id = $3 and d.day between pp.starts_on and pp.ends_on
       where d.entity_id = $1 and d.request_id = $2 and pp.status in ('built','released','posted') order by d.day limit 1`, [scope.entityId, id, p.pay_group_id]);
    need(!closed.length, `the pay period holding ${closed[0] ? dayWords(closed[0].day) : ""} is already ${closed[0]?.status}; time off there is corrected in payroll, not approved here`);
  }
  // paid once: no leave on a day already worked (ask for a shorter day: the hours not worked)
  const worked = await q<{ day: string; hours: string | null }>(c, `
    select d.day::text as day,
           (select sum(tc.hours)::text from timecard tc where tc.employee_id = $2 and tc.worked_on = d.day and tc.status <> 'rejected') hours
      from leave_request_day d where d.entity_id = $1 and d.request_id = $3 and d.returned_at is null
       and (exists (select 1 from timecard tc where tc.employee_id = $2 and tc.worked_on = d.day and tc.status <> 'rejected' and tc.hours > 0)
            or exists (select 1 from time_punch tp where tp.entity_id = $1 and tp.employee_id = $2 and tp.work_day = d.day and tp.voided_at is null))
     order by d.day limit 1`, [scope.entityId, r.employee_id, id]);
  need(!worked.length, `${r.name} already has time worked on ${worked[0] ? dayWords(worked[0].day) : ""}${worked[0]?.hours ? ` (${n(worked[0].hours)} h)` : ""}; a day is paid once, so ask for the hours not worked that day instead`);
  await c.query(`update leave_request set status = 'approved', decided_by = $3, decided_at = now(), decision_note = nullif($4,'') where entity_id = $1 and id = $2`,
    [scope.entityId, id, scope.actor.id || null, String(d.note ?? "").trim().slice(0, 300)]);
  if (t.kind !== "unpaid") {
    await c.query(`insert into leave_ledger (entity_id, employee_id, leave_type_id, occurred_on, kind, hours, request_id, note, created_by)
                   values ($1,$2,$3,$4,'taken',$5,$6,$7,$8)`,
      [scope.entityId, r.employee_id, t.id, r.starts_on, -n(r.total_hours), id, `${dayWords(r.starts_on)} to ${dayWords(r.ends_on)}`, scope.actor.id || null]);
  }
  // the schedule: shifts on those days are cancelled, and said so
  const tz = await one<{ tz: string }>(c, `select coalesce((select timezone from workforce_settings where entity_id = $1), 'America/New_York') tz`, [scope.entityId]);
  const shifts = await q<{ id: string; on_day: string }>(c, `
    select w.id, (w.starts_at at time zone $4)::date::text on_day from work_shift w
     where w.entity_id = $1 and w.employee_id = $2 and w.status = 'scheduled'
       and (w.starts_at at time zone $4)::date in (select day from leave_request_day where request_id = $3)`, [scope.entityId, r.employee_id, id, tz.tz]);
  for (const s of shifts) await cancelShift(c, scope, s.id);
  let paid = 0;
  if (t.paid) {
    const days = await q<{ id: string; day: string; hours: string }>(c, `select id, day::text as day, hours from leave_request_day where entity_id = $1 and request_id = $2 and earning_id is null order by day`, [scope.entityId, id]);
    for (const day of days) if (await payDay(c, scope, p, day, t.name, id, scope.actor.id || null)) paid++;
  }
  await audit(c, scope, { table: "leave_request", rowId: id, action: "transition", before: { status: "requested" }, after: { status: "approved", shiftsCancelled: shifts.length, daysPaid: paid } });
  return { status: "approved", shiftsCancelled: shifts.length, daysPaid: paid };
}

/** Withdraw a request, or take back approved leave that has not been paid in a payroll run. */
export async function cancel(c: Client, scope: Scope, id: string, reason: string, manager: boolean) {
  const r = await reqOf(c, scope.entityId, id);
  need(["requested", "approved"].includes(r.status), `that request is already ${r.status}`);
  need(String(reason ?? "").trim().length >= 3, "say why it is cancelled");
  const own = r.app_user_id === scope.actor.id;
  need(manager || (own && r.status === "requested"), r.status === "approved" ? "approved time off is taken back by a manager" : "that request is someone else's");
  if (r.status === "approved") {
    const ran = await q(c, `select 1 from leave_request_day d join payroll_earning e on e.id = d.earning_id
       where d.entity_id = $1 and d.request_id = $2 and e.payroll_run_id is not null and e.status = 'approved'`, [scope.entityId, id]);
    need(!ran.length, "part of that time off is already paid in a payroll run; a payroll person corrects it there");
    await c.query(`update payroll_earning e set status = 'cancelled' from leave_request_day d
                    where d.earning_id = e.id and d.entity_id = $1 and e.entity_id = $1 and d.request_id = $2 and e.status = 'approved'`, [scope.entityId, id]);
    const taken = await q<{ hours: string }>(c, `select coalesce(sum(hours),0)::text hours from leave_ledger where entity_id = $1 and request_id = $2`, [scope.entityId, id]);
    if (n(taken[0].hours) !== 0) {
      await c.query(`insert into leave_ledger (entity_id, employee_id, leave_type_id, occurred_on, kind, hours, request_id, note, created_by)
                     values ($1,$2,$3,current_date,'reversal',$4,$5,$6,$7)`,
        [scope.entityId, r.employee_id, r.leave_type_id, -n(taken[0].hours), id, String(reason).trim().slice(0, 300), scope.actor.id || null]);
    }
  }
  await c.query(`update leave_request set status = 'cancelled', cancelled_by = $3, cancelled_at = now(), cancel_reason = $4 where entity_id = $1 and id = $2`,
    [scope.entityId, id, scope.actor.id || null, String(reason).trim().slice(0, 300)]);
  return { status: "cancelled" };
}

export async function requests(c: Client, entityId: string, f: { employeeId?: string | null; status?: string | null; from?: string | null } = {}) {
  return q(c, `
    select r.id, r.employee_id, e.first_name || ' ' || e.last_name employee, e.app_user_id, t.name type, t.kind, t.paid, r.starts_on::text starts_on,
           r.ends_on::text ends_on, r.hours_per_day::float hours_per_day, r.total_hours::float total_hours, r.note, r.status,
           r.requested_at::text requested_at, du.name decided_by, r.decision_note, r.cancel_reason
      from leave_request r join employee e on e.id = r.employee_id join leave_type t on t.id = r.leave_type_id
      left join app_user du on du.id = r.decided_by
     where r.entity_id = $1 and ($2::uuid is null or r.employee_id = $2) and ($3::text is null or r.status = $3)
       and ($4::date is null or r.ends_on >= $4::date)
     order by case r.status when 'requested' then 0 else 1 end, r.starts_on desc limit 200`,
    [entityId, f.employeeId ?? null, f.status ?? null, f.from ?? null]);
}

/** The approved leave on a day for a person, if any: the clock and the schedule ask this. */
export async function onLeave(c: Client, entityId: string, employeeId: string, day: string): Promise<string | null> {
  const r = await q<{ name: string }>(c, `
    select t.name from leave_request_day d join leave_request r on r.id = d.request_id join leave_type t on t.id = r.leave_type_id
     where d.entity_id = $1 and r.employee_id = $2 and d.day = $3::date and r.status = 'approved' and d.returned_at is null limit 1`, [entityId, employeeId, day]);
  return r[0]?.name ?? null;
}

// ------------------------------------------------------------ holidays --

export async function holidays(c: Client, entityId: string, from: string, to: string) {
  return q(c, `select h.id, h.day::text as day, h.name, h.store_closed, h.paid, h.hours::float hours, h.blackout_id, h.cancelled_at::text cancelled_at, h.cancel_reason,
                      (select count(*) from holiday_pay x join payroll_earning e on e.id = x.earning_id where x.holiday_id = h.id and e.status = 'approved')::int paid_people
                 from company_holiday h where h.entity_id = $1 and h.day between $2::date and $3::date order by h.day`, [entityId, from, to]);
}

/**
 * A company holiday. Stores closed: no deliveries that day (a blackout in every
 * zone). Stops already booked that day are listed and nothing is added until
 * the person confirms. Approved leave on the day is given back (paid as the holiday).
 */
export async function addHoliday(c: Client, scope: Scope, b: { day: string; name: string; storeClosed?: boolean; paid?: boolean; hours?: number; confirm?: boolean }) {
  need(isDay(b.day), "pick the day");
  const name = String(b.name ?? "").trim().slice(0, 80);
  need(name, "name the holiday");
  const dup = await q<{ name: string }>(c, `select name from company_holiday where entity_id = $1 and day = $2 and cancelled_at is null`, [scope.entityId, b.day]);
  need(!dup.length, `${dayWords(b.day)} is already a holiday (${dup[0]?.name})`);
  const closed = b.storeClosed !== false;
  const hours = r2(n(b.hours ?? 8));
  need(hours > 0 && hours <= 24, "holiday hours are more than 0 and at most 24");
  if (closed && !b.confirm) {
    const booked = await q<{ id: string; number: string; customer: string | null; kind: string }>(c, `
      select s.id, s.number, cu.name customer, s.kind from delivery_stop s left join customer cu on cu.id = s.customer_id
       where s.entity_id = $1 and s.scheduled_on = $2 and s.status in ('scheduled','arrived') order by s.number`, [scope.entityId, b.day]);
    if (booked.length) {
      return { created: false, confirmNeeded: true, stops: booked,
        warning: `${booked.length} stop${booked.length === 1 ? " is" : "s are"} already booked on ${dayWords(b.day)} (${booked.map((x) => x.number).join(", ")}). ` +
          `Closing the stores does not move them; move them in Delivery, or add the holiday anyway.` };
    }
  }
  const blackout = closed ? ((await addBlackout(c, scope, { day: b.day, reason: `${name} (stores closed)` })) as { id: string }).id : null;
  const r = await one<{ id: string }>(c, `insert into company_holiday (entity_id, day, name, store_closed, paid, hours, blackout_id, created_by)
                                          values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [scope.entityId, b.day, name, closed, b.paid !== false, hours, blackout, scope.actor.id || null]);
  const returned = b.paid !== false ? await returnLeaveFor(c, scope, r.id, b.day, name) : 0;
  await audit(c, scope, { table: "company_holiday", rowId: r.id, action: "insert", after: { day: b.day, name, closed, blackout, leaveDaysReturned: returned } });
  return { created: true, id: r.id, blackoutId: blackout, leaveDaysReturned: returned };
}

/** Approved leave on a paid holiday: the day is the holiday, so the leave hours go back and that day's leave pay is cancelled. */
async function returnLeaveFor(c: Client, scope: Scope, holidayId: string, day: string, name: string) {
  const days = await q<{ id: string; hours: string; request_id: string; employee_id: string; leave_type_id: string; kind: string; earning_id: string | null; run: string | null }>(c, `
    select d.id, d.hours, d.request_id, r.employee_id, r.leave_type_id, t.kind, d.earning_id, e.payroll_run_id run
      from leave_request_day d join leave_request r on r.id = d.request_id join leave_type t on t.id = r.leave_type_id
      left join payroll_earning e on e.id = d.earning_id
     where d.entity_id = $1 and d.day = $2::date and r.status = 'approved' and d.returned_at is null for update of d`, [scope.entityId, day]);
  let n0 = 0;
  for (const d of days) {
    if (d.run) continue;   // already paid in a run: payroll corrects it there
    await c.query(`update leave_request_day set returned_at = now(), returned_reason = $3, holiday_id = $4 where entity_id = $1 and id = $2`,
      [scope.entityId, d.id, `${name} is a paid holiday`, holidayId]);
    if (d.earning_id) await c.query(`update payroll_earning set status = 'cancelled' where entity_id = $1 and id = $2 and payroll_run_id is null`, [scope.entityId, d.earning_id]);
    if (d.kind !== "unpaid") {
      await c.query(`insert into leave_ledger (entity_id, employee_id, leave_type_id, occurred_on, kind, hours, request_id, note, created_by)
                     values ($1,$2,$3,$4,'reversal',$5,$6,$7,$8)`,
        [scope.entityId, d.employee_id, d.leave_type_id, day, n(d.hours), d.request_id, `${name} is a paid holiday; the hours come back`, scope.actor.id || null]);
    }
    n0++;
  }
  return n0;
}

/** Cancel a holiday: its delivery blackout is released and holiday pay not yet in a payroll run is cancelled. Nothing is deleted. */
export async function cancelHoliday(c: Client, scope: Scope, id: string, reason: string) {
  need(isId(id), "no such holiday");
  need(String(reason ?? "").trim().length >= 3, "say why the holiday is cancelled");
  const h = await q<{ id: string; day: string; name: string; blackout_id: string | null; cancelled_at: string | null }>(c, `
    select id, day::text as day, name, blackout_id, cancelled_at from company_holiday where entity_id = $1 and id = $2 for update`, [scope.entityId, id]);
  need(h.length, "no such holiday");
  need(!h[0].cancelled_at, `${h[0].name} is already cancelled`);
  const why = String(reason).trim().slice(0, 300);
  await c.query(`update company_holiday set cancelled_at = now(), cancelled_by = $3, cancel_reason = $4 where entity_id = $1 and id = $2`, [scope.entityId, id, scope.actor.id || null, why]);
  if (h[0].blackout_id) {
    await c.query(`update delivery_blackout set released_at = now(), release_reason = $3 where entity_id = $1 and id = $2 and released_at is null`,
      [scope.entityId, h[0].blackout_id, `holiday cancelled: ${why}`]);
  }
  const pay = await q<{ paid: number; cancelled: number }>(c, `
    with x as (select e.id, e.payroll_run_id, e.status from holiday_pay hp join payroll_earning e on e.id = hp.earning_id where hp.entity_id = $1 and hp.holiday_id = $2),
         u as (update payroll_earning e set status = 'cancelled' from x where e.id = x.id and e.entity_id = $1 and x.payroll_run_id is null and x.status = 'approved' returning e.id)
    select (select count(*) from x where payroll_run_id is not null and status = 'approved')::int paid, (select count(*) from u)::int cancelled`, [scope.entityId, id]);
  await audit(c, scope, { table: "company_holiday", rowId: id, action: "transition", after: { cancelled: true, payCancelled: pay[0].cancelled }, reason: why });
  return { status: "cancelled", blackoutReleased: !!h[0].blackout_id, holidayPayCancelled: pay[0].cancelled, alreadyPaid: pay[0].paid };
}

/**
 * Before a payroll run: paid leave days and paid holidays in the period become
 * payroll earnings for the group's hourly people (once each). payroll.buildRun
 * calls this; it may also be run by hand.
 */
export async function leavePayForPeriod(c: Client, scope: Scope, payPeriodId: string, by: string | null) {
  const pp = await q<{ pay_group_id: string; starts_on: string; ends_on: string; status: string }>(c, `
    select pp.pay_group_id, pp.starts_on::text starts_on, pp.ends_on::text ends_on, pp.status from pay_period pp
      join pay_group pg on pg.id = pp.pay_group_id and pg.entity_id = $1 where pp.id = $2`, [scope.entityId, payPeriodId]);
  if (!pp.length || !["open", "timecards_approved"].includes(pp[0].status)) return { leaveDays: 0, holidayPay: 0 };
  const p0 = pp[0];
  let leaveDays = 0, holidayPay = 0;
  const days = await q<{ id: string; day: string; hours: string; request_id: string; employee_id: string; type: string }>(c, `
    select d.id, d.day::text as day, d.hours, d.request_id, r.employee_id, t.name type
      from leave_request_day d join leave_request r on r.id = d.request_id join leave_type t on t.id = r.leave_type_id
      join employee e on e.id = r.employee_id
     where d.entity_id = $1 and r.status = 'approved' and t.paid and d.earning_id is null and e.pay_group_id = $2 and d.returned_at is null
       and d.day between $3::date and $4::date`, [scope.entityId, p0.pay_group_id, p0.starts_on, p0.ends_on]);
  for (const d of days) {
    const p = await person(c, scope.entityId, d.employee_id);
    if (await payDay(c, scope, p, d, d.type, d.request_id, by)) leaveDays++;
  }
  const hols = await q<{ id: string; day: string; name: string; hours: string }>(c, `
    select id, day::text as day, name, hours from company_holiday where entity_id = $1 and paid and cancelled_at is null and day between $2::date and $3::date`,
    [scope.entityId, p0.starts_on, p0.ends_on]);
  for (const h of hols) {
    const people = await q<{ id: string; base_rate_minor: string }>(c, `
      select e.id, e.base_rate_minor from employee e
       where e.entity_id = $1 and e.pay_group_id = $2 and e.pay_type = 'hourly' and e.status = 'active' and e.hired_on <= $3::date
         and not exists (select 1 from holiday_pay x where x.holiday_id = $4 and x.employee_id = e.id)
         and not exists (select 1 from leave_request_day d join leave_request r on r.id = d.request_id
                          where d.entity_id = $1 and r.employee_id = e.id and d.day = $3::date and r.status = 'approved' and d.returned_at is null and d.earning_id is not null)`,
      [scope.entityId, p0.pay_group_id, h.day, h.id]);
    for (const p of people) {
      const amt = BigInt(Math.round(n(h.hours) * 100)) * BigInt(p.base_rate_minor) / 100n;
      if (amt <= 0n) continue;
      const e = await one<{ id: string }>(c, `
        insert into payroll_earning (entity_id, employee_id, pay_period_id, kind, amount_minor, debit_code, source_type, source_id, memo, created_by)
        values ($1,$2,$3,'other',$4,'6100','holiday',$5,$6,$7) returning id`,
        [scope.entityId, p.id, payPeriodId, amt.toString(), h.id, `Holiday pay: ${h.name}, ${n(h.hours)} h`, by]);
      await c.query(`insert into holiday_pay (entity_id, holiday_id, employee_id, earning_id) values ($1,$2,$3,$4)`, [scope.entityId, h.id, p.id, e.id]);
      holidayPay++;
    }
  }
  // paid once: on a paid leave day, worked hours plus leave hours are no more than the day's hours
  const over = await q<{ name: string; day: string; worked: string; leave: string; day_hours: string }>(c, `
    select e.first_name || ' ' || e.last_name name, d.day::text as day, sum(tc.hours)::text worked, d.hours::text leave, r.hours_per_day::text day_hours
      from leave_request_day d join leave_request r on r.id = d.request_id join leave_type t on t.id = r.leave_type_id
      join employee e on e.id = r.employee_id
      join timecard tc on tc.employee_id = e.id and tc.worked_on = d.day and tc.status <> 'rejected'
     where d.entity_id = $1 and r.status = 'approved' and t.paid and d.returned_at is null and e.pay_group_id = $2 and d.day between $3::date and $4::date
     group by e.first_name, e.last_name, d.day, d.hours, r.hours_per_day
    having sum(tc.hours) + d.hours > r.hours_per_day`, [scope.entityId, p0.pay_group_id, p0.starts_on, p0.ends_on]);
  need(!over.length, over.length ? `${over[0].name} has ${n(over[0].worked)} h worked and ${n(over[0].leave)} h paid leave on ${dayWords(over[0].day)}, ` +
    `more than the day's ${n(over[0].day_hours)} h; fix the time or take back the leave before building payroll` : "");
  return { leaveDays, holidayPay };
}

// ------------------------------------------------------------ the card --

/**
 * For managers: who is off today (approved leave), today's holiday, and who
 * was due on a shift that has started but has not punched in.
 */
export async function absentToday(c: Client, entityId: string, locationId: string | null) {
  const tz = (await one<{ tz: string }>(c, `select coalesce((select timezone from workforce_settings where entity_id = $1), 'America/New_York') tz`, [entityId])).tz;
  const day = (await one<{ d: string }>(c, `select (now() at time zone $1)::date::text d /* unscoped: the clock */`, [tz])).d;
  const onLeaveToday = await q(c, `
    select e.id employee_id, e.first_name || ' ' || e.last_name name, t.name type, t.kind, r.ends_on::text back_after, d.hours::float hours
      from leave_request_day d join leave_request r on r.id = d.request_id join leave_type t on t.id = r.leave_type_id join employee e on e.id = r.employee_id
      left join profit_object po on po.id = e.profit_object_id
     where d.entity_id = $1 and d.day = $2::date and r.status = 'approved' and d.returned_at is null and ($3::uuid is null or po.location_id = $3)
     order by e.last_name`, [entityId, day, locationId]);
  const noShow = await q(c, `
    select e.id employee_id, e.first_name || ' ' || e.last_name name, lo.name location, to_char(w.starts_at at time zone $4, 'HH24:MI') starts
      from work_shift w join employee e on e.id = w.employee_id join location lo on lo.id = w.location_id
     where w.entity_id = $1 and w.status = 'scheduled' and (w.starts_at at time zone $4)::date = $2::date and w.starts_at < now() - interval '15 minutes'
       and ($3::uuid is null or w.location_id = $3)
       and not exists (select 1 from time_punch p where p.entity_id = $1 and p.employee_id = e.id and p.work_day = $2::date and p.kind = 'in' and p.voided_at is null)
     order by w.starts_at`, [entityId, day, locationId, tz]);
  const hol = await q(c, `select name, store_closed from company_holiday where entity_id = $1 and day = $2::date and cancelled_at is null`, [entityId, day]);
  return { day, holiday: hol[0] ?? null, onLeave: onLeaveToday, noShow };
}

