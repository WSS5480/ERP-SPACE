// Receivables: the money side of every sale. Owned by the A/R module, which
// extends this file (house accounts, statements, aging, collections,
// installment contracts, finance companies, write-offs). The two exported
// functions are the contract POS, the web store and delivery call. Keep them.
//
// Accounting (accounts by code; Setup can map them per tenant):
//   money in before delivery   Dr 1050 undeposited funds (1110 for a finance company)   Cr 2300 customer deposits
//   goods handed over          Dr 2300 deposits applied, Dr 1100 A/R for the rest       Cr 4000 / 4030 / 4040, Cr 2100 tax
//                              Dr 5000 cost of goods                                     Cr 1300 inventory
// Revenue is recognised when the customer has the goods, not when they pay.

import { q, one, type Client, type Scope } from "./db.ts";
import { post, profitObjectFor } from "./posting.ts";

export class ArError extends Error {}

const today = () => new Date().toISOString().slice(0, 10);

/** Post a customer receipt (or refund, if negative) to the ledger. */
export async function postReceipt(c: Client, scope: Scope, receiptId: string): Promise<string> {
  const r = await one<{ amount_minor: string; method: string; number: string; location_id: string; received_at: string; voided_at: string | null }>(c,
    `select amount_minor, method, number, location_id, received_at::date::text received_at, voided_at
       from customer_receipt where id = $1 and entity_id = $2`, [receiptId, scope.entityId]);
  if (r.voided_at) throw new ArError("a voided receipt does not post");
  const amt = BigInt(r.amount_minor);
  const cashSide = r.method === "financing" ? "1110" : r.method === "store_credit" ? "2320" : r.method === "gift_card" ? "2310" : "1050";
  const po = await profitObjectFor(c, scope.entityId, r.location_id);
  const abs = amt < 0n ? -amt : amt;
  const lines = amt > 0n
    ? [{ code: cashSide, debit: abs, profitObjectId: po }, { code: "2300", credit: abs, profitObjectId: po }]
    : [{ code: "2300", debit: abs, profitObjectId: po }, { code: cashSide, credit: abs, profitObjectId: po }];
  return post(c, scope, { date: r.received_at, sourceType: amt > 0n ? "receipt" : "refund", sourceId: receiptId,
    description: `${amt > 0n ? "Receipt" : "Refund"} ${r.number}`, lines });
}

/**
 * Recognise the sale for lines just handed over. Revenue by line kind, tax,
 * deposits applied up to what has been paid, the rest to A/R; and cost of
 * goods against inventory (costMinor comes from inventory.fulfilLines).
 */
export async function invoiceFulfilment(c: Client, scope: Scope, orderId: string, lineIds: string[] | "all", costMinor: bigint):
  Promise<{ journalEntryId: string; revenueMinor: bigint; taxMinor: bigint; toArMinor: bigint }> {
  const so = await one<{ number: string; location_id: string; paid_minor: string; fees_minor: string }>(c,
    `select number, location_id, paid_minor, fees_minor from sales_order where id = $1 and entity_id = $2`, [orderId, scope.entityId]);
  const lines = await q<{ id: string; kind: string | null; qty: string; unit_price_minor: string; discount_minor: string; tax_minor: string }>(c, `
    select l.id, p.kind, l.qty, l.unit_price_minor, l.discount_minor, l.tax_minor
      from sales_order_line l left join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status = 'fulfilled'
       and ($3::uuid[] is null or l.id = any($3))`, [scope.entityId, orderId, lineIds === "all" ? null : lineIds]);
  const rev = new Map<string, bigint>();
  let tax = 0n;
  for (const l of lines) {
    const net = BigInt(Math.round(Number(l.qty) * Number(l.unit_price_minor))) - BigInt(l.discount_minor);
    const code = l.kind === "fee" || l.kind === "service" ? "4030" : l.kind === "warranty" ? "4040" : "4000";
    rev.set(code, (rev.get(code) ?? 0n) + net);
    tax += BigInt(l.tax_minor);
  }
  const revenue = [...rev.values()].reduce((a, b) => a + b, 0n);
  const gross = revenue + tax;
  // Deposits already recognised against this order.
  const applied = await one<{ s: string }>(c, `
    select coalesce(sum(jl.debit_minor),0)::text s from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id and je.entity_id = $1
      join gl_account g on g.id = jl.gl_account_id and g.code = '2300'
     where je.source_type = 'sale' and je.source_id = $2`, [scope.entityId, orderId]);
  const depositsLeft = BigInt(so.paid_minor) - BigInt(applied.s);
  const fromDeposits = depositsLeft > 0n ? (depositsLeft < gross ? depositsLeft : gross) : 0n;
  const toAr = gross - fromDeposits;
  const po = await profitObjectFor(c, scope.entityId, so.location_id);
  const out = [
    { code: "2300", debit: fromDeposits, profitObjectId: po },
    { code: "1100", debit: toAr > 0n ? toAr : 0n, profitObjectId: po },
    { code: "1100", credit: toAr < 0n ? -toAr : 0n, profitObjectId: po },
    ...[...rev.entries()].map(([code, v]) => v >= 0n ? { code, credit: v, profitObjectId: po } : { code, debit: -v, profitObjectId: po }),
    { code: "2100", credit: tax, profitObjectId: po },
    { code: "5000", debit: costMinor, profitObjectId: po },
    { code: "1300", credit: costMinor, profitObjectId: po },
  ];
  const je = await post(c, scope, { date: today(), sourceType: "sale", sourceId: orderId,
    description: `Sale ${so.number}, ${lines.length} line${lines.length === 1 ? "" : "s"} handed over`, lines: out });
  return { journalEntryId: je, revenueMinor: revenue, taxMinor: tax, toArMinor: toAr };
}
