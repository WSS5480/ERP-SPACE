// The invoice lifecycle: one status at a time, every change an event.
//
// A clean invoice crosses the whole machine without a person. The branches
// are where people enter, which is why the exception count matters more
// than the touchless rate on its own.

import { type Client, type Scope, audit, one, q } from "./db.ts";
import { openRequest } from "./approvals.ts";
import { withinTolerance } from "./money.ts";

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

async function matchMerchandise(
  c: Client,
  scope: Scope,
  invoiceId: string,
  poId: string | null
): Promise<{ ok: boolean; reason: string }> {
  if (!poId) return { ok: false, reason: "merchandise invoice with no purchase order" };
  const rows = await q<{ description: string; ordered: string; received: string; invoiced: string }>(
    c,
    `select pol.description,
            pol.quantity                                   as ordered,
            coalesce(sum(distinct grl.quantity), 0)        as received,
            count(il.id)                                   as invoiced
       from purchase_order_line pol
       join purchase_order po on po.id = pol.purchase_order_id and po.entity_id = $2
       left join goods_receipt_line grl on grl.purchase_order_line_id = pol.id
       left join invoice_line il on il.purchase_order_line_id = pol.id and il.invoice_id = $1
      where pol.purchase_order_id = $3
      group by pol.id, pol.description, pol.quantity`,
    [invoiceId, scope.entityId, poId]
  );
  const short = rows.filter((r) => Number(r.received) < Number(r.ordered) && Number(r.invoiced) > 0);
  if (short.length > 0)
    return {
      ok: false,
      reason: `invoiced but not received: ${short.map((s) => s.description).join(", ")}`,
    };
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
