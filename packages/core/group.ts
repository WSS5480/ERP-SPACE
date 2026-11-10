// Group accounting: one owner, several companies (a client's entities).
// Owned by the group module.
//
//   consolidation   each company's P&L and balance sheet side by side, the
//                   combined total, and the inter-company amounts eliminated
//   sibling links   each company is a customer and a vendor of the others,
//                   using the ordinary customer and vendor tables
//   documents       a matching pair for every inter-company sale or charge:
//                   a sales invoice in the company that sells, a bill in the
//                   company that buys, at transfer price
//   net to zero     per pair of companies, what one says it is owed against
//                   what the other says it owes; settle clears both sides
//
// Accounting (accounts by code; every pack carries them):
//   goods to a sibling   seller  Dr 1195 due from / Cr 4090 inter-company sales   (transfer price)
//                                Dr 5090 inter-company cost / Cr 1300 inventory   (average cost)
//                        buyer   Dr 1300 inventory / Cr 2190 due to               (transfer price)
//   a charge (service)   seller  Dr 1195 / Cr 4090        buyer  Dr 5090 / Cr 2190
//   settle               payee   Dr bank / Cr 1195 (and Dr 2190)   payer  Dr 2190 (and Cr 1195) / Cr bank
//                        a difference both companies agreed to write off goes to 6800
//   one-sided entry      Dr 1195 / Cr the account named, or Dr the account / Cr 2190
//
// Every movement here in 1195 and 2190 is also one ic_ledger row naming the
// company on the other side, so a pair's balances are sums of that table.
// Eliminations: 1195 and 2190 between included companies, 4090 and 5090 from
// the pairs' documents, and the margin on goods sold between them (transfer
// price less cost) out of inventory and earnings -- read as still in stock.

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { post, profitObjectFor, type PostLine } from "./posting.ts";
import { invoiceSibling, settleSiblingInvoices } from "./ar.ts";
import { billFromSibling, settleSiblingBills } from "./invoice.ts";
import { landAcross, InventoryError } from "./inventory.ts";
import { createProduct } from "./catalog.ts";
import { format } from "./money.ts";

export class GroupError extends Error {}
const need = (cond: unknown, msg: string): asserts cond => { if (!cond) throw new GroupError(msg); };
const today = () => new Date().toISOString().slice(0, 10);
const B = (v: unknown) => BigInt(String(v ?? "0"));
const $ = (m: bigint) => format(m);
const T = "/* unscoped: the client's own companies, by tenant */";

export const IC = { DUE_FROM: "1195", DUE_TO: "2190", SALES: "4090", COST: "5090" } as const;
export const IC_CODES: string[] = Object.values(IC);
const DIFFERENCE = "6800";

/** Half-up basis points of an amount. */
const bpsOf = (m: bigint, rate: number) => (m * BigInt(rate) + 5000n) / 10000n;

// ------------------------------------------------------------ companies --

export type Co = { id: string; name: string; legal_name: string };

export async function companies(c: Client, tenantId: string): Promise<Co[]> {
  return q<Co>(c, `select id, name, legal_name from entity where tenant_id = $1 and status <> 'closed' order by name ${T}`, [tenantId]);
}

async function companyIn(c: Client, tenantId: string, id: string | null | undefined): Promise<Co> {
  const r = await q<Co>(c, `select id, name, legal_name from entity where id = $1 and tenant_id = $2 and status <> 'closed' ${T}`, [id ?? null, tenantId]);
  need(r.length, "that company is not one of this client's");
  return r[0];
}

const scopeFor = (s: Scope, entityId: string): Scope => ({ tenantId: s.tenantId, entityId, actor: s.actor });

// --------------------------------------------------------------- roles --

/** What a person may do in each of the client's companies: owner, controller, or neither. */
async function standing(c: Client, tenantId: string, personId: string | null) {
  if (!personId) return { owner: false, controllerOf: new Set<string>(), ownerOf: new Set<string>() };
  const g = await q<{ entity_id: string | null; role: string }>(c, `
    select g.entity_id, g.role from role_grant g join app_user u on u.id = g.app_user_id
     where u.id = $1 and u.tenant_id = $2 and g.role in ('owner','controller') ${T}`, [personId, tenantId]);
  const all = await companies(c, tenantId);
  const ownerOf = new Set<string>(), controllerOf = new Set<string>();
  for (const x of g) for (const e of all) if (x.entity_id === null || x.entity_id === e.id) (x.role === "owner" ? ownerOf : controllerOf).add(e.id);
  return { owner: all.every((e) => ownerOf.has(e.id)), ownerOf, controllerOf };
}

/** The owner, or a controller in every one of these companies. Says which company is missing. */
export async function requireGroupRole(c: Client, tenantId: string, personId: string | null, entityIds: string[], doing: string) {
  need(personId, `${doing} is done as a named person; pick who you are first`);
  const st = await standing(c, tenantId, personId);
  const all = await companies(c, tenantId);
  for (const id of entityIds) {
    const e = all.find((x) => x.id === id);
    need(e, "that company is not one of this client's");
    need(st.ownerOf.has(id) || st.controllerOf.has(id),
      `${doing} needs the owner, or a controller in every company it covers; you are not a controller in ${e.name}`);
  }
}

/** The companies this person may look at together: all of them for the owner, else those they control. */
export async function viewable(c: Client, tenantId: string, personId: string | null): Promise<Co[]> {
  const st = await standing(c, tenantId, personId);
  return (await companies(c, tenantId)).filter((e) => st.ownerOf.has(e.id) || st.controllerOf.has(e.id));
}

// ------------------------------------------------------------ settings --

export type Settings = { basis: "cost" | "cost_plus"; markupBps: number };

export async function settings(c: Client, tenantId: string): Promise<Settings> {
  const r = await q<{ transfer_basis: "cost" | "cost_plus"; markup_bps: number }>(c,
    `select transfer_basis, markup_bps from group_setting where tenant_id = $1 ${T}`, [tenantId]);
  return r.length ? { basis: r[0].transfer_basis, markupBps: Number(r[0].markup_bps) } : { basis: "cost", markupBps: 0 };
}

export async function saveSettings(c: Client, s: Scope, x: { basis: string; markupBps: number }) {
  need(x.basis === "cost" || x.basis === "cost_plus", "the transfer price is cost, or cost plus a markup");
  const m = x.basis === "cost" ? 0 : Math.trunc(Number(x.markupBps));
  need(x.basis === "cost" || (Number.isFinite(m) && m > 0 && m <= 10000), "a markup is more than 0% and at most 100%");
  const before = await settings(c, s.tenantId);
  await c.query(`insert into group_setting (tenant_id, transfer_basis, markup_bps, updated_by) values ($1,$2,$3,$4)
                 on conflict (tenant_id) do update set transfer_basis = excluded.transfer_basis, markup_bps = excluded.markup_bps,
                   updated_by = excluded.updated_by, updated_at = now()`, [s.tenantId, x.basis, m, s.actor.id || null]);
  await audit(c, s, { table: "group_setting", rowId: s.tenantId, action: "update", before, after: { basis: x.basis, markupBps: m } });
  return { basis: x.basis, markupBps: m };
}

/** What a sibling pays for goods that cost this much. */
export const transferPrice = (costMinor: bigint, st: Settings): bigint =>
  st.basis === "cost_plus" ? costMinor + bpsOf(costMinor, st.markupBps) : costMinor;

// -------------------------------------------------------- sibling links --

/**
 * Make every company a customer and a vendor of every other: one vendor per
 * company for the client (with the usual per-company vendor_entity row in each
 * sibling) and one customer per company in each sibling. Only ever adds.
 */
export async function ensureLinks(c: Client, s: Scope): Promise<{ customers: number; vendors: number; vendorLinks: number }> {
  const cos = await companies(c, s.tenantId);
  let customers = 0, vendors = 0, vendorLinks = 0;
  if (cos.length < 2) return { customers, vendors, vendorLinks };
  const cost = await one<{ id: string }>(c, `select id from gl_account where tenant_id = $1 and code = $2 ${T}`, [s.tenantId, IC.COST]).catch(() => null);
  for (const y of cos) {
    let v = (await q<{ id: string }>(c, `select id from vendor where tenant_id = $1 and related_entity_id = $2 ${T}`, [s.tenantId, y.id]))[0];
    if (!v) {
      const same = (await q<{ id: string }>(c, `select id from vendor where tenant_id = $1 and legal_name = $2 and related_entity_id is null ${T}`, [s.tenantId, y.legal_name]))[0];
      if (same) {
        await c.query(`update vendor set related_entity_id = $2 where id = $1 and tenant_id = $3`, [same.id, y.id, s.tenantId]);
        v = same;
      } else {
        v = await one<{ id: string }>(c, `insert into vendor (tenant_id, legal_name, dba, tax_classification, is_1099, w9_on_file, status, created_by, related_entity_id)
                                            values ($1,$2,$3,'llc',false,true,'active',$4,$5) returning id`,
          [s.tenantId, y.legal_name, y.name === y.legal_name ? null : y.name, s.actor.id || null, y.id]);
        vendors++;
      }
    }
    for (const x of cos) {
      if (x.id === y.id) continue;
      const r = await c.query(`insert into vendor_entity (vendor_id, entity_id, terms_days, default_gl_account_id) values ($1,$2,30,$3)
                               on conflict (vendor_id, entity_id) do nothing`, [v.id, x.id, cost?.id ?? null]);
      vendorLinks += r.rowCount ?? 0;
      const cu = await q(c, `select 1 from customer where entity_id = $1 and related_entity_id = $2`, [x.id, y.id]);
      if (!cu.length) {
        const no = await one<{ n: string }>(c, `select next_doc_no($1, 'ic_customer', 'IC-') n /* unscoped: numbering keyed by entity argument */`, [x.id]);
        await c.query(`insert into customer (entity_id, number, kind, name, terms_days, status, related_entity_id) values ($1,$2,'business',$3,30,'active',$4)`,
          [x.id, no.n, y.name, y.id]);
        customers++;
      }
    }
  }
  if (customers || vendors || vendorLinks) await audit(c, s, { table: "group_link", rowId: s.tenantId, action: "insert", after: { customers, vendors, vendorLinks } });
  return { customers, vendors, vendorLinks };
}

/** The customer (in the seller) and vendor (in the buyer) that stand for each other; made on first use. */
async function linkFor(c: Client, s: Scope, fromId: string, toId: string): Promise<{ customerId: string; vendorId: string }> {
  const find = async () => {
    const cu = await q<{ id: string }>(c, `select id from customer where entity_id = $1 and related_entity_id = $2`, [fromId, toId]);
    const v = await q<{ id: string }>(c, `select v.id from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $2
                                            where v.related_entity_id = $1 and v.tenant_id = $3`, [fromId, toId, s.tenantId]);
    return cu.length && v.length ? { customerId: cu[0].id, vendorId: v[0].id } : null;
  };
  const got = await find();
  if (got) return got;
  await ensureLinks(c, s);
  const again = await find();
  need(again, "the two companies could not be linked as customer and vendor");
  return again;
}

export async function links(c: Client, tenantId: string) {
  const cos = await companies(c, tenantId);
  const cu = await q<{ entity_id: string; related_entity_id: string; number: string; id: string }>(c,
    `select cu.entity_id, cu.related_entity_id, cu.number, cu.id from customer cu join entity e on e.id = cu.entity_id
      where e.tenant_id = $1 and cu.related_entity_id is not null ${T}`, [tenantId]);
  const ve = await q<{ entity_id: string; related_entity_id: string; vendor_id: string }>(c,
    `select ve.entity_id, v.related_entity_id, v.id vendor_id from vendor v join vendor_entity ve on ve.vendor_id = v.id
      where v.tenant_id = $1 and v.related_entity_id is not null ${T}`, [tenantId]);
  const pairs = [];
  for (const x of cos) for (const y of cos) if (x.id !== y.id) {
    const customer = cu.find((r) => r.entity_id === x.id && r.related_entity_id === y.id);
    const vendor = ve.find((r) => r.entity_id === x.id && r.related_entity_id === y.id);
    pairs.push({ companyId: x.id, company: x.name, siblingId: y.id, sibling: y.name, customerNumber: customer?.number ?? null, customerId: customer?.id ?? null,
      vendorId: vendor?.vendor_id ?? null, linked: !!customer && !!vendor });
  }
  return { companies: cos, pairs, complete: pairs.every((p) => p.linked) };
}

// ----------------------------------------------------------- documents --

type DocLine = { sku: string | null; description: string; qty: number; netMinor: bigint; costMinor: bigint };

async function ledgerRow(c: Client, s: Scope, r: { entityId: string; counterpartyId: string; code: string; amount: bigint; date: string;
  kind: "document" | "settlement" | "adjustment"; documentId?: string | null; settlementId?: string | null; journalEntryId: string; memo: string }) {
  if (r.amount === 0n) return;
  await c.query(`insert into ic_ledger (entity_id, counterparty_entity_id, account_code, amount_minor, occurred_on, kind, document_id, settlement_id,
                   journal_entry_id, memo, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [r.entityId, r.counterpartyId, r.code, r.amount.toString(), r.date, r.kind, r.documentId ?? null, r.settlementId ?? null, r.journalEntryId,
     r.memo.slice(0, 300), s.actor.id || null]);
}

/**
 * The matching pair: a sales invoice in the seller and a bill in the buyer,
 * both posted, both in the sub-ledger. Goods land in the buyer's inventory;
 * a charge lands in its inter-company cost.
 */
async function recordPair(c: Client, s: Scope, x: { kind: "goods" | "service"; fromId: string; toId: string; description: string; lines: DocLine[];
  fromLocationId: string | null; toLocationId: string | null; transferId?: string | null; toTransferId?: string | null; basis: string; markupBps: number }) {
  need(x.fromId !== x.toId, "a company does not bill itself");
  const from = await companyIn(c, s.tenantId, x.fromId), to = await companyIn(c, s.tenantId, x.toId);
  const amount = x.lines.reduce((a, l) => a + l.netMinor, 0n);
  const cost = x.lines.reduce((a, l) => a + l.costMinor, 0n);
  need(amount > 0n, "an inter-company document is for more than zero");
  const fs = scopeFor(s, from.id), ts = scopeFor(s, to.id);
  const link = await linkFor(c, s, from.id, to.id);
  const date = today();
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'ic_document', 'IC-') n /* unscoped: numbering keyed by entity argument */`, [from.id])).n;
  const doc = await one<{ id: string }>(c, `
    insert into ic_document (tenant_id, number, kind, from_entity_id, to_entity_id, description, amount_minor, cost_minor, basis, markup_bps,
                             transfer_id, to_transfer_id, doc_date, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [s.tenantId, number, x.kind, from.id, to.id, x.description.slice(0, 300), amount.toString(), cost.toString(), x.basis, x.markupBps,
     x.transferId ?? null, x.toTransferId ?? null, date, s.actor.id || null]);

  const fpo = await profitObjectFor(c, from.id, x.fromLocationId), tpo = await profitObjectFor(c, to.id, x.toLocationId);
  const sell: PostLine[] = [
    { code: IC.DUE_FROM, debit: amount, profitObjectId: fpo, memo: `due from ${to.name}` },
    { code: IC.SALES, credit: amount, profitObjectId: fpo },
  ];
  if (x.kind === "goods" && cost > 0n) sell.push({ code: IC.COST, debit: cost, profitObjectId: fpo }, { code: "1300", credit: cost, profitObjectId: fpo });
  const fromEntry = await post(c, fs, { date, sourceType: "intercompany", sourceId: doc.id, description: `${number} to ${to.name}: ${x.description}`, lines: sell });
  const buyCode = x.kind === "goods" ? "1300" : IC.COST;
  const toEntry = await post(c, ts, { date, sourceType: "intercompany", sourceId: doc.id, description: `${number} from ${from.name}: ${x.description}`,
    lines: [{ code: buyCode, debit: amount, profitObjectId: tpo }, { code: IC.DUE_TO, credit: amount, profitObjectId: tpo, memo: `due to ${from.name}` }] });
  await ledgerRow(c, s, { entityId: from.id, counterpartyId: to.id, code: IC.DUE_FROM, amount, date, kind: "document", documentId: doc.id, journalEntryId: fromEntry, memo: number });
  await ledgerRow(c, s, { entityId: to.id, counterpartyId: from.id, code: IC.DUE_TO, amount: -amount, date, kind: "document", documentId: doc.id, journalEntryId: toEntry, memo: number });

  const inv = await invoiceSibling(c, fs, { customerId: link.customerId, locationId: x.fromLocationId, documentId: doc.id, date, journalEntryId: fromEntry,
    costMinor: cost, memo: `${number}: ${x.description}`,
    lines: x.lines.map((l) => ({ sku: l.sku, description: l.description, qty: l.qty, netMinor: l.netMinor,
      unitPriceMinor: l.qty ? BigInt(Math.round(Number(l.netMinor) / l.qty)) : l.netMinor })) });
  const billId = await billFromSibling(c, ts, { vendorId: link.vendorId, documentId: doc.id, reference: number, date,
    lines: x.lines.map((l) => ({ glCode: buyCode, description: l.qty === 1 ? l.description : `${l.description} × ${l.qty}`, amountMinor: l.netMinor, profitObjectId: tpo })) });
  await c.query(`update ic_document set customer_invoice_id = $2, invoice_id = $3, from_entry_id = $4, to_entry_id = $5 where id = $1 and tenant_id = $6`,
    [doc.id, inv.invoiceId, billId, fromEntry, toEntry, s.tenantId]);
  await audit(c, fs, { table: "ic_document", rowId: doc.id, action: "insert", after: { number, kind: x.kind, to: to.name, amount: amount.toString(), cost: cost.toString() } });
  return { documentId: doc.id, number, amountMinor: amount, costMinor: cost, invoiceId: inv.invoiceId, invoiceNumber: inv.number, billId, fromEntryId: fromEntry, toEntryId: toEntry };
}

/** A company bills a sibling for a service (the warehouse company charging a store for delivery, say). */
export async function billSibling(c: Client, s: Scope, x: { toId: string; description: string; amountMinor: bigint; locationId?: string | null; toLocationId?: string | null }) {
  const description = (x.description ?? "").trim();
  need(description.length >= 3, "say what the charge is for");
  need(x.amountMinor > 0n, "the amount has to be more than zero");
  if (x.locationId) need((await q(c, `select 1 from location where id = $1 and entity_id = $2`, [x.locationId, s.entityId])).length, "that location is not this company's");
  if (x.toLocationId) need((await q(c, `select 1 from location where id = $1 and entity_id = $2`, [x.toLocationId, x.toId])).length, "that location is not the billed company's");
  return recordPair(c, s, { kind: "service", fromId: s.entityId, toId: x.toId, description, fromLocationId: x.locationId ?? null, toLocationId: x.toLocationId ?? null,
    lines: [{ sku: null, description, qty: 1, netMinor: x.amountMinor, costMinor: 0n }], basis: "agreed", markupBps: 0 });
}

/**
 * Called by inventory when a transfer to a sibling's location ships: the stock
 * has left the sender at average cost. Match (or copy) each product into the
 * sibling's catalog by SKU, land the goods there at transfer price, and record
 * the pair. Refusals come back as inventory's own, so the ship route reads them.
 */
export async function completeAcross(c: Client, s: Scope, transferId: string) {
  try {
    const t = await one<{ id: string; number: string; from_location_id: string; to_location_id: string; to_entity_id: string }>(c,
      `select id, number, from_location_id, to_location_id, to_entity_id from inv_transfer where id = $1 and entity_id = $2`, [transferId, s.entityId]);
    const to = await companyIn(c, s.tenantId, t.to_entity_id);
    const ts = scopeFor(s, to.id);
    const st = await settings(c, s.tenantId);
    const lines = await q<{ product_id: string; qty: string; value_minor: string; sku: string; name: string; kind: string; brand: string | null; category: string | null;
      subcategory: string | null; collection: string | null; color: string | null; description: string | null; price_minor: string; taxable: boolean; serialized: boolean;
      ship_class: string; cubic_ft: string | null; weight_lb: string | null; barcode: string | null }>(c, `
      select l.product_id, l.qty, l.value_minor, p.sku, p.name, p.kind, p.brand, p.category, p.subcategory, p.collection, p.color, p.description, p.price_minor,
             p.taxable, p.serialized, p.ship_class, p.cubic_ft, p.weight_lb, p.barcode
        from inv_transfer_line l join product p on p.id = l.product_id where l.entity_id = $1 and l.transfer_id = $2 order by p.sku`, [s.entityId, transferId]);
    const landed: { productId: string; qty: number; valueMinor: bigint }[] = [];
    const docLines: DocLine[] = [];
    for (const l of lines) {
      const cost = B(l.value_minor), qty = Number(l.qty);
      const price = transferPrice(cost, st);
      let pid = (await q<{ id: string }>(c, `select id from product where entity_id = $1 and sku = $2`, [to.id, l.sku]))[0]?.id;
      if (!pid) {
        pid = await createProduct(c, ts, { sku: l.sku, name: l.name, kind: l.kind, brand: l.brand, category: l.category, subcategory: l.subcategory,
          collection: l.collection, color: l.color, description: l.description, priceMinor: B(l.price_minor),
          costMinor: qty ? BigInt(Math.round(Number(price) / qty)) : 0n, taxable: l.taxable, serialized: l.serialized, shipClass: l.ship_class,
          cubicFt: l.cubic_ft === null ? null : Number(l.cubic_ft), weightLb: l.weight_lb === null ? null : Number(l.weight_lb), barcode: l.barcode },
          { status: B(l.price_minor) > 0n || ["service", "fee"].includes(l.kind) ? "active" : "draft" });
      }
      landed.push({ productId: pid, qty, valueMinor: price });
      docLines.push({ sku: l.sku, description: l.name, qty, netMinor: price, costMinor: cost });
    }
    const land = await landAcross(c, ts, { fromEntityId: s.entityId, fromLocationId: t.from_location_id, toLocationId: t.to_location_id,
      senderNumber: t.number, lines: landed });
    const amount = docLines.reduce((a, l) => a + l.netMinor, 0n);
    if (amount === 0n) return { toCompany: to.name, toTransferNumber: land.number, document: null };
    const doc = await recordPair(c, s, { kind: "goods", fromId: s.entityId, toId: to.id, description: `Transfer ${t.number}`, lines: docLines,
      fromLocationId: t.from_location_id, toLocationId: t.to_location_id, transferId: t.id, toTransferId: land.transferId, basis: st.basis, markupBps: st.markupBps });
    return { toCompany: to.name, toTransferNumber: land.number, document: doc.number, documentId: doc.documentId, amountMinor: doc.amountMinor,
      invoiceNumber: doc.invoiceNumber };
  } catch (e) {
    if (e instanceof InventoryError) throw e;
    if (e instanceof Error && e.constructor !== Error && !(e as { code?: string }).code) throw new InventoryError(e.message);
    throw e;
  }
}

// ---------------------------------------------------- one-sided entries --

/**
 * One company's side only: a charge it says a sibling owes (Dr 1195), or a
 * credit it owes a sibling (Cr 2190), against an ordinary account. The other
 * company books its side later; until then the pair shows as out of balance.
 */
export async function adjust(c: Client, s: Scope, x: { counterpartyId: string; kind: string; amountMinor: bigint; offsetCode?: string | null; reason: string }) {
  const other = await companyIn(c, s.tenantId, x.counterpartyId);
  need(other.id !== s.entityId, "pick the other company");
  need(x.kind === "charge" || x.kind === "credit", "a one-sided entry is a charge to the sibling or a credit to it");
  need(x.amountMinor > 0n, "the amount has to be more than zero");
  const reason = (x.reason ?? "").trim();
  need(reason.length >= 3, "say why this is booked on one side only");
  const code = (x.offsetCode ?? "").trim() || DIFFERENCE;
  need(!IC_CODES.includes(code), `${code} is an inter-company account; book the other side to an ordinary account`);
  const acct = await q<{ is_postable: boolean; active: boolean }>(c, `select is_postable, active from gl_account where tenant_id = $1 and code = $2 ${T}`, [s.tenantId, code]);
  need(acct.length && acct[0].is_postable && acct[0].active, `there is no postable account ${code} in the chart`);
  const date = today();
  const lines: PostLine[] = x.kind === "charge"
    ? [{ code: IC.DUE_FROM, debit: x.amountMinor, memo: `due from ${other.name}` }, { code, credit: x.amountMinor }]
    : [{ code, debit: x.amountMinor }, { code: IC.DUE_TO, credit: x.amountMinor, memo: `due to ${other.name}` }];
  const je = await post(c, s, { date, sourceType: "intercompany", sourceId: null, description: `One-sided inter-company entry with ${other.name}: ${reason}`, lines });
  await ledgerRow(c, s, { entityId: s.entityId, counterpartyId: other.id, code: x.kind === "charge" ? IC.DUE_FROM : IC.DUE_TO,
    amount: x.kind === "charge" ? x.amountMinor : -x.amountMinor, date, kind: "adjustment", journalEntryId: je, memo: reason });
  await audit(c, s, { table: "ic_ledger", rowId: je, action: "insert", after: { kind: x.kind, with: other.name, amount: x.amountMinor.toString(), code }, reason });
  return { journalEntryId: je };
}

// ------------------------------------------------------- net to zero --

type Bal = { from: bigint; to: bigint };   // natural: due from (debit), due to (credit)

async function balances(c: Client, tenantId: string, asOf: string | null = null) {
  const rows = await q<{ entity_id: string; counterparty_entity_id: string; account_code: string; s: string }>(c, `
    select l.entity_id, l.counterparty_entity_id, l.account_code, sum(l.amount_minor)::text s
      from ic_ledger l join entity e on e.id = l.entity_id
     where e.tenant_id = $1 and ($2::date is null or l.occurred_on <= $2::date)
     group by 1, 2, 3 ${T}`, [tenantId, asOf]);
  const m = new Map<string, Bal>();
  for (const r of rows) {
    const k = `${r.entity_id}|${r.counterparty_entity_id}`;
    const b = m.get(k) ?? { from: 0n, to: 0n };
    if (r.account_code === IC.DUE_FROM) b.from += B(r.s); else b.to -= B(r.s);
    m.set(k, b);
  }
  return (a: string, b: string): Bal => m.get(`${a}|${b}`) ?? { from: 0n, to: 0n };
}

/**
 * Per pair of companies: what each says the other owes it (due from less due
 * to). A pair nets to zero when the two views are equal and opposite. Each
 * company's 1195 and 2190 in the ledger are tied to the sub-ledger too: an
 * amount posted to them by hand, outside Group, shows as not tracked.
 */
export async function netCheck(c: Client, tenantId: string, only: string[] | null = null) {
  const cos = (await companies(c, tenantId)).filter((e) => !only || only.includes(e.id));
  const bal = await balances(c, tenantId);
  const pairs = [];
  for (let i = 0; i < cos.length; i++) for (let j = i + 1; j < cos.length; j++) {
    const a = cos[i], b = cos[j];
    const ab = bal(a.id, b.id), ba = bal(b.id, a.id);
    const aNet = ab.from - ab.to, bNet = ba.from - ba.to;
    const open = await q<{ n: string }>(c, `select count(*)::text n from ic_document where tenant_id = $1 and status = 'open'
      and ((from_entity_id = $2 and to_entity_id = $3) or (from_entity_id = $3 and to_entity_id = $2)) ${T}`, [tenantId, a.id, b.id]);
    pairs.push({ a: { id: a.id, name: a.name, dueFromMinor: ab.from, dueToMinor: ab.to, netMinor: aNet },
      b: { id: b.id, name: b.name, dueFromMinor: ba.from, dueToMinor: ba.to, netMinor: bNet },
      differenceMinor: aNet + bNet, balanced: aNet + bNet === 0n, active: aNet !== 0n || bNet !== 0n || ab.from !== 0n || ab.to !== 0n || ba.from !== 0n || ba.to !== 0n,
      openDocuments: Number(open[0].n),
      owes: aNet > 0n ? b.name : aNet < 0n ? a.name : bNet > 0n ? a.name : bNet < 0n ? b.name : null });
  }
  const gl = await q<{ entity_id: string; code: string; bal: string }>(c, `
    select je.entity_id, g.code, sum(jl.debit_minor - jl.credit_minor)::text bal
      from journal_line jl join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id
      join entity e on e.id = je.entity_id
     where e.tenant_id = $1 and g.code in ('1195','2190') group by 1, 2 ${T}`, [tenantId]);
  const sub = await q<{ entity_id: string; account_code: string; s: string }>(c, `
    select l.entity_id, l.account_code, sum(l.amount_minor)::text s from ic_ledger l join entity e on e.id = l.entity_id
     where e.tenant_id = $1 group by 1, 2 ${T}`, [tenantId]);
  const ties = cos.map((e) => {
    const g = (code: string) => B(gl.find((x) => x.entity_id === e.id && x.code === code)?.bal);
    const l = (code: string) => B(sub.find((x) => x.entity_id === e.id && x.account_code === code)?.s);
    const untracked = (g(IC.DUE_FROM) - l(IC.DUE_FROM)) + (g(IC.DUE_TO) - l(IC.DUE_TO));
    return { id: e.id, name: e.name, gl1195Minor: g(IC.DUE_FROM), gl2190Minor: -g(IC.DUE_TO), untrackedMinor: untracked, ties: untracked === 0n };
  });
  const off = pairs.filter((p) => !p.balanced);
  return { companies: cos, pairs, ties, offPairs: off.length, untracked: ties.filter((x) => !x.ties).length, allBalanced: !off.length && ties.every((x) => x.ties) };
}

// ------------------------------------------------------------- settle --

/** Lines that bring a company's 1195 and 2190 with one sibling to zero, and the ledger rows that go with them. */
function clearing(bal: Bal, other: string): PostLine[] {
  const out: PostLine[] = [];
  if (bal.from > 0n) out.push({ code: IC.DUE_FROM, credit: bal.from, memo: `settled with ${other}` });
  if (bal.from < 0n) out.push({ code: IC.DUE_FROM, debit: -bal.from, memo: `settled with ${other}` });
  if (bal.to > 0n) out.push({ code: IC.DUE_TO, debit: bal.to, memo: `settled with ${other}` });
  if (bal.to < 0n) out.push({ code: IC.DUE_TO, credit: -bal.to, memo: `settled with ${other}` });
  return out;
}
const sideTotal = (ls: PostLine[]) => ls.reduce((a, l) => a + (l.debit ?? 0n) - (l.credit ?? 0n), 0n);

async function bankOf(c: Client, entityId: string, name: string) {
  const r = await q<{ id: string; code: string }>(c, `select ba.id, g.code from bank_account ba join gl_account g on g.id = ba.gl_account_id
     where ba.entity_id = $1 and ba.purpose = 'operating' and ba.status = 'active'`, [entityId]);
  need(r.length, `${name} has no operating bank account to pay from or into; add one under Cash`);
  return r[0];
}

/**
 * Settle a pair: the company that owes pays the other what its own books say
 * it owes (or the amount named), both sides' 1195 and 2190 with each other go
 * to zero, and their open documents are paid. When the two books disagree,
 * the difference is written off to 6800 in whichever book it sits, and that
 * needs a reason.
 */
export async function settle(c: Client, s: Scope, x: { aId: string; bId: string; amountMinor?: bigint | null; reason?: string | null }) {
  const a = await companyIn(c, s.tenantId, x.aId), b = await companyIn(c, s.tenantId, x.bId);
  need(a.id !== b.id, "settling is between two different companies");
  // One settlement at a time per client.
  await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`ic:${s.tenantId}`]);
  const bal = await balances(c, s.tenantId);
  const ab = bal(a.id, b.id), ba = bal(b.id, a.id);
  const aNet = ab.from - ab.to, bNet = ba.from - ba.to;
  need([ab.from, ab.to, ba.from, ba.to].some((v) => v !== 0n), `there is nothing open between ${a.name} and ${b.name}`);
  const aPays = aNet < 0n || (aNet === 0n && bNet > 0n);
  const [payer, payee, payerBal, payeeBal] = aPays ? [a, b, ab, ba] : [b, a, ba, ab];
  const owes = -(payerBal.from - payerBal.to);                 // what the payer's books say it owes
  const cash = x.amountMinor ?? (owes > 0n ? owes : 0n);
  need(cash >= 0n, "the amount paid cannot be negative");
  const date = today();
  const id = (await one<{ id: string }>(c, `select gen_random_uuid()::text id /* unscoped: no table */`)).id;
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'ic_settlement', 'ICS-') n /* unscoped: numbering keyed by entity argument */`, [payer.id])).n;

  const payerBank = cash > 0n ? await bankOf(c, payer.id, payer.name) : null;
  const payeeBank = cash > 0n ? await bankOf(c, payee.id, payee.name) : null;
  const payerLines = [...clearing(payerBal, payee.name), ...(payerBank ? [{ code: payerBank.code, credit: cash, bankAccountId: payerBank.id, memo: `paid to ${payee.name}` }] : [])];
  const payeeLines = [...clearing(payeeBal, payer.name), ...(payeeBank ? [{ code: payeeBank.code, debit: cash, bankAccountId: payeeBank.id, memo: `paid by ${payer.name}` }] : [])];
  const payerDiff = -sideTotal(payerLines), payeeDiff = -sideTotal(payeeLines);   // > 0: a cost written off; < 0: a gain
  const reason = (x.reason ?? "").trim();
  if (payerDiff !== 0n || payeeDiff !== 0n) {
    need(reason.length >= 3, `the two companies' books differ (${payer.name} says it owes ${$(owes > 0n ? owes : 0n)}, ${payee.name} says it is owed ${$(payeeBal.from - payeeBal.to)}); say why before settling, and the difference is written off to ${DIFFERENCE}`);
  }
  const plug = (d: bigint): PostLine[] => d > 0n ? [{ code: DIFFERENCE, debit: d, memo: "inter-company difference written off" }]
    : d < 0n ? [{ code: DIFFERENCE, credit: -d, memo: "inter-company difference written off" }] : [];
  const desc = `${number}: ${payer.name} settles with ${payee.name}${reason ? ` (${reason})` : ""}`;
  const payerLinesAll = [...payerLines, ...plug(payerDiff)], payeeLinesAll = [...payeeLines, ...plug(payeeDiff)];
  const payerEntry = payerLinesAll.length ? await post(c, scopeFor(s, payer.id), { date, sourceType: "intercompany", sourceId: id, description: desc, lines: payerLinesAll }) : null;
  const payeeEntry = payeeLinesAll.length ? await post(c, scopeFor(s, payee.id), { date, sourceType: "intercompany", sourceId: id, description: desc, lines: payeeLinesAll }) : null;
  await c.query(`insert into ic_settlement (id, tenant_id, number, payer_entity_id, payee_entity_id, amount_minor, payer_difference_minor, payee_difference_minor,
                   reason, payer_entry_id, payee_entry_id, settled_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, s.tenantId, number, payer.id, payee.id, cash.toString(), payerDiff.toString(), payeeDiff.toString(), reason || null, payerEntry, payeeEntry, date, s.actor.id || null]);
  for (const [who, other, bl, je] of [[payer, payee, payerBal, payerEntry], [payee, payer, payeeBal, payeeEntry]] as const) {
    if (!je) continue;
    await ledgerRow(c, s, { entityId: who.id, counterpartyId: other.id, code: IC.DUE_FROM, amount: -bl.from, date, kind: "settlement", settlementId: id, journalEntryId: je, memo: number });
    await ledgerRow(c, s, { entityId: who.id, counterpartyId: other.id, code: IC.DUE_TO, amount: bl.to, date, kind: "settlement", settlementId: id, journalEntryId: je, memo: number });
  }
  const docs = await q<{ id: string; from_entity_id: string; to_entity_id: string }>(c, `
    update ic_document set status = 'settled', settlement_id = $4 where tenant_id = $1 and status = 'open'
       and ((from_entity_id = $2 and to_entity_id = $3) or (from_entity_id = $3 and to_entity_id = $2))
    returning id, from_entity_id, to_entity_id /* unscoped: the pair's documents, by tenant */`, [s.tenantId, a.id, b.id, id]);
  const how = `settled by ${number}`;
  let invoices = 0, bills = 0;
  for (const e of [a, b]) {
    invoices += await settleSiblingInvoices(c, scopeFor(s, e.id), docs.filter((d) => d.from_entity_id === e.id).map((d) => d.id));
    bills += await settleSiblingBills(c, scopeFor(s, e.id), docs.filter((d) => d.to_entity_id === e.id).map((d) => d.id), how);
  }
  await audit(c, scopeFor(s, payer.id), { table: "ic_settlement", rowId: id, action: "insert",
    after: { number, payer: payer.name, payee: payee.name, cash: cash.toString(), payerDiff: payerDiff.toString(), payeeDiff: payeeDiff.toString(), documents: docs.length },
    reason: reason || undefined });
  return { id, number, payer: payer.name, payee: payee.name, amountMinor: cash, payerDifferenceMinor: payerDiff, payeeDifferenceMinor: payeeDiff,
    documents: docs.length, invoices, bills };
}

// -------------------------------------------------------- consolidation --

export type Section = "revenue" | "cost" | "opex" | "other" | "asset" | "liability" | "equity";
export const SECTIONS: { id: Section; label: string; statement: "pnl" | "bs" }[] = [
  { id: "revenue", label: "Revenue", statement: "pnl" }, { id: "cost", label: "Cost of merchandise", statement: "pnl" },
  { id: "opex", label: "Operating expenses", statement: "pnl" }, { id: "other", label: "Other expenses", statement: "pnl" },
  { id: "asset", label: "Assets", statement: "bs" }, { id: "liability", label: "Liabilities", statement: "bs" }, { id: "equity", label: "Equity", statement: "bs" },
];
const sectionOf = (type: string, code: string): Section =>
  type === "revenue" ? "revenue" : type === "expense" ? (code.startsWith("5") ? "cost" : code.startsWith("6") ? "opex" : "other") : (type as Section);
const EARNINGS = "earnings";

type Amounts = Record<string, bigint>;
type Line = { code: string; name: string; byCompany: Amounts; sumMinor: bigint; eliminatedMinor: bigint; combinedMinor: bigint; intercompany: boolean };

const sumOf = (a: Amounts) => Object.values(a).reduce((x, y) => x + y, 0n);

/**
 * The group view: every included company's P&L for a date range and balance
 * sheet as of a day, side by side; what is eliminated; and the combined total
 * (the sum of the companies less the eliminations). Amounts are in their
 * natural sign: revenue, liabilities and equity as credits are positive.
 */
export async function consolidate(c: Client, tenantId: string, x: { companyIds: string[]; from: string; to: string; asOf: string }) {
  const all = await companies(c, tenantId);
  const cos = all.filter((e) => x.companyIds.includes(e.id));
  need(cos.length === x.companyIds.length && cos.length > 0, "pick the companies to include");
  need(x.from <= x.to, "the start date is after the end date");
  const ids = cos.map((e) => e.id);
  const rows = await q<{ entity_id: string; code: string; name: string; account_type: string; range_net: string; asof_net: string }>(c, `
    select je.entity_id, g.code, g.name, g.account_type,
           sum(case when je.posting_date between $3::date and $4::date then jl.debit_minor - jl.credit_minor else 0 end)::text range_net,
           sum(case when je.posting_date <= $5::date then jl.debit_minor - jl.credit_minor else 0 end)::text asof_net
      from journal_line jl join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id
      join entity e on e.id = je.entity_id
     where e.tenant_id = $1 and je.entity_id = any($2::uuid[]) and je.posting_date <= greatest($4::date, $5::date)
     group by je.entity_id, g.code, g.name, g.account_type ${T}`, [tenantId, ids, x.from, x.to, x.asOf]);

  // What is inter-company between included companies: from the sub-ledger and the documents.
  const ledger = await q<{ code: string; s: string }>(c, `
    select l.account_code code, sum(l.amount_minor)::text s from ic_ledger l
     where l.entity_id = any($1::uuid[]) and l.counterparty_entity_id = any($1::uuid[]) and l.occurred_on <= $2::date group by 1
     /* unscoped: the included companies, all of this client */`, [ids, x.asOf]);
  const docs = await q<{ sales: string; cost: string; margin: string }>(c, `
    select coalesce(sum(amount_minor) filter (where doc_date between $3::date and $4::date), 0)::text sales,
           coalesce(sum(case when kind = 'goods' then cost_minor else amount_minor end) filter (where doc_date between $3::date and $4::date), 0)::text cost,
           coalesce(sum(case when kind = 'goods' then amount_minor - cost_minor else 0 end) filter (where doc_date <= $5::date), 0)::text margin
      from ic_document where tenant_id = $1 and from_entity_id = any($2::uuid[]) and to_entity_id = any($2::uuid[]) ${T}`, [tenantId, ids, x.from, x.to, x.asOf]);
  const sub = (code: string) => B(ledger.find((r) => r.code === code)?.s);
  const elim: Record<string, bigint> = {
    [IC.DUE_FROM]: sub(IC.DUE_FROM),              // asset, natural debit
    [IC.DUE_TO]: -sub(IC.DUE_TO),                 // liability, natural credit
    [IC.SALES]: B(docs[0].sales),
    [IC.COST]: B(docs[0].cost),
    "1300": B(docs[0].margin),                    // margin on goods between them, still in stock
    [EARNINGS]: B(docs[0].margin),
  };

  const lines = new Map<string, Line & { section: Section }>();
  const blank = (): Amounts => Object.fromEntries(ids.map((id) => [id, 0n]));
  const lineFor = (section: Section, code: string, name: string) => {
    const k = `${section}|${code}`;
    if (!lines.has(k)) lines.set(k, { section, code, name, byCompany: blank(), sumMinor: 0n, eliminatedMinor: 0n, combinedMinor: 0n, intercompany: IC_CODES.includes(code) });
    return lines.get(k)!;
  };
  const earnings = blank();
  for (const r of rows) {
    const sec = sectionOf(r.account_type, r.code);
    const credit = ["revenue", "liability", "equity"].includes(r.account_type);
    if (r.account_type === "revenue" || r.account_type === "expense") {
      const v = credit ? -B(r.range_net) : B(r.range_net);
      if (v !== 0n || B(r.range_net) !== 0n) lineFor(sec, r.code, r.name).byCompany[r.entity_id] += v;
      earnings[r.entity_id] += -B(r.asof_net);    // earnings to date: revenue less expenses, as a credit
    } else {
      const v = credit ? -B(r.asof_net) : B(r.asof_net);
      if (v !== 0n) lineFor(sec, r.code, r.name).byCompany[r.entity_id] += v;
    }
  }
  const earn = lineFor("equity", EARNINGS, "Earnings to date (not yet closed)");
  for (const id of ids) earn.byCompany[id] += earnings[id];
  for (const [k, amt] of Object.entries(elim)) {
    if (amt === 0n) continue;
    const sec: Section = k === IC.DUE_FROM || k === "1300" ? "asset" : k === IC.DUE_TO ? "liability" : k === IC.SALES ? "revenue" : k === IC.COST ? "cost" : "equity";
    const name = k === EARNINGS ? earn.name : (await q<{ name: string }>(c, `select name from gl_account where tenant_id = $1 and code = $2 ${T}`, [tenantId, k]))[0]?.name ?? k;
    lineFor(sec, k, name).eliminatedMinor += amt;
  }
  for (const l of lines.values()) { l.sumMinor = sumOf(l.byCompany); l.combinedMinor = l.sumMinor - l.eliminatedMinor; }

  const groups = SECTIONS.map((sec) => {
    const ls = [...lines.values()].filter((l) => l.section === sec.id && (l.sumMinor !== 0n || l.eliminatedMinor !== 0n || Object.values(l.byCompany).some((v) => v !== 0n)))
      .sort((p, q2) => (p.code === EARNINGS ? 1 : q2.code === EARNINGS ? -1 : p.code.localeCompare(q2.code)));
    const byCompany = blank();
    for (const l of ls) for (const id of ids) byCompany[id] += l.byCompany[id];
    const sum = sumOf(byCompany), eliminated = ls.reduce((a, l) => a + l.eliminatedMinor, 0n);
    return { id: sec.id, label: sec.label, statement: sec.statement, byCompany, sumMinor: sum, eliminatedMinor: eliminated, combinedMinor: sum - eliminated,
      accounts: ls.map(({ section: _s, ...l }) => l) };
  });
  const g = (id: Section) => groups.find((x) => x.id === id)!;
  const netIncome = { byCompany: blank(), sumMinor: 0n, eliminatedMinor: 0n, combinedMinor: 0n };
  for (const id of ids) netIncome.byCompany[id] = g("revenue").byCompany[id] - g("cost").byCompany[id] - g("opex").byCompany[id] - g("other").byCompany[id];
  netIncome.sumMinor = sumOf(netIncome.byCompany);
  netIncome.eliminatedMinor = g("revenue").eliminatedMinor - g("cost").eliminatedMinor - g("opex").eliminatedMinor - g("other").eliminatedMinor;
  netIncome.combinedMinor = netIncome.sumMinor - netIncome.eliminatedMinor;
  // Assets less liabilities and equity: zero for every company; for the combined books, what does not net to zero between them.
  const check = (pick: (x: typeof groups[number]) => bigint) => pick(g("asset")) - pick(g("liability")) - pick(g("equity"));
  const outOfBalance = check((x) => x.combinedMinor);
  return {
    companies: cos, from: x.from, to: x.to, asOf: x.asOf,
    groups, netIncome,
    eliminations: { dueFromMinor: elim[IC.DUE_FROM], dueToMinor: elim[IC.DUE_TO], salesMinor: elim[IC.SALES], costMinor: elim[IC.COST], marginInStockMinor: elim["1300"],
      totalPnlMinor: netIncome.eliminatedMinor },
    balanceCheck: { byCompany: Object.fromEntries(ids.map((id) => [id, check((x) => x.byCompany[id])])), combinedMinor: outOfBalance, balanced: outOfBalance === 0n },
  };
}

// -------------------------------------------------------------- lists --

export async function documents(c: Client, tenantId: string, only: string[], limit = 50) {
  return q(c, `
    select d.id, d.number, d.kind, d.description, d.amount_minor::text, d.cost_minor::text, d.basis, d.markup_bps, d.status, d.doc_date::text,
           d.from_entity_id, fe.name from_name, d.to_entity_id, te.name to_name, ci.number invoice_number, i.reference bill_reference, i.status bill_status,
           ft.number transfer_number, tt.number to_transfer_number, st.number settlement_number
      from ic_document d join entity fe on fe.id = d.from_entity_id join entity te on te.id = d.to_entity_id
      left join customer_invoice ci on ci.id = d.customer_invoice_id left join invoice i on i.id = d.invoice_id
      left join inv_transfer ft on ft.id = d.transfer_id left join inv_transfer tt on tt.id = d.to_transfer_id
      left join ic_settlement st on st.id = d.settlement_id
     where d.tenant_id = $1 and (d.from_entity_id = any($2::uuid[]) or d.to_entity_id = any($2::uuid[]))
     order by d.created_at desc limit $3 ${T}`, [tenantId, only, limit]);
}

export async function settlements(c: Client, tenantId: string, only: string[], limit = 20) {
  return q(c, `
    select s.id, s.number, s.amount_minor::text, s.payer_difference_minor::text, s.payee_difference_minor::text, s.reason, s.settled_on::text,
           pe.name payer, re.name payee
      from ic_settlement s join entity pe on pe.id = s.payer_entity_id join entity re on re.id = s.payee_entity_id
     where s.tenant_id = $1 and (s.payer_entity_id = any($2::uuid[]) or s.payee_entity_id = any($2::uuid[]))
     order by s.created_at desc limit $3 ${T}`, [tenantId, only, limit]);
}

/** Active locations of the client's other companies: where a transfer can go across companies. */
export async function siblingLocations(c: Client, s: Scope) {
  return q(c, `select l.id, l.code, l.name, l.kind, e.id entity_id, e.name company from location l join entity e on e.id = l.entity_id
     where e.tenant_id = $1 and e.id <> $2 and e.status = 'active' and l.status = 'active' order by e.name, l.name ${T}`, [s.tenantId, s.entityId]);
}
