// Inventory checks: receiving, pieces and labels, transfers, allocation and
// pick lists, damage and claims, counts with maker-not-checker, adjustments,
// valuation, GL balance and entity isolation. Each refusal is asserted too.
import type { T } from "./harness.ts";
import { ENTITY, RIO_ENTITY, LOC, PEOPLE } from "./harness.ts";
import { tx, pool, q, type Client, type Scope } from "../../packages/core/db.ts";
import * as inv from "../../packages/core/inventory.ts";
import { module } from "../../server/modules/inventory.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";

const DC = "33333333-0000-0000-0000-0000000000dc";
const DEE = "55555555-0000-0000-0000-000000000013";      // warehouse
const MARIA = "55555555-0000-0000-0000-000000000011";    // sales
const MGR = "55555555-0000-0000-0000-000000000018";      // store manager + sales
const P = {
  SOFA: "77777777-0000-0000-0000-000000000001", LOVESEAT: "77777777-0000-0000-0000-000000000002", BED: "77777777-0000-0000-0000-000000000003",
  DRESSER: "77777777-0000-0000-0000-000000000004", RECLINER: "77777777-0000-0000-0000-000000000007", MATTRESS: "77777777-0000-0000-0000-000000000008",
  LAMP: "77777777-0000-0000-0000-000000000009", CHAIRS: "77777777-0000-0000-0000-000000000006",
};
const PO = "99992222-0000-0000-0000-000000000001";
const POL = { SOFA: "99992222-0000-0000-0000-000000000011", BED: "99992222-0000-0000-0000-000000000012", MAT: "99992222-0000-0000-0000-000000000013" };
const BIN = { RCV: "99991111-0000-0000-0000-000000000001", A011: "99991111-0000-0000-0000-000000000002", B02: "99991111-0000-0000-0000-000000000006",
  SR01: "99991111-0000-0000-0000-000000000011", BK01: "99991111-0000-0000-0000-000000000012" };

// The harness's company() query has no entity filter and no unscoped marker,
// so db.guard refuses it (and t.as with it). These do the same, guarded.
export async function companyOf(entityId = ENTITY): Promise<Company> {
  const c = await pool.connect();
  try {
    const x = (await q<Record<string, string>>(c, `
      select e.id, e.tenant_id, e.name, e.legal_name, t.name tenant_name, t.vertical, t.location_label, t.profit_object_label, t.aging_label
        from entity e join tenant t on t.id = e.tenant_id where e.id = $1 /* unscoped: loading the company itself */`, [entityId]))[0];
    return { id: x.id, tenantId: x.tenant_id, name: x.name, legalName: x.legal_name, tenantName: x.tenant_name, vertical: x.vertical,
      locationLabel: x.location_label, profitObjectLabel: x.profit_object_label, agingLabel: x.aging_label } as unknown as Company;
  } finally { c.release(); }
}
export async function asPerson<R>(personId: string, fn: (c: Client, co: Company, a: Actor) => Promise<R>, entityId = ENTITY): Promise<R> {
  const c0 = await pool.connect();
  let name = "?";
  try { name = (await q<{ name: string }>(c0, "select name from app_user where id = $1 /* unscoped: lookup */", [personId]))[0]?.name ?? "?"; }
  finally { c0.release(); }
  const co = await companyOf(entityId);
  return tx({ kind: "user", id: personId, label: name }, (c) => fn(c, co, { personId, personName: name, label: name }));
}

type Get = (c: Client, co: Company, url: URL, m: RegExpMatchArray, p: string | null) => Promise<unknown>;
type Post = (c: Client, co: Company, a: Actor, b: Record<string, unknown>, m: RegExpMatchArray) => Promise<unknown>;
export function routesOf(mod: { register: (k: never) => void }) {
  const gets: [RegExp, Get][] = [], posts: [RegExp, Post][] = [];
  mod.register({ coGet: (tail: string, fn: Get) => gets.push([new RegExp(`^(co)${tail}$`), fn]),
    coPost: (tail: string, fn: Post) => posts.push([new RegExp(`^(co)${tail}$`), fn]), publicRoute: () => {} } as never);
  const find = <F>(list: [RegExp, F][], path: string): [F, RegExpMatchArray] => {
    for (const [re, fn] of list) { const m = ("co" + path.split("?")[0]).match(re); if (m) return [fn, m]; }
    throw new Error(`no route ${path}`);
  };
  return {
    post: (t: T, person: string, path: string, body: Record<string, unknown> = {}) =>
      asPerson(person, (c, co, a) => { const [fn, m] = find(posts, path); return fn(c, co, a, body, m); }),
    get: async (t: T, path: string) => {
      const c = await t.pool.connect();
      try { const co = await companyOf(); const [fn, m] = find(gets, path); return await fn(c, co, new URL("http://x" + path), m, null); }
      finally { c.release(); }
    },
  };
}
const R = routesOf(module as never);

export async function run(t: T) {
  const c0 = await t.pool.connect();
  const read = <X extends Record<string, unknown>>(sql: string, p: unknown[] = []) => t.q<X>(c0, sql, p);
  const level = async (pid: string, loc: string) => {
    const r = await read<{ on_hand: string; reserved: string; held: string; on_order: string }>(
      `select on_hand, reserved, held, on_order from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`, [ENTITY, pid, loc]);
    const x = r[0] ?? { on_hand: "0", reserved: "0", held: "0", on_order: "0" };
    return { onHand: Number(x.on_hand), reserved: Number(x.reserved), held: Number(x.held), onOrder: Number(x.on_order) };
  };
  // A serialized product's on hand and held always match its pieces.
  const consistent = async (what: string) => {
    const bad = await read<{ n: string }>(`
      select count(*) n from stock_level s join product p on p.id = s.product_id
       where s.entity_id = $1 and p.serialized and (
         s.on_hand <> (select count(distinct unit_id) from inv_piece x where x.entity_id = s.entity_id and x.product_id = s.product_id
                         and x.location_id = s.location_id and x.status = any($2))
         or s.held <> (select count(distinct unit_id) from inv_piece x where x.entity_id = s.entity_id and x.product_id = s.product_id
                         and x.location_id = s.location_id and x.status = any($3)))`, [ENTITY, inv.ON_HAND, inv.HELD]);
    t.ok(`pieces match stock_level ${what}`, bad[0].n === "0", `${bad[0].n} product/location rows disagree`);
  };
  const glBalanced = async (what: string) => {
    const r = await read<{ n: string }>(`select count(*) n from (select je.id from journal_entry je join journal_line jl on jl.journal_entry_id = je.id
      where je.entity_id = $1 and je.source_type = 'inventory' group by je.id having sum(jl.debit_minor) <> sum(jl.credit_minor)) x`, [ENTITY]);
    t.ok(`every inventory journal entry balances ${what}`, r[0].n === "0");
  };
  const lastJe = async (sourceId: string) => read<{ code: string; debit_minor: string; credit_minor: string }>(`
    select g.code, jl.debit_minor, jl.credit_minor from journal_entry je join journal_line jl on jl.journal_entry_id = je.id
      join gl_account g on g.id = jl.gl_account_id where je.entity_id = $1 and je.source_id = $2 order by je.posted_at, jl.seq`, [ENTITY, sourceId]);
  const sideOf = (rows: { code: string; debit_minor: string; credit_minor: string }[], code: string) =>
    rows.filter((r) => r.code === code).reduce((a, r) => a + BigInt(r.debit_minor) - BigInt(r.credit_minor), 0n);

  try {
    await consistent("after the seed");
    const tagged = await read<{ n: string }>(`select count(*) n from inv_piece where entity_id = $1`, [ENTITY]);
    t.ok("every serialized unit in the seed has a label", Number(tagged[0].n) > 50, `${tagged[0].n} pieces`);

    // ----------------------------------------------------- available to promise
    const atp = await R.get(t, `/inventory/atp/${P.SOFA}`) as Awaited<ReturnType<typeof inv.availableToPromise>>;
    t.ok("ATP: Darcy sofa available now across DC and stores", atp.availableNow === 11, `${atp.availableNow}`);
    t.ok("ATP: next purchase order and its ETA", atp.nextPurchaseOrder?.number === "PO-INV-0001" && atp.nextPurchaseOrder.qty === 6 && !!atp.nextPurchaseOrder.expectedOn);
    // The made-to-order accent chair: purchasing's checks order the Hudson sofa for a customer, so it has a PO by now; nothing orders this one.
    const conf = await R.get(t, `/inventory/atp/77777777-0000-0000-0000-000000000026`) as { availableNow: number; nextPurchaseOrder: unknown; promise: string };
    const confPos = await read<{ n: string }>(`select count(*) n from purchase_order_line l join purchase_order po on po.id = l.purchase_order_id
      where po.entity_id = $1 and po.status = 'open' and l.product_id = $2`, [ENTITY, "77777777-0000-0000-0000-000000000026"]);
    t.ok("ATP: a made-to-order sofa with no PO says not available, rather than failing",
      confPos[0].n === "0" && conf.availableNow === 0 && conf.nextPurchaseOrder === null && conf.promise === "not available", JSON.stringify(conf));

    // ----------------------------------------------------------------- receiving
    const before = await level(P.SOFA, DC);
    await t.throws("receiving: sales cannot receive goods", () => R.post(t, MARIA, "/inventory/receiving",
      { purchaseOrderId: PO, locationId: DC, lines: [{ poLineId: POL.SOFA, qty: 1 }] }), /receiving goods needs one of: warehouse, store manager/);
    await t.throws("receiving: more than is left on the line is refused", () => R.post(t, DEE, "/inventory/receiving",
      { purchaseOrderId: PO, locationId: DC, lines: [{ poLineId: POL.SOFA, qty: 7 }] }), /has 6 left to receive, not 7/);
    const r1 = await R.post(t, DEE, "/inventory/receiving", { purchaseOrderId: PO, locationId: DC,
      lines: [{ poLineId: POL.SOFA, qty: 3, damagedQty: 1, damageNote: "Torn arm on carton 1" }] }) as Awaited<ReturnType<typeof inv.receivePurchaseOrder>>;
    const after = await level(P.SOFA, DC);
    t.ok("receiving: partial receipt makes a label per carton", r1.lines[0].labels.length >= 3, r1.lines[0].labels.join(" "));
    t.ok("receiving: on hand up 3, on order down 3, the damaged one held", after.onHand === before.onHand + 3 && after.onOrder === before.onOrder - 3 && after.held === before.held + 1,
      JSON.stringify({ before, after }));
    t.ok("receiving: the PO stays open on a partial", r1.poStatus === "open");
    const gr = await read<{ n: string; q: string }>(`select count(*) n, sum(gl.quantity)::text q from goods_receipt gr join purchase_order po on po.id = gr.purchase_order_id
      join goods_receipt_line gl on gl.goods_receipt_id = gr.id where po.entity_id = $1 and po.id = $2`, [ENTITY, PO]);
    t.ok("receiving: writes goods_receipt and goods_receipt_line", gr[0].n === "1" && Number(gr[0].q) === 3);
    const dmgRcv = await read<{ n: string }>(`select count(*) n from inv_damage where entity_id = $1 and source = 'receiving' and status = 'open'`, [ENTITY]);
    t.ok("receiving: a unit that arrives damaged opens a damage record", dmgRcv[0].n === "1");
    const inRcv = await read<{ n: string }>(`select count(*) n from inv_piece where entity_id = $1 and label = any($2) and bin_id = $3`, [ENTITY, r1.lines[0].labels, BIN.RCV]);
    t.ok("receiving: good pieces land in the dock's receiving bin", Number(inRcv[0].n) >= 2);
    await consistent("after a partial receipt");
    const r2 = await R.post(t, DEE, "/inventory/receiving", { purchaseOrderId: PO, locationId: DC,
      lines: [{ poLineId: POL.SOFA, qty: 3 }, { poLineId: POL.BED, qty: 4 }, { poLineId: POL.MAT, qty: 10 }] }) as { poStatus: string };
    t.ok("receiving: the last of every line closes the PO", r2.poStatus === "received");
    await t.throws("receiving: a received PO takes nothing more", () => R.post(t, DEE, "/inventory/receiving",
      { purchaseOrderId: PO, locationId: DC, lines: [{ poLineId: POL.SOFA, qty: 1 }] }), /is received, not open/);
    const atp2 = await inv.availableToPromise(c0, ENTITY, P.SOFA);
    // Other modules' checks may leave their own open POs for the sofa; the received one must drop out, and any next one is still open with something left.
    const stillOpen = await read<{ number: string }>(`select po.number from purchase_order po join purchase_order_line l on l.purchase_order_id = po.id
      where po.entity_id = $1 and po.status = 'open' and l.product_id = $2 and po.id <> $3
        and l.quantity - coalesce(l.cancelled_qty, 0) > coalesce((select sum(g.quantity) from goods_receipt_line g where g.purchase_order_line_id = l.id), 0)`, [ENTITY, P.SOFA, PO]);
    t.ok("ATP: once received there is no next PO", atp2.nextPurchaseOrder?.number !== "PO-INV-0001"
      && (stillOpen.length ? stillOpen.some((x) => x.number === atp2.nextPurchaseOrder?.number) : atp2.nextPurchaseOrder === null), JSON.stringify(atp2.nextPurchaseOrder));
    await consistent("after the PO is fully received");

    // ------------------------------------------------------- receiving calendar
    const plus5 = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await R.post(t, DEE, "/inventory/appointments", { locationId: DC, day: plus5, expectedPieces: 100, carrier: "Coaster" });
    await t.throws("calendar: a booking over the dock's daily piece limit is refused", () => R.post(t, DEE, "/inventory/appointments",
      { locationId: DC, day: plus5, expectedPieces: 10 }), /already has 120 of 120 pieces booked/);
    await t.throws("calendar: a day in the past is refused", () => R.post(t, DEE, "/inventory/appointments",
      { locationId: DC, day: "2020-01-01", expectedPieces: 5 }), /that day has passed/);

    // ----------------------------------------------------------------- transfers
    const rcDc0 = await level(P.RECLINER, DC), rcPal0 = await level(P.RECLINER, LOC.PALESTINE);
    const tr = await R.post(t, DEE, "/inventory/transfers", { fromId: DC, toId: LOC.PALESTINE, lines: [{ productId: P.RECLINER, qty: 2 }] }) as { id: string; number: string };
    const sh = await R.post(t, DEE, `/inventory/transfers/${tr.id}/ship`) as { valueMinor: bigint };
    const rcDc1 = await level(P.RECLINER, DC);
    const transit = await read<{ n: string }>(`select count(*) n from inv_piece where entity_id = $1 and transfer_id = $2 and status = 'in_transit'`, [ENTITY, tr.id]);
    t.ok("transfer: shipping takes stock off the origin and puts its pieces in transit", rcDc1.onHand === rcDc0.onHand - 2 && Number(transit[0].n) === 2);
    const jeShip = await lastJe(tr.id);
    t.ok("transfer: shipping posts Dr 1310 Cr 1300 at cost", sideOf(jeShip, "1310") === 58000n && sideOf(jeShip, "1300") === -58000n && sh.valueMinor === 58000n);
    await t.throws("transfer: cannot ship twice", () => R.post(t, DEE, `/inventory/transfers/${tr.id}/ship`), /is in transit, so it cannot ship/);
    await R.post(t, DEE, `/inventory/transfers/${tr.id}/receive`);
    const rcPal1 = await level(P.RECLINER, LOC.PALESTINE);
    t.ok("transfer: receiving lands the stock at the destination", rcPal1.onHand === rcPal0.onHand + 2);
    const jeAll = await lastJe(tr.id);
    t.ok("transfer: after receipt in-transit nets to zero", sideOf(jeAll, "1310") === 0n && sideOf(jeAll, "1300") === 0n);
    const big = await R.post(t, DEE, "/inventory/transfers", { fromId: DC, toId: LOC.ENOLA, lines: [{ productId: P.LAMP, qty: 500 }] }) as { id: string };
    await t.throws("transfer: cannot ship more than is available", () => R.post(t, DEE, `/inventory/transfers/${big.id}/ship`), /available at the origin, 500 on the transfer/);
    await t.throws("transfer: a transfer to the same place is refused", () => R.post(t, DEE, "/inventory/transfers",
      { fromId: DC, toId: DC, lines: [{ productId: P.LAMP, qty: 1 }] }), /two different locations/);
    await consistent("after a transfer");

    // ---------------------------------------- allocation, pick list, fulfilment
    const order = await asPerson(PEOPLE.STEVE, async (c) => {
      const so = (await t.q<{ id: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, status, fulfillment, ship_address_id)
        values ($1, 'INVTEST-1', 'phone', $2, '88888888-0000-0000-0000-000000000001', 'open', 'delivery',
                (select id from customer_address where entity_id = $1 and customer_id = '88888888-0000-0000-0000-000000000001')) returning id`, [ENTITY, LOC.ENOLA]))[0];
      const ln = (await t.q<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, fulfil_from_id)
        values ($1,$2,1,$3,'ASH-B192-31','Willowton Dresser',1,54999,$4) returning id`, [ENTITY, so.id, P.DRESSER, DC]))[0];
      const ln2 = (await t.q<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, fulfil_from_id)
        values ($1,$2,2,$3,'ACC-LAMP-01','Ceramic table lamp',2,5999,$4) returning id`, [ENTITY, so.id, P.LAMP, DC]))[0];
      const r = await inv.reserveOrder(c, ENTITY, so.id);
      return { id: so.id, line: ln.id, lampLine: ln2.id, r };
    });
    t.ok("reserve: both stock lines reserved", order.r.reserved === 2 && order.r.shortLines === 0);
    const dr0 = await level(P.DRESSER, DC);
    const wrong = (await read<{ label: string }>(`select label from inv_piece where entity_id = $1 and product_id = $2 and location_id = $3 and status = 'in_stock' limit 1`,
      [ENTITY, P.SOFA, DC]))[0].label;
    await t.throws("allocate: a piece of another product is refused", () => R.post(t, DEE, "/inventory/allocate", { label: wrong, lineId: order.line }), /different product/);
    const pick = await R.post(t, DEE, "/inventory/pick-list", { orderIds: [order.id] }) as Awaited<ReturnType<typeof inv.pickListFor>>;
    const dl = pick.lines.find((l) => l.lineId === order.line)!;
    t.ok("pick list: allocates a dresser piece and says which bin", dl.pieces.length >= 1 && dl.short === 0 && !!dl.pieces[0].bin, JSON.stringify(dl.pieces[0]));
    t.ok("pick list: the lamp line shows its bins", (pick.lines.find((l) => l.lineId === order.lampLine)?.bins.length ?? 0) >= 1);
    t.ok("pick list: totals cube and weight for the truck", pick.cubicFt > 0 && pick.weightLb > 0);
    const label = dl.pieces[0].label;
    const s1 = await R.get(t, `/inventory/scan/${label}`) as { piece: { status: string; order_number: string }; actions: string[] };
    t.ok("scan: shows the piece reserved to its order with pick next", s1.piece.status === "reserved" && s1.piece.order_number === "INVTEST-1" && s1.actions.includes("pick"));
    await t.throws("scan: warehouse cannot write a piece off", () => R.post(t, DEE, `/inventory/pieces/${label}/write_off`), /needs one of: store manager/);
    await t.throws("scan: an action the status does not allow is refused", () => R.post(t, DEE, `/inventory/pieces/${label}/repair`), /reserved cannot repair/);
    await R.post(t, DEE, `/inventory/pieces/${label}/pick`);
    await R.post(t, DEE, `/inventory/pieces/${label}/load`);
    const s2 = await inv.scan(c0, ENTITY, label);
    t.ok("scan: pick then load moves the piece along and logs both", s2.piece.status === "loaded" && s2.history.filter((h) => ["pick", "load"].includes(h.kind)).length === 2);
    await asPerson(PEOPLE.STEVE, (c) => inv.fulfilLines(c, ENTITY, order.id, [order.line]));
    const dr1 = await level(P.DRESSER, DC);
    const s3 = await inv.scan(c0, ENTITY, label);
    t.ok("fulfil: on hand and reserved both down one, the piece delivered", dr1.onHand === dr0.onHand - 1 && dr1.reserved === dr0.reserved - 1 && s3.piece.status === "delivered");
    await consistent("after delivery");
    await asPerson(PEOPLE.STEVE, (c) => inv.restock(c, ENTITY, P.DRESSER, DC, 1, { lineIds: [order.line], binId: BIN.A011 }));
    const s4 = await inv.scan(c0, ENTITY, label);
    t.ok("restock: the same labelled piece comes back to stock", s4.piece.status === "in_stock" && s4.piece.bin === "A-01-1");
    t.ok("restock: on hand back up", (await level(P.DRESSER, DC)).onHand === dr0.onHand);
    await asPerson(PEOPLE.STEVE, (c) => inv.releaseLines(c, ENTITY, order.id, [order.lampLine]));
    t.ok("release: a cancelled line gives its reservation back", (await level(P.LAMP, DC)).reserved === 0);
    await consistent("after a return");

    // ------------------------------------------------------- damage and claims
    const ls = (await read<{ label: string }>(`select label from inv_piece where entity_id = $1 and product_id = $2 and location_id = $3 and status = 'in_stock' order by label limit 2`,
      [ENTITY, P.LOVESEAT, DC])).map((x) => x.label);
    const lv0 = await level(P.LOVESEAT, DC);
    await t.throws("damage: needs a description", () => R.post(t, DEE, "/inventory/damage", { label: ls[0] }), /say what is wrong/);
    const d1 = await R.post(t, DEE, "/inventory/damage", { label: ls[0], description: "Scuffed leg", photoUrls: ["https://example.com/p1.jpg"] }) as { damageId: string };
    const lv1 = await level(P.LOVESEAT, DC);
    t.ok("damage: the unit is held, so available drops but on hand does not", lv1.held === lv0.held + 1 && lv1.onHand === lv0.onHand);
    await t.throws("damage: photo links must be https", () => R.post(t, DEE, "/inventory/damage", { label: ls[1], description: "x", photoUrls: ["javascript:alert(1)"] }), /https/);
    await R.post(t, DEE, `/inventory/damage/${d1.damageId}/repair`);
    await R.post(t, DEE, `/inventory/damage/${d1.damageId}/resolve`, { resolution: "restocked", note: "Touched up" });
    t.ok("damage: repaired and restocked puts it back on sale", (await level(P.LOVESEAT, DC)).held === lv0.held && (await inv.scan(c0, ENTITY, ls[0])).piece.status === "in_stock");
    const d2 = await R.post(t, DEE, "/inventory/damage", { label: ls[1], description: "Frame cracked", source: "warehouse" }) as { damageId: string };
    const cl = await R.post(t, DEE, `/inventory/damage/${d2.damageId}/claim`, { amount: "330.00", vendorRef: "RA-5521", photoUrls: ["https://example.com/c.jpg"] }) as { id: string; number: string };
    t.ok("claim: opens against the product's vendor, piece on vendor claim", (await inv.scan(c0, ENTITY, ls[1])).piece.status === "vendor_claim");
    await t.throws("claim: crediting needs the amount and how it was settled", () => R.post(t, MGR, `/inventory/claims/${cl.id}`, { status: "credited" }), /say how the vendor settled/);
    await R.post(t, MGR, `/inventory/claims/${cl.id}`, { status: "credited", credit: "330.00", resolution: "Full credit memo CM-88" });
    await t.throws("claim: a closed claim does not move", () => R.post(t, MGR, `/inventory/claims/${cl.id}`, { status: "approved" }), /is closed/);
    await t.throws("damage: warehouse cannot write stock off", () => R.post(t, DEE, `/inventory/damage/${d2.damageId}/resolve`,
      { resolution: "returned_to_vendor", note: "Picked up by Ashley" }), /needs one of: store manager/);
    const lvA = await level(P.LOVESEAT, DC);
    const res = await R.post(t, MGR, `/inventory/damage/${d2.damageId}/resolve`, { resolution: "returned_to_vendor", note: "Picked up by Ashley" }) as { journalEntryId: string };
    const lvB = await level(P.LOVESEAT, DC);
    t.ok("damage: returned to vendor leaves stock and the hold", lvB.onHand === lvA.onHand - 1 && lvB.held === lvA.held - 1);
    const jeD = await lastJe(d2.damageId);
    t.ok("damage: leaving stock posts Dr 5040 Cr 1300 at cost", !!res.journalEntryId && sideOf(jeD, "5040") === 33000n && sideOf(jeD, "1300") === -33000n);
    const lamp0 = await level(P.LAMP, LOC.ENOLA);
    await R.post(t, DEE, "/inventory/damage", { productId: P.LAMP, locationId: LOC.ENOLA, qty: 2, description: "Shades crushed" });
    t.ok("damage: a non-serialized quantity can be held too", (await level(P.LAMP, LOC.ENOLA)).held === lamp0.held + 2);
    await consistent("after damage, repair and a claim");

    // -------------------------------------------------------------- cycle counts
    const ct = await R.post(t, DEE, "/inventory/counts", { locationId: DC, binId: BIN.A011 }) as { id: string; number: string };
    const sheet = await R.get(t, `/inventory/counts/${ct.id}`) as { lines: { product_id: string; serialized: boolean; expected_qty: string; expected_labels: string[] }[] };
    const ser = sheet.lines.find((l) => l.serialized && Number(l.expected_qty) >= 2)!;
    t.ok("count: the sheet lists what the bin should hold, with labels", !!ser && ser.expected_labels.length >= 2);
    // Everything found but one unit of one product.
    const pieceUnits = await read<{ unit_id: string; labels: string[] }>(`select unit_id, array_agg(label) labels from inv_piece where entity_id = $1 and label = any($2) group by unit_id`,
      [ENTITY, ser.expected_labels]);
    const missingUnit = pieceUnits[0];
    const scanned = ser.expected_labels.filter((x) => !missingUnit.labels.includes(x));
    await t.throws("count: every line needs a count before it is submitted", () => R.post(t, DEE, `/inventory/counts/${ct.id}/submit`,
      { lines: [{ productId: ser.product_id, scannedLabels: scanned }] }), sheet.lines.length > 1 ? /still needs? a count/ : /./);
    const subm = await R.post(t, DEE, `/inventory/counts/${ct.id}/submit`, { lines: sheet.lines.map((l) =>
      l.product_id === ser.product_id ? { productId: l.product_id, scannedLabels: scanned } : { productId: l.product_id, countedQty: Number(l.expected_qty) }) }) as { varianceMinor: bigint };
    t.ok("count: submitted with a one-unit shortfall valued at cost", subm.varianceMinor < 0n, String(subm.varianceMinor));
    await t.throws("count: warehouse cannot approve a count", () => R.post(t, DEE, `/inventory/counts/${ct.id}/decide`, { approve: true }), /approving a count needs one of: store manager/);
    // The manager makes and submits one of their own, and cannot approve it.
    const own = await R.post(t, MGR, "/inventory/counts", { locationId: LOC.ENOLA, binId: BIN.BK01 }) as { id: string };
    const ownSheet = await R.get(t, `/inventory/counts/${own.id}`) as { lines: { product_id: string; expected_qty: string }[] };
    await R.post(t, MGR, `/inventory/counts/${own.id}/submit`, { lines: ownSheet.lines.map((l) => ({ productId: l.product_id, countedQty: Number(l.expected_qty) + 1 })) });
    await t.throws("count: the maker is never the checker", () => R.post(t, MGR, `/inventory/counts/${own.id}/decide`, { approve: true }), /made or submitted a count cannot also approve/);
    const shortProduct = ser.product_id;
    const sp0 = await level(shortProduct, DC);
    const dec = await R.post(t, PEOPLE.STEVE, `/inventory/counts/${ct.id}/decide`, { approve: true, note: "Recount agreed" }) as { varianceMinor: bigint; journalEntryId: string };
    const sp1 = await level(shortProduct, DC);
    t.ok("count: approval writes off the unit that was not found", sp1.onHand === sp0.onHand - 1 && (await inv.scan(c0, ENTITY, missingUnit.labels[0])).piece.status === "written_off");
    const jeC = await lastJe(ct.id);
    t.ok("count: the shortfall posts Dr 5040 Cr 1300", sideOf(jeC, "5040") === -dec.varianceMinor && sideOf(jeC, "1300") === dec.varianceMinor);
    const ownDec = await R.post(t, PEOPLE.STEVE, `/inventory/counts/${own.id}/decide`, { approve: true }) as { varianceMinor: bigint };
    const jeO = await lastJe(own.id);
    t.ok("count: an overage posts Dr 1300 Cr 5040", ownDec.varianceMinor > 0n && sideOf(jeO, "1300") === ownDec.varianceMinor);
    await consistent("after counts");

    // ---------------------------------------------------------------- adjustments
    await t.throws("adjust: warehouse cannot adjust stock value", () => R.post(t, DEE, "/inventory/adjustments",
      { locationId: LOC.ENOLA, productId: P.LAMP, qty: -1, reasonCode: "theft" }), /adjusting stock needs one of: store manager/);
    await t.throws("adjust: 'other' needs a note", () => R.post(t, MGR, "/inventory/adjustments",
      { locationId: LOC.ENOLA, productId: P.LAMP, qty: -1, reasonCode: "other" }), /say what the adjustment is for/);
    await t.throws("adjust: a serialized write-down names the pieces", () => R.post(t, MGR, "/inventory/adjustments",
      { locationId: DC, productId: P.SOFA, qty: -1, reasonCode: "lost" }), /name the Darcy Sofa pieces/);
    const la0 = await level(P.LAMP, LOC.ENOLA);
    const adj = await R.post(t, MGR, "/inventory/adjustments", { locationId: LOC.ENOLA, productId: P.LAMP, qty: -1, reasonCode: "theft", note: "Missing after event" }) as { id: string; valueMinor: bigint };
    t.ok("adjust: on hand down and valued at cost", (await level(P.LAMP, LOC.ENOLA)).onHand === la0.onHand - 1 && adj.valueMinor === -1900n);
    const jeA = await lastJe(adj.id);
    t.ok("adjust: posts Dr 5040 Cr 1300", sideOf(jeA, "5040") === 1900n);
    const found = await R.post(t, MGR, "/inventory/adjustments", { locationId: DC, productId: P.SOFA, qty: 1, reasonCode: "found", binId: BIN.A011 }) as { labels: string[] };
    t.ok("adjust: a found serialized unit gets new labels", found.labels.length >= 1);
    await consistent("after adjustments");

    // --------------------------------------------------------- non-serialized bins
    await R.post(t, DEE, "/inventory/move-qty", { productId: P.CHAIRS, fromBinId: BIN.B02, toBinId: "99991111-0000-0000-0000-000000000005", qty: 2 });
    const bins = await read<{ code: string; qty: string }>(`select b.code, s.qty from inv_bin_stock s join inv_bin b on b.id = s.bin_id
       where s.entity_id = $1 and s.product_id = $2 order by b.code`, [ENTITY, P.CHAIRS]);
    t.ok("bins: non-serialized stock moves between bins", bins.some((b) => b.code === "B-01" && Number(b.qty) === 2));
    await t.throws("bins: cannot move more than the bin holds", () => R.post(t, DEE, "/inventory/move-qty",
      { productId: P.CHAIRS, fromBinId: BIN.B02, toBinId: "99991111-0000-0000-0000-000000000005", qty: 99 }), /does not hold that many/);

    // ---------------------------------------------------------------- valuation
    const val = await R.get(t, "/inventory/valuation") as { totalMinor: bigint };
    const direct = await read<{ v: string }>(`select sum(round(s.on_hand * p.cost_minor))::bigint::text v from stock_level s join product p on p.id = s.product_id where s.entity_id = $1`, [ENTITY]);
    t.ok("valuation: by location and category adds up to on hand at cost", BigInt(val.totalMinor) === BigInt(direct[0].v));
    await glBalanced("");

    // -------------------------------------------------------------- immutability
    await t.throws("history: a movement row cannot be edited", () => tx({ kind: "system", label: "test" }, (c) =>
      c.query(`update inv_move set qty = 5 where entity_id = $1`, [ENTITY])), /never edited or deleted/);

    // ----------------------------------------------------------------- isolation
    const rio = await companyOf(RIO_ENTITY);
    const rioScope: Scope = { tenantId: rio.tenantId, entityId: RIO_ENTITY, actor: { kind: "user", id: PEOPLE.STEVE, label: "test" } };
    await t.throws("isolation: another company cannot scan this company's label", () => inv.scan(c0, RIO_ENTITY, label), /no piece is labelled/);
    await t.throws("isolation: another company cannot receive this company's PO", () => tx(rioScope.actor, (c) =>
      inv.receivePurchaseOrder(c, rioScope, { purchaseOrderId: PO, locationId: DC, lines: [{ poLineId: POL.SOFA, qty: 1 }] })), /no such purchase order/);
    const rioVal = await inv.valuation(c0, RIO_ENTITY);
    t.ok("isolation: another company's valuation holds none of this stock", rioVal.rows.length === 0 && rioVal.totalMinor === 0n);
    const rioOpen = await inv.openPurchaseOrders(c0, RIO_ENTITY);
    t.ok("isolation: another company sees none of these purchase orders", rioOpen.length === 0);
  } finally {
    c0.release();
  }
}
