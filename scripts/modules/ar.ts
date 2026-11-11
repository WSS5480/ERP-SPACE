// A/R checks: every one asserts the refusal as well as the success, and the
// books are tied at the end -- aging to GL 1100, deposits to GL 2300,
// finance-company receivables to GL 1110. POS is built in parallel, so these
// checks write their own orders and receipts and call the contract functions.

import type { T } from "./harness.ts";
import { ENTITY, RIO_ENTITY, LOC, PEOPLE } from "./harness.ts";
import type { Client } from "../../packages/core/db.ts";
import { one, q, tx, pool } from "../../packages/core/db.ts";
import { loadCompany } from "../../server/views.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";
import * as ar from "../../packages/core/ar.ts";
import { H } from "../../server/modules/ar.ts";
import { scopeOf } from "../../server/actions.ts";

// The checks' own customers, made fresh each run, so other modules' sales to
// the demo customers never move these numbers (the company-wide tie-outs below
// still cover everyone).
let CUST = { ALICIA: "", BRIAN: "", CHEN: "", DANA: "", RIVERSIDE: "", ED: "" };
const P = (n: number) => `77777777-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const JEN = "55555555-0000-0000-0000-000000000017";      // ar_clerk
const MARIA = "55555555-0000-0000-0000-000000000011";    // sales
const LUIS = "55555555-0000-0000-0000-000000000012";     // cashier
const PRIME = "abab0000-0000-0000-0000-000000000001";
const SECOND = "abab0000-0000-0000-0000-000000000002";
const today = () => new Date().toISOString().slice(0, 10);

// The shared harness's own company() lookup is refused by the entity guard
// (it filters on e.id, not entity_id), so these checks look the company up
// through the server's loadCompany and run as a person the same way.
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

type Line = { product: number; qty?: number; price: number; tax?: number };

/** An order the way POS writes one, with its lines handed over. */
async function order(c: Client, customerId: string | null, loc: string, lines: Line[], fulfil = true): Promise<{ id: string; lineIds: string[] }> {
  const no = (await one<{ n: string }>(c, `select next_doc_no($1,'order','SO-') n /* unscoped: numbering */`, [ENTITY])).n;
  const so = await one<{ id: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, salesperson_id, status, fulfillment)
                                            values ($1,$2,'pos',$3,$4,$5,'open','carry') returning id`, [ENTITY, no, loc, customerId, MARIA]);
  const ids: string[] = [];
  let seq = 1;
  for (const l of lines) {
    const p = await one<{ sku: string; name: string }>(c, `select sku, name from product where id = $1 and entity_id = $2`, [P(l.product), ENTITY]);
    const r = await one<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, tax_minor, line_status)
                                             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [ENTITY, so.id, seq++, P(l.product), p.sku, p.name, l.qty ?? 1, l.price, l.tax ?? 0, fulfil ? "fulfilled" : "open"]);
    ids.push(r.id);
  }
  await c.query(`select sales_order_retotal($1) /* unscoped: by order id */`, [so.id]);
  return { id: so.id, lineIds: ids };
}

const B = (v: unknown) => BigInt(String(v ?? 0));
const tb = async (c: Client) => {
  const r = await one<{ d: string; k: string }>(c, `select coalesce(sum(jl.debit_minor),0) d, coalesce(sum(jl.credit_minor),0) k
     from journal_line jl join journal_entry je on je.id = jl.journal_entry_id where je.entity_id = $1`, [ENTITY]);
  return B(r.d) === B(r.k);
};

async function makeCustomers() {
  const tag = Math.random().toString(36).slice(2, 7);
  const mk = [["ALICIA", "Alicia Gomez", LOC.ENOLA], ["BRIAN", "Brian Kelly", LOC.ENOLA], ["CHEN", "Chen Family", LOC.ENOLA],
    ["DANA", "Dana Wright", LOC.PALESTINE], ["RIVERSIDE", "Riverside Apartments", LOC.ENOLA], ["ED", "Ed Martinez", LOC.SOCORRO]] as const;
  const out = { ...CUST };
  await as(PEOPLE.CONTROLLER, async (c, co, a) => {
    let i = 0;
    for (const [k, name, loc] of mk) {
      i++;
      const r = await one<{ id: string }>(c, `insert into customer (entity_id, number, name, email, phone, home_location_id)
        values ($1,$2,$3,$4,$5,$6) returning id`, [ENTITY, `AR-${tag}-${i}`, `${name} (A/R check)`, `ar-${tag}-${i}@example.com`, `555-555-01${String(60 + i)}`, loc]);
      out[k] = r.id;
    }
    await H.setAccount(c, co, a, out.CHEN, { houseAccount: true, creditLimit: "3000", termsDays: 30 });
    await H.setAccount(c, co, a, out.RIVERSIDE, { houseAccount: true, creditLimit: "25000", termsDays: 30, lateFees: false });
  });
  CUST = out;
}

export async function run(t: T) {
  await makeCustomers();
  const s = (c: Client, person: string) => ({ tenantId: "11111111-1111-1111-1111-111111111111", entityId: ENTITY, actor: { kind: "user" as const, id: person, label: "check" } });

  // ------------------------------------------------ invoice on fulfilment --
  console.log("  -- invoices on fulfilment, deposits, house accounts");
  const chen1 = await as(LUIS, async (c, co, a) => {
    const o = await order(c, CUST.CHEN, LOC.ENOLA, [{ product: 1, price: 79999, tax: 4800 }]);
    await H.pay(c, co, a, CUST.CHEN, { amount: "200.00", method: "card", salesOrderId: o.id, locationId: LOC.ENOLA });
    const r = await ar.invoiceFulfilment(c, s(c, LUIS), o.id, "all", 0n);
    return { ...r, orderId: o.id };
  });
  t.ok("handing over a sold sofa writes a customer invoice", !!chen1.invoiceId && chen1.invoiceNumber.startsWith("INV-"), chen1.invoiceNumber);
  t.ok("the deposit is applied and only the rest goes to the account", chen1.toArMinor === 84799n - 20000n, String(chen1.toArMinor));
  const inv1 = await as(JEN, (c, co) => H.invoice(c, co, chen1.invoiceId));
  t.ok("the invoice carries its line, the deposit applied, and net-30 terms on a house account",
    inv1.lines.length === 1 && B(inv1.invoice.deposit_applied_minor) === 20000n && inv1.invoice.due_date > inv1.invoice.invoice_date,
    `${inv1.invoice.invoice_date} → ${inv1.invoice.due_date}`);
  await t.throws("the same lines are never invoiced twice",
    () => as(LUIS, (c) => ar.invoiceFulfilment(c, s(c, LUIS), chen1.orderId, "all", 0n)), /already invoiced/i);

  // ------------------------------------------------------- credit limit --
  const big = await as(LUIS, (c) => order(c, CUST.CHEN, LOC.ENOLA, [{ product: 10, price: 259900, tax: 15594 }]));
  await t.throws("a charge past the house account's credit limit is refused",
    () => as(LUIS, (c) => ar.invoiceFulfilment(c, s(c, LUIS), big.id, "all", 0n)), /over its \$3,000\.00 limit/);
  await t.throws("a salesperson cannot approve a charge past the limit",
    () => as(MARIA, (c, co, a) => H.override(c, co, a, CUST.CHEN, { upTo: "3000", reason: "long-time customer", salesOrderId: big.id })), /needs one of: controller/);
  await t.throws("an override needs a reason",
    () => as(PEOPLE.CONTROLLER, (c, co, a) => H.override(c, co, a, CUST.CHEN, { upTo: "3000", reason: "ok", salesOrderId: big.id })), /reason/);
  await as(PEOPLE.CONTROLLER, (c, co, a) => H.override(c, co, a, CUST.CHEN, { upTo: "3000", reason: "Ten-year customer; limit review booked", salesOrderId: big.id }));
  const chen2 = await as(LUIS, (c) => ar.invoiceFulfilment(c, s(c, LUIS), big.id, "all", 0n));
  t.ok("with the controller's override the charge goes through", chen2.toArMinor === 275494n);
  const used = await as(JEN, (c) => q<{ used_at: string | null }>(c, `select used_at from ar_credit_override where entity_id = $1 and sales_order_id = $2`, [ENTITY, big.id]));
  t.ok("the override is used once and says so", used.length === 1 && used[0].used_at !== null);

  await t.throws("an A/R clerk cannot change a credit limit",
    () => as(JEN, (c, co, a) => H.setAccount(c, co, a, CUST.BRIAN, { status: "hold" })), /needs one of: controller/);
  await as(PEOPLE.CONTROLLER, (c, co, a) => H.setAccount(c, co, a, CUST.BRIAN, { status: "hold" }));
  const brianOrder = await as(LUIS, (c) => order(c, CUST.BRIAN, LOC.ENOLA, [{ product: 9, price: 5999, tax: 360 }]));
  await t.throws("nothing new is charged to an account on hold",
    () => as(LUIS, (c) => ar.invoiceFulfilment(c, s(c, LUIS), brianOrder.id, "all", 0n)), /on hold/);
  await as(PEOPLE.CONTROLLER, (c, co, a) => H.setAccount(c, co, a, CUST.BRIAN, { status: "active" }));

  // A walk-in with a balance due at delivery (no house account) is invoiced, due now.
  const alicia = await as(LUIS, async (c) => {
    const o = await order(c, CUST.ALICIA, LOC.ENOLA, [{ product: 7, price: 64999, tax: 3900 }, { product: 12, price: 14999, tax: 900 }]);
    return ar.invoiceFulfilment(c, s(c, LUIS), o.id, "all", 0n);
  });
  t.ok("a balance due on delivery is invoiced and due the same day", alicia.toArMinor === 84798n);
  const cc = await as(JEN, (c, co) => H.creditCheck(c, co, CUST.ALICIA, "10", null));
  t.ok("the credit check says a customer with no house account cannot charge", !cc.ok && /no house account/.test(cc.reason));

  // ------------------------------------------------------------ payments --
  console.log("  -- payments on account, unapplied cash, store credit");
  await t.throws("a salesperson cannot take a payment on account",
    () => as(MARIA, (c, co, a) => H.pay(c, co, a, CUST.CHEN, { amount: "100", method: "cash" })), /needs one of/);
  await t.throws("an invoice cannot be paid more than it owes",
    () => as(JEN, (c, co, a) => H.pay(c, co, a, CUST.CHEN, { amount: "900", method: "check", apply: [{ invoiceId: chen1.invoiceId, amount: "900" }] })), /owes \$647\.99/);
  const p1 = await as(JEN, (c, co, a) => H.pay(c, co, a, CUST.CHEN, { amount: "500.00", method: "check", reference: "1043" }));
  t.ok("a payment goes to the oldest invoice first", p1.applications.length === 1 && p1.applications[0].invoiceId === chen1.invoiceId && p1.appliedMinor === 50000n);
  const pAl = await as(JEN, (c, co, a) => H.pay(c, co, a, CUST.ALICIA, { amount: "900.00", method: "card", overpayment: "store_credit" }));
  t.ok("an overpayment kept as store credit posts to 2320", pAl.storeCreditMinor === 90000n - 84798n && pAl.unappliedMinor === 0n, String(pAl.storeCreditMinor));
  const scBal = await as(JEN, (c) => ar.storeCreditBalance(c, ENTITY, CUST.ALICIA));
  t.ok("the store credit is on the customer's account", scBal === 5202n);
  await t.throws("store credit cannot pay more than the customer has",
    () => as(JEN, (c, co, a) => H.pay(c, co, a, CUST.ALICIA, { amount: "60", method: "store_credit" })), /store credit/);

  const pR = await as(JEN, (c, co, a) => H.pay(c, co, a, CUST.RIVERSIDE, { amount: "250.00", method: "ach" }));
  t.ok("money with no invoice to take it stays on the account as unapplied cash", pR.unappliedMinor === 25000n);
  const riv = await as(LUIS, async (c) => {
    const o = await order(c, CUST.RIVERSIDE, LOC.ENOLA, [{ product: 3, qty: 2, price: 59999, tax: 7200 }]);
    return ar.invoiceFulfilment(c, s(c, LUIS), o.id, "all", 0n);
  });
  const ap = await as(JEN, (c, co, a) => H.applyCredits(c, co, a, CUST.RIVERSIDE, {}));
  t.ok("unapplied cash is applied to the next invoice", ap.appliedMinor === 25000n);
  const rivOpen = await as(JEN, (c) => ar.openInvoices(c, ENTITY, CUST.RIVERSIDE));
  t.ok("the invoice owes what is left", rivOpen.length === 1 && B(rivOpen[0].open_minor) === riv.toArMinor - 25000n, rivOpen[0]?.open_minor);
  await t.throws("applying credit with none left is refused",
    () => as(JEN, (c, co, a) => H.applyCredits(c, co, a, CUST.RIVERSIDE, {})), /no unapplied cash/);

  // ---------------------------------------------- statements and aging --
  console.log("  -- statements, aging, the tie to the books");
  const st = await as(JEN, (c, co) => H.statement(c, co, CUST.CHEN, today().slice(0, 8) + "01", today()));
  const chenBal = await as(JEN, (c) => ar.customerBalance(c, ENTITY, CUST.CHEN));
  t.ok("a statement runs opening to closing and the lines add up", st.ties && st.closing === chenBal && st.opening + st.charges - st.credits === st.closing,
    `${st.lines.length} lines, closing ${st.closing}`);
  await t.throws("a statement needs its dates the right way round",
    () => as(JEN, (c, co) => H.statement(c, co, CUST.CHEN, "2026-12-31", "2026-01-01")), /start first/);

  // Age two invoices: Chen's first past 45 days, Riverside's past 75.
  await as(PEOPLE.CONTROLLER, async (c) => {
    await c.query(`update customer_invoice set due_date = current_date - 45 where id = $1 and entity_id = $2`, [chen1.invoiceId, ENTITY]);
    await c.query(`update customer_invoice set due_date = current_date - 75 where id = $1 and entity_id = $2`, [riv.invoiceId, ENTITY]);
  });
  const ag = await as(JEN, (c, co) => H.aging(c, co, today()));
  const chenRow = ag.customers.find((r) => r.key === CUST.CHEN)!;
  const rivRow = ag.customers.find((r) => r.key === CUST.RIVERSIDE)!;
  t.ok("the aging puts each invoice in its bucket", chenRow.d31_60 === 14799n && rivRow.d61_90 === riv.toArMinor - 25000n && chenRow.current === 275494n,
    `Chen 31-60 ${chenRow.d31_60}, Riverside 61-90 ${rivRow.d61_90}`);
  t.ok("the screens use the tenant's own word for it", ag.label === "Receivables");
  t.ok("aging by store adds up to the same total", ag.locations.reduce((x, r) => x + r.total, 0n) === ag.totals.total);
  t.ok("the aging total ties to GL 1100", ag.differenceMinor === 0n, `aging ${ag.totals.total}, GL ${ag.glMinor}`);

  // -------------------------------------------------------------- late fees --
  console.log("  -- late fees");
  await t.throws("a cashier cannot charge late fees",
    () => as(LUIS, (c, co, a) => H.lateFees(c, co, a, {})), /needs one of/);
  const fees4020Before = await as(JEN, (c) => ar.glBalance(c, ENTITY, "4020"));
  const lf = await as(JEN, (c, co, a) => H.lateFees(c, co, a, {}));
  const mineFees = lf.fees.filter((f) => f.customer.endsWith("(A/R check)"));
  t.ok("a late fee is charged on the overdue invoice past grace, at the minimum when the rate is less", mineFees.length === 1 && mineFees[0].feeMinor === 500n,
    lf.fees.map((f) => `${f.customer} ${f.invoice} ${f.feeMinor}`).join(", "));
  t.ok("an account with late fees turned off is not charged", !lf.fees.some((f) => f.customer.startsWith("Riverside")));
  const lf2 = await as(JEN, (c, co, a) => H.lateFees(c, co, a, {}));
  t.ok("running late fees twice in a month charges nothing more", lf2.charged === 0);
  const fees4020 = await as(JEN, (c) => ar.glBalance(c, ENTITY, "4020"));
  t.ok("late fees post to 4020", fees4020 - fees4020Before === -lf.totalMinor, String(fees4020 - fees4020Before));

  // ------------------------------------------------------------ collections --
  console.log("  -- collections");
  const mineOnly = (l: { customerId: string }[]) => l.filter((x) => Object.values(CUST).includes(x.customerId));
  const list1 = await as(JEN, (c, co) => H.callList(c, co, today())).then((r) => ({ ...r, list: mineOnly(r.list) }));
  t.ok("the call list holds everyone past due, longest and largest first",
    list1.list.length === 2 && list1.list[0].customerId === CUST.RIVERSIDE && list1.list[1].customerId === CUST.CHEN,
    list1.list.map((x) => `${x.name} ${x.maxDaysPastDue}d`).join("; "));
  await t.throws("a salesperson cannot log collections calls",
    () => as(MARIA, (c, co, a) => H.logAction(c, co, a, CUST.CHEN, { kind: "call", outcome: "no_answer" })), /needs one of/);
  await t.throws("a promise to pay needs a date and an amount",
    () => as(JEN, (c, co, a) => H.logAction(c, co, a, CUST.CHEN, { kind: "call", outcome: "promised" })), /date and an amount/);
  const tomorrow = ar.addDays(today(), 1);
  await as(JEN, (c, co, a) => H.logAction(c, co, a, CUST.CHEN, { kind: "call", outcome: "promised", notes: "Will pay Friday", promise: { on: tomorrow, amount: "147.99" } }));
  await as(JEN, (c, co, a) => H.logAction(c, co, a, CUST.RIVERSIDE, { kind: "call", outcome: "callback", notes: "AP clerk out, call back", callbackAt: new Date(Date.now() - 60000).toISOString() }));
  const list2 = await as(JEN, (c, co) => H.callList(c, co, today())).then((r) => ({ ...r, list: mineOnly(r.list) }));
  t.ok("a customer with a promise not yet due drops off the list", !list2.list.some((x) => x.customerId === CUST.CHEN));
  t.ok("a callback that has come due keeps the customer on the list even after today's call",
    list2.list.some((x) => x.customerId === CUST.RIVERSIDE && x.tier === 2), list2.list.map((x) => x.reason).join("; "));
  await as(PEOPLE.CONTROLLER, (c) => c.query(`update ar_promise set promised_on = current_date - 1 where entity_id = $1 and customer_id = $2 and status = 'open'`, [ENTITY, CUST.CHEN]));
  const list3 = await as(JEN, (c, co) => H.callList(c, co, today())).then((r) => ({ ...r, list: mineOnly(r.list) }));
  t.ok("a broken promise brings the customer back to the top", list3.list[0]?.customerId === CUST.CHEN && /broken/i.test(list3.list[0].reason), list3.list[0]?.reason);
  const rp = await as(JEN, (c, co, a) => H.refreshPromises(c, co, a));
  t.ok("the broken promise is marked broken", rp.broken >= 1);
  const sms = await as(JEN, (c, co, a) => H.send(c, co, a, CUST.CHEN, { template: "reminder-sms" }));
  t.ok("a text is filled from the template and recorded as sent, through the provider seam",
    /Chen Family/.test(sms.body) && /\$147\.99/.test(sms.body) && /record only/.test(sms.provider), sms.body.slice(0, 60));
  await t.throws("an unknown template is refused",
    () => as(JEN, (c, co, a) => H.send(c, co, a, CUST.CHEN, { template: "nope" })), /no such template/);

  // ------------------------------------------------------------- write-offs --
  console.log("  -- write-offs and recoveries");
  const brian = await as(LUIS, async (c) => {
    await c.query(`update ar_account set house_account = false where customer_id = $1 and entity_id = $2`, [CUST.BRIAN, ENTITY]);
    return ar.invoiceFulfilment(c, s(c, LUIS), brianOrder.id, "all", 0n);
  });
  await t.throws("a write-off cannot be for more than is open",
    () => as(JEN, (c, co, a) => H.requestWriteoff(c, co, a, { invoiceId: brian.invoiceId, amount: "100", reason: "Moved away, no forwarding address" })), /open to write off/);
  await t.throws("a write-off needs a reason",
    () => as(JEN, (c, co, a) => H.requestWriteoff(c, co, a, { invoiceId: brian.invoiceId, amount: "63.59", reason: "bad" })), /reason/);
  const allow0 = await as(JEN, (c) => ar.glBalance(c, ENTITY, "1190"));
  const wo = await as(JEN, (c, co, a) => H.requestWriteoff(c, co, a, { invoiceId: brian.invoiceId, amount: "63.59", reason: "Moved away, no forwarding address" }));
  await t.throws("an A/R clerk cannot approve a write-off",
    () => as(JEN, (c, co, a) => H.decideWriteoff(c, co, a, wo.writeoffId, { decision: "approved" })), /needs one of: controller/);
  const wo2 = await as(PEOPLE.CONTROLLER, (c, co, a) => H.requestWriteoff(c, co, a, { invoiceId: alicia.invoiceId, amount: "0.01", reason: "rounding test write-off" })).catch(() => null);
  t.ok("a paid invoice has nothing to write off", wo2 === null);
  const wo3 = await as(PEOPLE.CONTROLLER, async (c, co, a) => {
    const o = await order(c, CUST.DANA, LOC.PALESTINE, [{ product: 9, price: 5999, tax: 495 }]);
    const inv = await ar.invoiceFulfilment(c, scopeOf(co, a), o.id, "all", 0n);
    return { inv, w: await H.requestWriteoff(c, co, a, { invoiceId: inv.invoiceId, amount: "64.94", reason: "Disputed, settled with customer", method: "direct" }) };
  });
  await t.throws("whoever asked for a write-off cannot approve it",
    () => as(PEOPLE.CONTROLLER, (c, co, a) => H.decideWriteoff(c, co, a, wo3.w.writeoffId, { decision: "approved" })), /cannot approve it/);
  await as(PEOPLE.STEVE, (c, co, a) => H.decideWriteoff(c, co, a, wo3.w.writeoffId, { decision: "rejected", note: "Collect it instead" }));
  const d1 = await as(PEOPLE.CONTROLLER, (c, co, a) => H.decideWriteoff(c, co, a, wo.writeoffId, { decision: "approved", note: "agreed" }));
  t.ok("a second person approves and the write-off posts", d1.status === "posted" && !!d1.journalEntryId);
  const bInv = await as(JEN, (c, co) => H.invoice(c, co, brian.invoiceId));
  const allow = await as(JEN, (c) => ar.glBalance(c, ENTITY, "1190"));
  t.ok("the invoice is written off against the allowance (Dr 1190, Cr 1100)", bInv.invoice.status === "written_off" && bInv.openMinor === 0n && allow - allow0 === 6359n,
    `1190 ${allow}`);
  await t.throws("a recovery cannot exceed what was written off",
    () => as(JEN, (c, co, a) => H.recover(c, co, a, wo.writeoffId, { amount: "70", method: "cash", locationId: LOC.ENOLA })), /can still be recovered/);
  const rec = await as(JEN, (c, co, a) => H.recover(c, co, a, wo.writeoffId, { amount: "40", method: "cash", locationId: LOC.ENOLA }));
  const allow2 = await as(JEN, (c) => ar.glBalance(c, ENTITY, "1190"));
  const bAfter = await as(JEN, (c) => ar.customerBalance(c, ENTITY, CUST.BRIAN));
  t.ok("a recovery reinstates and collects: the allowance is credited back, the account stays at zero",
    !!rec.receiptId && allow2 - allow0 === 2359n && bAfter === 0n, `1190 ${allow2}, Brian ${bAfter}`);

  // --------------------------------------------------- installment contracts --
  console.log("  -- installment contracts");
  const sch = ar.amortize(100000n, 1999, 12, "2026-12-15");
  t.ok("an amortization schedule's principal sums to exactly what was financed",
    sch.rows.reduce((x, r) => x + r.principalMinor, 0n) === 100000n && sch.rows.length === 12, `payment ${sch.paymentMinor}`);
  t.ok("interest falls and principal rises each month", sch.rows[0].interestMinor > sch.rows[11].interestMinor && sch.rows[0].principalMinor < sch.rows[10].principalMinor);
  const z = ar.amortize(100000n, 0, 3, "2026-01-31");
  t.ok("a no-interest schedule splits evenly and lands the month-end on short months",
    z.rows.map((r) => r.principalMinor).join(",") === "33334,33334,33332" && z.rows[1].dueOn === "2026-02-28" && z.rows.every((r) => r.interestMinor === 0n));
  await t.throws("a term outside 1 to 120 months is refused", async () => ar.amortize(1000n, 0, 0, "2026-01-01"), /1 to 120/);

  const danaSale = await as(LUIS, async (c) => {
    const o = await order(c, CUST.DANA, LOC.PALESTINE, [{ product: 5, price: 44999, tax: 3712 }, { product: 6, qty: 2, price: 19999, tax: 3300 }]);
    return ar.invoiceFulfilment(c, s(c, LUIS), o.id, "all", 0n);
  });
  await t.throws("a cashier cannot open an installment contract",
    () => as(LUIS, (c, co, a) => H.openContract(c, co, a, { invoiceId: danaSale.invoiceId, apr: 19.99, termMonths: 12 })), /needs one of/);
  await t.throws("a contract cannot finance more than the invoice owes",
    () => as(JEN, (c, co, a) => H.openContract(c, co, a, { invoiceId: danaSale.invoiceId, principal: "5000", apr: 19.99, termMonths: 12 })), /cannot finance more/);
  const k = await as(JEN, (c, co, a) => H.openContract(c, co, a, { invoiceId: danaSale.invoiceId, apr: 19.99, termMonths: 12 }));
  const kd = await as(JEN, (c, co) => H.contract(c, co, k.contractId));
  t.ok("a contract moves the invoice's balance onto a 12-month schedule", kd.schedule.length === 12 && kd.payoff.principalMinor === danaSale.toArMinor,
    `${k.number}, ${kd.payoff.principalMinor} at ${k.paymentMinor}/mo`);
  const danaInv = await as(JEN, (c, co) => H.invoice(c, co, danaSale.invoiceId));
  t.ok("the invoice it financed is closed", danaInv.openMinor === 0n && danaInv.invoice.status === "paid");
  // The first installment comes due: interest first, then principal.
  await as(PEOPLE.CONTROLLER, (c) => c.query(`update ar_contract_installment set due_on = current_date - 1 where entity_id = $1 and contract_id = $2 and seq = 1`, [ENTITY, k.contractId]));
  const first = kd.schedule[0];
  const before4020 = await as(JEN, (c) => ar.glBalance(c, ENTITY, "4020"));
  const pay1 = await as(LUIS, (c, co, a) => H.payContract(c, co, a, k.contractId, { amount: String(Number(first.payment_minor) / 100), method: "cash", locationId: LOC.PALESTINE }));
  const after4020 = await as(JEN, (c) => ar.glBalance(c, ENTITY, "4020"));
  t.ok("a payment is split into principal and interest, and interest is income in 4020",
    pay1.interestMinor === B(first.interest_minor) && pay1.principalMinor === B(first.principal_minor) && before4020 - after4020 === pay1.interestMinor,
    `${pay1.principalMinor} principal, ${pay1.interestMinor} interest`);
  const quote = await as(JEN, (c, co) => H.payoff(c, co, k.contractId, today()));
  await t.throws("a payment over the payoff is refused",
    () => as(LUIS, (c, co, a) => H.payContract(c, co, a, k.contractId, { amount: String(Number(quote.payoffMinor + 100n) / 100), method: "cash" })), /more than the payoff/);
  const d2 = await as(JEN, (c, co, a) => H.restructure(c, co, a, k.contractId, { kind: "defer", months: 1, reason: "Customer hospitalised, one month grace" }));
  const kd2 = await as(JEN, (c, co) => H.contract(c, co, k.contractId));
  const next1 = kd.schedule.find((r) => r.seq === 2)!.due_on, next2 = kd2.schedule.find((r) => r.seq === 2 && r.status === "due")!.due_on;
  t.ok("a deferral moves every unpaid installment a month out", d2.version === 1 && next2 === ar.addMonths(next1, 1), `${next1} → ${next2}`);
  await t.throws("an A/R clerk cannot refinance a contract",
    () => as(JEN, (c, co, a) => H.restructure(c, co, a, k.contractId, { kind: "refinance", apr: 9.99, termMonths: 18, reason: "Lower payment requested" })), /needs one of: controller/);
  const rf = await as(PEOPLE.CONTROLLER, (c, co, a) => H.restructure(c, co, a, k.contractId, { kind: "refinance", apr: 9.99, termMonths: 18, reason: "Lower payment requested" }));
  const left = await as(JEN, (c) => ar.payoffQuote(c, ENTITY, k.contractId));
  t.ok("a refinance re-spreads exactly the principal left at the new rate",
    rf.version === 2 && rf.schedule!.length === 18 && rf.schedule!.reduce((x, r) => x + r.principalMinor, 0n) === left.principalMinor, `${rf.paymentMinor}/mo`);
  const po = await as(LUIS, (c, co, a) => H.payContract(c, co, a, k.contractId, { amount: String(Number(left.payoffMinor) / 100), method: "card", locationId: LOC.PALESTINE }));
  const kd3 = await as(JEN, (c, co) => H.contract(c, co, k.contractId));
  t.ok("paying the payoff quote closes the contract at zero", po.paidOff && kd3.contract.status === "paid_off" && kd3.payoff.principalMinor === 0n);

  const ed = await as(LUIS, async (c) => {
    const o = await order(c, CUST.ED, LOC.SOCORRO, [{ product: 8, price: 89999, tax: 7425 }]);
    return ar.invoiceFulfilment(c, s(c, LUIS), o.id, "all", 0n);
  });
  const k2 = await as(JEN, (c, co, a) => H.openContract(c, co, a, { invoiceId: ed.invoiceId, apr: 24, termMonths: 6 }));
  await t.throws("goods are not taken back on a contract in good standing",
    () => as(JEN, (c, co, a) => H.repossession(c, co, a, k2.contractId, { items: "Queen hybrid mattress" })), /in default/);
  await as(JEN, (c, co, a) => H.setDefault(c, co, a, k2.contractId, { reason: "Three payments missed, no contact" }));
  const rp1 = await as(JEN, (c, co, a) => H.repossession(c, co, a, k2.contractId, { items: "Queen hybrid mattress 12\"", scheduledOn: ar.addDays(today(), 3) }));
  await as(JEN, (c, co, a) => H.repossession(c, co, a, k2.contractId, { id: rp1.id, status: "recovered", recoveredOn: today(), condition: "Used, resaleable as-is" }));
  const wk = await as(JEN, (c, co, a) => H.requestWriteoff(c, co, a, { contractId: k2.contractId, amount: String(Number(ed.toArMinor) / 100), reason: "Defaulted contract, goods recovered" }));
  await as(PEOPLE.CONTROLLER, (c, co, a) => H.decideWriteoff(c, co, a, wk.writeoffId, { decision: "approved" }));
  const kd4 = await as(JEN, (c, co) => H.contract(c, co, k2.contractId));
  t.ok("a defaulted contract records the repossession and charges off when written off",
    kd4.contract.status === "charged_off" && kd4.repossessions[0]?.status === "recovered", kd4.contract.status);

  // ------------------------------------------------ third-party finance --
  console.log("  -- finance companies");
  const gl1110Before = await as(JEN, (c) => ar.glBalance(c, ENTITY, "1110"));
  const fin = await as(LUIS, async (c, co, a) => {
    const o = await order(c, CUST.ED, LOC.SOCORRO, [{ product: 1, price: 79999, tax: 6600 }, { product: 2, price: 69999, tax: 5775 }], false);
    const cas0 = await ar.lenderCascade(c, ENTITY, 162373n, o.id);
    await H.application(c, co, a, { salesOrderId: o.id, customerId: CUST.ED, companyId: PRIME, requested: "1623.73", decision: "declined" });
    const cas = await ar.lenderCascade(c, ENTITY, 162373n, o.id);
    await H.application(c, co, a, { salesOrderId: o.id, customerId: CUST.ED, companyId: SECOND, requested: "1623.73", approved: "2000", decision: "approved", reference: "SL-88231" });
    const r = await H.pay(c, co, a, CUST.ED, { amount: "1623.73", method: "financing", salesOrderId: o.id, locationId: LOC.SOCORRO, reference: "SL-88231" });
    return { o, cas0, cas, r };
  });
  t.ok("the lender cascade asks the first lender first, then the next after a decline",
    fin.cas0.next?.id === PRIME && fin.cas.next?.id === SECOND, `${fin.cas0.next?.name} → ${fin.cas.next?.name}`);
  const planL18 = await as(JEN, (c) => one<{ id: string }>(c, `select id from finance_plan where entity_id = $1 and code = 'L18'`, [ENTITY]));
  const planP12 = await as(JEN, (c) => one<{ id: string }>(c, `select id from finance_plan where entity_id = $1 and code = 'P12'`, [ENTITY]));
  await t.throws("a cash receipt is not owed by a finance company",
    () => as(JEN, (c, co, a) => H.financedSale(c, co, a, { receiptId: p1.receiptId, planId: planL18.id })), /taken as financing/);
  const fs = await as(LUIS, (c, co, a) => H.financedSale(c, co, a, { receiptId: fin.r.receiptId, planId: planL18.id }));
  t.ok("a financed sale expects the plan's fee", fs.expectedFeeMinor === 19485n, String(fs.expectedFeeMinor));
  const gl1110 = await as(JEN, (c) => ar.glBalance(c, ENTITY, "1110"));
  t.ok("the financing receipt is owed by the lender in 1110", gl1110 - gl1110Before === 162373n, String(gl1110 - gl1110Before));
  await t.throws("a lender sending more than the batch is refused",
    () => as(JEN, (c, co, a) => H.settle(c, co, a, { companyId: SECOND, saleIds: [fs.financedSaleId], funded: "1700", reference: "B-1" })), /more than/);
  await t.throws("a batch for the wrong lender is refused",
    () => as(JEN, (c, co, a) => H.settle(c, co, a, { companyId: PRIME, saleIds: [fs.financedSaleId], funded: "1400", reference: "B-1" })), /same finance company/);
  const set = await as(JEN, (c, co, a) => H.settle(c, co, a, { companyId: SECOND, saleIds: [fs.financedSaleId], funded: "1428.88", reference: "B-1" }));
  t.ok("a settlement posts the lender's fee to 6910 and reconciles it to the expected fee",
    set.feeMinor === 19485n && set.varianceMinor === 0n, `fee ${set.feeMinor}, variance ${set.varianceMinor}`);
  await t.throws("a sale is funded once", () => as(JEN, (c, co, a) => H.settle(c, co, a, { companyId: SECOND, saleIds: [fs.financedSaleId], funded: "1428.88", reference: "B-2" })), /already funded/);
  const fv = await as(JEN, (c, co) => H.finance(c, co));
  t.ok("what finance companies owe ties to GL 1110, and the funding cleared this sale", fv.differenceMinor === 0n && fv.gl1110Minor === gl1110Before,
    `owed ${fv.owedMinor}, GL ${fv.gl1110Minor}`);
  void planP12;

  // ------------------------------------------------------- the tie-out --
  console.log("  -- the books");
  const dep = await as(JEN, (c, co) => H.deposits(c, co));
  t.ok("deposits held tie to GL 2300", dep.differenceMinor === 0n && dep.unposted.length === 0,
    `${dep.orders.length} orders, held ${dep.totalMinor}, GL ${dep.glMinor}`);
  t.ok("the Ed Martinez financed order shows as a deposit held until delivery", dep.orders.some((o) => o.sales_order_id === fin.o.id && B(o.held_minor) === 162373n));
  const agEnd = await as(JEN, (c, co) => H.aging(c, co, today()));
  t.ok("after everything, the aging still ties to GL 1100", agEnd.differenceMinor === 0n, `aging ${agEnd.totals.total}, GL ${agEnd.glMinor}`);
  t.ok("every A/R entry balances: the trial balance does", await as(JEN, (c) => tb(c)));
  const acct = await as(JEN, (c, co) => H.account(c, co, CUST.CHEN));
  t.ok("the account view shows balance, deposits, limit, invoices, notes and contacts together",
    acct.balanceMinor === chenBal + 500n && acct.customer.house_account === true && acct.actions.length >= 2 && acct.invoices.length >= 3,
    `balance ${acct.balanceMinor}, available ${acct.availableCreditMinor}`);

  // -------------------------------------------------- entity isolation --
  console.log("  -- isolation");
  const rio = await company(RIO_ENTITY);
  const c0 = await t.pool.connect();
  try {
    await c0.query("begin");
    const rAg = await H.aging(c0, rio, today());
    t.ok("another client's aging sees none of these receivables", rAg.totals.total === 0n && rAg.customers.length === 0);
    const rList = await H.customers(c0, rio, "chen");
    t.ok("another client cannot find these customers", rList.length === 0);
    let refused = "";
    try { await H.account(c0, rio, CUST.CHEN); } catch (e) { refused = (e as Error).message; }
    t.ok("another client cannot open this customer's account", /no such customer/.test(refused), refused);
    refused = "";
    try { await H.invoice(c0, rio, chen1.invoiceId); } catch (e) { refused = (e as Error).message; }
    t.ok("another client cannot read this invoice", /no such invoice/.test(refused), refused);
    refused = "";
    try { await H.contract(c0, rio, k.contractId); } catch (e) { refused = (e as Error).message; }
    t.ok("another client cannot read this contract", /no such contract/.test(refused), refused);
  } finally { await c0.query("rollback"); c0.release(); }
}
