// workforce module -- time clock, schedules, commissions into payroll.
// See docs/MODULES.md for the contract. Handlers are exported (H) so the
// checks call exactly what a route calls, role checks included.

import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, need, requireRole, str, uuid, int, minor } from "./kit.ts";
import { scopeOf, rolesOf } from "../actions.ts";
import { q, one } from "../../packages/core/db.ts";
import { PostingError } from "../../packages/core/posting.ts";
import * as wf from "../../packages/core/workforce.ts";

const today = () => new Date().toISOString().slice(0, 10);
const day = (v: unknown, dflt: string) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : dflt; };
const bpsOf = (v: unknown) => { const n = Number(v); need(Number.isFinite(n) && n >= 0 && n <= 100, "a rate is 0% to 100%"); return Math.round(n * 100); };

function wrap<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return async (...a: A) => {
    try { return await fn(...a); }
    catch (e) {
      if (e instanceof wf.WorkforceError || e instanceof PostingError) throw new ModuleError(e.message);
      throw e;
    }
  };
}

const MANAGE = ["store_manager", "hr"];
const PAYPLANS = ["hr", "controller"];

async function myEmployee(c: Client, co: Company, personId: string | null) {
  if (!personId) return null;
  const r = await q<{ id: string }>(c, `select id from employee where entity_id = $1 and app_user_id = $2 and status = 'active' limit 1`, [co.id, personId]);
  return r[0]?.id ?? null;
}

async function locationOf(c: Client, co: Company, v: unknown): Promise<string> {
  const id = uuid(v);
  need(id, "pick the store");
  const r = await q(c, `select 1 from location where id = $1 and entity_id = $2`, [id, co.id]);
  need(r.length, "pick the store");
  return id;
}

export const H = {
  options: wrap(async (c: Client, co: Company, personId: string | null) => {
    const locations = await q(c, `select id, name, kind from location where entity_id = $1 and kind in ('store','warehouse','outlet','office') order by code`, [co.id]);
    const employees = await q(c, `select e.id, e.first_name || ' ' || e.last_name name, e.position, e.pay_type, e.app_user_id, po.location_id home_location_id
                                    from employee e left join profit_object po on po.id = e.profit_object_id
                                   where e.entity_id = $1 and e.status = 'active' order by e.last_name, e.first_name`, [co.id]);
    const periods = await q(c, `select pp.id, pg.name pay_group, pp.starts_on::text, pp.ends_on::text, pp.pay_date::text, pp.status
                                  from pay_period pp join pay_group pg on pg.id = pp.pay_group_id and pg.entity_id = $1
                                 where pp.status in ('open','timecards_approved','built','released','posted') order by pp.ends_on desc, pg.name limit 30`, [co.id]);
    const sellers = await q(c, `select distinct u.id, u.name from app_user u join role_grant g on g.app_user_id = u.id
                                 where (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $2)) and g.role in ('sales','store_manager','designer','owner')
                                 order by u.name`, [co.id, co.tenantId]);
    const mine = await myEmployee(c, co, personId);
    const roles = personId ? [...(await rolesOf(c, co, personId))] : [];
    return { locations, employees, periods, sellers, me: { employeeId: mine, roles } };
  }),

  me: wrap(async (c: Client, co: Company, personId: string | null) => {
    const id = await myEmployee(c, co, personId);
    if (!id) return { employee: null };
    const e = await wf.employeeOf(c, co.id, id);
    const last = await q<{ kind: string; at: string; work_day: string; location_id: string; location: string }>(c, `
      select p.kind, p.at::text, p.work_day::text, p.location_id, lo.name location from time_punch p join location lo on lo.id = p.location_id
       where p.entity_id = $1 and p.employee_id = $2 and p.voided_at is null order by p.at desc limit 1`, [co.id, id]);
    const recent = await wf.punchesFor(c, co.id, id, new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), today());
    const hours = await q(c, `select t.worked_on::text, t.hours::text, t.status from timecard t join employee e on e.id = t.employee_id and e.entity_id = $1
                               where t.employee_id = $2 and t.worked_on >= current_date - 13 order by t.worked_on desc`, [co.id, id]);
    // In the store's own time, whatever zone the phone is in.
    const shifts = await q(c, `select w.id, w.role, lo.name location, x.tz,
                                      (w.starts_at at time zone x.tz)::date::text on_day,
                                      to_char(w.starts_at at time zone x.tz, 'HH24:MI') starts, to_char(w.ends_at at time zone x.tz, 'HH24:MI') ends
                                 from work_shift w join location lo on lo.id = w.location_id
                                 cross join lateral (select coalesce((select timezone from workforce_location wl where wl.location_id = w.location_id and wl.entity_id = $1),
                                                                     (select timezone from workforce_settings ws where ws.entity_id = $1), (select time_zone from fleet_setting fs where fs.entity_id = $1), 'America/New_York') tz) x
                                where w.entity_id = $1 and w.employee_id = $2 and w.status = 'scheduled' and w.ends_at >= now() order by w.starts_at limit 7`, [co.id, id]);
    return { employee: e, last: last[0] ?? null, recent, hours, shifts };
  }),

  board: wrap(async (c: Client, co: Company, locationId: string | null) => wf.clockBoard(c, co.id, uuid(locationId))),
  exceptions: wrap(async (c: Client, co: Company) => wf.exceptions(c, co.id)),
  punches: wrap(async (c: Client, co: Company, employeeId: string, from: string, to: string) => {
    const id = uuid(employeeId); need(id, "pick the person");
    await wf.employeeOf(c, co.id, id);
    return wf.punchesFor(c, co.id, id, from, to);
  }),

  /** Punch: yourself from a phone, or (a manager) for someone else with a reason. */
  punch: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    const mine = await myEmployee(c, co, a.personId);
    const target = uuid(b.employeeId) ?? mine;
    need(target, "you are not set up as an employee here, so there is nobody to punch in");
    const forSelf = target === mine;
    if (!forSelf || b.at) await requireRole(c, co, a, MANAGE, forSelf ? "entering a punch at another time" : "punching for someone else");
    if (!forSelf) {
      const e = await wf.employeeOf(c, co.id, target);
      need(e.app_user_id !== a.personId, "nobody enters their own time this way");
    }
    const loc = await locationOf(c, co, b.locationId);
    const g = b.geo as { lng?: unknown; lat?: unknown } | undefined;
    const manual = !forSelf || !!b.at;
    return wf.punch(c, scopeOf(co, a), { employeeId: target, locationId: loc, kind: str(b.kind, 12) as wf.PunchKind, at: str(b.at, 40) || null,
      source: manual ? "manager" : (b.source === "kiosk" ? "kiosk" : "phone"), reason: str(b.reason, 500) || null,
      geo: g ? { lng: Number(g.lng), lat: Number(g.lat) } : null, byId: a.personId });
  }),

  fix: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, MANAGE, "changing someone's punch");
    const pid = uuid(id); need(pid, "no such punch");
    return wf.fixPunch(c, scopeOf(co, a), pid, { at: str(b.at, 40) || null, reason: str(b.reason, 500), byId: a.personId });
  }),

  schedule: wrap(async (c: Client, co: Company, locationId: string, weekStart: string) => {
    const loc = await locationOf(c, co, locationId);
    return wf.week(c, co.id, loc, weekStart);
  }),

  addShift: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, MANAGE, "scheduling shifts");
    const emp = uuid(b.employeeId); need(emp, "pick the person");
    return { shiftId: await wf.addShift(c, scopeOf(co, a), { locationId: await locationOf(c, co, b.locationId), employeeId: emp,
      startsAt: str(b.startsAt, 40), endsAt: str(b.endsAt, 40), role: str(b.role, 40) || null, notes: str(b.notes, 300) || null }) };
  }),

  cancelShift: wrap(async (c: Client, co: Company, a: Actor, id: string) => {
    await requireRole(c, co, a, MANAGE, "cancelling a shift");
    const sid = uuid(id); need(sid, "no such shift");
    await wf.cancelShift(c, scopeOf(co, a), sid);
    return { ok: true };
  }),

  // ------------------------------------------------------------ commissions
  commissions: wrap(async (c: Client, co: Company) => {
    const plans = await q(c, `select id, name, basis, rate_bps, active, notes from commission_plan where entity_id = $1 order by active desc, name`, [co.id]);
    const tiers = await q(c, `select id, plan_id, min_monthly_minor, rate_bps from commission_tier where entity_id = $1 order by plan_id, min_monthly_minor`, [co.id]);
    const rules = await q(c, `select r.id, r.plan_id, r.category, r.vendor_id, v.legal_name vendor, r.rate_bps from commission_rule r left join vendor v on v.id = r.vendor_id
                               where r.entity_id = $1 order by r.plan_id, r.category, v.legal_name`, [co.id]);
    const assignments = await q(c, `select a.id, a.app_user_id, u.name, a.plan_id, p.name plan, a.effective_from::text, a.effective_to::text, a.draw_minor, a.draw_recoverable,
                                           exists (select 1 from employee e where e.entity_id = $1 and e.app_user_id = a.app_user_id and e.status = 'active') on_payroll
                                      from commission_assignment a join app_user u on u.id = a.app_user_id join commission_plan p on p.id = a.plan_id
                                     where a.entity_id = $1 and (a.effective_to is null or a.effective_to >= current_date) order by u.name`, [co.id]);
    const spiffs = await q(c, `select s.id, s.name, s.product_id, pr.sku, pr.name product, s.vendor_id, v.legal_name vendor, s.amount_minor, s.starts_on::text, s.ends_on::text, s.active
                                 from spiff s left join product pr on pr.id = s.product_id left join vendor v on v.id = s.vendor_id
                                where s.entity_id = $1 order by s.active desc, s.ends_on desc`, [co.id]);
    const accrued = await q(c, `select ev.app_user_id, u.name, sum(ev.amount_minor)::text amount_minor, count(*)::int events
                                  from commission_event ev join app_user u on u.id = ev.app_user_id
                                 where ev.entity_id = $1 and ev.status = 'accrued' and ev.amount_minor <> 0 group by ev.app_user_id, u.name order by u.name`, [co.id]);
    const payouts = await q(c, `select cp.id, cp.pay_period_id, pp.ends_on::text, u.name, cp.commission_minor, cp.payout_minor, cp.topup_minor, cp.recovered_minor, cp.draw_balance_minor
                                  from commission_payout cp join app_user u on u.id = cp.app_user_id join pay_period pp on pp.id = cp.pay_period_id
                                 where cp.entity_id = $1 order by cp.approved_at desc limit 30`, [co.id]);
    const products = await q(c, `select id, sku, name from product where entity_id = $1 and status = 'active' order by sku`, [co.id]);
    const vendors = await q(c, `select distinct v.id, v.legal_name name from vendor v join product p on p.vendor_id = v.id and p.entity_id = $1 order by v.legal_name`, [co.id]);
    const categories = await q(c, `select distinct category from product where entity_id = $1 and category is not null order by category`, [co.id]);
    const gl2160 = await one<{ b: string }>(c, `select coalesce(sum(jl.credit_minor - jl.debit_minor),0)::text b from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
                                                 join gl_account g on g.id = jl.gl_account_id where je.entity_id = $1 and g.code = '2160'`, [co.id]);
    return { plans, tiers, rules, assignments, spiffs, accrued, payouts, products, vendors, categories: categories.map((x) => x.category), payableMinor: gl2160.b };
  }),

  savePlan: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, PAYPLANS, "setting up commission plans");
    const name = str(b.name, 80); need(name, "name the plan");
    const basis = b.basis === "margin" ? "margin" : "sale";
    const id = uuid(b.id);
    if (id) {
      const r = await q(c, `update commission_plan set name = $3, basis = $4, rate_bps = $5, active = $6, notes = $7 where id = $1 and entity_id = $2 returning id`,
        [id, co.id, name, basis, bpsOf(b.rate), b.active !== false, str(b.notes, 300) || null]);
      need(r.length, "no such plan");
      return { planId: id };
    }
    const r = await one<{ id: string }>(c, `insert into commission_plan (entity_id, name, basis, rate_bps, notes) values ($1,$2,$3,$4,$5) returning id`,
      [co.id, name, basis, bpsOf(b.rate), str(b.notes, 300) || null]);
    return { planId: r.id };
  }),

  addTier: wrap(async (c: Client, co: Company, a: Actor, planId: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, PAYPLANS, "setting up commission plans");
    const p = await q(c, `select 1 from commission_plan where id = $1 and entity_id = $2`, [planId, co.id]); need(p.length, "no such plan");
    const r = await one<{ id: string }>(c, `insert into commission_tier (entity_id, plan_id, min_monthly_minor, rate_bps) values ($1,$2,$3,$4)
                                             on conflict (plan_id, min_monthly_minor) do update set rate_bps = excluded.rate_bps returning id`,
      [co.id, planId, minor(b.from).toString(), bpsOf(b.rate)]);
    return { tierId: r.id };
  }),

  addRule: wrap(async (c: Client, co: Company, a: Actor, planId: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, PAYPLANS, "setting up commission plans");
    const p = await q(c, `select 1 from commission_plan where id = $1 and entity_id = $2`, [planId, co.id]); need(p.length, "no such plan");
    const category = str(b.category, 60) || null, vendor = uuid(b.vendorId);
    need(category || vendor, "a rule is for a category or a vendor");
    const r = await one<{ id: string }>(c, `insert into commission_rule (entity_id, plan_id, category, vendor_id, rate_bps) values ($1,$2,$3,$4,$5) returning id`,
      [co.id, planId, category, vendor, bpsOf(b.rate)]);
    return { ruleId: r.id };
  }),

  assign: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, PAYPLANS, "putting someone on a commission plan");
    const user = uuid(b.appUserId), plan = uuid(b.planId); need(user && plan, "pick the person and the plan");
    const p = await q(c, `select 1 from commission_plan where id = $1 and entity_id = $2 and active`, [plan, co.id]); need(p.length, "no such plan");
    const from = day(b.from, today());
    // A new assignment ends the one before it.
    await c.query(`update commission_assignment set effective_to = $3::date - 1 where entity_id = $1 and app_user_id = $2
                     and (effective_to is null or effective_to >= $3::date) and effective_from < $3::date`, [co.id, user, from]);
    await c.query(`update commission_assignment set effective_to = effective_from where entity_id = $1 and app_user_id = $2 and effective_from >= $3::date and effective_to is null`, [co.id, user, from]);
    const r = await one<{ id: string }>(c, `insert into commission_assignment (entity_id, app_user_id, plan_id, effective_from, draw_minor, draw_recoverable)
                                             values ($1,$2,$3,$4,$5,$6) returning id`, [co.id, user, plan, from, minor(b.draw ?? "0").toString(), b.recoverable !== false]);
    return { assignmentId: r.id };
  }),

  addSpiff: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, PAYPLANS, "setting up spiffs");
    const name = str(b.name, 80); need(name, "name the spiff");
    const product = uuid(b.productId), vendor = uuid(b.vendorId);
    need(product || vendor, "a spiff is on a SKU or a vendor");
    const amt = minor(b.amount); need(amt > 0n, "a spiff pays something per unit");
    const from = day(b.from, ""), to = day(b.to, "");
    need(from && to && to >= from, "a spiff runs from a start date to an end date");
    const r = await one<{ id: string }>(c, `insert into spiff (entity_id, name, product_id, vendor_id, amount_minor, starts_on, ends_on) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [co.id, name, product, vendor, amt.toString(), from, to]);
    return { spiffId: r.id };
  }),

  endSpiff: wrap(async (c: Client, co: Company, a: Actor, id: string) => {
    await requireRole(c, co, a, PAYPLANS, "ending a spiff");
    const r = await q(c, `update spiff set active = false where id = $1 and entity_id = $2 returning id`, [id, co.id]);
    need(r.length, "no such spiff");
    return { ok: true };
  }),

  setSplits: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ["sales", "store_manager", "cashier"], "splitting a sale");
    const order = uuid(b.orderId); need(order, "pick the order");
    const so = await q<{ status: string }>(c, `select status from sales_order where id = $1 and entity_id = $2`, [order, co.id]);
    need(so.length, "no such order");
    const rows = Array.isArray(b.splits) ? (b.splits as Record<string, unknown>[]) : [];
    need(rows.length, "name who sold it");
    const parsed = rows.map((r) => ({ user: uuid(r.appUserId), bps: bpsOf(r.pct) }));
    need(parsed.every((p) => p.user && p.bps > 0), "each salesperson needs a share");
    need(new Set(parsed.map((p) => p.user)).size === parsed.length, "the same person is named twice");
    need(parsed.reduce((x, p) => x + p.bps, 0) === 10000, "the shares add up to 100%");
    const earned = await q(c, `select 1 from commission_event where entity_id = $1 and sales_order_id = $2 limit 1`, [co.id, order]);
    need(!earned.length, "commission has already been earned on this order, so its split cannot change");
    await c.query(`delete from sales_order_salesperson where entity_id = $1 and sales_order_id = $2`, [co.id, order]);
    for (const p of parsed) {
      await c.query(`insert into sales_order_salesperson (entity_id, sales_order_id, app_user_id, split_bps) values ($1,$2,$3,$4)`, [co.id, order, p.user, p.bps]);
    }
    return { ok: true };
  }),

  accrue: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ["controller", "hr"], "accruing commissions");
    return wf.accrueCommissions(c, scopeOf(co, a), { orderId: uuid(b.orderId) });
  }),

  approve: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ["controller", "hr"], "approving commissions for payroll");
    const pp = uuid(b.payPeriodId); need(pp, "pick the pay period");
    const s = scopeOf(co, a);
    await wf.accrueCommissions(c, s);
    return wf.approveCommissions(c, s, pp, a.personId);
  }),

  statement: wrap(async (c: Client, co: Company, periodId: string, person: string, viewer: string | null) => {
    const pp = uuid(periodId), u = uuid(person) ?? viewer; need(pp && u, "pick the pay period and the person");
    // A salesperson sees their own; someone else's takes a manager, payroll or the controller.
    if (viewer && u !== viewer) {
      const held = await rolesOf(c, co, viewer);
      need(["owner", "controller", "hr", "store_manager"].some((r) => held.has(r)), "another person's commission statement needs one of: controller, hr, store manager");
    }
    return wf.commissionStatement(c, co.id, pp, u);
  }),

  leaderboard: wrap(async (c: Client, co: Company, from: string, to: string) => ({ from, to, rows: await wf.leaderboard(c, co.id, from, to) })),
};

const ID = "([0-9a-fA-F-]{36})";

export const module: ErpModule = {
  id: "workforce",
  register(kit) {
    const g = (u: URL, k: string) => u.searchParams.get(k) ?? "";
    const monthStart = () => today().slice(0, 8) + "01";
    kit.coGet("/workforce/options", (c, co, _u, _m, p) => H.options(c, co, p));
    kit.coGet("/workforce/me", (c, co, _u, _m, p) => H.me(c, co, p));
    kit.coGet("/workforce/clock", (c, co, u) => H.board(c, co, g(u, "location") || null));
    kit.coGet("/workforce/exceptions", (c, co) => H.exceptions(c, co));
    kit.coGet("/workforce/punches", (c, co, u) => H.punches(c, co, g(u, "employee"), day(g(u, "from"), today()), day(g(u, "to"), today())));
    kit.coGet("/workforce/schedule", (c, co, u) => H.schedule(c, co, g(u, "location"), day(g(u, "week"), today())));
    kit.coGet("/workforce/commissions", (c, co) => H.commissions(c, co));
    kit.coGet("/workforce/commissions/statement", (c, co, u, _m, p) => H.statement(c, co, g(u, "period"), g(u, "person"), p));
    kit.coGet("/workforce/leaderboard", (c, co, u) => H.leaderboard(c, co, day(g(u, "from"), monthStart()), day(g(u, "to"), today())));

    kit.coPost("/workforce/punch", (c, co, a, b) => H.punch(c, co, a, b));
    kit.coPost(`/workforce/punches/${ID}/fix`, (c, co, a, b, m) => H.fix(c, co, a, m[2], b));
    kit.coPost("/workforce/shifts", (c, co, a, b) => H.addShift(c, co, a, b));
    kit.coPost(`/workforce/shifts/${ID}/cancel`, (c, co, a, _b, m) => H.cancelShift(c, co, a, m[2]));
    kit.coPost("/workforce/commissions/plans", (c, co, a, b) => H.savePlan(c, co, a, b));
    kit.coPost(`/workforce/commissions/plans/${ID}/tiers`, (c, co, a, b, m) => H.addTier(c, co, a, m[2], b));
    kit.coPost(`/workforce/commissions/plans/${ID}/rules`, (c, co, a, b, m) => H.addRule(c, co, a, m[2], b));
    kit.coPost("/workforce/commissions/assignments", (c, co, a, b) => H.assign(c, co, a, b));
    kit.coPost("/workforce/commissions/spiffs", (c, co, a, b) => H.addSpiff(c, co, a, b));
    kit.coPost(`/workforce/commissions/spiffs/${ID}/end`, (c, co, a, _b, m) => H.endSpiff(c, co, a, m[2]));
    kit.coPost("/workforce/commissions/splits", (c, co, a, b) => H.setSplits(c, co, a, b));
    kit.coPost("/workforce/commissions/accrue", (c, co, a, b) => H.accrue(c, co, a, b));
    kit.coPost("/workforce/commissions/approve", (c, co, a, b) => H.approve(c, co, a, b));
  },
};
