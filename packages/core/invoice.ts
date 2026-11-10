// The invoice lifecycle: one status at a time, every change an event.
//
// A clean invoice crosses the whole machine without a person. The branches
// are where people enter, which is why the exception count matters more
// than the touchless rate on its own.

import { type Client, type Scope, audit, one, q } from "./db.ts";
import { openRequest } from "./approvals.ts";
import { withinTolerance } from "./money.ts";
import { post } from "./posting.ts";

export type Status =
  | "captured" | "extracted" | "matched" | "validated" | "pending"
  | "exception" | "held" | "approved" | "scheduled" | "paid" | "rejected";

const TRANSITIONS: Record<Status, Status[]> = {
  captured:  ["extracted", "exception"],
  extracted: ["matched", "exception"],
  matched:   ["validated", "exception"],
  validated: ["approved", "pending", "held"],
  pending:   ["approved", "rejected"],
  exception: ["validated", "rejected"],
  held:      ["validated", "rejected"],
  approved:  ["scheduled"],
  scheduled: ["paid"],
  paid:      [],
  rejected:  [],
};

/** The confidence a field must clear before it posts without a person. */
export const CONFIDENCE_GATE_BPS = 9000;

/** How close in days two invoices must be to be scored as a possible duplicate. */
export const DUPLICATE_WINDOW_DAYS = 5;

export class TransitionError extends Error {}

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Status never changes by an update alone. It changes here, with the audit
 * row written in the same transaction, so there is no unexplained state.
 */
export async function transition(
  c: Client,
  scope: Scope,
  invoiceId: string,
  to: Status,
  reason: string
): Promise<Status> {
  const inv = await one<{ id: string; status: Status }>(
    c,
    `select id, status from invoice where id = $1 and entity_id = $2 for update`,
    [invoiceId, scope.entityId]
  );
  if (!canTransition(inv.status, to))
    throw new TransitionError(`cannot move an invoice from ${inv.status} to ${to}`);

  await c.query(`update invoice set status = $2 where id = $1`, [invoiceId, to]);
  await audit(c, scope, {
    table: "invoice",
    rowId: invoiceId,
    action: "transition",
    before: { status: inv.status },
    after: { status: to },
    reason,
  });
  return to;
}

type GateOutcome = { status: Status; reason: string; approvalRequestId?: string };

/**
 * Drive the pipeline as far as it goes on its own. Every return value is a
 * status plus the reason it landed there -- that reason is what the
 * exception queue shows, and what the auditor reads later.
 */
export async function runGates(
  c: Client,
  scope: Scope,
  invoiceId: string,
  makerId: string
): Promise<GateOutcome> {
  const inv = await one<{
    id: string; kind: string; vendor_id: string; reference: string | null;
    total_minor: string; invoice_date: string; confidence_bps: number | null;
    purchase_order_id: string | null; status: Status;
  }>(
    c,
    `select id, kind, vendor_id, reference, total_minor, invoice_date,
            confidence_bps, purchase_order_id, status
       from invoice where id = $1 and entity_id = $2`,
    [invoiceId, scope.entityId]
  );
  const total = BigInt(inv.total_minor);

  // Gate 1 -- extraction confidence
  if (inv.status === "captured") await transition(c, scope, invoiceId, "extracted", "fields extracted");
  if ((inv.confidence_bps ?? 0) < CONFIDENCE_GATE_BPS) {
    await transition(c, scope, invoiceId, "exception", "below the confidence gate");
    return { status: "exception", reason: "below the confidence gate" };
  }

  // Gate 2 -- vendor known to this entity
  const ve = await q<{ id: string; status: string }>(
    c,
    `select ve.id, ve.status from vendor_entity ve
      where ve.vendor_id = $1 and ve.entity_id = $2`,
    [inv.vendor_id, scope.entityId]
  );
  if (ve.length === 0 || ve[0].status !== "active") {
    await transition(c, scope, invoiceId, "exception", "vendor is not set up for this company");
    return { status: "exception", reason: "vendor not set up" };
  }

  // Gate 3 -- match
  const matched =
    inv.kind === "merchandise"
      ? await matchMerchandise(c, scope, inv.id, inv.purchase_order_id)
      : await matchTemplate(c, scope, ve[0].id, total);
  if (!matched.ok) {
    await transition(c, scope, invoiceId, "exception", matched.reason);
    return { status: "exception", reason: matched.reason };
  }
  await transition(c, scope, invoiceId, "matched", matched.reason);

  // Gate 4 -- duplicate and anomaly. Flagging is free; suppressing is not.
  const dupe = await findDuplicate(c, scope, inv.id, inv.vendor_id, total, inv.invoice_date);
  if (dupe) {
    await transition(c, scope, invoiceId, "validated", "match clear");
    await transition(c, scope, invoiceId, "held", `possible duplicate of ${dupe}`);
    return { status: "held", reason: `possible duplicate of ${dupe}` };
  }
  await transition(c, scope, invoiceId, "validated", "no duplicate or anomaly");

  // Gate 5 -- threshold
  const approval = await openRequest(c, scope, {
    subjectType: "invoice",
    subjectId: invoiceId,
    amountMinor: total,
    makerId,
  });
  if (!approval.required) {
    await transition(c, scope, invoiceId, "approved", "under the approval threshold");
    return { status: "approved", reason: "under the approval threshold" };
  }
  await transition(c, scope, invoiceId, "pending", "over the approval threshold");
  return { status: "pending", reason: "awaiting approval", approvalRequestId: approval.requestId };
}

async function matchTemplate(
  c: Client,
  scope: Scope,
  vendorEntityId: string,
  total: bigint
): Promise<{ ok: boolean; reason: string }> {
  const t = await q<{ id: string; expected_amount_minor: string | null; tolerance_bps: number }>(
    c,
    `select t.id, t.expected_amount_minor, t.tolerance_bps
       from vendor_template t
       join vendor_entity ve on ve.id = t.vendor_entity_id and ve.entity_id = $2
      where t.vendor_entity_id = $1 and t.status = 'active'`,
    [vendorEntityId, scope.entityId]
  );
  if (t.length === 0) return { ok: false, reason: "no template for this vendor yet" };
  const expected = t[0].expected_amount_minor ? BigInt(t[0].expected_amount_minor) : null;
  if (expected === null) return { ok: true, reason: "template matched, no expected amount" };
  return withinTolerance(total, expected, t[0].tolerance_bps)
    ? { ok: true, reason: `inside the ${t[0].tolerance_bps / 100}% band` }
    : { ok: false, reason: `outside the ${t[0].tolerance_bps / 100}% band` };
}

/** A number from the company's settings, with a default. */
async function settingNumber(c: Client, entityId: string, key: string, dflt: number): Promise<number> {
  const r = await q<{ value: unknown }>(c, `select value from entity_setting where entity_id = $1 and key = $2`, [entityId, key]);
  const n = Number(r[0]?.value);
  return r.length && Number.isFinite(n) ? n : dflt;
}
const usd = (m: bigint) => { const neg = m < 0n, a = neg ? -m : m; return `${neg ? "-" : ""}$${(a / 100n).toLocaleString("en-US")}.${String(a % 100n).padStart(2, "0")}`; };

/** How far a billed unit price may sit from the PO price, in basis points (setting payables.price_tolerance_bps, default 1%). */
export const PRICE_TOLERANCE_BPS = 100;

/**
 * The three-way match for every merchandise bill, however it came in: per PO
 * line, the quantity billed may not pass what was received less what earlier
 * bills already billed, and the billed unit price must sit within the
 * company's tolerance of the PO price. Charges that are not PO lines
 * (freight, fuel) may not pass the landed cost recorded on the PO plus the
 * setting payables.charge_limit_minor (default 0). Allowances (negative
 * lines) always pass. A miss sends the bill to the exception queue, where
 * the controller or owner must look before it can be approved.
 */
async function matchMerchandise(
  c: Client,
  scope: Scope,
  invoiceId: string,
  poId: string | null
): Promise<{ ok: boolean; reason: string }> {
  if (!poId) return { ok: false, reason: "merchandise invoice with no purchase order" };
  const tol = await settingNumber(c, scope.entityId, "payables.price_tolerance_bps", PRICE_TOLERANCE_BPS);
  const chargeLimit = BigInt(Math.round(await settingNumber(c, scope.entityId, "payables.charge_limit_minor", 0)));
  const rows = await q<{ description: string; unit: string; received: string; billed_qty: string; billed_amount: string; priced_qty: string | null;
    before_qty: string }>(
    c,
    `select pol.description, pol.unit_price_minor::text unit,
            coalesce((select sum(g.quantity) from goods_receipt_line g where g.purchase_order_line_id = pol.id), 0) received,
            sum(coalesce(il.quantity, il.amount_minor::numeric / nullif(pol.unit_price_minor, 0))) billed_qty,
            sum(il.amount_minor) billed_amount,
            sum(il.quantity) priced_qty,
            coalesce((select sum(coalesce(o.quantity, o.amount_minor::numeric / nullif(pol.unit_price_minor, 0)))
                        from invoice_line o join invoice oi on oi.id = o.invoice_id
                       where o.purchase_order_line_id = pol.id and oi.id <> $1 and oi.entity_id = $2 and oi.status <> 'rejected'), 0) before_qty
       from invoice_line il
       join purchase_order_line pol on pol.id = il.purchase_order_line_id
       join purchase_order po on po.id = pol.purchase_order_id and po.entity_id = $2
      where il.invoice_id = $1 and pol.purchase_order_id = $3
      group by pol.id, pol.description, pol.unit_price_minor`,
    [invoiceId, scope.entityId, poId]
  );
  const problems: string[] = [];
  const short = rows.filter((r) => Number(r.billed_qty ?? 0) > Number(r.received) - Number(r.before_qty) + 0.0005);
  if (short.length) problems.push(`invoiced but not received: ${short.map((r) => `${r.description} (billed ${Number(Number(r.billed_qty).toFixed(3))}, received ${Number(r.received)}${Number(r.before_qty) ? `, billed before ${Number(Number(r.before_qty).toFixed(3))}` : ""})`).join(", ")}`);
  for (const r of rows) {
    const unit = BigInt(r.unit);
    const qty = Number(r.billed_qty ?? 0);
    if (!(qty > 0)) continue;
    const billedUnit = BigInt(Math.round(Number(r.billed_amount) / qty));
    const off = billedUnit > unit ? billedUnit - unit : unit - billedUnit;
    if (off * 10000n > unit * BigInt(Math.round(tol)) && off > 0n) problems.push(`billed at ${usd(billedUnit)} each against ${usd(unit)} on the purchase order: ${r.description}`);
  }
  const extra = await q<{ charges: string; landed: string; before: string }>(c, `
    select coalesce(sum(il.amount_minor) filter (where il.purchase_order_line_id is null and il.amount_minor > 0), 0) charges,
           coalesce((select sum(amount_minor) from po_landed_cost lc where lc.entity_id = $2 and lc.purchase_order_id = $3), 0) landed,
           coalesce((select sum(o.amount_minor) from invoice_line o join invoice oi on oi.id = o.invoice_id
                      where oi.entity_id = $2 and oi.purchase_order_id = $3 and oi.id <> $1 and oi.status <> 'rejected'
                        and o.purchase_order_line_id is null and o.amount_minor > 0), 0) before
      from invoice_line il where il.invoice_id = $1`, [invoiceId, scope.entityId, poId]);
  const charges = BigInt(extra[0]?.charges ?? 0), allowed = BigInt(extra[0]?.landed ?? 0) - BigInt(extra[0]?.before ?? 0) + chargeLimit;
  if (charges > 0n && charges > (allowed > 0n ? allowed : 0n)) {
    problems.push(`charges of ${usd(charges)} are more than the purchase order expects (${usd(allowed > 0n ? allowed : 0n)} of freight and other landed cost)`);
  }
  if (problems.length) return { ok: false, reason: problems.join("; ") };
  return { ok: true, reason: "three-way match clean" };
}

/**
 * Fuzzy, not exact. Exact invoice-number matching misses the cases that
 * actually happen: the same bill re-sent under a new number, a statement
 * paid alongside its invoices, a credit applied twice.
 */
async function findDuplicate(
  c: Client,
  scope: Scope,
  invoiceId: string,
  vendorId: string,
  total: bigint,
  invoiceDate: string
): Promise<string | null> {
  const rows = await q<{ id: string }>(
    c,
    `select id from invoice
      where entity_id = $1 and vendor_id = $2 and id <> $3
        and total_minor = $4
        and abs(invoice_date - $5::date) <= $6
        and status not in ('rejected')
      limit 1`,
    [scope.entityId, vendorId, invoiceId, total.toString(), invoiceDate, DUPLICATE_WINDOW_DAYS]
  );
  return rows[0]?.id ?? null;
}

/** Debit what the lines say, credit accounts payable. Nothing posts before approval. */
export async function postToLedger(c: Client, scope: Scope, invoiceId: string): Promise<string> {
  const inv = await one<{ id: string; status: Status; total_minor: string; invoice_date: string; reference: string | null }>(
    c,
    `select id, status, total_minor, invoice_date, reference
       from invoice where id = $1 and entity_id = $2`,
    [invoiceId, scope.entityId]
  );
  if (!["approved", "scheduled", "paid"].includes(inv.status))
    throw new TransitionError(`invoice is ${inv.status}; nothing posts before approval`);

  const period = await one<{ id: string }>(
    c,
    `select id from fiscal_period
      where entity_id = $1 and $2::date between starts_on and ends_on`,
    [scope.entityId, inv.invoice_date]
  );

  const lines = await q<{ gl_account_id: string; profit_object_id: string | null; department_id: string | null; amount_minor: string }>(
    c,
    `select il.gl_account_id, il.profit_object_id, il.department_id, il.amount_minor
       from invoice_line il
       join invoice i on i.id = il.invoice_id and i.entity_id = $2
      where il.invoice_id = $1
      order by il.seq`,
    [invoiceId, scope.entityId]
  );

  const ap = await one<{ id: string }>(
    c,
    `select id from gl_account where tenant_id = $1 and code = '2010' /* unscoped: chart is tenant-wide */`,
    [scope.tenantId]
  );

  const je = await one<{ id: string }>(
    c,
    `insert into journal_entry
       (tenant_id, entity_id, period_id, posting_date, source_type, source_id,
        description, posted_by, actor_kind)
     values ($1,$2,$3,$4,'invoice',$5,$6,$7,$8)
     returning id`,
    [
      scope.tenantId, scope.entityId, period.id, inv.invoice_date, invoiceId,
      `Invoice ${inv.reference ?? invoiceId.slice(0, 8)}`,
      scope.actor.id ?? null, scope.actor.kind,
    ]
  );

  let seq = 1;
  for (const l of lines) {
    await c.query(
      `insert into journal_line
         (journal_entry_id, seq, gl_account_id, profit_object_id, department_id, debit_minor)
       values ($1,$2,$3,$4,$5,$6)`,
      [je.id, seq++, l.gl_account_id, l.profit_object_id, l.department_id, l.amount_minor]
    );
  }
  await c.query(
    `insert into journal_line (journal_entry_id, seq, gl_account_id, credit_minor)
     values ($1,$2,$3,$4)`,
    [je.id, seq, ap.id, inv.total_minor]
  );

  await audit(c, scope, {
    table: "journal_entry",
    rowId: je.id,
    action: "insert",
    after: { source: "invoice", invoiceId, total: inv.total_minor },
    reason: "posted on approval",
  });
  return je.id;
}

// ======================================================= sibling companies
// A bill from one of the client's own companies, written by the group module
// with its sales invoice in the sibling. Its posting is the group module's
// journal entry (Dr the cost, Cr Due to related companies 2190), so it is
// recorded approved and is settled in Group, never in a payment run.

export async function billFromSibling(c: Client, scope: Scope, x: {
  vendorId: string; documentId: string; reference: string; date: string;
  lines: { glCode: string; description: string; amountMinor: bigint; profitObjectId?: string | null }[];
}): Promise<string> {
  const v = await q<{ id: string }>(c, `select v.id from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $2
     where v.id = $1 and v.related_entity_id is not null`, [x.vendorId, scope.entityId]);
  if (!v.length) throw new TransitionError("that vendor is not one of this client's own companies");
  const total = x.lines.reduce((s, l) => s + l.amountMinor, 0n);
  if (total <= 0n) throw new TransitionError("an inter-company bill is for more than zero");
  const codes = [...new Set(x.lines.map((l) => l.glCode))];
  const accts = await q<{ id: string; code: string }>(c, `select id, code from gl_account where tenant_id = $1 and code = any($2) /* unscoped: chart is tenant-wide */`,
    [scope.tenantId, codes]);
  const byCode = new Map(accts.map((a) => [a.code, a.id]));
  const inv = await one<{ id: string }>(c, `
    insert into invoice (tenant_id, entity_id, vendor_id, kind, reference, invoice_date, due_date, total_minor, status, created_by, ic_document_id)
    values ($1,$2,$3,'operating',$4,$5,$5,$6,'approved',$7,$8) returning id`,
    [scope.tenantId, scope.entityId, x.vendorId, x.reference, x.date, total.toString(), scope.actor.id || null, x.documentId]);
  let seq = 1;
  for (const l of x.lines) {
    await c.query(`insert into invoice_line (invoice_id, seq, gl_account_id, profit_object_id, description, amount_minor) values ($1,$2,$3,$4,$5,$6)`,
      [inv.id, seq++, byCode.get(l.glCode), l.profitObjectId ?? null, l.description.slice(0, 300), l.amountMinor.toString()]);
  }
  await audit(c, scope, { table: "invoice", rowId: inv.id, action: "insert", after: { status: "approved", total: total.toString(), sibling: true },
    reason: "a bill from a sister company, recorded with its invoice there" });
  return inv.id;
}

/** Group settled these sibling bills: approved → scheduled → paid, each step audited. */
export async function settleSiblingBills(c: Client, scope: Scope, documentIds: string[], how: string): Promise<number> {
  if (!documentIds.length) return 0;
  const bills = await q<{ id: string }>(c, `select id from invoice where entity_id = $1 and ic_document_id = any($2) and status = 'approved'`,
    [scope.entityId, documentIds]);
  for (const b of bills) {
    await transition(c, scope, b.id, "scheduled", how);
    await transition(c, scope, b.id, "paid", how);
  }
  return bills.length;
}

// ------------------------------------------------ bills a vendor sends us --

export class BillError extends Error {}
const needBill = (cond: unknown, msg: string): void => { if (!cond) throw new BillError(msg); };

export type VendorBillLine = { poLineId: string; qty: number; unitMinor: bigint; description?: string | null };
export type VendorBill = {
  vendorId: string; poId: string; reference: string; invoiceDate: string; termsDays?: number | null;
  lines: VendorBillLine[]; charges?: { description: string; amountMinor: bigint }[]; totalMinor: bigint;
};

/**
 * A merchandise bill the vendor sent us (an EDI 810, say), against its PO:
 * one bill line per PO line, coded where the PO line is coded (received not
 * invoiced), and freight or other charges to freight in. The gates run as
 * for any bill, so the three-way match (PO, receipt, bill) decides whether
 * it goes straight through. Approved bills post through the shared ledger.
 */
export async function enterVendorBill(c: Client, scope: Scope, b: VendorBill, makerId: string) {
  needBill(makerId, "a bill needs a person who entered it");
  needBill(b.reference && b.reference.trim(), "the bill has no number");
  needBill(/^\d{4}-\d{2}-\d{2}$/.test(b.invoiceDate ?? ""), "the bill has no date");
  needBill(b.lines.length, "the bill has no lines");
  const po = (await q<{ id: string; number: string; vendor_id: string; profit_object_id: string | null }>(c,
    `select id, number, vendor_id, profit_object_id from purchase_order where id = $1 and entity_id = $2`, [b.poId, scope.entityId]))[0];
  needBill(po, "no such purchase order");
  needBill(po.vendor_id === b.vendorId, `${po.number} is another vendor's order`);
  const ve = (await q<{ terms_days: number }>(c, `select terms_days from vendor_entity where vendor_id = $1 and entity_id = $2 and status = 'active'`, [b.vendorId, scope.entityId]))[0];
  needBill(ve, "that vendor is not set up for this company");
  const dupe = await q(c, `select 1 from invoice where entity_id = $1 and vendor_id = $2 and reference = $3`, [scope.entityId, b.vendorId, b.reference.trim()]);
  needBill(!dupe.length, `this vendor already has a bill numbered ${b.reference.trim()}`);
  const pls = await q<{ id: string; seq: number; gl_account_id: string; description: string; quantity: string; cancelled_qty: string }>(c, `
    select id, seq, gl_account_id, description, quantity, cancelled_qty from purchase_order_line where purchase_order_id = $1 and entity_id = $2`, [po.id, scope.entityId]);
  const freight = (await q<{ id: string }>(c, `select id from gl_account where tenant_id = $1 and code = '5030' /* unscoped: chart is tenant-wide */`, [scope.tenantId]))[0];
  let sum = 0n;
  const rows: { gl: string; pol: string | null; desc: string; amount: bigint; qty: number | null; unit: bigint | null }[] = [];
  for (const l of b.lines) {
    const pl = pls.find((x) => x.id === l.poLineId);
    needBill(pl, `the bill names a line that is not on ${po.number}`);
    needBill(Number.isFinite(l.qty) && l.qty > 0, `line ${pl!.seq} is billed for no quantity`);
    needBill(l.qty <= Number(pl!.quantity) - Number(pl!.cancelled_qty), `line ${pl!.seq} is billed for ${l.qty}, more than the ${Number(pl!.quantity) - Number(pl!.cancelled_qty)} ordered`);
    const amount = BigInt(Math.round(l.qty * Number(l.unitMinor)));
    sum += amount;
    rows.push({ gl: pl!.gl_account_id, pol: pl!.id, desc: (l.description || pl!.description).slice(0, 200), amount, qty: l.qty, unit: l.unitMinor });
  }
  for (const ch of b.charges ?? []) {
    if (ch.amountMinor === 0n) continue;
    sum += ch.amountMinor;
    if (ch.amountMinor < 0n) {      // an allowance takes the cost of the goods down, where the goods are coded
      rows.push({ gl: pls[0].gl_account_id, pol: null, desc: ch.description.slice(0, 200), amount: ch.amountMinor, qty: null, unit: null });
      continue;
    }
    needBill(freight, "the chart has no 5030 freight-in account for the bill's charges; apply a setup pack in Business setup");
    rows.push({ gl: freight!.id, pol: null, desc: ch.description.slice(0, 200), amount: ch.amountMinor, qty: null, unit: null });
  }
  needBill(sum > 0n, "the bill comes to nothing or less; a credit is entered as a credit memo");
  needBill(sum === b.totalMinor, "the bill's total is not the sum of its lines and charges");
  const inv = await one<{ id: string }>(c, `
    insert into invoice (tenant_id, entity_id, vendor_id, kind, reference, invoice_date, due_date, total_minor, confidence_bps, purchase_order_id, created_by)
    values ($1,$2,$3,'merchandise',$4,$5::date,$5::date + $6::int,$7,10000,$8,$9) returning id`,
    [scope.tenantId, scope.entityId, b.vendorId, b.reference.trim().slice(0, 60), b.invoiceDate, b.termsDays ?? ve.terms_days, b.totalMinor.toString(), po.id, makerId]);
  for (const [i, r] of rows.entries()) {
    await c.query(`insert into invoice_line (invoice_id, seq, gl_account_id, profit_object_id, purchase_order_line_id, description, amount_minor, quantity, unit_price_minor)
                   select $1,$2,$3,$4,$5,$6,$7,$9,$10 where exists (select 1 from invoice where id = $1 and entity_id = $8)`,
      [inv.id, i + 1, r.gl, po.profit_object_id, r.pol, r.desc, r.amount.toString(), scope.entityId, r.qty, r.unit?.toString() ?? null]);
  }
  await audit(c, scope, { table: "invoice", rowId: inv.id, action: "insert", after: { reference: b.reference, po: po.number, total: b.totalMinor.toString(), lines: rows.length } });
  const out = await runGates(c, scope, inv.id, makerId);
  let journalId: string | null = null;
  if (out.status === "approved") {
    const codes = new Map((await q<{ id: string; code: string }>(c, `select id, code from gl_account where tenant_id = $1 and id = any($2) /* unscoped: chart is tenant-wide */`,
      [scope.tenantId, rows.map((r) => r.gl)])).map((x) => [x.id, x.code]));
    journalId = await post(c, scope, {
      date: b.invoiceDate, sourceType: "invoice", sourceId: inv.id, description: `Bill ${b.reference.trim()} on ${po.number}`,
      lines: [...rows.map((r) => (r.amount >= 0n ? { code: codes.get(r.gl)!, debit: r.amount, profitObjectId: po.profit_object_id, memo: r.desc }
        : { code: codes.get(r.gl)!, credit: -r.amount, profitObjectId: po.profit_object_id, memo: r.desc })), { code: "2010", credit: b.totalMinor }],
    });
  }
  return { invoiceId: inv.id, status: out.status, reason: out.reason, journalId };
}
