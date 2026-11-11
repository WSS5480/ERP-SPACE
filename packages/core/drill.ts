// Drill-downs: the rows behind a figure on a tile.
//
// Every summary number on a screen opens the detail it was added up from.
// Most screens already fetch those rows (their lists); this file serves the
// ones that did not exist: each list here is one fixed, read-only query
// scoped to the company ($1) that returns exactly the rows a tile counts or
// sums, so the rows reconcile to the figure. Nothing here writes.
//
// A row is always { id, title, detail, on_day, amount_minor, qty, badge,
// open_kind, open_id }: the screen shows it as a card (phone first) and opens
// what it names (a bill, an order, a journal entry) when tapped.
//
// Each list mirrors the query that makes its tile. scripts/modules/drilldown.ts
// checks, list by list, that count and total match that figure.

import { q, one, type Client } from "./db.ts";
import * as fleet from "./fleet.ts";
import { OPEN as SERVICE_OPEN } from "./service.ts";

export class DrillError extends Error {}
function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new DrillError(message);
}

export const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type ParamKind = "uuid" | "day" | "code" | "word" | "int" | "since";
type Param = { name: string; kind: ParamKind; optional?: boolean; words?: string[]; missing: string; /** read by prep only, not bound into the SQL */ prepOnly?: boolean };
export type Def = {
  title: string;
  /** what the figure is: a sum of money, or a count of rows */
  measure: "money" | "count" | "hours";
  /** who may open it; none means anyone who may open the company (as the screen it drills from) */
  roles?: string[];
  /** words for a refusal: "Seeing <doing> needs one of: ..." */
  doing?: string;
  params?: Param[];
  /** extra bound values worked out before the query (a time zone, a check that a session is this company's) */
  prep?: (c: Client, entityId: string, p: Record<string, string | null>, personId: string | null, held: Set<string> | null) => Promise<unknown[]>;
  /**
   * A list over the books' whole history is shown a window at a time (from the fiscal year's first day,
   * unless since= says another day or "all"). opening sums what came before the window, with the same
   * bound values, so the opening plus the rows is still the tile's figure. The window's first day is the
   * last value prep returns.
   */
  opening?: string;
  /** the rows; $1 is the company, then params in order, then what prep returned */
  sql: string;
  order: string;
};

/** service.ts OPEN: the statuses a ticket counts as open in, written into the lists as a fixed SQL list */
const OPEN_SQL = SERVICE_OPEN.map((x) => `'${x.replace(/[^a-z_]/g, "")}'`).join(",");
/** service.dashboard's age buckets for open tickets */
const AGE_BUCKETS = ["0–2 days", "3–7 days", "8–14 days", "15+ days"];
/** a books list's window: a day, or "all" for the whole history */
const SINCE: Param = { name: "since", kind: "since", optional: true, missing: "", prepOnly: true };
const COST_ROLES = ["owner", "buyer", "controller", "store_manager"];
const BOOKS_ROLES = ["owner", "controller", "approver", "ap_clerk", "viewer", "ar_clerk", "hr", "buyer", "store_manager"];
// The screens' own read rules, so a drill shows no more than the screen it opens from:
/** server/modules/service.ts STAFF (the service dashboard is for store staff) */
const SERVICE_ROLES = ["owner", "store_manager", "dispatcher", "sales", "cashier", "ar_clerk", "controller", "buyer", "warehouse", "viewer"];
/** server/modules/fleet.ts: the delivery dashboard (STAFF + sales); booking availability adds cashier */
const FLEET_ROLES = ["owner", "dispatcher", "store_manager", "warehouse", "sales"];
const FLEET_BOOK_ROLES = [...FLEET_ROLES, "cashier"];
/** server/modules/trade.ts ROLES.view (trade accounts are for store staff) */
const TRADE_ROLES = ["sales", "store_manager", "designer", "controller", "ar_clerk", "marketing", "cashier", "buyer"];

/** The window a books list opens on: since= a day, "all" (no window), or by default the fiscal year's first day. */
async function bookWindow(c: Client, entityId: string, p: Record<string, string | null>): Promise<unknown[]> {
  if (p.since === "all") return [null];
  if (p.since) return [p.since];
  const r = await one<{ d: string }>(c, `
    select make_date(extract(year from business_today($1))::int - case when extract(month from business_today($1)) >= (e.fiscal_year_end_month % 12) + 1 then 0 else 1 end, /* store-local date */
                     (e.fiscal_year_end_month % 12) + 1, 1)::text d
      from entity e where e.id = $1 /* unscoped: the company itself */`, [entityId]);
  return [r.d];
}

/** a POS drawer session must be this company's, or the list says so plainly */
async function sessionHere(c: Client, entityId: string, p: Record<string, string | null>) {
  const s = await q(c, `select 1 from pos_session where entity_id = $1 and id = $2`, [entityId, p.session]);
  need(s.length, "There is no such drawer session in this company.");
  return [];
}

export const DEFS: Record<string, Def> = {
  // ------------------------------------------------------------------ Home
  /** Home → Bills due in 7 days (views.home bills.due7, due7_n) */
  "bills-due7": {
    title: "Bills due in the next 7 days", measure: "money",
    sql: `
      select i.id, coalesce(v.dba, v.legal_name) || coalesce(' · ' || i.reference, '') title,
             initcap(i.status) detail,
             i.due_date::text as on_day,
             (i.total_minor - coalesce((select sum(a.amount_minor) from vendor_memo_application a where a.invoice_id = i.id and a.entity_id = i.entity_id), 0))::text amount_minor,
             null::text qty, case when i.due_date < business_today($1) /* store-local date */ then 'Past due' end badge, 'bill' open_kind, i.id::text open_id,
             i.due_date ord1, i.created_at ord2
        from invoice i join vendor v on v.id = i.vendor_id
       where i.entity_id = $1 and i.ic_document_id is null and i.status in ('approved','scheduled') and i.due_date <= business_today($1) /* store-local date */ + 7`,
    order: "ord1, ord2, id",
  },

  // ------------------------------------------------------------- Reconcile
  /** Reconcile → Matched (views.recon byMethod) */
  "recon-matches": {
    title: "Bank lines matched", measure: "count",
    sql: `
      select m.id, l.description title, ba.name || ' · ' || case m.method when 'manual' then 'by a person' when 'exact' then 'exact'
               when 'tolerance' then 'net of fees' when 'batch' then 'several days together' else m.method end
               || coalesce(' · by ' || u.name, '') detail,
             l.posted_on::text as on_day, m.amount_minor::text amount_minor, null::text qty,
             case when m.method = 'manual' then 'By a person' else 'Automatic' end badge, null::text open_kind, null::text open_id,
             m.created_at ord1
        from reconciliation_match m
        join bank_statement_line l on l.id = m.bank_statement_line_id
        join bank_statement s on s.id = l.bank_statement_id
        join bank_account ba on ba.id = s.bank_account_id
        left join app_user u on u.id = m.matched_by
       where ba.entity_id = $1`,
    order: "ord1 desc, id",
  },
  /** Reconcile → Card fees posted (views.recon accounts[].fees_minor, active accounts) */
  "recon-fees": {
    title: "Card fees posted by matching", measure: "money",
    sql: `
      select rr.id, ba.name title, rr.lines_matched || ' of ' || rr.lines_total || ' lines matched' detail,
             (rr.ran_at at time zone business_tz($1))::date /* store-local date */::text as on_day, rr.variance_minor::text amount_minor, null::text qty, null::text badge,
             null::text open_kind, null::text open_id, rr.ran_at ord1
        from reconciliation_run rr join bank_account ba on ba.id = rr.bank_account_id
       where ba.entity_id = $1 and ba.status = 'active' and rr.variance_minor <> 0`,
    order: "ord1 desc, id",
  },

  // ----------------------------------------------------------------- Books
  /** Any account's balance, entry by entry: the GL figures tiles tie to (2160 commissions, 1100, 2300, ...) */
  "gl-lines": {
    title: "Entries in the account", measure: "money", roles: BOOKS_ROLES, doing: "the entries in an account",
    params: [{ name: "code", kind: "code", missing: "Say which account (its code) to list." }, SINCE],
    prep: (c, entityId, p) => bookWindow(c, entityId, p),
    opening: `
      select coalesce(sum(case when g.account_type in ('liability','equity','revenue') then jl.credit_minor - jl.debit_minor
                               else jl.debit_minor - jl.credit_minor end), 0)::text opening
        from journal_line jl join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id
       where je.entity_id = $1 and g.code = $2 and $3::date is not null and je.posting_date < $3::date`,
    sql: `
      select jl.id, je.description title,
             concat_ws(' · ', g.code || ' ' || g.name, po.name, ba.name, jl.memo) detail, je.posting_date::text as on_day,
             (case when g.account_type in ('liability','equity','revenue') then jl.credit_minor - jl.debit_minor
                   else jl.debit_minor - jl.credit_minor end)::text amount_minor,
             null::text qty, null::text badge, 'entry' open_kind, je.id::text open_id, je.posting_date ord1, je.posted_at ord2
        from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id
        join gl_account g on g.id = jl.gl_account_id
        left join profit_object po on po.id = jl.profit_object_id
        left join bank_account ba on ba.id = jl.bank_account_id
       where je.entity_id = $1 and g.code = $2 and ($3::date is null or je.posting_date >= $3::date)`,
    order: "ord1 desc, ord2 desc, id",
  },

  /** Cash → an account's balance in the books (bank_position ledger_balance_minor): every line posted to it */
  "bank-lines": {
    title: "Entries in the bank account", measure: "money", roles: BOOKS_ROLES, doing: "the entries in a bank account",
    params: [{ name: "account", kind: "uuid", missing: "Pick a bank account first." }, SINCE],
    prep: (c, entityId, p) => bookWindow(c, entityId, p),
    opening: `
      select coalesce(sum(jl.debit_minor - jl.credit_minor), 0)::text opening
        from journal_line jl join bank_account ba on ba.id = jl.bank_account_id join journal_entry je on je.id = jl.journal_entry_id
       where ba.entity_id = $1 and ba.id = $2 and ba.status = 'active' and $3::date is not null and je.posting_date < $3::date`,
    sql: `
      select jl.id, je.description title, concat_ws(' · ', g.code || ' ' || g.name, jl.memo) detail, je.posting_date::text as on_day,
             (jl.debit_minor - jl.credit_minor)::text amount_minor, null::text qty, null::text badge,
             'entry' open_kind, je.id::text open_id, je.posting_date ord1, je.posted_at ord2
        from journal_line jl
        join bank_account ba on ba.id = jl.bank_account_id
        join journal_entry je on je.id = jl.journal_entry_id
        join gl_account g on g.id = jl.gl_account_id
       where ba.entity_id = $1 and ba.id = $2 and ba.status = 'active' and ($3::date is null or je.posting_date >= $3::date)`,
    order: "ord1 desc, ord2 desc, id",
  },

  // ------------------------------------------------------------- Inventory
  /** Inventory → Stock at cost (inventory.valuation totalMinor): the cost pool, else on hand at the product's cost */
  "stock-value": {
    title: "Stock at cost, by product", measure: "money", roles: COST_ROLES, doing: "what each product is worth at cost",
    sql: `
      select p.id, p.name title, concat_ws(' · ', p.sku, p.category, 'average cost') detail, null::text as on_day,
             ic.value_minor::text amount_minor, ic.qty::text qty, null::text badge, 'product' open_kind, p.id::text open_id, p.name ord1
        from inv_cost ic join product p on p.id = ic.product_id
       where ic.entity_id = $1 and (ic.value_minor <> 0 or ic.qty <> 0)
      union all
      select p.id, p.name, concat_ws(' · ', p.sku, p.category, 'at the product''s cost'), null::text,
             sum(round(s.on_hand * p.cost_minor))::bigint::text, sum(s.on_hand)::text, 'No cost pool', 'product', p.id::text, p.name
        from stock_level s join product p on p.id = s.product_id
       where s.entity_id = $1 and s.on_hand <> 0
         and not exists (select 1 from inv_cost ic where ic.entity_id = s.entity_id and ic.product_id = s.product_id)
       group by p.id, p.name, p.sku, p.category`,
    order: "ord1, id",
  },

  // ------------------------------------------------------------- Delivery
  /** Delivery → Stops done / On time (fleet.dashboard stops, onTimePct): the day's stops it counts */
  "fleet-stops": {
    title: "Stops on the day", measure: "count", roles: FLEET_ROLES, doing: "the day's delivery stops",
    params: [
      { name: "day", kind: "day", missing: "Pick a day first." },
      { name: "show", kind: "word", optional: true, words: ["all", "done", "timed", "on_time", "late", "failed"], missing: "" },
    ],
    prep: async (c, entityId) => [(await fleet.settings(c, entityId)).tz],
    sql: `
      select x.* from (
        select s.id, s.number || coalesce(' · ' || cu.name, '') title,
               concat_ws(' · ', initcap(replace(s.kind, '_', ' ')), coalesce(r.number, 'not routed'), w.label,
                         case when s.arrived_at is not null then 'arrived ' || to_char(s.arrived_at at time zone $4::text, 'HH12:MI am') end) detail,
               s.scheduled_on::text as on_day, null::text amount_minor, null::text qty,
               case when s.status in ('delivered','partial','failed') and s.completed_at is not null and w.ends is not null
                    then case when (s.arrived_at at time zone $4::text)::time <= w.ends then 'On time' else 'Late' end
                    else initcap(replace(s.status, '_', ' ')) end badge,
               null::text open_kind, null::text open_id, s.number ord1,
               s.status in ('delivered','partial','failed') done,
               case when s.completed_at is null or w.ends is null then null else (s.arrived_at at time zone $4::text)::time <= w.ends end on_time,
               s.status
          from delivery_stop s left join delivery_window w on w.id = s.window_id
          left join customer cu on cu.id = s.customer_id left join delivery_route r on r.id = s.route_id
         where s.entity_id = $1 and s.scheduled_on = $2::date and s.status <> 'cancelled' and s.kind <> 'will_call') x
       where coalesce($3::text, 'all') = 'all' or ($3::text = 'done' and x.done) or ($3::text = 'timed' and x.done and x.on_time is not null)
          or ($3::text = 'on_time' and x.done and x.on_time) or ($3::text = 'late' and x.done and x.on_time = false) or ($3::text = 'failed' and x.status = 'failed')`,
    order: "ord1, id",
  },

  /** Delivery → a window's "N left" when booking (fleet.availability used.stops): the stops that count against its capacity */
  "window-stops": {
    title: "Booked in the window", measure: "count", roles: FLEET_BOOK_ROLES, doing: "what is booked in a delivery window",
    params: [{ name: "window", kind: "uuid", missing: "Pick a delivery window first." }, { name: "day", kind: "day", missing: "Pick a day first." }],
    sql: `
      select s.id, s.number || coalesce(' · ' || cu.name, '') title,
             concat_ws(' · ', initcap(replace(s.kind, '_', ' ')), s.pieces || ' pcs', round(s.cube_ft) || ' cu ft', s.service_min || ' crew min',
                       case when s.confirmed_at is null then 'not confirmed' end) detail,
             s.scheduled_on::text as on_day, null::text amount_minor, s.pieces::text qty, initcap(s.status) badge,
             null::text open_kind, null::text open_id, s.number ord1
        from delivery_stop s left join customer cu on cu.id = s.customer_id
       where s.entity_id = $1 and s.window_id = $2 and s.scheduled_on = $3::date and s.status <> 'cancelled' and not s.over_capacity_ok`,
    order: "ord1, id",
  },

  // -------------------------------------------------------------- Service
  /** Service → Open tickets (service.dashboard open) */
  "service-open": {
    title: "Open service tickets", measure: "count", roles: SERVICE_ROLES, doing: "the service desk's tickets",
    params: [{ name: "age", kind: "word", optional: true, words: AGE_BUCKETS, missing: "" }],
    sql: `
      select t.id, t.number || coalesce(' · ' || coalesce(cu.name, t.contact_name), '') title,
             concat_ws(' · ', initcap(t.priority) || ' priority', 'due ' || to_char(t.sla_due_at, 'Mon DD')) detail,
             (t.created_at at time zone business_tz($1))::date /* store-local date */::text as on_day, null::text amount_minor, null::text qty,
             case when t.sla_due_at < now() then 'Past due' else initcap(replace(t.status, '_', ' ')) end badge,
             'ticket' open_kind, t.id::text open_id, t.sla_due_at ord1
        from service_ticket t left join customer cu on cu.id = t.customer_id
       where t.entity_id = $1 and t.status in (${OPEN_SQL})
         and ($2::text is null or $2::text = case when now() - t.created_at < interval '3 days' then '0–2 days' when now() - t.created_at < interval '8 days' then '3–7 days'
                                                 when now() - t.created_at < interval '15 days' then '8–14 days' else '15+ days' end)`,
    order: "ord1 nulls last, id",
  },
  /** Service → Due in 24 hours (service.dashboard dueSoon) */
  "service-due24": {
    title: "Tickets due in the next 24 hours", measure: "count", roles: SERVICE_ROLES, doing: "the service desk's tickets",
    sql: `
      select t.id, t.number || coalesce(' · ' || coalesce(cu.name, t.contact_name), '') title,
             concat_ws(' · ', initcap(t.priority) || ' priority', 'due ' || to_char(t.sla_due_at, 'Mon DD HH12:MI am')) detail,
             (t.sla_due_at at time zone business_tz($1))::date /* store-local date */::text as on_day, null::text amount_minor, null::text qty, initcap(replace(t.status, '_', ' ')) badge,
             'ticket' open_kind, t.id::text open_id, t.sla_due_at ord1
        from service_ticket t left join customer cu on cu.id = t.customer_id
       where t.entity_id = $1 and t.status in (${OPEN_SQL})
         and t.sla_due_at between now() and now() + interval '24 hours'`,
    order: "ord1, id",
  },
  /** Service → Fixed first visit (service.dashboard firstTimeFix): resolved tickets with repair visits */
  "service-ftf": {
    title: "Resolved tickets with repair visits", measure: "count", roles: SERVICE_ROLES, doing: "the service desk's tickets",
    sql: `
      with v as (
        select t.id, t.number, coalesce(cu.name, t.contact_name) customer, t.resolved_at,
               count(sv.id) filter (where sv.outcome <> 'not_home')::int visits,
               (array_agg(sv.outcome order by sv.completed_at) filter (where sv.outcome <> 'not_home'))[1] first_outcome
          from service_ticket t join service_visit sv on sv.ticket_id = t.id and sv.completed_at is not null and sv.kind = 'repair'
          left join customer cu on cu.id = t.customer_id
         where t.entity_id = $1 and t.status in ('resolved','closed') group by t.id, cu.name)
      select v.id, v.number || coalesce(' · ' || v.customer, '') title,
             v.visits || case when v.visits = 1 then ' visit' else ' visits' end || coalesce(' · first: ' || replace(v.first_outcome, '_', ' '), '') detail,
             (v.resolved_at at time zone business_tz($1))::date /* store-local date */::text as on_day, null::text amount_minor, null::text qty,
             case when v.visits = 1 and v.first_outcome in ('fixed','no_fault') then 'First visit' else 'More than one' end badge,
             'ticket' open_kind, v.id::text open_id, v.resolved_at ord1
        from v`,
    order: "ord1 desc nulls last, id",
  },
  /** Service → Service cost, 30 days (service.dashboard cost30dMinor) */
  "service-cost30": {
    title: "Service cost, last 30 days", measure: "money", roles: SERVICE_ROLES, doing: "the service desk's tickets",
    sql: `
      select sc.id, t.number || ' · ' || initcap(replace(sc.kind, '_', ' ')) title,
             concat_ws(' · ', 'charged to ' || replace(sc.charge_to, '_', ' '), sc.note) detail,
             (sc.created_at at time zone business_tz($1))::date /* store-local date */::text as on_day, sc.amount_minor::text amount_minor, null::text qty, null::text badge,
             'ticket' open_kind, t.id::text open_id, sc.created_at ord1
        from service_cost sc join service_ticket t on t.id = sc.ticket_id
       where sc.entity_id = $1 and sc.created_at > now() - interval '30 days'`,
    order: "ord1 desc, id",
  },

  /** Time off → a balance tile (leave.balances available = balance - pending): the person's own ledger, less what is asked for */
  "leave-ledger": {
    title: "Time off, hour by hour", measure: "hours",
    params: [{ name: "type", kind: "uuid", missing: "Pick a kind of time off first." }],
    prep: async (c, entityId, _p, personId) => {
      const e = personId ? await q<{ id: string }>(c, `select id from employee where entity_id = $1 and app_user_id = $2 and status = 'active' limit 1`, [entityId, personId]) : [];
      need(e.length, "You are not set up as an employee here, so there is no time off to list.");
      return [e[0].id];
    },
    sql: `
      select l.id, case l.kind when 'accrual' then 'Earned' when 'taken' then 'Taken' when 'adjustment' then 'Adjusted by HR'
                            when 'reversal' then 'Given back' when 'carryover' then 'Carried over' else initcap(l.kind) end title,
             l.note detail, l.occurred_on::text as on_day, null::text amount_minor, l.hours::text qty, null::text badge,
             null::text open_kind, null::text open_id, l.occurred_on ord1, l.created_at ord2
        from leave_ledger l
       where l.entity_id = $1 and l.employee_id = $3 and l.leave_type_id = $2
      union all
      select r.id, 'Asked for', to_char(r.starts_on, 'Mon DD') || ' to ' || to_char(r.ends_on, 'Mon DD') || coalesce(' · ' || r.note, ''),
             r.starts_on::text, null::text, (-r.total_hours)::text, 'Waiting', null::text, null::text, r.starts_on, r.requested_at
        from leave_request r
       where r.entity_id = $1 and r.employee_id = $3 and r.leave_type_id = $2 and r.status = 'requested'`,
    order: "ord1 desc, ord2 desc, id",
  },

  // ---------------------------------------------------- Finance settlements
  /** Finance settlements → a lender's tile (ar_settlement.lenderAging owedMinor): what is left on each sale, plus holdbacks */
  "lender-owed": {
    title: "What the lender owes, sale by sale", measure: "money",
    params: [{ name: "lender", kind: "uuid", missing: "Pick a lender first." }],
    sql: `
      select f.id, coalesce(r.number, 'Sale') || coalesce(' · ' || cu.name, '') title,
             concat_ws(' · ', 'sale ' || to_char(f.amount_minor / 100.0, 'FM$999,999,990.00'),
                       case when f.holdback_open_minor <> 0 then 'holdback ' || to_char(f.holdback_open_minor / 100.0, 'FM$999,999,990.00') end,
                       replace(f.status, '_', ' ')) detail,
             (f.created_at at time zone business_tz($1))::date /* store-local date */::text as on_day,
             ((f.amount_minor - f.refunded_minor - f.funded_gross_minor) + f.holdback_open_minor)::text amount_minor,
             null::text qty, case when (f.amount_minor - f.refunded_minor - f.funded_gross_minor) < 0 then 'Refund to reverse' end badge,
             case when f.sales_order_id is not null then 'order' end open_kind, f.sales_order_id::text open_id, f.created_at ord1
        from financed_sale f left join customer_receipt r on r.id = f.receipt_id and r.entity_id = f.entity_id
        left join customer cu on cu.id = f.customer_id
       where f.entity_id = $1 and f.company_id = $2 and f.status <> 'charged_off'
         and ((f.amount_minor - f.refunded_minor - f.funded_gross_minor) <> 0 or f.holdback_open_minor <> 0)`,
    order: "ord1, id",
  },

  // ------------------------------------------------------------------- CRM
  /** Customer → Lifetime sales and Orders (crm.customer360 lifetimeValueMinor, orderCount) */
  "customer-orders": {
    title: "Every order", measure: "money",
    params: [{ name: "customer", kind: "uuid", missing: "Pick a customer first." }],
    sql: `
      select so.id, so.number || ' · ' || initcap(so.channel) title,
             concat_ws(' · ', initcap(replace(so.status, '_', ' ')), lo.name) detail, (so.ordered_at at time zone business_tz($1, so.location_id))::date /* store-local date */::text as on_day,
             so.total_minor::text amount_minor, null::text qty, null::text badge, 'order' open_kind, so.id::text open_id, so.ordered_at ord1
        from sales_order so left join location lo on lo.id = so.location_id
       where so.entity_id = $1 and so.customer_id = $2 and so.status not in ('draft','cancelled')`,
    order: "ord1 desc, id",
  },
  /** Customer → Store credit (ar.storeCreditBalance): credit issued, less credit spent */
  "store-credit": {
    title: "Store credit, issued and used", measure: "money",
    params: [{ name: "customer", kind: "uuid", missing: "Pick a customer first." }],
    sql: `
      select l.id, 'Issued' title, l.reason detail, (l.created_at at time zone business_tz($1))::date /* store-local date */::text as on_day, l.amount_minor::text amount_minor, null::text qty, null::text badge,
             null::text open_kind, null::text open_id, l.created_at ord1
        from store_credit_ledger l where l.entity_id = $1 and l.customer_id = $2
      union all
      select r.id, 'Used', concat_ws(' · ', r.number, so.number), (r.received_at at time zone business_tz($1, r.location_id))::date /* store-local date */::text, (-r.amount_minor)::text, null::text, null::text,
             case when r.sales_order_id is not null then 'order' end, r.sales_order_id::text, r.received_at
        from customer_receipt r left join sales_order so on so.id = r.sales_order_id
       where r.entity_id = $1 and r.customer_id = $2 and r.method = 'store_credit' and r.voided_at is null`,
    order: "ord1 desc, id",
  },

  /** Marketing dashboard (crm.dashboard leads, conversion, response) and My day → Open leads (crm.myDay openLeads) */
  "crm-leads": {
    title: "Leads", measure: "count",
    params: [
      { name: "show", kind: "word", words: ["window", "closed", "responded", "open"], missing: "Say which leads to show." },
      { name: "days", kind: "int", optional: true, missing: "" },
      { name: "person", kind: "uuid", optional: true, missing: "", prepOnly: true },
    ],
    // Open leads are the signed-in person's own; only the owner or a store manager may name someone else (My day's "Whose day").
    prep: async (_c, _e, p, personId, held) => {
      if (p.show !== "open") return [null];
      const mgr = !held || held.has("owner") || held.has("store_manager");
      const who = p.person && mgr ? p.person : personId;
      need(who, "Pick who you are acting as to see their leads.");
      need(!p.person || p.person === personId || mgr, "You see your own open leads; a store manager sees anyone's.");
      return [who];
    },
    sql: `
      select l.id, coalesce(l.number || ' · ', '') || coalesce(l.name, 'Lead') title,
             concat_ws(' · ', initcap(replace(l.source, '_', ' ')), u.name,
                       case when l.first_response_at is not null then 'answered in ' || round(extract(epoch from l.first_response_at - l.created_at) / 60) || ' min' end) detail,
             (l.created_at at time zone business_tz($1))::date /* store-local date */::text as on_day, l.estimate_minor::text amount_minor, null::text qty, initcap(l.stage) badge,
             'lead' open_kind, l.id::text open_id, l.created_at ord1
        from crm_lead l left join app_user u on u.id = l.assigned_to
       where l.entity_id = $1
         and case $2::text
               when 'open' then l.stage not in ('won','lost') and l.assigned_to = $4::uuid
               when 'window' then l.created_at >= now() - make_interval(days => coalesce($3::int, 90))
               when 'closed' then l.created_at >= now() - make_interval(days => coalesce($3::int, 90)) and l.stage in ('won','lost')
               when 'responded' then l.created_at >= now() - make_interval(days => coalesce($3::int, 90)) and l.first_response_at is not null
             end`,
    order: "ord1 desc, id",
  },
  /** Marketing dashboard → Overdue follow-ups (crm.overdue, every person) */
  "crm-overdue": {
    title: "Overdue follow-ups", measure: "count",
    sql: `
      select t.id, t.title, concat_ws(' · ', u.name, cu.name, l.name) detail, (t.due_at at time zone business_tz($1))::date /* store-local date */::text as on_day, null::text amount_minor, null::text qty,
             'Overdue' badge, case when t.lead_id is not null then 'lead' when t.customer_id is not null then 'customer' end open_kind,
             coalesce(t.lead_id, t.customer_id)::text open_id, t.due_at ord1
        from crm_task t join app_user u on u.id = t.assigned_to left join customer cu on cu.id = t.customer_id left join crm_lead l on l.id = t.lead_id
       where t.entity_id = $1 and t.done_at is null and t.cancelled_at is null and t.due_at < now()`,
    order: "ord1, id",
  },

  /** An order's Paid (sales_order.paid_minor; the web store's order view): the receipts taken on it, refunds negative */
  "order-receipts": {
    title: "Payments on the order", measure: "money",
    params: [{ name: "order", kind: "uuid", missing: "Pick an order first." }],
    sql: `
      select r.id, r.number || ' · ' || initcap(replace(r.method, '_', ' ')) title, concat_ws(' · ', initcap(r.channel), r.reference) detail,
             (r.received_at at time zone business_tz($1, r.location_id))::date /* store-local date */::text as on_day, r.amount_minor::text amount_minor, null::text qty, case when r.amount_minor < 0 then 'Refund' end badge,
             null::text open_kind, null::text open_id, r.received_at ord1
        from customer_receipt r
       where r.entity_id = $1 and r.sales_order_id = $2 and r.voided_at is null`,
    order: "ord1, id",
  },

  // ------------------------------------------------------------- Vendor EDI
  /** Vendor EDI → Quarantined, Waiting to go out, failed (edi.ediHome) */
  "edi-docs": {
    title: "EDI documents", measure: "count",
    params: [{ name: "status", kind: "word", words: ["quarantined", "queued", "failed"], missing: "Say which documents to show." }],
    sql: `
      select d.id, d.doc_type || ' · ' || case d.direction when 'in' then 'from ' else 'to ' end || coalesce(v.dba, v.legal_name, 'a vendor') title,
             concat_ws(' · ', d.reason, d.filename) detail, (d.created_at at time zone business_tz($1))::date /* store-local date */::text as on_day, null::text amount_minor, null::text qty,
             initcap(d.status) badge, 'edi' open_kind, d.id::text open_id, d.created_at ord1
        from edi_document d left join vendor v on v.id = d.vendor_id
       where d.entity_id = $1 and case $2::text when 'failed' then d.status in ('failed','rejected') else d.status = $2::text end`,
    order: "ord1 desc, id",
  },

  // ------------------------------------------------------------- Trade
  /** Trade account → Owed (ar.customerBalance as of today): the customer's receivable ledger */
  "customer-ledger": {
    title: "What the account owes", measure: "money", roles: TRADE_ROLES, doing: "a trade account's figures",
    params: [{ name: "customer", kind: "uuid", missing: "Pick a customer first." }],
    sql: `
      select l.id, initcap(replace(l.kind, '_', ' ')) || coalesce(' · ' || i.number, '') title, concat_ws(' · ', lo.name, l.memo) detail,
             l.occurred_on::text as on_day, l.amount_minor::text amount_minor, null::text qty, null::text badge,
             case when l.journal_entry_id is not null then 'entry' end open_kind, l.journal_entry_id::text open_id, l.occurred_on ord1, l.created_at ord2
        from ar_ledger l left join customer_invoice i on i.id = l.invoice_id left join location lo on lo.id = l.location_id
       where l.entity_id = $1 and l.customer_id = $2 and l.occurred_on <= business_today($1) /* store-local date */`,
    order: "ord1 desc, ord2 desc, id",
  },
  /** Trade account → On order, unbilled (trade credit pending): open trade orders, less what is paid or billed */
  "trade-onorder": {
    title: "On order, not billed yet", measure: "money", roles: TRADE_ROLES, doing: "a trade account's figures",
    params: [{ name: "customer", kind: "uuid", missing: "Pick a customer first." }],
    sql: `
      select x.* from (
        select so.id, so.number title, concat_ws(' · ', initcap(so.status), 'total ' || to_char(so.total_minor / 100.0, 'FM$999,999,990.00'),
                         case when so.paid_minor <> 0 then 'paid ' || to_char(so.paid_minor / 100.0, 'FM$999,999,990.00') end) detail,
               (so.ordered_at at time zone business_tz($1, so.location_id))::date /* store-local date */::text as on_day,
               greatest(so.total_minor - so.paid_minor - coalesce((select sum(i.charged_minor) from customer_invoice i
                 where i.entity_id = so.entity_id and i.sales_order_id = so.id), 0), 0)::text amount_minor,
               null::text qty, null::text badge, 'order' open_kind, so.id::text open_id, so.ordered_at ord1
          from sales_order so
         where so.entity_id = $1 and so.customer_id = $2 and so.status in ('open','fulfilling') and so.channel = 'b2b') x
       where x.amount_minor::bigint <> 0`,
    order: "ord1, id",
  },
  /** Trade account → Referral owed (trade.account referrals.owedMinor): referral events not yet on a bill */
  "trade-referrals": {
    title: "Referral commission owed", measure: "money", roles: TRADE_ROLES, doing: "a trade account's figures",
    params: [{ name: "account", kind: "uuid", missing: "Pick a trade account first." }],
    sql: `
      select e.id, coalesce(so.number, 'Order') || ' · ' || initcap(replace(e.kind, '_', ' ')) title,
             concat_ws(' · ', 'on ' || to_char(e.basis_minor / 100.0, 'FM$999,999,990.00'), (e.rate_bps / 100.0)::text || '%') detail,
             e.earned_on::text as on_day, e.amount_minor::text amount_minor, null::text qty, null::text badge,
             case when e.sales_order_id is not null then 'order' end open_kind, e.sales_order_id::text open_id, e.earned_on ord1, e.created_at ord2
        from trade_referral_event e left join sales_order so on so.id = e.sales_order_id
       where e.entity_id = $1 and e.trade_account_id = $2 and e.bill_id is null`,
    order: "ord1 desc, ord2 desc, id",
  },

  // ------------------------------------------------------------------- POS
  /** POS → Z report: Sales (pos.zReport sales) */
  "pos-sales": {
    title: "Sales rung on this drawer", measure: "money",
    params: [{ name: "session", kind: "uuid", missing: "Pick a drawer session first." }],
    prep: sessionHere,
    sql: `
      select so.id, so.number || coalesce(' · ' || cu.name, '') title,
             concat_ws(' · ', initcap(po.kind), 'tax ' || to_char(so.tax_minor / 100.0, 'FM$999,999,990.00'),
                       case when so.discount_minor <> 0 then 'discount ' || to_char(so.discount_minor / 100.0, 'FM$999,999,990.00') end) detail,
             (so.ordered_at at time zone business_tz($1, so.location_id))::date /* store-local date */::text as on_day, so.total_minor::text amount_minor, null::text qty, initcap(so.status) badge,
             'order' open_kind, so.id::text open_id, so.number ord1
        from pos_order po join sales_order so on so.id = po.sales_order_id left join customer cu on cu.id = so.customer_id
       where po.entity_id = $1 and po.register_session_id = $2 and po.kind in ('sale','layaway') and so.status <> 'draft' and so.status <> 'cancelled'`,
    order: "ord1, id",
  },
  /** POS → Z report: Returns (pos.zReport returns) */
  "pos-returns": {
    title: "Returns on this drawer", measure: "money",
    params: [{ name: "session", kind: "uuid", missing: "Pick a drawer session first." }],
    prep: sessionHere,
    sql: `
      select so.id, so.number || coalesce(' · ' || cu.name, '') title, coalesce(po.return_note, 'Return') detail,
             (so.ordered_at at time zone business_tz($1, so.location_id))::date /* store-local date */::text as on_day, (-so.total_minor)::text amount_minor, null::text qty, null::text badge,
             'order' open_kind, so.id::text open_id, so.number ord1
        from pos_order po join sales_order so on so.id = po.sales_order_id left join customer cu on cu.id = so.customer_id
       where po.entity_id = $1 and po.register_session_id = $2 and po.kind = 'return'`,
    order: "ord1, id",
  },
  /** POS → Z report: By tender, and Cash taken (pos.zReport tenders): receipts net of refunds */
  "pos-receipts": {
    title: "Payments taken on this drawer", measure: "money",
    params: [
      { name: "session", kind: "uuid", missing: "Pick a drawer session first." },
      { name: "method", kind: "code", optional: true, missing: "" },
    ],
    prep: sessionHere,
    sql: `
      select r.id, r.number || coalesce(' · ' || cu.name, '') title,
             concat_ws(' · ', initcap(replace(r.method, '_', ' ')), so.number, r.reference) detail,
             (r.received_at at time zone business_tz($1, r.location_id))::date /* store-local date */::text as on_day, r.amount_minor::text amount_minor, null::text qty,
             case when r.amount_minor < 0 then 'Refund' end badge,
             case when r.sales_order_id is not null then 'order' end open_kind, r.sales_order_id::text open_id, r.received_at ord1
        from customer_receipt r left join customer cu on cu.id = r.customer_id left join sales_order so on so.id = r.sales_order_id
       where r.entity_id = $1 and r.register_session_id = $2 and r.voided_at is null and ($3::text is null or r.method = $3)`,
    order: "ord1, id",
  },
  /** POS → Z report: Drops, Paid in / out (pos.zReport cash) */
  "pos-cash": {
    title: "Cash in and out of this drawer", measure: "money",
    params: [
      { name: "session", kind: "uuid", missing: "Pick a drawer session first." },
      { name: "kind", kind: "word", optional: true, words: ["drop", "paid_in", "paid_out"], missing: "" },
    ],
    prep: sessionHere,
    sql: `
      select m.id, case m.kind when 'drop' then 'Drop to the safe' when 'paid_in' then 'Paid in' when 'paid_out' then 'Paid out' else m.kind end title,
             concat_ws(' · ', m.note, u.name) detail, (m.at at time zone business_tz($1))::date /* store-local date */::text as on_day, m.amount_minor::text amount_minor, null::text qty, null::text badge,
             null::text open_kind, null::text open_id, m.at ord1
        from pos_cash_movement m left join app_user u on u.id = m.by_user
       where m.entity_id = $1 and m.session_id = $2 and ($3::text is null or m.kind = $3)`,
    order: "ord1, id",
  },
};

export type DrillRow = { id: string; title: string; detail: string | null; on_day: string | null; amount_minor: string | null; qty: string | null;
  badge: string | null; open_kind: string | null; open_id: string | null };

function readParams(def: Def, input: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of def.params ?? []) {
    const raw = (input[p.name] ?? "").trim();
    if (!raw) { need(p.optional, p.missing); out[p.name] = null; continue; }
    if (p.kind === "uuid") need(UUID.test(raw), p.missing);
    if (p.kind === "day") need(DAY.test(raw) && !Number.isNaN(Date.parse(raw)), "That is not a day; use the form 2026-11-11.");
    if (p.kind === "code") need(/^[A-Za-z0-9_.-]{1,30}$/.test(raw), "That is not an account or method code.");
    if (p.kind === "word") need(p.words!.includes(raw), `Show one of: ${p.words!.join(", ").replace(/_/g, " ")}.`);
    if (p.kind === "int") need(/^\d{1,4}$/.test(raw), "That is not a whole number of days.");
    if (p.kind === "since") need(raw === "all" || (DAY.test(raw) && !Number.isNaN(Date.parse(raw))), "Show from a day (2026-01-01), or all.");
    out[p.name] = raw;
  }
  return out;
}

/** The rows behind one figure, a page at a time, with the count and total of every row (not just this page). */
export async function list(c: Client, entityId: string, key: string, input: Record<string, string | null>, page = 1, held: Set<string> | null = null, personId: string | null = null) {
  const def = Object.prototype.hasOwnProperty.call(DEFS, key) ? DEFS[key] : null;
  need(def, `There is no list called “${key.slice(0, 40)}”.`);
  if (def.roles && held) {
    need(held.has("owner") || def.roles.some((r) => held.has(r)),
      `Seeing ${def.doing ?? def.title.toLowerCase()} needs one of: ${def.roles.filter((r) => r !== "owner").map((r) => r.replace(/_/g, " ")).join(", ")}.`);
  }
  need(Number.isInteger(page) && page >= 1 && page <= 10000, "Pages are counted from 1.");
  const p = readParams(def, input);
  const args: unknown[] = [entityId, ...(def.params ?? []).filter((x) => !x.prepOnly).map((x) => p[x.name])];
  if (def.prep) args.push(...(await def.prep(c, entityId, p, personId, held)));
  // def.sql names entity_id = $1 in every table it reads; the wrapper only pages it and adds it up, in one pass.
  type Row = DrillRow & { n_all: number; total_all: string; hours_all: string };
  const got = await q<Row>(c, `
    select d.id::text, d.title, d.detail, d.on_day, d.amount_minor, d.qty, d.badge, d.open_kind, d.open_id,
           count(*) over ()::int n_all, coalesce(sum(d.amount_minor::bigint) over (), 0)::text total_all,
           round(coalesce(sum(d.qty::numeric) over (), 0), 3)::text hours_all
      from (${def.sql}) d /* entity_id = $1 inside */ order by ${def.order} limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`, args);
  let tot = got.length ? { n: got[0].n_all, total: got[0].total_all, hours: got[0].hours_all } : { n: 0, total: "0", hours: "0" };
  if (!got.length && page > 1) {
    // past the end: count once, only to say how many pages there are
    tot = await one<{ n: number; total: string; hours: string }>(c, `select count(*)::int n, '0' total, '0' hours from (${def.sql}) d /* entity_id = $1 inside */`, args);
  }
  const pages = Math.max(1, Math.ceil(tot.n / PAGE_SIZE));
  need(page <= pages, `There ${pages === 1 ? "is only one page" : `are only ${pages} pages`} in this list.`);
  const rows: DrillRow[] = got.map(({ n_all: _n, total_all: _t, hours_all: _h, ...r }) => r);
  // A windowed books list: what came before the window, carried in as one figure.
  const since = def.opening ? (args[args.length - 1] as string | null) : null;
  const openingMinor = def.opening && since ? (await one<{ opening: string }>(c, def.opening, args)).opening : def.opening ? "0" : null;
  return { key, title: def.title, measure: def.measure, count: tot.n, totalMinor: def.measure === "money" ? tot.total : null,
    totalHours: def.measure === "hours" ? Number(tot.hours) : null,
    /** books lists: the window's first day (null: the whole history), what came before it, and the balance (opening + every row) */
    since: def.opening ? since : undefined, openingMinor: openingMinor ?? undefined,
    balanceMinor: def.opening ? (BigInt(openingMinor ?? "0") + BigInt(tot.total)).toString() : undefined,
    page, pages, pageSize: PAGE_SIZE, params: p, rows };
}

/** Every row of a list, all pages (for checks). */
export async function all(c: Client, entityId: string, key: string, input: Record<string, string | null>, held: Set<string> | null = null, personId: string | null = null) {
  const first = await list(c, entityId, key, input, 1, held, personId);
  const rows = [...first.rows];
  for (let pg = 2; pg <= first.pages; pg++) rows.push(...(await list(c, entityId, key, input, pg, held, personId)).rows);
  return { ...first, rows };
}
