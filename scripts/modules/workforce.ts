// Workforce checks: the clock feeding payroll timecards, schedules, and
// commissions earned on delivery, charged back on return, approved with a
// draw, and paid through the payroll run -- with 2160 back at zero after.
// Each asserts the refusal as well as the success.

import type { T } from "./harness.ts";
import { ENTITY, RIO_ENTITY, LOC, PEOPLE } from "./harness.ts";
import type { Client } from "../../packages/core/db.ts";
import { one, q, tx, pool } from "../../packages/core/db.ts";
import { loadCompany } from "../../server/views.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";
import { H } from "../../server/modules/workforce.ts";
import { approveTimecards } from "../../server/actions.ts";
import * as ar from "../../packages/core/ar.ts";
import * as wf from "../../packages/core/workforce.ts";
import { buildRun, requestRelease, release, postRun, IllustrativeTaxProvider } from "../../packages/core/payroll.ts";
import { decide } from "../../packages/core/approvals.ts";

const MARIA = "55555555-0000-0000-0000-000000000011";     // sales; employee E-3001, hourly $15
const MGR = "55555555-0000-0000-0000-000000000018";       // store manager + sales; employee E-3002
const JEN = "55555555-0000-0000-0000-000000000017";       // ar_clerk
const E_MARIA = "aaaa0000-0000-0000-0000-000000000011";
const E_MGR = "aaaa0000-0000-0000-0000-000000000012";
const PERIOD = "cccc0000-0000-0000-0000-000000000003";    // Sales floor, the week ending today
const P = (n: number) => `77777777-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const B = (v: unknown) => BigInt(String(v ?? 0));
const today = () => new Date().toISOString().slice(0, 10);

// The shared harness's company() lookup is refused by the entity guard, so
// these checks look the company up through the server's loadCompany.
async function company(id = ENTITY): Promise<Company> {
  const c = await pool.connect();
  try { const co = await loadCompany(c, id); if (!co) throw new Error("no company " + id); return co; } finally { c.release(); }
}
async function as<R>(personId: string, fn: (c: Client, co: Company, a: Actor) => Promise<R>): Promise<R> {
  const c0 = await pool.connect();
  let name = "?";
  try { name = (await q<{ name: string }>(c0, "select name from app_user where id = $1 /* unscoped: lookup */", [personId]))[0]?.name ?? "?"; }
  finally { c0.release(); }
  const co = await company();
  return tx({ kind: "user", id: personId, label: name }, (c) => fn(c, co, { personId, personName: name, label: name }));
}
const scope = (person: string) => ({ tenantId: "11111111-1111-1111-1111-111111111111", entityId: ENTITY, actor: { kind: "user" as const, id: person, label: "check" } });

/** A local time at Enola on a day, as an ISO instant. */
async function ny(c: Client, day: string, hm: string): Promise<string> {
  return (await one<{ t: string }>(c, `select to_char((($1::date + $2::time) at time zone 'America/New_York') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') t /* unscoped: arithmetic */`, [day, hm])).t;
}
const dayOf = async (c: Client, n: number) => (await one<{ d: string }>(c, `select (current_date - $1::int)::text d /* unscoped: arithmetic */`, [n])).d;

async function order(c: Client, salesperson: string, lines: { product: number; qty?: number; price: number; tax?: number }[], fulfil = true) {
  const no = (await one<{ n: string }>(c, `select next_doc_no($1,'order','SO-') n /* unscoped: numbering */`, [ENTITY])).n;
  const so = await one<{ id: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, salesperson_id, status, fulfillment)
                                            values ($1,$2,'pos',$3,'88888888-0000-0000-0000-000000000001',$4,'open','carry') returning id`, [ENTITY, no, LOC.ENOLA, salesperson]);
  const ids: string[] = [];
  let seq = 1;
  for (const l of lines) {
    const p = await one<{ sku: string; name: string }>(c, `select sku, name from product where id = $1 and entity_id = $2`, [P(l.product), ENTITY]);
    ids.push((await one<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, tax_minor, line_status)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [ENTITY, so.id, seq++, P(l.product), p.sku, p.name, l.qty ?? 1, l.price, l.tax ?? 0, fulfil ? "fulfilled" : "open"])).id);
  }
  await c.query(`select sales_order_retotal($1) /* unscoped: by order id */`, [so.id]);
  return { id: so.id, lineIds: ids };
}
// Through any date: the payroll entry posts on its pay date, after today.
const gl = async (c: Client, code: string) => ar.glBalance(c, ENTITY, code, "9999-12-31");

export async function run(t: T) {
  // ------------------------------------------------------------ the clock --
  console.log("  -- time clock into payroll timecards");
  const p1 = await as(MARIA, (c, co, a) => H.punch(c, co, a, { kind: "in", locationId: LOC.ENOLA, geo: { lng: -76.93, lat: 40.26 } }));
  t.ok("a salesperson punches in from a phone, and the open day blocks payroll as an exception", p1.workDay === today() && p1.status === "exception", `${p1.workDay} ${p1.status}`);
  await t.throws("punching in twice is refused", () => as(MARIA, (c, co, a) => H.punch(c, co, a, { kind: "in", locationId: LOC.ENOLA })), /twice/);
  await t.throws("a break cannot end before it starts", () => as(MARIA, (c, co, a) => H.punch(c, co, a, { kind: "break_end", locationId: LOC.ENOLA })), /had not started/);
  await as(MARIA, (c, co, a) => H.punch(c, co, a, { kind: "break_start", locationId: LOC.ENOLA }));
  await t.throws("punching out on a break is refused", () => as(MARIA, (c, co, a) => H.punch(c, co, a, { kind: "out", locationId: LOC.ENOLA })), /end the break first/);
  await as(MARIA, (c, co, a) => H.punch(c, co, a, { kind: "break_end", locationId: LOC.ENOLA }));
  const p2 = await as(MARIA, (c, co, a) => H.punch(c, co, a, { kind: "out", locationId: LOC.ENOLA }));
  t.ok("punching out closes the day as a recorded timecard", p2.status === "recorded");
  await t.throws("a salesperson cannot enter her own time at another hour",
    () => as(MARIA, async (c, co, a) => H.punch(c, co, a, { kind: "in", locationId: LOC.ENOLA, at: await ny(c, await dayOf(c, 5), "09:00") })), /needs one of: store manager, hr/);

  const d1 = await as(MGR, (c) => dayOf(c, 5)), d2 = await as(MGR, (c) => dayOf(c, 4)), d3 = await as(MGR, (c) => dayOf(c, 3));
  await t.throws("a manager's entry needs a reason",
    () => as(MGR, async (c, co, a) => H.punch(c, co, a, { employeeId: E_MARIA, kind: "in", locationId: LOC.ENOLA, at: await ny(c, d1, "09:00") })), /reason/);
  const enter = (day: string, kind: string, hm: string, reason = "Forgot to punch, confirmed on schedule") =>
    as(MGR, async (c, co, a) => H.punch(c, co, a, { employeeId: E_MARIA, kind, locationId: LOC.ENOLA, at: await ny(c, day, hm), reason }));
  await enter(d1, "in", "09:00"); await enter(d1, "break_start", "12:00"); await enter(d1, "break_end", "12:30");
  const day1 = await enter(d1, "out", "17:30");
  t.ok("a day's hours are ins to outs less the unpaid break", day1.hours === 8 && day1.status === "recorded", `${day1.hours} h`);
  await enter(d2, "in", "09:00");
  const day2 = await enter(d2, "out", "17:00");
  const day3 = await enter(d3, "in", "09:00");
  t.ok("a day still punched in is held as an exception", day3.status === "exception");
  const ex = await as(MGR, (c, co) => H.exceptions(c, co));
  const mine = ex.find((x) => x.employee_id === E_MARIA && x.worked_on === d3);
  t.ok("an open day older than the setting is listed as a missed punch", !!mine && mine.missed && mine.label === "Missed punch", mine?.label);
  await t.throws("payroll cannot be built over a missed punch",
    () => as(JEN, async (c, co, a) => { await approveTimecards(c, co, a, { periodId: PERIOD }); return buildRun(c, scope(JEN), { payPeriodId: PERIOD, builtBy: JEN, taxProvider: new IllustrativeTaxProvider() }); }),
    /unapproved timecards/);
  const fix3 = await enter(d3, "out", "15:00", "Left at 3 for a doctor's visit, per the manager");
  t.ok("entering the missing punch records the day and clears the exception", fix3.hours === 6 && fix3.status === "recorded");
  const ex2 = await as(MGR, (c, co) => H.exceptions(c, co));
  t.ok("the exception is resolved", !ex2.some((x) => x.employee_id === E_MARIA && x.worked_on === d3));

  const outD2 = await as(MGR, (c) => one<{ id: string }>(c, `select id from time_punch where entity_id = $1 and employee_id = $2 and work_day = $3 and kind = 'out' and voided_at is null`, [ENTITY, E_MARIA, d2]));
  await t.throws("a salesperson cannot change a punch", () => as(MARIA, (c, co, a) => H.fix(c, co, a, outD2.id, { reason: "stayed late" })), /needs one of/);
  await t.throws("changing a punch needs a reason", () => as(MGR, (c, co, a) => H.fix(c, co, a, outD2.id, { reason: "" })), /reason/);
  const fx = await as(MGR, async (c, co, a) => H.fix(c, co, a, outD2.id, { at: await ny(c, d2, "18:00"), reason: "Stayed for a late delivery" }));
  t.ok("a manager corrects a punch by voiding and replacing it, and the day re-feeds", fx.hours === 9 && !!fx.replacementId, `${fx.hours} h`);
  const voided = await as(MGR, (c) => one<{ voided_at: string | null; void_reason: string }>(c, `select voided_at, void_reason from time_punch where id = $1 and entity_id = $2`, [outD2.id, ENTITY]));
  t.ok("the original punch stays on file, voided with the reason", !!voided.voided_at && /late delivery/.test(voided.void_reason));
  const mgrIn = await as(MGR, (c, co, a) => H.punch(c, co, a, { kind: "in", locationId: LOC.ENOLA }));
  await t.throws("nobody changes their own time", () => as(MGR, (c, co, a) => H.fix(c, co, a, mgrIn.punchId, { at: new Date(Date.now() - 3600000).toISOString(), reason: "came in earlier" })), /their own time/);
  await as(MGR, (c, co, a) => H.punch(c, co, a, { kind: "out", locationId: LOC.ENOLA }));
  await t.throws("time for a day no pay period covers is refused",
    () => as(MGR, async (c, co, a) => H.punch(c, co, a, { employeeId: E_MARIA, kind: "in", locationId: LOC.ENOLA, at: await ny(c, await dayOf(c, 40), "09:00"), reason: "late entry" })), /no pay period covers/);
  await t.throws("a salaried manager does not punch", () => as(MGR, (c, co, a) => H.punch(c, co, a, { employeeId: "aaaa0000-0000-0000-0000-000000000005", kind: "in", locationId: LOC.ENOLA, reason: "test entry", at: new Date().toISOString() })), /salaried/);
  const tc = await as(MGR, (c) => q<{ worked_on: string; hours: string; source: string; profit_object_id: string }>(c, `
    select t.worked_on::text, t.hours::text, t.source, t.profit_object_id from timecard t join employee e on e.id = t.employee_id and e.entity_id = $1
     where t.employee_id = $2 and t.pay_period_id = $3 order by t.worked_on`, [ENTITY, E_MARIA, PERIOD]));
  t.ok("the clock writes payroll's own timecards, one per day, on the store's profit object",
    tc.length === 4 && tc.every((x) => x.source === "clock" && x.profit_object_id === "44444444-0000-0000-0000-000000000001")
    && tc.reduce((s, x) => s + Number(x.hours), 0) === 23, tc.map((x) => `${x.worked_on} ${x.hours}`).join(", "));

  // ------------------------------------------------------------- schedule --
  console.log("  -- shifts");
  const tomorrow = await as(MGR, (c) => dayOf(c, -1));
  // As a phone's date and time pickers send it: no zone, read in the store's own time.
  const sh = await as(MGR, async (c, co, a) => H.addShift(c, co, a, { employeeId: E_MARIA, locationId: LOC.ENOLA, startsAt: `${tomorrow}T10:00`, endsAt: `${tomorrow}T18:00`, role: "Floor" }));
  await t.throws("a salesperson cannot schedule shifts",
    () => as(MARIA, async (c, co, a) => H.addShift(c, co, a, { employeeId: E_MARIA, locationId: LOC.ENOLA, startsAt: await ny(c, tomorrow, "10:00"), endsAt: await ny(c, tomorrow, "18:00") })), /needs one of/);
  await t.throws("two shifts for one person cannot overlap",
    () => as(MGR, async (c, co, a) => H.addShift(c, co, a, { employeeId: E_MARIA, locationId: LOC.PALESTINE, startsAt: await ny(c, tomorrow, "17:00"), endsAt: await ny(c, tomorrow, "21:00") })), /already on a shift/);
  await t.throws("a shift longer than 16 hours is refused",
    () => as(MGR, async (c, co, a) => H.addShift(c, co, a, { employeeId: E_MGR, locationId: LOC.ENOLA, startsAt: await ny(c, tomorrow, "05:00"), endsAt: await ny(c, tomorrow, "22:00") })), /16 hours/);
  const wk = await as(MGR, (c, co) => H.schedule(c, co, LOC.ENOLA, tomorrow));
  t.ok("the store's week lists the shift in local time with hours by person",
    wk.shifts.some((s) => s.id === sh.shiftId && s.starts === "10:00" && s.ends === "18:00") && wk.people.some((p) => p.employee_id === E_MARIA && p.hours >= 8), wk.timezone);
  await as(MGR, (c, co, a) => H.cancelShift(c, co, a, sh.shiftId));
  await t.throws("a cancelled shift is not cancelled twice", () => as(MGR, (c, co, a) => H.cancelShift(c, co, a, sh.shiftId)), /already cancelled/);

  // ---------------------------------------------------------- commissions --
  console.log("  -- commissions");
  // Catch up on anything sold before these checks (the A/R checks' sales), so the numbers below are only these orders.
  await as(PEOPLE.CONTROLLER, (c, co, a) => H.accrue(c, co, a, {}));
  const o1 = await as(MARIA, async (c) => {
    const o = await order(c, MARIA, [{ product: 1, price: 79999, tax: 4800 }, { product: 12, price: 14999, tax: 900 }]);
    await ar.invoiceFulfilment(c, scope(MARIA), o.id, "all", 41500n);
    return o;
  });
  const o2 = await as(MARIA, (c) => order(c, MARIA, [{ product: 8, price: 89999, tax: 5400 }, { product: 7, price: 64999, tax: 3900 }]));
  await t.throws("a split has to add up to 100%",
    () => as(MARIA, (c, co, a) => H.setSplits(c, co, a, { orderId: o2.id, splits: [{ appUserId: MARIA, pct: 60 }, { appUserId: MGR, pct: 30 }] })), /100%/);
  await t.throws("an A/R clerk cannot split a sale",
    () => as(JEN, (c, co, a) => H.setSplits(c, co, a, { orderId: o2.id, splits: [{ appUserId: MARIA, pct: 100 }] })), /needs one of/);
  await as(MARIA, (c, co, a) => H.setSplits(c, co, a, { orderId: o2.id, splits: [{ appUserId: MARIA, pct: 60 }, { appUserId: MGR, pct: 40 }] }));
  await as(MARIA, (c) => ar.invoiceFulfilment(c, scope(MARIA), o2.id, "all", 65000n));
  const o3 = await as(MARIA, (c) => order(c, MARIA, [{ product: 3, price: 59999, tax: 3600 }], false));

  await t.throws("a salesperson cannot accrue commissions", () => as(MARIA, (c, co, a) => H.accrue(c, co, a, {})), /needs one of: controller, hr/);
  const before6130 = await as(JEN, (c) => gl(c, "6130"));
  const acc = await as(PEOPLE.CONTROLLER, (c, co, a) => H.accrue(c, co, a, {}));
  const evs = await as(JEN, (c) => q<{ app_user_id: string; sales_order_id: string; kind: string; amount_minor: string; rate_bps: number }>(c,
    `select app_user_id, sales_order_id, kind, amount_minor, rate_bps from commission_event where entity_id = $1 and sales_order_id = any($2) and amount_minor <> 0`,
    [ENTITY, [o1.id, o2.id, o3.id]]));
  const sum = (who: string, oid?: string, kind?: string) => evs.filter((e) => e.app_user_id === who && (!oid || e.sales_order_id === oid) && (!kind || e.kind === kind))
    .reduce((x, e) => x + B(e.amount_minor), 0n);
  t.ok("% of sale: 4% on the sofa and the plan, plus the protection-plan spiff", sum(MARIA, o1.id, "earned") === 3800n && sum(MARIA, o1.id, "spiff") === 2500n,
    `${sum(MARIA, o1.id, "earned")} + spiff ${sum(MARIA, o1.id, "spiff")}`);
  t.ok("a split sale splits it: 60% to her at the mattress rate (8%) and the floor rate, plus 60% of the vendor spiff",
    sum(MARIA, o2.id, "earned") === 4320n + 1560n && sum(MARIA, o2.id, "spiff") === 900n, `${sum(MARIA, o2.id, "earned")} + ${sum(MARIA, o2.id, "spiff")}`);
  t.ok("% of margin: the manager's 40% earns 10% of the gross margin on it, plus 40% of the spiff",
    sum(MGR, o2.id, "earned") === 2160n + 1440n && sum(MGR, o2.id, "spiff") === 600n, `${sum(MGR, o2.id, "earned")} + ${sum(MGR, o2.id, "spiff")}`);
  t.ok("nothing is earned on a sale written but not delivered", !evs.some((e) => e.sales_order_id === o3.id));
  const after6130 = await as(JEN, (c) => gl(c, "6130"));
  t.ok("the accrual posts Dr 6130 Cr 2160 for what was earned", after6130 - before6130 === acc.totalMinor && acc.totalMinor === 3800n + 2500n + 5880n + 900n + 3600n + 600n,
    String(acc.totalMinor));
  const again = await as(PEOPLE.CONTROLLER, (c, co, a) => H.accrue(c, co, a, {}));
  t.ok("running the accrual again earns nothing twice", again.earned === 0 && again.spiffs === 0 && again.totalMinor === 0n);

  // A tier: past $20,000 delivered this month the floor plan pays 5%.
  const plan = { rate_bps: 400, tiers: [{ min: 2000000n, rate: 500 }, { min: 4000000n, rate: 600 }], rules: [{ category: "Mattresses", vendor_id: null, rate_bps: 800 }] };
  t.ok("volume tiers step the rate up with the month's delivered sales; a category rate wins over tiers",
    wf.rateFor(plan, { category: "Living room", vendor_id: null }, 1999999n) === 400 && wf.rateFor(plan, { category: "Living room", vendor_id: null }, 2500000n) === 500
    && wf.rateFor(plan, { category: "Bedroom", vendor_id: null }, 4000000n) === 600 && wf.rateFor(plan, { category: "Mattresses", vendor_id: null }, 4000000n) === 800);

  // A return charges it back.
  await as(MARIA, (c) => c.query(`update sales_order_line set line_status = 'returned' where id = $1 and entity_id = $2`, [o1.lineIds[1], ENTITY]));
  const cb = await as(PEOPLE.CONTROLLER, (c, co, a) => H.accrue(c, co, a, {}));
  t.ok("a returned line charges back its commission and its spiff", cb.chargebacks === 2 && cb.totalMinor === -(600n + 2500n), String(cb.totalMinor));

  // ----------------------------------------------- approve into payroll --
  console.log("  -- commissions into the payroll run");
  await t.throws("a salesperson cannot approve commissions", () => as(MARIA, (c, co, a) => H.approve(c, co, a, { payPeriodId: PERIOD })), /needs one of/);
  // Guarantee Maria $2,000 a period, recoverable, from today.
  await as(PEOPLE.CONTROLLER, (c, co, a) => H.assign(c, co, a, { appUserId: MARIA, planId: "cdcd0000-0000-0000-0000-000000000001", from: today(), draw: "2000", recoverable: true }));
  const cMaria = await as(JEN, (c) => one<{ s: string }>(c, `select coalesce(sum(amount_minor),0)::text s from commission_event where entity_id = $1 and app_user_id = $2 and status = 'accrued'`, [ENTITY, MARIA]));
  const cMgr = await as(JEN, (c) => one<{ s: string }>(c, `select coalesce(sum(amount_minor),0)::text s from commission_event where entity_id = $1 and app_user_id = $2 and status = 'accrued'`, [ENTITY, MGR]));
  const ap = await as(PEOPLE.CONTROLLER, (c, co, a) => H.approve(c, co, a, { payPeriodId: PERIOD }));
  const m = ap.approved.find((x) => x.name === "Maria Sales")!;
  const expTop = 200000n > B(cMaria.s) ? 200000n - B(cMaria.s) : 0n;
  t.ok("the draw tops commission up to the guarantee and is owed back", m.commission === B(cMaria.s) && m.topup === expTop && m.payout === B(cMaria.s) + expTop && m.drawBalance === expTop,
    `commission ${m.commission}, draw paid ${m.topup}, owed back ${m.drawBalance}`);
  const ap2 = await as(PEOPLE.CONTROLLER, (c, co, a) => H.approve(c, co, a, { payPeriodId: PERIOD }));
  t.ok("a period's commissions are approved once", ap2.approved.length === 0);
  const earn = await as(JEN, (c) => q<{ employee_id: string; kind: string; amount_minor: string; debit_code: string }>(c,
    `select employee_id, kind, amount_minor, debit_code from payroll_earning where entity_id = $1 and pay_period_id = $2 order by employee_id, kind`, [ENTITY, PERIOD]));
  t.ok("approval hands payroll its earnings: commission against 2160, the draw against 6130",
    earn.some((e) => e.employee_id === E_MARIA && e.kind === "commission" && B(e.amount_minor) === B(cMaria.s) && e.debit_code === "2160")
    && earn.some((e) => e.employee_id === E_MARIA && e.kind === "draw" && B(e.amount_minor) === expTop && e.debit_code === "6130")
    && earn.some((e) => e.employee_id === E_MGR && e.kind === "commission" && B(e.amount_minor) === B(cMgr.s)), earn.map((e) => `${e.kind} ${e.amount_minor}`).join(", "));

  await t.throws("a salesperson cannot read another salesperson's commission statement",
    () => as(MARIA, (c, co) => H.statement(c, co, PERIOD, MGR, MARIA)), /needs one of/);
  const st = await as(MARIA, (c, co) => H.statement(c, co, PERIOD, MARIA, MARIA));
  t.ok("the pay-period commission statement lists every line and adds up to the commission", !!st.payout && st.totalMinor === B(cMaria.s) && st.lines.length > 0, `${st.lines.length} lines`);

  const runId = await as(JEN, async (c, co, a) => {
    await approveTimecards(c, co, a, { periodId: PERIOD });
    const r = await buildRun(c, scope(JEN), { payPeriodId: PERIOD, builtBy: JEN, taxProvider: new IllustrativeTaxProvider() });
    return r.runId;
  });
  const lines = await as(JEN, (c) => q<{ employee_id: string; gross_minor: string; regular_hours: string }>(c, `
    select pl.employee_id, pl.gross_minor, pl.regular_hours::text from payroll_line pl join payroll_run pr on pr.id = pl.payroll_run_id and pr.entity_id = $1
     where pl.payroll_run_id = $2`, [ENTITY, runId]));
  const lm = lines.find((l) => l.employee_id === E_MARIA), lg = lines.find((l) => l.employee_id === E_MGR);
  t.ok("the payroll run pays the clock's hours plus commission and draw", !!lm && Number(lm.regular_hours) === 23 && B(lm.gross_minor) === 23n * 1500n + B(cMaria.s) + expTop,
    lm ? `${lm.regular_hours} h, gross ${lm.gross_minor}` : "missing");
  t.ok("someone with commission and no hours is still paid", !!lg && B(lg.gross_minor) === B(cMgr.s), lg?.gross_minor);
  const w0 = await as(JEN, (c) => gl(c, "6100"));
  await as(JEN, (c) => requestRelease(c, scope(JEN), runId, JEN));
  await as(PEOPLE.STEVE, async (c) => {
    const r = await one<{ id: string }>(c, `select id from approval_request where entity_id = $1 and subject_id = $2 and status = 'open'`, [ENTITY, runId]);
    await decide(c, scope(PEOPLE.STEVE), { requestId: r.id, actorId: PEOPLE.STEVE, decision: "approved", note: "reviewed" });
  });
  await as(PEOPLE.CONTROLLER, async (c) => { await release(c, scope(PEOPLE.CONTROLLER), runId, PEOPLE.CONTROLLER); await postRun(c, scope(PEOPLE.CONTROLLER), runId); });
  const w1 = await as(JEN, (c) => gl(c, "6100"));
  const pay2160 = await as(JEN, (c) => gl(c, "2160"));
  t.ok("the payroll posting debits wages only for the hours", w1 - w0 === 23n * 1500n, `6100 +${w1 - w0}`);
  t.ok("commission paid through payroll clears 2160 to zero", pay2160 === 0n, `2160 ${pay2160}`);
  const bal = await as(JEN, (c) => one<{ d: string; k: string }>(c, `select sum(jl.debit_minor)::text d, sum(jl.credit_minor)::text k from journal_line jl
     join journal_entry je on je.id = jl.journal_entry_id where je.entity_id = $1 and je.source_id = $2`, [ENTITY, runId]));
  t.ok("the payroll entry balances", bal.d === bal.k);
  await t.throws("time in a posted pay period is closed",
    () => as(MGR, async (c, co, a) => H.punch(c, co, a, { employeeId: E_MARIA, kind: "in", locationId: LOC.ENOLA, at: await ny(c, d1, "19:00"), reason: "late entry" })), /is posted/);

  // ---------------------------------------------------------- leaderboard --
  const lb = await as(MARIA, (c, co) => H.leaderboard(c, co, today().slice(0, 8) + "01", today()));
  const lm2 = lb.rows.find((r) => r.appUserId === MARIA)!;
  t.ok("the leaderboard shows written against delivered, and margin", lm2.writtenMinor > lm2.deliveredMinor && lm2.marginPct !== null && lm2.marginPct > 0,
    `written ${lm2.writtenMinor}, delivered ${lm2.deliveredMinor}, margin ${lm2.marginPct}%`);

  // ------------------------------------------------------------ isolation --
  console.log("  -- isolation");
  const rio = await company(RIO_ENTITY);
  const c0 = await pool.connect();
  try {
    await c0.query("begin");
    t.ok("another client's clock board shows none of these people", !(await H.board(c0, rio, null)).some((r) => r.employee_id === E_MARIA || r.employee_id === E_MGR));
    t.ok("another client sees none of these commission plans", (await H.commissions(c0, rio)).plans.length === 0);
    let msg = "";
    try { await H.punches(c0, rio, E_MARIA, d1, today()); } catch (e) { msg = (e as Error).message; }
    t.ok("another client cannot read these punches", /no such employee/.test(msg), msg);
    msg = "";
    try { await H.schedule(c0, rio, LOC.ENOLA, today()); } catch (e) { msg = (e as Error).message; }
    t.ok("another client cannot read this store's schedule", /pick the store/.test(msg), msg);
  } finally { await c0.query("rollback"); c0.release(); }
}
