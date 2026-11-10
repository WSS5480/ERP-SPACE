// Group accounting: two companies under the demo client. Sibling links made
// on demand; the role refusals (owner, or a controller in every company
// covered); a same-company transfer untouched; a cross-company transfer and a
// service charge each making a sales invoice and a matching bill with
// balanced books on both sides, inventory at cost out and transfer price in;
// the consolidation (combined = sum of the companies less eliminations, the
// inter-company accounts eliminated to zero); the net-to-zero check flagging
// a one-sided entry and settle clearing it; the history frozen; the group
// ledger dataset in the report builder, role-checked and isolated.
import { type T, ENTITY, RIO_ENTITY, PEOPLE } from "./harness.ts";
import { tx, q, type Client } from "../../packages/core/db.ts";
import { module as groupModule } from "../../server/modules/group.ts";
import { module as inventoryModule } from "../../server/modules/inventory.ts";
import { routes, asPerson } from "./catalog.ts";
import { createPaymentRun } from "../../server/actions.ts";
import { paymentRuns } from "../../server/views.ts";
import * as inv from "../../packages/core/inventory.ts";
import * as ar from "../../packages/core/ar.ts";
import * as rep from "../../packages/core/reports.ts";
import { PACKS, MODULE_IDS } from "../../packages/core/setup.ts";
import { IC_CODES } from "../../packages/core/group.ts";

const TX = "a2a2a2a2-2222-2222-2222-222222222222";
const TYL = "a2a2a2a2-0000-0000-0000-000000000001";
const DC = "33333333-0000-0000-0000-0000000000dc";
const ENOLA = "33333333-0000-0000-0000-000000000001";
const RIO_YARD = "eeee0000-0000-0000-0000-000000000101";
const TINA = "55555555-0000-0000-0000-000000000041";    // controller in Texas only
const DEE = "55555555-0000-0000-0000-000000000013";     // warehouse
const RIO_OWNER = "eeee0000-0000-0000-0000-000000000201";
const B = (v: unknown) => BigInt(String(v ?? "0"));
const bps = (m: bigint, r: number) => (m * BigInt(r) + 5000n) / 10000n;

type Fn = (...a: unknown[]) => Promise<unknown>;
/** The group module's routes, called as the server calls them, for either company. */
function grp(t: T) {
  const gets = new Map<string, Fn>(), posts = new Map<string, Fn>();
  groupModule.register({ coGet: (tail: string, fn: Fn) => gets.set(tail, fn), coPost: (tail: string, fn: Fn) => posts.set(tail, fn), publicRoute: () => {} } as never);
  return {
    post: <R = Record<string, unknown>>(tail: string, who: string, body: Record<string, unknown>, entityId = ENTITY) =>
      asPerson(t, who, (c, co, a) => posts.get(tail)!(c, co, a, body, ["", co.id]) as Promise<R>, entityId),
    get: async <R = Record<string, unknown>>(tail: string, who: string | null, query = "", entityId = ENTITY): Promise<R> => {
      const c = await t.pool.connect();
      try {
        const co = (await asPerson(t, PEOPLE.STEVE, async (_c, x) => x, entityId));
        return await gets.get(tail)!(c, co, new URL("http://x/?" + query), ["", co.id], who) as R;
      } finally { c.release(); }
    },
  };
}

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = await t.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};
/** A check's own query; several span both companies (entity_id = any(...)), and say so. */
const sql = <R extends Record<string, unknown>>(t: T, text: string, p: unknown[] = []) =>
  read(t, (c) => q<R>(c, /entity_id = any\(/.test(text) ? `${text} /* unscoped: a check reading both companies of the client */` : text, p));

/** Debits and credits of one journal entry, by account code. */
async function entry(t: T, id: string) {
  const rows = await sql<{ code: string; dr: string; cr: string; bank: string | null }>(t, `
    select g.code, sum(jl.debit_minor)::text dr, sum(jl.credit_minor)::text cr, max(jl.bank_account_id::text) bank
      from journal_line jl join gl_account g on g.id = jl.gl_account_id join journal_entry je on je.id = jl.journal_entry_id
     where jl.journal_entry_id = $1 group by g.code /* unscoped: one entry by id */`, [id]);
  const dr = rows.reduce((a, r) => a + B(r.dr), 0n), cr = rows.reduce((a, r) => a + B(r.cr), 0n);
  const by = (code: string) => ({ dr: B(rows.find((r) => r.code === code)?.dr), cr: B(rows.find((r) => r.code === code)?.cr) });
  return { balanced: dr === cr && dr > 0n, by, rows };
}

const glBal = (t: T, entityId: string, code: string) => read(t, (c) => ar.glBalance(c, entityId, code, "2999-12-31"));
const onHand = async (t: T, entityId: string, sku: string, loc: string) => Number((await sql<{ n: string }>(t, `
  select coalesce(sum(s.on_hand), 0)::text n from stock_level s join product p on p.id = s.product_id where s.entity_id = $1 and p.sku = $2 and s.location_id = $3`,
  [entityId, sku, loc]))[0].n);

export async function run(t: T) {
  const g = grp(t);
  const inventory = routes(t, inventoryModule);

  // ------------------------------------------------------------ the set-up
  t.ok("setup: group is a module", (MODULE_IDS as readonly string[]).includes("group"));
  t.ok("setup: every pack carries the four inter-company accounts", PACKS.every((p) => IC_CODES.every((code) => p.accounts.some((a) => a[0] === code))));
  const clash = PACKS.flatMap((p) => p.accounts).filter((a) => IC_CODES.includes(a[0]) && !/related companies|Inter-company/.test(a[1]));
  t.ok("setup: the inter-company codes are not used for anything else in any pack", !clash.length, JSON.stringify(clash[0] ?? ""));
  const chartIc = await sql<{ code: string; name: string }>(t, `select code, name from gl_account where tenant_id = $1 and code = any($2) /* unscoped: the chart */`,
    ["11111111-1111-1111-1111-111111111111", IC_CODES]);
  t.ok("setup: the demo chart has 1195, 2190, 4090 and 5090", chartIc.length === 4, chartIc.map((x) => x.code).join(","));
  const used = await sql<{ n: string }>(t, `select count(*)::text n from entity_gl_account x join gl_account g on g.id = x.gl_account_id
     where x.entity_id = any($1) and g.code = any($2) and x.active`, [[ENTITY, TX], IC_CODES]);
  t.ok("setup: both demo companies use them", Number(used[0].n) === 8, used[0].n);

  // ------------------------------------------------------------ roles
  await t.throws("roles: an AP clerk cannot open the group view", () => g.get("/group/view", PEOPLE.CLERK), /owner, or a controller in every company/);
  await t.throws("roles: a controller in only one company cannot see both", () => g.get("/group/view", TINA, "", TX), /not a controller in Demo Furniture Co/);
  await t.throws("roles: nobody named, no group view", () => g.get("/group/view", null), /named person/);
  const tinaView = await g.get<{ companies: { id: string }[] }>("/group/view", TINA, `companies=${TX}`, TX);
  t.ok("roles: she can see the company she controls on its own", tinaView.companies.length === 1 && tinaView.companies[0].id === TX);
  const ctlView = await g.get<{ companies: unknown[] }>("/group/view", PEOPLE.CONTROLLER);
  t.ok("roles: a controller in every company sees the whole group", ctlView.companies.length === 2);
  const steveView = await g.get<{ companies: unknown[] }>("/group/view", PEOPLE.STEVE);
  t.ok("roles: the owner sees the whole group", steveView.companies.length === 2);
  const tinaOverview = await g.get<{ viewable: unknown[] }>("/group", TINA, "", TX);
  t.ok("roles: the overview lists only what the person may see", tinaOverview.viewable.length === 1);

  // ------------------------------------------------------------ sibling links
  const l0 = await g.get<{ links: { complete: boolean } }>("/group", PEOPLE.STEVE);
  t.ok("links: none before first use", !l0.links.complete);
  await t.throws("links: an AP clerk cannot link the companies", () => g.post("/group/links", PEOPLE.CLERK, {}), /owner, or a controller/);
  const made = await g.post<{ customers: number; vendors: number; vendorLinks: number }>("/group/links", PEOPLE.CONTROLLER, {});
  t.ok("links: each company becomes a customer and a vendor of the other", made.customers === 2 && made.vendors === 2 && made.vendorLinks === 2, JSON.stringify(made));
  const again = await g.post<{ customers: number; vendors: number; vendorLinks: number }>("/group/links", PEOPLE.STEVE, {});
  t.ok("links: linking again adds nothing", again.customers === 0 && again.vendors === 0 && again.vendorLinks === 0);
  const custTx = (await sql<{ id: string; kind: string; name: string }>(t, `select id, kind, name from customer where entity_id = $1 and related_entity_id = $2`, [ENTITY, TX]))[0];
  const vendTx = (await sql<{ id: string }>(t, `select v.id from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $1 where v.related_entity_id = $2`, [ENTITY, TX]))[0];
  t.ok("links: the Texas company is a business customer of Demo and a vendor set up in Demo", custTx?.kind === "business" && custTx.name === "Demo Furniture Texas, LLC" && !!vendTx);
  await t.throws("database: a company is never its own customer", () => tx({ kind: "system", label: "check" }, (c) =>
    c.query(`insert into customer (entity_id, number, name, related_entity_id) values ($1,'X-1','Me',$1)`, [ENTITY])), /customer_not_itself/);

  // ------------------------------------------------------------ same-company transfer: unchanged
  const pick = (await sql<{ sku: string; id: string; cost: string }>(t, `
    select p.sku, p.id, p.cost_minor::text cost from stock_level s join product p on p.id = s.product_id
     where s.entity_id = $1 and s.location_id = $2 and not p.serialized and p.kind = 'stock' and s.on_hand - s.reserved - s.held >= 4
     order by s.on_hand desc, p.sku limit 1`, [ENTITY, DC]))[0];
  const docs0 = Number((await sql<{ n: string }>(t, `select count(*)::text n from ic_document where from_entity_id = $1 or to_entity_id = $1`, [ENTITY]))[0].n);
  const same = await inventory.post<{ id: string; number: string }>("/inventory/transfers", DEE, { fromId: DC, toId: ENOLA, lines: [{ productId: pick.id, qty: 1 }] });
  const shipped = await inventory.post<{ number: string; valueMinor: bigint; document?: unknown }>("/inventory/transfers/:id/ship", DEE, {}, same.id);
  const st0 = (await sql<{ status: string; to_entity_id: string | null }>(t, `select status, to_entity_id from inv_transfer where id = $1 and entity_id = $2`, [same.id, ENTITY]))[0];
  const je0 = (await sql<{ id: string }>(t, `select id from journal_entry where entity_id = $1 and source_type = 'inventory' and source_id = $2`, [ENTITY, same.id]))[0];
  const e0 = await entry(t, je0.id);
  t.ok("same company: the transfer ships into transit as before (Dr 1310, Cr 1300), with no inter-company document",
    st0.status === "in_transit" && !st0.to_entity_id && shipped.document === undefined && e0.balanced && e0.by("1310").dr === B(shipped.valueMinor) && e0.by("1300").cr === B(shipped.valueMinor));
  await inventory.post("/inventory/transfers/:id/receive", DEE, {}, same.id);
  const docs1 = Number((await sql<{ n: string }>(t, `select count(*)::text n from ic_document where from_entity_id = $1 or to_entity_id = $1`, [ENTITY]))[0].n);
  t.ok("same company: received as before, and still no inter-company document", docs1 === docs0);
  await t.throws("transfer: a location of another client is not a destination", () =>
    inventory.post("/inventory/transfers", DEE, { fromId: DC, toId: RIO_YARD, lines: [{ productId: pick.id, qty: 1 }] }), /pick two of this company's locations/);

  // ------------------------------------------------------------ settings
  await t.throws("settings: a controller of one company cannot set the group's transfer price", () => g.post("/group/settings", TINA, { basis: "cost_plus", markupPct: 10 }, TX),
    /not a controller in Demo Furniture Co/);
  await t.throws("settings: a markup over 100% is refused", () => g.post("/group/settings", PEOPLE.CONTROLLER, { basis: "cost_plus", markupPct: 150 }), /at most 100%/);
  const set = await g.post<{ basis: string; markupBps: number }>("/group/settings", PEOPLE.CONTROLLER, { basis: "cost_plus", markupPct: 10 });
  t.ok("settings: cost plus 10% saved", set.basis === "cost_plus" && set.markupBps === 1000);

  // ------------------------------------------------------------ cross-company transfer
  const txBefore = await onHand(t, TX, pick.sku, TYL), dcBefore = await onHand(t, ENTITY, pick.sku, DC);
  const across = await inventory.post<{ id: string; number: string }>("/inventory/transfers", DEE, { fromId: DC, toId: TYL, lines: [{ productId: pick.id, qty: 3 }] });
  const sent = await inventory.post<{ number: string; valueMinor: bigint; document: string; documentId: string; amountMinor: bigint; toCompany: string; toTransferNumber: string }>(
    "/inventory/transfers/:id/ship", DEE, {}, across.id);
  const cost = B(sent.valueMinor), price = cost + bps(cost, 1000);
  t.ok("across: shipping to a Texas store makes an inter-company document at cost plus 10%", !!sent.document && sent.toCompany === "Demo Furniture Texas, LLC"
    && B(sent.amountMinor) === price && cost > 0n, `${cost} → ${sent.amountMinor}`);
  const doc = (await sql<{ kind: string; amount_minor: string; cost_minor: string; customer_invoice_id: string; invoice_id: string; from_entry_id: string; to_entry_id: string;
    to_transfer_id: string; status: string }>(t, `select * from ic_document where id = $1 and from_entity_id = $2`, [sent.documentId, ENTITY]))[0];
  const ci = (await sql<{ total_minor: string; status: string; customer_id: string; number: string }>(t,
    `select total_minor, status, customer_id, number from customer_invoice where id = $1 and entity_id = $2`, [doc.customer_invoice_id, ENTITY]))[0];
  const bill = (await sql<{ total_minor: string; status: string; vendor_id: string; reference: string }>(t,
    `select total_minor, status, vendor_id, reference from invoice where id = $1 and entity_id = $2`, [doc.invoice_id, TX]))[0];
  t.ok("across: a sales invoice to the Texas customer in Demo, and a matching bill from the Demo vendor in Texas",
    B(ci.total_minor) === price && ci.status === "open" && ci.customer_id === custTx.id && B(bill.total_minor) === price && bill.status === "approved" && bill.reference === sent.document);
  const se = await entry(t, doc.from_entry_id), re = await entry(t, doc.to_entry_id);
  t.ok("across: the seller's entry balances: Dr 1195 / Cr 4090 at transfer price, Dr 5090 / Cr 1300 at cost",
    se.balanced && se.by("1195").dr === price && se.by("4090").cr === price && se.by("5090").dr === cost && se.by("1300").cr === cost);
  t.ok("across: the buyer's entry balances: Dr 1300 / Cr 2190 at transfer price", re.balanced && re.by("1300").dr === price && re.by("2190").cr === price);
  const sst = (await sql<{ status: string; to_entity_id: string }>(t, `select status, to_entity_id from inv_transfer where id = $1 and entity_id = $2`, [across.id, ENTITY]))[0];
  const rst = (await sql<{ status: string; from_entity_id: string; number: string }>(t, `select status, from_entity_id, number from inv_transfer where id = $1 and entity_id = $2`, [doc.to_transfer_id, TX]))[0];
  t.ok("across: the transfer is done in one step, with a received copy in Texas naming where it came from",
    sst.status === "received" && sst.to_entity_id === TX && rst.status === "received" && rst.from_entity_id === ENTITY && rst.number === sent.toTransferNumber);
  t.ok("across: the stock left the DC and is on hand at Tyler", (await onHand(t, ENTITY, pick.sku, DC)) === dcBefore - 3 && (await onHand(t, TX, pick.sku, TYL)) === txBefore + 3);
  const txProduct = (await sql<{ sku: string; status: string }>(t, `select sku, status from product where entity_id = $1 and sku = $2`, [TX, pick.sku]))[0];
  t.ok("across: the product was copied into the Texas catalog by SKU", txProduct?.sku === pick.sku && txProduct.status === "active");
  const tieDemo = await read(t, (c) => inv.tieOut(c, ENTITY)), tieTx = await read(t, (c) => inv.tieOut(c, TX));
  t.ok("across: inventory ties to the ledger in both companies (out at cost, in at transfer price)", tieDemo.ties && tieTx.ties && tieTx.stockMinor === price,
    `demo ${tieDemo.differenceMinor}, tx ${tieTx.differenceMinor} / ${tieTx.stockMinor}`);
  const aging = await read(t, (c) => ar.aging(c, ENTITY));
  t.ok("across: the receivables aging still ties to 1100 (a sibling's invoice sits in 1195)", aging.differenceMinor === 0n, String(aging.differenceMinor));

  // a serialized one: pieces leave Demo and new labels land in Texas
  const ser = (await sql<{ id: string; sku: string }>(t, `
    select p.id, p.sku from product p where p.entity_id = $1 and p.serialized and p.kind = 'stock'
       and (select count(distinct unit_id) from inv_piece x where x.entity_id = p.entity_id and x.product_id = p.id and x.location_id = $2 and x.status = 'in_stock' and x.sales_order_line_id is null) >= 1
     order by p.sku limit 1`, [ENTITY, DC]))[0];
  if (ser) {
    const s1 = await inventory.post<{ id: string }>("/inventory/transfers", DEE, { fromId: DC, toId: TYL, lines: [{ productId: ser.id, qty: 1 }] });
    const s2 = await inventory.post<{ document: string; documentId: string }>("/inventory/transfers/:id/ship", DEE, {}, s1.id);
    const pcs = await sql<{ n: string }>(t, `select count(*)::text n from inv_piece x join product p on p.id = x.product_id where x.entity_id = $1 and p.sku = $2 and x.location_id = $3 and x.status = 'in_stock'`,
      [TX, ser.sku, TYL]);
    const gone = await sql<{ n: string }>(t, `select count(*)::text n from inv_piece where entity_id = $1 and transfer_id = $2 and status = 'delivered'`, [ENTITY, s1.id]);
    t.ok("across: a serialized unit leaves Demo's pieces and lands in Texas with labels of its own", !!s2.document && Number(pcs[0].n) >= 1 && Number(gone[0].n) >= 1, `${pcs[0].n} / ${gone[0].n}`);
    t.ok("across: both companies still tie after the serialized move", (await read(t, (c) => inv.tieOut(c, ENTITY))).ties && (await read(t, (c) => inv.tieOut(c, TX))).ties);
  } else t.ok("across: a serialized unit to move", false, "no free serialized unit at the DC");

  // a sibling's bill is settled in Group, never in a payment run
  await t.throws("payables: a sibling's bill cannot go in a payment run", () => asPerson(t, PEOPLE.STEVE, (c, co, a) =>
    createPaymentRun(c, co, a, { payDate: new Date().toISOString().slice(0, 10), method: "check", invoiceIds: [doc.invoice_id] }), TX), /settled in Group/);
  const pay = await asPerson(t, PEOPLE.STEVE, (c, co) => paymentRuns(c, co) as Promise<{ eligible?: { id: string }[] }>, TX).catch(() => null);
  t.ok("payables: and it is not offered for one", !pay || !(pay.eligible ?? []).some((x) => x.id === doc.invoice_id));

  // ------------------------------------------------------------ bill a sibling (a service)
  await t.throws("bill: a controller of one company cannot bill across", () => g.post("/group/bill", TINA, { to: ENTITY, description: "Shared staff", amount: "40.00" }, TX),
    /not a controller in Demo Furniture Co/);
  await t.throws("bill: a company does not bill itself", () => g.post("/group/bill", PEOPLE.CONTROLLER, { to: ENTITY, description: "x", amount: "1" }), /pick the company being billed/);
  await t.throws("bill: it says what it is for", () => g.post("/group/bill", PEOPLE.CONTROLLER, { to: TX, description: "", amount: "1" }), /what the charge is for/);
  const charge = await g.post<{ number: string; amountMinor: bigint; fromEntryId: string; toEntryId: string; billId: string }>("/group/bill", PEOPLE.CONTROLLER,
    { to: TX, description: "Delivery for the month, 12 stops", amount: "250.00", toLocationId: TYL });
  const ce = await entry(t, charge.fromEntryId), cr = await entry(t, charge.toEntryId);
  t.ok("bill: the warehouse company charges the store: Dr 1195 / Cr 4090 here, Dr 5090 / Cr 2190 there, both balanced",
    B(charge.amountMinor) === 25000n && ce.balanced && ce.by("1195").dr === 25000n && ce.by("4090").cr === 25000n && cr.balanced && cr.by("5090").dr === 25000n && cr.by("2190").cr === 25000n);
  const back = await g.post<{ amountMinor: bigint }>("/group/bill", PEOPLE.STEVE, { to: ENTITY, description: "Showroom staff lent to Enola", amount: "40.00" }, TX);
  t.ok("bill: and Texas bills Demo the other way (the owner may)", B(back.amountMinor) === 4000n);

  // ------------------------------------------------------------ net to zero
  const expectDemo = price + 25000n - 4000n + (ser ? B((await sql<{ a: string }>(t, `select coalesce(sum(amount_minor),0)::text a from ic_document where from_entity_id = $1 and kind = 'goods' and id <> $2`, [ENTITY, sent.documentId]))[0].a) : 0n);
  type Net = { pairs: { a: { id: string; netMinor: string }; b: { id: string; netMinor: string }; differenceMinor: string; balanced: boolean; openDocuments: number }[];
    ties: { id: string; ties: boolean; untrackedMinor: string }[]; allBalanced: boolean };
  const n1 = await g.get<Net>("/group/net", PEOPLE.CONTROLLER);
  const p1 = n1.pairs[0];
  const demoNet = p1.a.id === ENTITY ? B(p1.a.netMinor) : B(p1.b.netMinor);
  t.ok("net: Demo is owed what Texas owes, and the pair nets to zero", n1.pairs.length === 1 && p1.balanced && demoNet === expectDemo && B(p1.a.netMinor) === -B(p1.b.netMinor),
    `${demoNet} vs ${expectDemo}`);
  t.ok("net: each company's 1195 and 2190 tie to the group's sub-ledger", n1.ties.every((x) => x.ties) && n1.allBalanced);
  t.ok("net: GL agrees: Demo's due from less due to equals Texas's due to less due from",
    (await glBal(t, ENTITY, "1195")) + (await glBal(t, ENTITY, "2190")) === -((await glBal(t, TX, "1195")) + (await glBal(t, TX, "2190"))));
  t.ok("home: nothing to flag while the pair nets to zero", !(await g.get<{ show: boolean }>("/group/home", PEOPLE.CONTROLLER)).show);

  // ------------------------------------------------------------ consolidation
  type Line = { code: string; byCompany: Record<string, string>; sumMinor: string; eliminatedMinor: string; combinedMinor: string };
  type View = { groups: (Line & { id: string; accounts: Line[] })[]; netIncome: Line; eliminations: Record<string, string>;
    balanceCheck: { byCompany: Record<string, string>; combinedMinor: string; balanced: boolean } };
  const today = new Date().toISOString().slice(0, 10);
  const v = await g.get<View>("/group/view", PEOPLE.STEVE, `from=${today}&to=${today}&asOf=${today}`);
  const lines = v.groups.flatMap((x) => x.accounts);
  const badSum = lines.filter((l) => B(l.combinedMinor) !== Object.values(l.byCompany).reduce((a, x) => a + B(x), 0n) - B(l.eliminatedMinor) || B(l.sumMinor) !== Object.values(l.byCompany).reduce((a, x) => a + B(x), 0n));
  t.ok("view: every account's combined total is the companies added together less what is eliminated", lines.length > 10 && !badSum.length, JSON.stringify(badSum[0] ?? ""));
  const badGroup = v.groups.filter((x) => B(x.combinedMinor) !== x.accounts.reduce((a, l) => a + B(l.combinedMinor), 0n)
    || B(x.combinedMinor) !== B(x.sumMinor) - B(x.eliminatedMinor));
  t.ok("view: each account group's totals are its accounts' totals", !badGroup.length, badGroup.map((x) => x.id).join(","));
  const ni = v.netIncome;
  const g0 = (id: string) => v.groups.find((x) => x.id === id)!;
  t.ok("view: combined net income is the companies' net income less the eliminations",
    B(ni.combinedMinor) === B(ni.sumMinor) - B(ni.eliminatedMinor) && B(ni.combinedMinor) === B(g0("revenue").combinedMinor) - B(g0("cost").combinedMinor) - B(g0("opex").combinedMinor) - B(g0("other").combinedMinor));
  const icLeft = lines.filter((l) => IC_CODES.includes(l.code) && B(l.combinedMinor) !== 0n);
  t.ok("view: eliminations zero out 1195, 2190, 4090 and 5090 in the combined total", !icLeft.length && lines.filter((l) => IC_CODES.includes(l.code)).length === 4,
    icLeft.map((l) => `${l.code}=${l.combinedMinor}`).join(" "));
  // The companies' own figures are the ledger's, independently summed.
  const raw = await sql<{ entity_id: string; code: string; n: string }>(t, `
    select je.entity_id, g.code, sum(case when g.account_type in ('revenue','liability','equity') then jl.credit_minor - jl.debit_minor else jl.debit_minor - jl.credit_minor end)::text n
      from journal_line jl join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id
     where je.entity_id = any($1) and g.code in ('4000','4090','1300','1195') and (g.account_type not in ('revenue','expense') or je.posting_date = current_date)
     group by 1, 2`, [[ENTITY, TX]]);
  const mismatch = raw.filter((r) => B(lines.find((l) => l.code === r.code)?.byCompany[r.entity_id]) !== B(r.n));
  t.ok("view: each company's column is its own ledger", raw.length >= 5 && !mismatch.length, JSON.stringify(mismatch[0] ?? ""));
  const docsToday = await sql<{ sales: string; margin: string }>(t, `select coalesce(sum(amount_minor),0)::text sales,
      coalesce(sum(case when kind = 'goods' then amount_minor - cost_minor else 0 end),0)::text margin from ic_document where from_entity_id = any($1) and to_entity_id = any($1)`, [[ENTITY, TX]]);
  t.ok("view: the inter-company sales eliminated are the documents' total, and the margin comes out of inventory and net income",
    B(v.eliminations.salesMinor) === B(docsToday[0].sales) && B(v.eliminations.marginInStockMinor) === B(docsToday[0].margin) && B(ni.eliminatedMinor) === B(docsToday[0].margin)
      && B(docsToday[0].margin) > 0n && B(lines.find((l) => l.code === "1300")!.eliminatedMinor) === B(docsToday[0].margin));
  t.ok("view: every company's balance sheet balances, and so does the combined one", Object.values(v.balanceCheck.byCompany).every((x) => B(x) === 0n) && v.balanceCheck.balanced);
  const vt = await g.get<View>("/group/view", TINA, `companies=${TX}&from=${today}&to=${today}`, TX);
  t.ok("view: one company alone has nothing to eliminate (its sibling is not included)",
    vt.groups.flatMap((x) => x.accounts).every((l) => B(l.eliminatedMinor) === 0n && B(l.combinedMinor) === B(l.sumMinor)));

  // ------------------------------------------------------------ out of balance, then settle
  await t.throws("one side: an AP clerk cannot book it", () => g.post("/group/adjust", PEOPLE.CLERK, { counterparty: TX, kind: "charge", amount: "1", reason: "x x x" }), /controller/);
  await t.throws("one side: the other leg cannot be an inter-company account", () => g.post("/group/adjust", TINA,
    { counterparty: ENTITY, kind: "credit", amount: "15.00", offsetCode: "4090", reason: "freight credit" }, TX), /inter-company account/);
  await t.throws("one side: it needs a reason", () => g.post("/group/adjust", TINA, { counterparty: ENTITY, kind: "credit", amount: "15.00", reason: "" }, TX), /say why/);
  await g.post("/group/adjust", TINA, { counterparty: ENTITY, kind: "credit", amount: "15.00", offsetCode: "6800", reason: "Freight Demo agreed to charge, not billed yet" }, TX);
  const n2 = await g.get<Net>("/group/net", PEOPLE.STEVE);
  t.ok("net: a one-sided entry puts the pair out of balance by exactly that much", !n2.pairs[0].balanced && B(n2.pairs[0].differenceMinor) === -1500n && !n2.allBalanced,
    n2.pairs[0].differenceMinor);
  const home = await g.get<{ show: boolean; pairs: unknown[] }>("/group/home", PEOPLE.CONTROLLER);
  t.ok("home: the controller gets the out-of-balance card", home.show && home.pairs.length === 1);
  t.ok("home: so does the owner, but not an AP clerk", (await g.get<{ show: boolean }>("/group/home", PEOPLE.STEVE)).show && !(await g.get<{ show: boolean }>("/group/home", PEOPLE.CLERK)).show);
  const v2 = await g.get<View>("/group/view", PEOPLE.STEVE);
  t.ok("view: the combined balance sheet shows the gap", !v2.balanceCheck.balanced && B(v2.balanceCheck.combinedMinor) !== 0n);

  await t.throws("settle: a controller of one company cannot settle the pair", () => g.post("/group/settle", TINA, { with: ENTITY }, TX), /not a controller in Demo Furniture Co/);
  await t.throws("settle: when the books differ it needs a reason", () => g.post("/group/settle", PEOPLE.CONTROLLER, { with: TX }), /books differ.*say why/);
  const demoBank0 = (await sql<{ b: string }>(t, `select ledger_balance_minor::text b from bank_position where entity_id = $1 and purpose = 'operating'`, [ENTITY]))[0];
  const txBank0 = (await sql<{ b: string }>(t, `select ledger_balance_minor::text b from bank_position where entity_id = $1 and purpose = 'operating'`, [TX]))[0];
  const done = await g.post<{ number: string; payer: string; payee: string; amountMinor: string; payeeDifferenceMinor: string; payerDifferenceMinor: string; documents: number; invoices: number; bills: number }>(
    "/group/settle", PEOPLE.CONTROLLER, { with: TX, reason: "Freight credit Texas booked; Demo agrees, written off" });
  t.ok("settle: Texas pays what its own books say it owes", done.payer === "Demo Furniture Texas, LLC" && B(done.amountMinor) === expectDemo + 1500n, done.amountMinor);
  t.ok("settle: Demo writes off the 15.00 it was paid over what it shows (a gain to 6800); Texas has no difference",
    B(done.payeeDifferenceMinor) === -1500n && B(done.payerDifferenceMinor) === 0n);
  const n3 = await g.get<Net>("/group/net", PEOPLE.STEVE);
  t.ok("settle: both sides are cleared and the pair nets to zero", n3.allBalanced && B(n3.pairs[0].a.netMinor) === 0n && B(n3.pairs[0].b.netMinor) === 0n && n3.pairs[0].openDocuments === 0);
  t.ok("settle: the ledger agrees: 1195 and 2190 are zero in both companies",
    (await glBal(t, ENTITY, "1195")) === 0n && (await glBal(t, ENTITY, "2190")) === 0n && (await glBal(t, TX, "1195")) === 0n && (await glBal(t, TX, "2190")) === 0n);
  const demoBank1 = (await sql<{ b: string }>(t, `select ledger_balance_minor::text b from bank_position where entity_id = $1 and purpose = 'operating'`, [ENTITY]))[0];
  const txBank1 = (await sql<{ b: string }>(t, `select ledger_balance_minor::text b from bank_position where entity_id = $1 and purpose = 'operating'`, [TX]))[0];
  t.ok("settle: the money moved between the two operating accounts", B(demoBank1.b) - B(demoBank0.b) === B(done.amountMinor) && B(txBank0.b) - B(txBank1.b) === B(done.amountMinor));
  const paid = await sql<{ ci: string; bills: string }>(t, `select
      (select count(*) from customer_invoice where entity_id = $1 and ic_document_id is not null and status <> 'paid')::text ci,
      (select count(*) from invoice where entity_id = $2 and ic_document_id is not null and status <> 'paid')::text bills`, [ENTITY, TX]);
  t.ok("settle: the sibling invoices are paid and the bills are paid (each step audited)", paid[0].ci === "0" && paid[0].bills === "0" && done.invoices >= 2 && done.bills >= 2,
    JSON.stringify(paid[0]));
  t.ok("home: the card is gone once settled", !(await g.get<{ show: boolean }>("/group/home", PEOPLE.CONTROLLER)).show);
  await t.throws("settle: nothing left to settle", () => g.post("/group/settle", PEOPLE.STEVE, { with: TX }), /nothing open between/);
  const v3 = await g.get<View>("/group/view", PEOPLE.STEVE);
  t.ok("view: balanced again after settling", v3.balanceCheck.balanced);

  // ------------------------------------------------------------ history is frozen
  await t.throws("database: the inter-company sub-ledger is never edited", () => tx({ kind: "system", label: "check" }, (c) =>
    c.query(`update ic_ledger set amount_minor = 1 where entity_id = $1`, [ENTITY])), /never changed or deleted/);
  await t.throws("database: a settlement is never deleted", () => tx({ kind: "system", label: "check" }, (c) =>
    c.query(`delete from ic_settlement where payer_entity_id = $1`, [TX])), /never changed or deleted/);
  await t.throws("database: a document's amount cannot change", () => tx({ kind: "system", label: "check" }, (c) =>
    c.query(`update ic_document set amount_minor = amount_minor + 1 where id = $1`, [sent.documentId])), /cannot change/);
  await t.throws("database: a document is never deleted", () => tx({ kind: "system", label: "check" }, (c) =>
    c.query(`delete from ic_document where id = $1`, [sent.documentId])), /never changed or deleted/);

  // ------------------------------------------------------------ report builder
  const runAs = (person: string, entityId: string, def: unknown) => tx({ kind: "user", id: person, label: "check" }, async (c) =>
    rep.run(c, entityId, await rep.rolesFor(c, entityId, person), def, { size: 200 }));
  const byCo = await runAs(PEOPLE.CONTROLLER, ENTITY, { dataset: "group_gl", groupBy: [{ field: "company" }], columns: [{ id: "n", field: "net" }, { id: "k", field: "debit", agg: "count" }] });
  const rows = byCo.rows as Record<string, unknown>[];
  const counted = rows.reduce((a, r) => a + Number(r.k ?? 0), 0);
  const rawCount = Number((await sql<{ n: string }>(t, `select count(*)::text n from journal_line jl join journal_entry je on je.id = jl.journal_entry_id where je.entity_id = any($1)`,
    [[ENTITY, TX]]))[0].n);
  t.ok("report: the group ledger covers both companies, every line, and each company nets to zero",
    rows.length === 2 && counted === rawCount && rows.every((r) => B(r.n) === 0n), `${rows.length} companies, ${counted} of ${rawCount} lines`);
  const icRun = await runAs(PEOPLE.STEVE, TX, { dataset: "group_gl", groupBy: [{ field: "account_code" }], columns: [{ id: "n", field: "net" }],
    filters: [{ field: "intercompany", op: "is_true" }] });
  const icRows = icRun.rows as Record<string, unknown>[];
  t.ok("report: the inter-company flag picks out exactly 1195, 2190, 4090 and 5090; 1195 and 2190 are at zero after settling",
    icRows.map((r) => String(r.g0)).sort().join(",") === "1195,2190,4090,5090" && icRows.filter((r) => ["1195", "2190"].includes(String(r.g0))).every((r) => B(r.n) === 0n),
    JSON.stringify(icRows.map((r) => [r.g0, r.n])));
  await t.throws("report: a controller of one company may not use it", () => runAs(TINA, TX, { dataset: "group_gl", columns: [{ id: "n", field: "net" }] }), /controller in every company/);
  await t.throws("report: nor an AP clerk", () => runAs(PEOPLE.CLERK, ENTITY, { dataset: "group_gl", columns: [{ id: "n", field: "net" }] }), /controller in every company/);
  const rio = await runAs(RIO_OWNER, RIO_ENTITY, { dataset: "group_gl", columns: [{ id: "c", field: "company" }] });
  t.ok("report: another client sees only its own company", (rio.rows as Record<string, unknown>[]).every((r) => r.c === "Rio Freight Lines, LLC"));
}
