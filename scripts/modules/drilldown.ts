// Drill-downs: every list behind a tile (packages/core/drill.ts, GET /drill/<list>)
// adds up to the figure on the tile it opens from, page by page, and only for
// the company in the address: another tenant's company is refused.
import type { T } from "./harness.ts";
import { ENTITY, RIO_ENTITY, PEOPLE } from "./harness.ts";

import * as drill from "../../packages/core/drill.ts";
import * as views from "../../server/views.ts";
import * as inv from "../../packages/core/inventory.ts";
import * as fleet from "../../packages/core/fleet.ts";
import * as service from "../../packages/core/service.ts";
import * as crm from "../../packages/core/crm.ts";
import * as ar from "../../packages/core/ar.ts";
import * as settle from "../../packages/core/ar_settlement.ts";
import * as pos from "../../packages/core/pos.ts";
import * as edi from "../../packages/core/edi.ts";
import * as trade from "../../packages/core/trade.ts";
import * as leave from "../../packages/core/leave.ts";

type Res = { status: number; data: Record<string, unknown> & { error?: string } };
const B = (v: unknown) => BigInt(String(v ?? 0));
const sumRows = (rows: drill.DrillRow[]) => rows.reduce((a, r) => a + B(r.amount_minor), 0n);

export async function run(t: T) {
  const c = await t.pool.connect();
  const co = await t.company();
  const owner = new Set(["owner"]);
  const all = (key: string, p: Record<string, string | null> = {}, personId: string | null = null) => drill.all(c, ENTITY, key, p, owner, personId);
  const used = new Set<string>();
  let nonEmpty = 0;
  /** A list reconciles: every page's rows add up to the figure, and the header's count and total say the same. */
  const ties = async (name: string, key: string, p: Record<string, string | null>, want: { count?: number; minor?: unknown; hours?: number }, personId: string | null = null) => {
    used.add(key);
    const r = await all(key, p, personId);
    if (r.rows.length) nonEmpty++;
    const pagesOk = r.rows.length === r.count;
    const bits: string[] = [`${r.count} rows`];
    let ok = pagesOk;
    if (want.count != null) { ok = ok && r.count === want.count; bits.push(`count ${r.count} vs ${want.count}`); }
    if (want.minor != null) { ok = ok && sumRows(r.rows) === B(want.minor) && B(r.totalMinor) === B(want.minor); bits.push(`total ${sumRows(r.rows)} vs ${B(want.minor)}`); }
    if (want.hours != null) {
      const h = r.rows.reduce((a, x) => a + Number(x.qty ?? 0), 0);
      ok = ok && Math.abs(h - want.hours) < 0.001 && Math.abs(Number(r.totalHours) - want.hours) < 0.001; bits.push(`hours ${h} vs ${want.hours}`);
    }
    t.ok(`drill ${name} adds up to its tile`, ok, bits.join(", "));
    return r;
  };
  const one = async <R>(sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows as R[];

  // Read-only throughout; one transaction so the readers that use savepoints (customer360) can.
  await c.query("begin");
  try {
    // ------------------------------------------------------------- Home
    const home = await views.home(c, co, PEOPLE.STEVE);
    await ties("Home → Bills due in 7 days", "bills-due7", {}, { count: home.bills.due7_n, minor: home.bills.due7 });

    // -------------------------------------------------------- Cash, books
    const cash = await views.cash(c, co);
    let banks = 0;
    for (const p of cash.positions as { bank_account_id: string; name: string; ledger_balance_minor: string }[]) {
      if (banks++ >= 4) break;
      await ties(`Cash → ${p.name}`, "bank-lines", { account: p.bank_account_id }, { minor: p.ledger_balance_minor });
    }
    const tb = await views.trialBalance(c, co, "2999-12-31");
    for (const code of ["1100", "1300", "2160", "2300", "4000"]) {
      const row = (tb.rows as { code: string; account_type: string; balance_minor: string }[]).find((x) => x.code === code);
      const bal = row ? (["liability", "equity", "revenue"].includes(row.account_type) ? -B(row.balance_minor) : B(row.balance_minor)) : 0n;
      await ties(`GL ${code} entries (trial balance)`, "gl-lines", { code }, { minor: bal });
    }
    const gl2160 = (await one<{ b: string }>(`select coalesce(sum(jl.credit_minor - jl.debit_minor),0)::text b from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
      join gl_account g on g.id = jl.gl_account_id where je.entity_id = $1 and g.code = '2160'`, [ENTITY]))[0].b;
    await ties("Time and commissions → Commissions payable (2160)", "gl-lines", { code: "2160" }, { minor: gl2160 });

    // ---------------------------------------------------------- Reconcile
    const rec = await views.recon(c, co);
    await ties("Reconcile → Matched", "recon-matches", {}, { count: (rec.byMethod as { n: number }[]).reduce((a, m) => a + m.n, 0) });
    await ties("Reconcile → Card fees posted", "recon-fees", {}, { minor: (rec.accounts as { fees_minor: string }[]).reduce((a, x) => a + B(x.fees_minor), 0n) });

    // ---------------------------------------------------------- Inventory
    const val = await inv.valuation(c, ENTITY);
    await ties("Inventory → Stock at cost", "stock-value", {}, { minor: val.totalMinor });

    // ----------------------------------------------------------- Delivery
    const days = await one<{ d: string }>(`select scheduled_on::text d from delivery_stop where entity_id = $1 and scheduled_on is not null and kind <> 'will_call'
      group by 1 order by count(*) filter (where status in ('delivered','partial','failed')) desc, count(*) desc limit 2`, [ENTITY]);
    for (const { d } of days) {
      const dash = await fleet.dashboard(c, ENTITY, d);
      await ties(`Delivery ${d} → Stops`, "fleet-stops", { day: d }, { count: dash.stops.total });
      await ties(`Delivery ${d} → Stops done`, "fleet-stops", { day: d, show: "done" }, { count: dash.stops.done });
      await ties(`Delivery ${d} → Failed`, "fleet-stops", { day: d, show: "failed" }, { count: dash.stops.failed });
      const timed = await all("fleet-stops", { day: d, show: "timed" });
      const onTime = timed.rows.filter((x) => x.badge === "On time").length;
      t.ok(`drill Delivery ${d} → On time: the marked stops give the tile's percent`,
        dash.onTimePct == null ? timed.count === 0 : Math.round((100 * onTime) / timed.count) === dash.onTimePct, `${onTime}/${timed.count} vs ${dash.onTimePct}%`);
    }
    const win = await one<{ zone_id: string; window_id: string; d: string }>(`select s.zone_id, s.window_id, s.scheduled_on::text d from delivery_stop s
      join delivery_window w on w.id = s.window_id and w.active where s.entity_id = $1 and s.status <> 'cancelled' and s.zone_id is not null and s.scheduled_on >= current_date
      group by 1, 2, 3 order by count(*) desc limit 1`, [ENTITY]);
    if (win.length) {
      const slots = await fleet.availability(c, ENTITY, win[0].zone_id, win[0].d, 1);
      const slot = slots.find((x) => x.windowId === win[0].window_id);
      if (slot) await ties("Delivery booking → a window's capacity used", "window-stops", { window: win[0].window_id, day: win[0].d }, { count: slot.used.stops });
      else t.ok("drill Delivery booking → the busiest window is offered for booking", false, JSON.stringify(win[0]));
    }

    // ------------------------------------------------------------ Service
    const sv = await service.dashboard(c, ENTITY);
    await ties("Service → Open tickets", "service-open", {}, { count: sv.open });
    for (const b of sv.age as { bucket: string; n: number }[]) await ties(`Service → open ${b.bucket}`, "service-open", { age: b.bucket }, { count: b.n });
    await ties("Service → Due in 24 hours", "service-due24", {}, { count: sv.dueSoon });
    const ftf = await ties("Service → Fixed first visit", "service-ftf", {}, { count: sv.firstTimeFix.resolvedWithVisits });
    t.ok("drill Service → the first-visit rows give the tile's count", ftf.rows.filter((x) => x.badge === "First visit").length === sv.firstTimeFix.fixedFirstTime);
    await ties("Service → Service cost, 30 days", "service-cost30", {}, { minor: sv.cost30dMinor });

    // ---------------------------------------------------- Settlements
    const ag = await settle.lenderAging(c, ENTITY);
    for (const l of ag.lenders) await ties(`Finance settlements → ${l.name}`, "lender-owed", { lender: l.companyId }, { minor: l.owedMinor });

    // ----------------------------------------------------------------- POS
    const sessions = await one<{ id: string; number: string }>(`select s.id, s.number from pos_session s where s.entity_id = $1
      order by (select count(*) from customer_receipt r where r.register_session_id = s.id) desc limit 3`, [ENTITY]);
    for (const s of sessions) {
      const z = await pos.zReport(c, ENTITY, s.id);
      await ties(`POS ${s.number} → Sales`, "pos-sales", { session: s.id }, { count: z.sales.n, minor: z.sales.total });
      await ties(`POS ${s.number} → Returns`, "pos-returns", { session: s.id }, { count: z.returns.n, minor: z.returns.total });
      for (const tn of z.tenders) await ties(`POS ${s.number} → ${tn.method} taken`, "pos-receipts", { session: s.id, method: tn.method }, { count: tn.n, minor: B(tn.taken) - B(tn.refunded) });
      await ties(`POS ${s.number} → Cash taken, net`, "pos-receipts", { session: s.id, method: "cash" }, { minor: z.cash.cashNetMinor });
      await ties(`POS ${s.number} → Drops`, "pos-cash", { session: s.id, kind: "drop" }, { minor: z.cash.dropsMinor });
      await ties(`POS ${s.number} → Paid in`, "pos-cash", { session: s.id, kind: "paid_in" }, { minor: z.cash.paidInMinor });
      await ties(`POS ${s.number} → Paid out`, "pos-cash", { session: s.id, kind: "paid_out" }, { minor: z.cash.paidOutMinor });
    }
    t.ok("POS drawer lists checked against at least one drawer", sessions.length > 0);
    const rioSession = await one<{ id: string }>(`select id from pos_session where entity_id = $1 limit 1`, [RIO_ENTITY]);
    const elsewhere = rioSession[0]?.id ?? "00000000-0000-4000-8000-000000000000";
    await t.throws("a drawer session of another company reads as not here, in a sentence", () => all("pos-sales", { session: elsewhere }), /no such drawer session in this company/);

    // ---------------------------------------------------- Customers, CRM
    const custs = await one<{ id: string }>(`select customer_id id from sales_order where entity_id = $1 and customer_id is not null and status not in ('draft','cancelled')
      group by 1 order by count(*) desc limit 3`, [ENTITY]);
    for (const { id } of custs) {
      const x = await crm.customer360(c, ENTITY, id);
      await ties("Customer → Lifetime sales and Orders", "customer-orders", { customer: id }, { count: x.orderCount, minor: x.lifetimeValueMinor });
    }
    const credits = await one<{ id: string }>(`select customer_id id from store_credit_ledger where entity_id = $1 group by 1 limit 2`, [ENTITY]);
    for (const { id } of [...credits, ...custs.slice(0, 1)]) await ties("Customer → Store credit", "store-credit", { customer: id }, { minor: await ar.storeCreditBalance(c, ENTITY, id) });
    const dash = await crm.dashboard(c, ENTITY);
    await ties("Marketing → Leads in the window", "crm-leads", { show: "window", days: String(dash.days) }, { count: dash.leads });
    await ties("Marketing → Conversion (closed leads)", "crm-leads", { show: "closed", days: String(dash.days) }, { count: dash.won + dash.lost });
    await ties("Marketing → Overdue follow-ups", "crm-overdue", {}, { count: (dash.overdue as { n: number }[]).reduce((a, o) => a + o.n, 0) });
    const sellers = await one<{ id: string }>(`select assigned_to id from crm_lead where entity_id = $1 and assigned_to is not null group by 1 order by count(*) desc limit 2`, [ENTITY]);
    for (const { id } of sellers) await ties("My day → Open leads", "crm-leads", { show: "open", person: id }, { count: (await crm.myDay(c, ENTITY, id)).openLeads });

    // ----------------------------------------------------- web store order
    const paid = await one<{ id: string; paid_minor: string }>(`select so.id, so.paid_minor::text from sales_order so where so.entity_id = $1
      and exists (select 1 from customer_receipt r where r.sales_order_id = so.id) order by so.ordered_at desc limit 6`, [ENTITY]);
    for (const o of paid) await ties("Order → Paid", "order-receipts", { order: o.id }, { minor: o.paid_minor });

    // ------------------------------------------------------------- EDI
    const eh = await edi.ediHome(c, ENTITY);
    await ties("Vendor EDI → Quarantined", "edi-docs", { status: "quarantined" }, { count: Number(eh.quarantined) });
    await ties("Vendor EDI → Waiting to go out", "edi-docs", { status: "queued" }, { count: Number(eh.queued) });
    await ties("Vendor EDI → Failed", "edi-docs", { status: "failed" }, { count: Number(eh.failed) });

    // ------------------------------------------------------------- Trade
    const accts = await one<{ id: string }>(`select id from trade_account where entity_id = $1 order by number limit 3`, [ENTITY]);
    for (const { id } of accts) {
      const x = (await trade.account(c, ENTITY, id))!;
      const cu = x.account.customer_id;
      await ties(`Trade ${x.account.number} → Owed`, "customer-ledger", { customer: cu }, { minor: x.credit.balanceMinor });
      await ties(`Trade ${x.account.number} → On order, unbilled`, "trade-onorder", { customer: cu }, { minor: x.credit.onOrderMinor });
      await ties(`Trade ${x.account.number} → Referral owed`, "trade-referrals", { account: id }, { minor: x.referrals.owedMinor });
    }

    // ------------------------------------------------------------ Time off
    const emps = await one<{ id: string; app_user_id: string }>(`select e.id, e.app_user_id from employee e where e.entity_id = $1 and e.status = 'active' and e.app_user_id is not null
      and exists (select 1 from leave_ledger l where l.employee_id = e.id) limit 2`, [ENTITY]);
    for (const e of emps) {
      const bal = await leave.balances(c, ENTITY, e.id);
      for (const ty of bal.types) await ties(`Time off → ${ty.name} available`, "leave-ledger", { type: ty.id }, { hours: ty.available }, e.app_user_id);
    }
    await t.throws("Time off: someone with no employee record is told so in a sentence", () => all("leave-ledger", { type: "00000000-0000-4000-8000-000000000000" }, null),
      /not set up as an employee here/);

    // ---------------------------------------------------- every list ran
    const missing = Object.keys(drill.DEFS).filter((k) => !used.has(k));
    t.ok("every drill list is checked against its tile", !missing.length, missing.join(", "));
    t.ok("most drill lists had rows to add up in the demo", nonEmpty >= 25, `${nonEmpty} non-empty`);

    // ------------------------------------------------- plain-sentence errors
    await t.throws("an unknown list is refused in a sentence", () => all("nope"), /There is no list called/);
    await t.throws("a list that needs a parameter says which", () => all("bank-lines"), /Pick a bank account first/);
    await t.throws("a bad day is refused in a sentence", () => all("fleet-stops", { day: "11/11/2026" }), /not a day/);
    await t.throws("a page past the end is refused in a sentence", () => drill.list(c, ENTITY, "bills-due7", {}, 999, owner), /only one page|only \d+ pages/);
    await t.throws("a word outside the list is refused, naming the choices", () => all("edi-docs", { status: "everything" }), /Show one of: quarantined, queued, failed/);
    await t.throws("the books' entries are refused to a role that does not see them, in a sentence",
      () => drill.list(c, ENTITY, "gl-lines", { code: "1100" }, 1, new Set(["sales"])), /Seeing the entries in an account needs one of: controller/);
    await t.throws("stock at cost is refused to a role that does not see costs", () => drill.list(c, ENTITY, "stock-value", {}, 1, new Set(["warehouse"])), /needs one of: buyer, controller, store manager/);
    // the SQL is the company's own: the same list for Rio Freight never shows the demo's rows
    const rioBills = await drill.all(c, RIO_ENTITY, "bills-due7", {}, owner);
    const demoIds = new Set((await all("bills-due7")).rows.map((r) => r.id));
    t.ok("a list run for one company never carries another's rows", rioBills.rows.every((r) => !demoIds.has(r.id)));
  } finally { await c.query("rollback"); c.release(); }

  // ------------------------------------------------------ over HTTP, by tenant
  process.env.ERP_API_TOKEN = process.env.ERP_API_TOKEN && process.env.ERP_API_TOKEN.length >= 32 ? process.env.ERP_API_TOKEN : "t".repeat(48);
  const { createServer } = await import("../../server/index.ts");
  const P = await import("../../server/platform.ts");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, cookie: string | null = null, method = "GET"): Promise<Res & { cookie: string | null }> => {
    const headers: Record<string, string> = { "x-erp-page": "1", "x-forwarded-for": "198.51.100.200" };
    if (cookie) headers.cookie = cookie;
    const r = await fetch(base + path, { method, headers });
    let data: Res["data"] = {};
    try { data = await r.json(); } catch { /* empty */ }
    const sc = r.headers.get("set-cookie");
    return { status: r.status, data, cookie: sc ? sc.split(";")[0] : null };
  };
  const c2 = await t.pool.connect();
  const email = "drill-check@rio.example";
  try {
    // A customer of the other tenant (Rio Freight's owner) signs in with a password.
    const had = await c2.query(`update platform_login set status = 'active', pw_hash = $2, password_set_at = now() where email = $1 /* unscoped: this check's own sign-in */`,
      [email, P.hashPassword("drill-check-pass")]);
    if (!had.rowCount) {
      const rio = (await c2.query<{ id: string; tenant_id: string }>(`select u.id, u.tenant_id from app_user u join role_grant g on g.app_user_id = u.id and g.role = 'owner'
        join entity e on e.tenant_id = u.tenant_id and e.id = $1 where not exists (select 1 from platform_login l where l.app_user_id = u.id) limit 1`, [RIO_ENTITY])).rows[0];
      t.ok("Rio Freight has an owner to sign in as", !!rio);
      await c2.query(`insert into platform_login (tenant_id, app_user_id, email, kind, status, pw_hash, password_set_at)
        values ($1, $2, $3, 'customer', 'active', $4, now())`, [rio.tenant_id, rio.id, email, P.hashPassword("drill-check-pass")]);
    }
    const signIn = await fetch(base + "/session", { method: "POST", headers: { "x-erp-page": "1", "content-type": "application/json", "x-forwarded-for": "198.51.100.200" },
      body: JSON.stringify({ email, password: "drill-check-pass" }) });
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
    t.ok("a customer of the other tenant signs in", signIn.status === 200 && !!cookie);
    const own = await call(`/api/c/${RIO_ENTITY}/drill/bills-due7`, cookie);
    t.ok("their own company's drill list opens, with a count and a page", own.status === 200 && typeof own.data.count === "number" && own.data.page === 1, own.data.error);
    const anyId = "11111111-1111-4111-8111-111111111111";
    const SAMPLE: Record<string, string> = { code: "1100", account: anyId, day: "2026-11-11", window: anyId, lender: anyId, session: anyId, customer: anyId, order: anyId,
      account_id: anyId, type: anyId, show: "window", status: "queued" };
    let refused = 0;
    const leaks: string[] = [];
    for (const [key, def] of Object.entries(drill.DEFS)) {
      const qs = new URLSearchParams();
      for (const p of def.params ?? []) if (!p.optional || p.name === "show") qs.set(p.name, p.name === "account" && key === "trade-referrals" ? anyId : SAMPLE[p.name] ?? anyId);
      if (key === "fleet-stops") qs.set("show", "all");
      if (key === "edi-docs") qs.set("status", "queued");
      if (key === "crm-leads") qs.set("show", "window");
      const r = await call(`/api/c/${ENTITY}/drill/${key}?${qs}`, cookie);
      if (r.status === 404 && r.data.error === "no such company") refused++; else leaks.push(`${key} -> ${r.status} ${r.data.error ?? ""}`);
    }
    t.ok(`every drill list refuses another tenant's company (${refused} lists)`, !leaks.length && refused === Object.keys(drill.DEFS).length, leaks.slice(0, 4).join("; "));
    const err = await call(`/api/c/${RIO_ENTITY}/drill/not-a-list`, cookie);
    t.ok("an unknown list over HTTP is a 409 with a sentence", err.status === 409 && /^There is no list called/.test(err.data.error ?? ""), err.data.error);
    const page = await call(`/api/c/${RIO_ENTITY}/drill/bills-due7?page=0`, cookie);
    t.ok("a bad page over HTTP is a 409 with a sentence", page.status === 409 && /Pages are counted from 1/.test(page.data.error ?? ""), page.data.error);
    const write = await call(`/api/c/${RIO_ENTITY}/drill/bills-due7`, cookie, "POST");
    t.ok("drill lists are read-only: there is no POST", write.status === 404 || write.status === 405, String(write.status));
  } finally {
    // This check's own sign-in goes again, so the demo reset and the platform checks after it see the demo as it was.
    try { await c2.query(`delete from platform_login where email = $1 /* unscoped: this check's own sign-in */`, [email]); }
    catch { await c2.query(`update platform_login set status = 'disabled', session_version = session_version + 1 where email = $1 /* unscoped: this check's own sign-in */`, [email]); }
    c2.release();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

