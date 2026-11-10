// The designer as a commission role (trade module). A sale line can carry
// its own split -- the primary rep and an internal designer -- which replaces
// the order's salespeople for that line when workforce.accrueCommissions earns
// it (on gross margin or the sale, as each person's plan says). A line can
// also carry an outside referral: the trade account that brought the client
// in earns its referral rate as a payable (Dr 6130 Cr 2160 now; a vendor bill
// against the account's vendor later moves it to payables), when the line is
// delivered, or when the order is paid if the company says so. A return gives
// it back the same way (a negative event), and a cancelled line that earned
// gives back all of it.
//
// This file reads and writes only its own tables, the GL through post(), and
// a vendor bill through the payables gates (runGates, postToLedger).

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { post, profitObjectFor, type PostLine } from "./posting.ts";
import { mulBps } from "./money.ts";
import { runGates, postToLedger } from "./invoice.ts";

export class TradeCommissionError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new TradeCommissionError(msg); };
const U = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B = (v: string | number | bigint | null | undefined) => BigInt(v ?? 0);
const today = () => new Date().toISOString().slice(0, 10);
const pct = (b: number) => `${(b / 100).toFixed(b % 100 ? 2 : 0)}%`;

/** The line a return line gives back (itself, if it is not a return). */
async function sourceLine(c: Client, entityId: string, lineId: string): Promise<string> {
  const r = await q<{ original_line_id: string | null }>(c, `select original_line_id from pos_line where entity_id = $1 and sales_order_line_id = $2`, [entityId, lineId]);
  return r[0]?.original_line_id ?? lineId;
}

/** A line's own split, or none (then the order's salespeople earn it). A return line uses the line it returns. */
export async function lineSplits(c: Client, entityId: string, lineId: string): Promise<{ app_user_id: string; split_bps: number }[]> {
  const src = await sourceLine(c, entityId, lineId);
  return q<{ app_user_id: string; split_bps: number }>(c, `select app_user_id, split_bps from sales_order_line_split
     where entity_id = $1 and sales_order_line_id = $2 and replaced_at is null order by role, split_bps desc, app_user_id`, [entityId, src]);
}

export type LineCommissionIn = {
  primaryId?: string | null; designerId?: string | null; designerSplitBps?: number | null; referralTradeAccountId?: string | null; clearReferral?: boolean;
};

/**
 * Say who earns a line: the primary rep, and an internal designer with their
 * share; and/or the outside trade account that referred the client. Only
 * until the line is invoiced -- after that its commission is already earned.
 */
export async function setLineCommission(c: Client, scope: Scope, lineId: string, e: LineCommissionIn) {
  need(U.test(lineId), "no such line");
  const l = (await q<{ id: string; sku: string; sales_order_id: string; salesperson_id: string | null; status: string; line_status: string; qty: string; invoiced: boolean }>(c, `
    select l.id, l.sku, l.sales_order_id, so.salesperson_id, so.status, l.line_status, l.qty::text,
           exists (select 1 from customer_invoice_line il where il.sales_order_line_id = l.id) invoiced
      from sales_order_line l join sales_order so on so.id = l.sales_order_id and so.entity_id = l.entity_id
     where l.id = $1 and l.entity_id = $2 for update of l`, [lineId, scope.entityId]))[0];
  need(l, "no such line");
  need(Number(l!.qty) > 0, "a return line follows the line it returns");
  need(!l!.invoiced && !["fulfilled", "returned", "cancelled"].includes(l!.line_status), `${l!.sku} has been handed over; its commission is already earned`);
  need(l!.status !== "cancelled", "that order was cancelled");
  const people = async (ids: string[]) => (await q(c, `select u.id from app_user u where u.id = any($1) and u.status = 'active'
      and exists (select 1 from role_grant g where g.app_user_id = u.id and (g.entity_id = $2 or (g.entity_id is null and u.tenant_id = $3)))`,
    [ids, scope.entityId, scope.tenantId])).length === ids.length;
  if (e.designerId !== undefined || e.primaryId !== undefined) {
    const designer = e.designerId || null;
    const primary = e.primaryId || l!.salesperson_id || scope.actor.id || null;
    if (!designer) {
      // No designer: the line goes back to the order's salespeople.
      await c.query(`update sales_order_line_split set replaced_at = now() where entity_id = $1 and sales_order_line_id = $2 and replaced_at is null`, [scope.entityId, lineId]);
      if (e.primaryId) {
        need(await people([e.primaryId]), "the rep named is not one of this company's people");
        await c.query(`insert into sales_order_line_split (entity_id, sales_order_line_id, app_user_id, role, split_bps, set_by) values ($1,$2,$3,'primary',10000,$4)`,
          [scope.entityId, lineId, e.primaryId, scope.actor.id || null]);
      }
    } else {
      need(primary, "name the primary rep");
      need(designer !== primary, "the designer and the primary rep are two different people");
      const sb = Number(e.designerSplitBps);
      need(Number.isInteger(sb) && sb >= 1 && sb <= 9999, "the designer's share is between 0.01% and 99.99%; the rest is the primary rep's");
      need(await people([primary!, designer]), "a person named is not one of this company's people");
      const isDesigner = await q(c, `select 1 from role_grant g join app_user u on u.id = g.app_user_id where g.app_user_id = $1 and g.role in ('designer','sales','store_manager','owner')
          and (g.entity_id = $2 or (g.entity_id is null and u.tenant_id = $3))`, [designer, scope.entityId, scope.tenantId]);
      need(isDesigner.length, "the designer named has no designer or sales role here");
      await c.query(`update sales_order_line_split set replaced_at = now() where entity_id = $1 and sales_order_line_id = $2 and replaced_at is null`, [scope.entityId, lineId]);
      await c.query(`insert into sales_order_line_split (entity_id, sales_order_line_id, app_user_id, role, split_bps, set_by) values ($1,$2,$3,'primary',$4,$6), ($1,$2,$5,'designer',$7,$6)`,
        [scope.entityId, lineId, primary, 10000 - sb, designer, scope.actor.id || null, sb]);
    }
  }
  if (e.clearReferral) {
    await c.query(`update sales_order_line_referral set replaced_at = now() where entity_id = $1 and sales_order_line_id = $2 and replaced_at is null`, [scope.entityId, lineId]);
  } else if (e.referralTradeAccountId) {
    const ta = (await q<{ id: string; company_name: string; status: string; referral_bps: number; referral_basis: string; vendor_id: string | null }>(c,
      `select id, company_name, status, referral_bps, referral_basis, vendor_id from trade_account where id = $1 and entity_id = $2`, [e.referralTradeAccountId, scope.entityId]))[0];
    need(ta, "no such trade account");
    need(ta!.status === "active", `${ta!.company_name}'s trade account is ${ta!.status}`);
    need(ta!.referral_bps > 0, `${ta!.company_name} has no referral commission set; set its rate on the trade account first`);
    need(ta!.vendor_id, `${ta!.company_name} is not linked to a vendor to pay; link one on the trade account first`);
    await c.query(`update sales_order_line_referral set replaced_at = now() where entity_id = $1 and sales_order_line_id = $2 and replaced_at is null`, [scope.entityId, lineId]);
    await c.query(`insert into sales_order_line_referral (sales_order_line_id, entity_id, trade_account_id, rate_bps, basis, set_by) values ($1,$2,$3,$4,$5,$6)`,
      [lineId, scope.entityId, ta!.id, ta!.referral_bps, ta!.referral_basis, scope.actor.id || null]);
  }
  await audit(c, scope, { table: "sales_order_line", rowId: lineId, action: "update", after: { ...e }, sourceRef: "trade commission" });
  return lineCommission(c, scope.entityId, lineId);
}

export async function lineCommission(c: Client, entityId: string, lineId: string) {
  const split = await q(c, `select s.app_user_id, u.name, s.role, s.split_bps from sales_order_line_split s join app_user u on u.id = s.app_user_id
     where s.entity_id = $1 and s.sales_order_line_id = $2 and s.replaced_at is null order by s.role, s.split_bps desc`, [entityId, lineId]);
  const referral = (await q(c, `select r.trade_account_id, t.company_name, r.rate_bps, r.basis from sales_order_line_referral r join trade_account t on t.id = r.trade_account_id
     where r.entity_id = $1 and r.sales_order_line_id = $2 and r.replaced_at is null`, [entityId, lineId]))[0] ?? null;
  return { lineId, split, referral };
}

/** When referral commission is earned: on delivery (default) or once the order is paid in full. */
export async function referralTrigger(c: Client, entityId: string): Promise<"delivered" | "paid"> {
  const r = await q<{ v: string }>(c, `select value #>> '{}' v from entity_setting where entity_id = $1 and key = 'trade.referral_on'`, [entityId]);
  return r[0]?.v === "paid" ? "paid" : "delivered";
}

/**
 * Earn the referral on lines delivered (or paid) and give it back on lines
 * returned or cancelled. Safe to run any number of times. Posts Dr 6130
 * Cr 2160, by store, in one entry.
 */
export async function accrueReferrals(c: Client, scope: Scope, opts: { orderId?: string | null } = {}) {
  const has = (await q<{ t: string | null }>(c, `select to_regclass('trade_referral_event')::text t /* unscoped: is the trade module installed */`))[0]?.t;
  if (!has) return { earned: 0, clawedBack: 0, totalMinor: 0n, journalEntryId: null as string | null };
  const onPaid = (await referralTrigger(c, scope.entityId)) === "paid";
  const lines = await q<{ line_id: string; order_id: string; location_id: string; earned_on: string; net_minor: string; qty: string; cost_minor: string | null;
    trade_account_id: string; vendor_id: string | null; rate_bps: number; basis: string }>(c, `
    select l.id line_id, so.id order_id, so.location_id, coalesce(i.invoice_date, current_date)::text earned_on,
           coalesce(il.net_minor, round(l.qty * l.unit_price_minor)::bigint - l.discount_minor)::text net_minor, l.qty::text, p.cost_minor::text,
           r.trade_account_id, t.vendor_id, r.rate_bps, r.basis
      from sales_order_line l
      join sales_order so on so.id = l.sales_order_id and so.entity_id = l.entity_id
      left join pos_line pl on pl.sales_order_line_id = l.id and pl.entity_id = l.entity_id
      join sales_order_line_referral r on r.sales_order_line_id = coalesce(pl.original_line_id, l.id) and r.entity_id = l.entity_id and r.replaced_at is null
      join trade_account t on t.id = r.trade_account_id and t.entity_id = l.entity_id
      left join customer_invoice_line il on il.sales_order_line_id = l.id
      left join customer_invoice i on i.id = il.invoice_id
      left join product p on p.id = l.product_id
     where l.entity_id = $1 and ($2::uuid is null or so.id = $2)
       and ((l.qty > 0 and il.id is not null and l.line_status = 'fulfilled' and ($3 = false or so.paid_minor >= so.total_minor))
         or (l.qty < 0 and l.line_status = 'returned' and l.product_id is not null))
       and not exists (select 1 from trade_referral_event ev where ev.entity_id = $1 and ev.sales_order_line_id = l.id)
     order by so.ordered_at, l.seq`, [scope.entityId, opts.orderId ?? null, onPaid]);
  const fresh: { amount: bigint; location: string; id: string }[] = [];
  let earned = 0, clawedBack = 0;
  for (const l of lines) {
    const net = B(l.net_minor);
    const cost = BigInt(Math.round(Number(l.qty) * Number(l.cost_minor ?? 0)));
    const basis = l.basis === "margin" ? net - cost : net;
    const amount = mulBps(basis, l.rate_bps);
    // A return line is only given back if the line it returns earned.
    if (net < 0n) {
      const src = await sourceLine(c, scope.entityId, l.line_id);
      const was = await q(c, `select 1 from trade_referral_event where entity_id = $1 and sales_order_line_id = $2 and kind = 'earned'`, [scope.entityId, src]);
      if (!was.length) continue;
    }
    const ev = await one<{ id: string }>(c, `insert into trade_referral_event (entity_id, trade_account_id, vendor_id, sales_order_id, sales_order_line_id, kind,
        sale_minor, cost_minor, basis_minor, rate_bps, amount_minor, earned_on) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [scope.entityId, l.trade_account_id, l.vendor_id, l.order_id, l.line_id, net < 0n ? "clawback" : "earned", net.toString(), cost.toString(),
       basis.toString(), l.rate_bps, amount.toString(), l.earned_on]);
    fresh.push({ amount, location: l.location_id, id: ev.id });
    if (net < 0n) clawedBack++; else earned++;
  }
  // A line that earned and was then cancelled gives it all back.
  const gone = await q<{ id: string; trade_account_id: string; vendor_id: string | null; sales_order_id: string; sales_order_line_id: string; sale_minor: string;
    cost_minor: string; basis_minor: string; rate_bps: number; amount_minor: string; location_id: string }>(c, `
    select ev.id, ev.trade_account_id, ev.vendor_id, ev.sales_order_id, ev.sales_order_line_id, ev.sale_minor, ev.cost_minor, ev.basis_minor, ev.rate_bps, ev.amount_minor,
           so.location_id
      from trade_referral_event ev join sales_order_line l on l.id = ev.sales_order_line_id join sales_order so on so.id = l.sales_order_id
     where ev.entity_id = $1 and ev.kind = 'earned' and ev.amount_minor <> 0 and ($2::uuid is null or so.id = $2)
       and (l.line_status in ('returned','cancelled') or so.status = 'cancelled')
       and not exists (select 1 from trade_referral_event cb where cb.entity_id = $1 and cb.sales_order_line_id = ev.sales_order_line_id and cb.kind = 'clawback')`,
    [scope.entityId, opts.orderId ?? null]);
  for (const g of gone) {
    const ev = await one<{ id: string }>(c, `insert into trade_referral_event (entity_id, trade_account_id, vendor_id, sales_order_id, sales_order_line_id, kind,
        sale_minor, cost_minor, basis_minor, rate_bps, amount_minor, earned_on) values ($1,$2,$3,$4,$5,'clawback',$6,$7,$8,$9,$10,$11) returning id`,
      [scope.entityId, g.trade_account_id, g.vendor_id, g.sales_order_id, g.sales_order_line_id, (-B(g.sale_minor)).toString(), (-B(g.cost_minor)).toString(),
       (-B(g.basis_minor)).toString(), g.rate_bps, (-B(g.amount_minor)).toString(), today()]);
    fresh.push({ amount: -B(g.amount_minor), location: g.location_id, id: ev.id });
    clawedBack++;
  }
  const byLoc = new Map<string, bigint>();
  for (const f of fresh) byLoc.set(f.location, (byLoc.get(f.location) ?? 0n) + f.amount);
  const pl: PostLine[] = [];
  for (const [loc, amt] of byLoc) {
    if (amt === 0n) continue;
    const po = await profitObjectFor(c, scope.entityId, loc);
    if (amt > 0n) pl.push({ code: "6130", debit: amt, profitObjectId: po, memo: "trade referral" }, { code: "2160", credit: amt, profitObjectId: po, memo: "trade referral" });
    else pl.push({ code: "2160", debit: -amt, profitObjectId: po, memo: "trade referral" }, { code: "6130", credit: -amt, profitObjectId: po, memo: "trade referral" });
  }
  let je: string | null = null;
  if (pl.length) {
    je = await post(c, scope, { date: today(), sourceType: "commission", sourceId: opts.orderId ?? null,
      description: `Trade referral commission: ${earned} earned, ${clawedBack} given back`, lines: pl });
    await c.query(`update trade_referral_event set journal_entry_id = $2 where entity_id = $3 and id = any($1)`, [fresh.map((f) => f.id), je, scope.entityId]);
  }
  return { earned, clawedBack, totalMinor: fresh.reduce((a, f) => a + f.amount, 0n), journalEntryId: je };
}

/** What each trade account is owed in referral commission and not yet billed. */
export async function referralsOwed(c: Client, entityId: string, tradeAccountId: string | null = null) {
  return q<{ trade_account_id: string; company_name: string; vendor_id: string | null; owed_minor: string; events: number }>(c, `
    select t.id trade_account_id, t.company_name, t.vendor_id, coalesce(sum(ev.amount_minor), 0)::text owed_minor, count(ev.id)::int events
      from trade_account t join trade_referral_event ev on ev.trade_account_id = t.id and ev.entity_id = t.entity_id and ev.bill_id is null
     where t.entity_id = $1 and ($2::uuid is null or t.id = $2) group by t.id order by t.company_name`, [entityId, tradeAccountId]);
}

/**
 * Turn what an account is owed into a bill from its vendor, coded to 2160
 * (the accrual), through the payables gates like any bill. A net give-back
 * (more returned than earned) is not billed; it waits against later referrals.
 */
export async function billReferrals(c: Client, scope: Scope, tradeAccountId: string, makerId: string) {
  need(U.test(tradeAccountId), "no such trade account");
  const ta = (await q<{ company_name: string; vendor_id: string | null; number: string }>(c, `select company_name, vendor_id, number from trade_account where id = $1 and entity_id = $2 for update`,
    [tradeAccountId, scope.entityId]))[0];
  need(ta, "no such trade account");
  need(ta!.vendor_id, `${ta!.company_name} is not linked to a vendor to pay`);
  const ve = (await q<{ terms_days: number }>(c, `select terms_days from vendor_entity where vendor_id = $1 and entity_id = $2 and status = 'active'`, [ta!.vendor_id, scope.entityId]))[0];
  need(ve, `${ta!.company_name}'s vendor is not set up for this company`);
  const evs = await q<{ id: string; amount_minor: string }>(c, `select id, amount_minor from trade_referral_event where entity_id = $1 and trade_account_id = $2 and bill_id is null for update`,
    [scope.entityId, tradeAccountId]);
  const total = evs.reduce((a, x) => a + B(x.amount_minor), 0n);
  need(evs.length, `${ta!.company_name} has no referral commission waiting to be billed`);
  need(total > 0n, `${ta!.company_name}'s returns outweigh its referrals (${(Number(-total) / 100).toFixed(2)} to recover); nothing is billed until later referrals cover it`);
  const acct = (await q<{ id: string }>(c, `select id from gl_account where tenant_id = $1 and code = '2160' /* unscoped: chart is tenant-wide */`, [scope.tenantId]))[0];
  need(acct, "the chart has no 2160 commissions payable account; apply a setup pack in Business setup");
  const seq = (await one<{ n: string }>(c, `select next_doc_no($1, 'trade_referral_bill', 'REF-') n /* unscoped: numbering function takes the entity */`, [scope.entityId])).n;
  const reference = `${seq}-${ta!.number}`.slice(0, 60);
  const inv = await one<{ id: string }>(c, `
    insert into invoice (tenant_id, entity_id, vendor_id, kind, reference, invoice_date, due_date, total_minor, confidence_bps, created_by)
    values ($1,$2,$3,'operating',$4,current_date,current_date + $5::int,$6,10000,$7) returning id`,
    [scope.tenantId, scope.entityId, ta!.vendor_id, reference, ve!.terms_days, total.toString(), makerId]);
  await c.query(`insert into invoice_line (invoice_id, seq, gl_account_id, description, amount_minor)
                 select $1, 1, $2, $3, $4 where exists (select 1 from invoice where id = $1 and entity_id = $5)`,
    [inv.id, acct!.id, `Referral commission, ${evs.length} line${evs.length === 1 ? "" : "s"}`, total.toString(), scope.entityId]);
  await c.query(`update trade_referral_event set bill_id = $3 where entity_id = $1 and id = any($2)`, [scope.entityId, evs.map((x) => x.id), inv.id]);
  const out = await runGates(c, scope, inv.id, makerId);
  if (out.status === "approved") await postToLedger(c, scope, inv.id);
  await audit(c, scope, { table: "invoice", rowId: inv.id, action: "insert", after: { reference, total: total.toString(), referralEvents: evs.length } });
  return { invoiceId: inv.id, reference, totalMinor: total, status: out.status };
}

export const describeSplit = (bps: number) => pct(bps);
