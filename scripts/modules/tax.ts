// Sales tax and selling-rule checks: stacked jurisdictions, one jurisdiction
// equal to the old single rate, destination vs origin sourcing, exempt line
// kinds, exemption certificates (an expired one refused), returns reversing
// the same jurisdictions, the filing export tying to GL 2100, the
// special-order deposit minimum with its manager override, quote stock holds
// (hold, extend, expire, release on convert and cancel), and tear sheets
// (rendered with no script; the public copy only with its token).
import type { AddressInfo } from "node:net";
import type { T } from "./harness.ts";
import { ENTITY, LOC, PEOPLE, TENANT } from "./harness.ts";
import * as shop from "../../packages/core/shop.ts";
import * as service from "../../packages/core/service.ts";
import { invoiceFulfilment } from "../../packages/core/ar.ts";
import { post as glPost } from "../../packages/core/posting.ts";
import * as sheet from "../../server/modules/tearsheet.ts";
import { tx } from "../../packages/core/db.ts";
import * as tax from "../../packages/core/tax.ts";
import * as pos from "../../packages/core/pos.ts";
import { saveLocation } from "../../packages/core/setup.ts";
import { scopeOf } from "../../server/actions.ts";
import { module } from "../../server/modules/pos.ts";
import { module as setupModule } from "../../server/modules/setup.ts";
import { module as reportsModule } from "../../server/modules/reports.ts";
import { module as catalogModule, useImageFetch } from "../../server/modules/catalog.ts";
import { PublicPage } from "../../server/modules/kit.ts";
import type { ImageFetch } from "../../packages/core/catalog.ts";
import { routesOf } from "./inventory.ts";
import { runDueHolds } from "../run-due.ts";

const R = routesOf(module as never);
const RS = routesOf(setupModule as never);
const RR = routesOf(reportsModule as never);
const RC = routesOf(catalogModule as never);
const OWNER = PEOPLE.STEVE;
const MARIA = "55555555-0000-0000-0000-000000000011";    // sales
const MGR = "55555555-0000-0000-0000-000000000018";      // store manager + sales
const TABLET = "9a9a0000-0000-0000-0000-000000000002";   // Riverside sales tablet
const PAL_REG = "9a9a0000-0000-0000-0000-000000000003";  // Mesa Verde counter
const CUST = { ALICIA: "88888888-0000-0000-0000-000000000001", BRIAN: "88888888-0000-0000-0000-000000000002", DANA: "88888888-0000-0000-0000-000000000004",
  RIVERSIDE: "88888888-0000-0000-0000-000000000005" };
const P = { SOFA: "77777777-0000-0000-0000-000000000001", LAMP: "77777777-0000-0000-0000-000000000009", HUDSON: "77777777-0000-0000-0000-000000000010" };
const J = { PA: "a7a70000-0000-0000-0000-000000000001", TX: "a7a70000-0000-0000-0000-000000000002", PAL: "a7a70000-0000-0000-0000-000000000003", AND: "a7a70000-0000-0000-0000-000000000004" };
const plus = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const half = (m: bigint, r: number) => (m * BigInt(r) + 5000n) / 10000n;
type Row = { line_id: string; jurisdiction_id: string; code: string; rate_bps: number; taxable_minor: string; exempt_minor: string; exempt_reason: string | null; tax_minor: string; sourced: string; kind: string; posted_on: string | null };

export async function run(t: T) {
  const c0 = await t.pool.connect();
  const read = <X extends Record<string, unknown>>(sql: string, p: unknown[] = []) => t.q<X>(c0, sql, p);
  const sys = <X>(fn: (c: import("../../packages/core/db.ts").Client) => Promise<X>) => tx({ kind: "system", label: "tax checks" }, fn);
  const rowsOf = (orderId: string) => read<Row>(`select t.sales_order_line_id line_id, t.jurisdiction_id, j.code, t.rate_bps, t.taxable_minor, t.exempt_minor, t.exempt_reason, t.tax_minor, t.sourced, t.kind, t.posted_on::text
      from sales_order_line_tax t join tax_jurisdiction j on j.id = t.jurisdiction_id where t.entity_id = $1 and t.sales_order_id = $2 order by t.created_at, j.code`, [ENTITY, orderId]);
  const view = async (id: string) => (await R.get(t, `/pos/orders/${id}`)) as Record<string, unknown> & { lines: { id: string; tax_minor: string; net_minor: string; line_status: string; sku: string }[] };
  const level = async (pid: string, loc: string) => Number((await read<{ r: string }>(`select reserved::text r from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`,
    [ENTITY, pid, loc]))[0]?.r ?? 0);
  const order = (person: string, body: Record<string, unknown>) => R.post(t, person, "/pos/orders", body) as Promise<{ id: string; number: string }>;

  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 0xff, 0xd9]);
  const fakeImg: ImageFetch = async (url) => ({ status: 200, url, headers: { get: (k: string) => (k === "content-type" ? "image/jpeg" : k === "content-length" ? String(JPEG.length) : null) },
    arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length) as ArrayBuffer });
  useImageFetch(fakeImg);

  try {
    const enola = await R.post(t, OWNER, "/pos/sessions", { registerId: TABLET, float: "0" }) as { id: string };
    const pal = await R.post(t, OWNER, "/pos/sessions", { registerId: PAL_REG, float: "100.00" }) as { id: string };

    // ------------------------------------------------------- stacked rates
    const ps = await order(OWNER, { kind: "sale", locationId: LOC.PALESTINE, sessionId: pal.id, lines: [{ productId: P.LAMP, qty: 2, fulfillment: "carry" }] });
    const psRows = await rowsOf(ps.id);
    const psTax = BigInt((await view(ps.id)).tax_minor as string);
    t.ok("stacked: a Mesa Verde sale is taxed by Texas, the city and the county", psRows.map((r) => r.code).sort().join(",") === "TX,TX-JUNIPER,TX-MESAVERDE");
    t.ok("stacked: together they charge exactly the old 8.25% store rate", psTax === half(11998n, 825), `${psTax}`);
    t.ok("stacked: the line's tax is split over them by rate and adds up", psRows.reduce((a, r) => a + BigInt(r.tax_minor), 0n) === psTax
      && BigInt(psRows.find((r) => r.code === "TX")!.tax_minor) === 750n && BigInt(psRows.find((r) => r.code === "TX-MESAVERDE")!.tax_minor) === 180n
      && BigInt(psRows.find((r) => r.code === "TX-JUNIPER")!.tax_minor) === 60n, psRows.map((r) => `${r.code} ${r.tax_minor}`).join(" "));
    const psOut = await R.post(t, OWNER, `/pos/orders/${ps.id}/checkout`, { sessionId: pal.id, tenders: [{ method: "cash", amount: "200.00" }] }) as { status: string };
    const psPosted = await rowsOf(ps.id);
    t.ok("stacked: handed over, each jurisdiction's tax is posted the day it reached 2100", psOut.status === "fulfilled" && psPosted.every((r) => !!r.posted_on));
    const pv = await view(ps.id);
    t.ok("stacked: the order view shows the tax by jurisdiction", Array.isArray(pv.taxes) && (pv.taxes as unknown[]).length === 3);

    // ------------------------------------- one jurisdiction = the old single rate
    const es = await order(OWNER, { kind: "sale", locationId: LOC.ENOLA, lines: [{ productId: P.LAMP, qty: 3, fulfillment: "carry" }] });
    const esRows = await rowsOf(es.id);
    t.ok("one jurisdiction: Riverside is Pennsylvania alone, at 6%, as before", esRows.length === 1 && esRows[0].code === "PA" && BigInt(esRows[0].tax_minor) === half(17997n, 600));
    const ohio = await t.as(OWNER, (c, co, a) => saveLocation(c, scopeOf(co, a), { code: "OHX", name: "Columbus test store", kind: "store", taxRateBps: 725,
      address: { line1: "1 High St", city: "Columbus", state: "OH", postal: "43215" } }));
    const oh = await order(OWNER, { kind: "sale", locationId: ohio, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    const ohRows = await rowsOf(oh.id);
    t.ok("single rate: a store with no jurisdictions keeps its own rate, as one combined jurisdiction", ohRows.length === 1 && ohRows[0].code === "LOC-OHX"
      && BigInt(ohRows[0].tax_minor) === half(5999n, 725), JSON.stringify(ohRows.map((r) => [r.code, r.tax_minor])));
    await t.as(OWNER, (c, co, a) => saveLocation(c, scopeOf(co, a), { id: ohio, code: "OHX", name: "Columbus test store", kind: "store", taxRateBps: 750,
      address: { line1: "1 High St", city: "Columbus", state: "OH", postal: "43215" } }));
    const oh2 = await order(OWNER, { kind: "sale", locationId: ohio, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    t.ok("single rate: changing the store's rate in setup changes it from today", BigInt((await rowsOf(oh2.id))[0].tax_minor) === half(5999n, 750));
    await t.throws("a stacked store's rate is not typed over in setup", () => t.as(OWNER, (c, co, a) => saveLocation(c, scopeOf(co, a), { id: LOC.PALESTINE, code: "PAL",
      name: "Mesa Verde", kind: "store", taxRateBps: 700, address: { line1: "200 Spring St", city: "Mesa Verde", state: "TX", postal: "00181" } })), /comes from its tax jurisdictions/);

    // ---------------------------------------------- destination vs origin
    const danaAddr = (await read<{ id: string }>(`select id from customer_address where entity_id = $1 and customer_id = $2 and is_default`, [ENTITY, CUST.DANA]))[0].id;
    const dest = await order(OWNER, { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.DANA, shipAddressId: danaAddr, promisedOn: plus(9),
      lines: [{ productId: P.SOFA, qty: 1, fulfillment: "delivery" }, { productId: P.LAMP, qty: 1, fulfillment: "carry" }] });
    const dRows = await rowsOf(dest.id);
    const dLines = (await view(dest.id)).lines;
    const sofaLine = dLines.find((l) => l.sku === "ASH-2930338")!, lampLine = dLines.find((l) => l.sku === "ACC-LAMP-01")!;
    t.ok("destination: a sofa sold at Riverside and delivered to Mesa Verde, TX is taxed at the Texas address (8.25%)", BigInt(sofaLine.tax_minor) === half(79999n, 825)
      && dRows.filter((r) => r.line_id === sofaLine.id).map((r) => `${r.code}:${r.sourced}`).sort().join(",") === "TX-JUNIPER:destination,TX-MESAVERDE:destination,TX:destination",
      `${sofaLine.tax_minor}`);
    t.ok("destination: the lamp taken out of the Riverside store is taxed at Riverside (6%)", BigInt(lampLine.tax_minor) === half(5999n, 600)
      && dRows.some((r) => r.code === "PA" && r.sourced === "origin"));
    await RS.post(t, OWNER, "/setup/tax/sourcing", { sourcing: "origin" });
    const orig = await order(OWNER, { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.DANA, shipAddressId: danaAddr, promisedOn: plus(9),
      lines: [{ productId: P.SOFA, qty: 1, fulfillment: "delivery" }] });
    const oSofa = (await view(orig.id)).lines.find((l) => l.sku === "ASH-2930338")!;
    const oRows = (await rowsOf(orig.id)).filter((r) => r.line_id === oSofa.id);
    t.ok("origin: with the company set to origin, the same delivery is taxed at the store", oRows.length === 1 && oRows[0].code === "PA" && oRows[0].sourced === "origin"
      && BigInt(oRows[0].tax_minor) === half(79999n, 600));
    await RS.post(t, OWNER, "/setup/tax/sourcing", { sourcing: "destination" });
    await t.throws("sourcing is origin or destination", () => RS.post(t, OWNER, "/setup/tax/sourcing", { sourcing: "anywhere" }), /origin .* or by destination/);
    await t.throws("only the owner or a controller sets up tax", () => RS.post(t, MARIA, "/setup/tax/sourcing", { sourcing: "origin" }), /needs one of: owner, controller/);

    // ----------------------------------------------------- exempt line kinds
    const kinds = await sys(async (c) => {
      const ins = async (sku: string, kind: string, price: number) => (await t.q<{ id: string }>(c, `insert into product (entity_id, sku, name, kind, price_minor, cost_minor, taxable, ship_class)
        values ($1,$2,$3,$4,$5,0,true,'none') returning id`, [ENTITY, sku, `Tax check ${kind}`, kind, price]))[0].id;
      return { labor: await ins("TAXCHK-LABOR", "service", 5000), fee: await ins("TAXCHK-FEE", "fee", 4000), plan: await ins("TAXCHK-PLAN", "warranty", 3000) };
    });
    const kx = await order(OWNER, { kind: "sale", locationId: LOC.ENOLA, lines: [{ productId: kinds.labor, qty: 1, fulfillment: "pickup" }, { productId: kinds.fee, qty: 1, fulfillment: "pickup" },
      { productId: kinds.plan, qty: 1, fulfillment: "pickup" }, { productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    const kxl = (await view(kx.id)).lines;
    const kxRows = await read<{ sku: string; exempt_reason: string | null; tax_minor: string; exempt_minor: string }>(`select l.sku, t.exempt_reason, t.tax_minor, t.exempt_minor from sales_order_line_tax t
      join sales_order_line l on l.id = t.sales_order_line_id where t.entity_id = $1 and t.sales_order_id = $2`, [ENTITY, kx.id]);
    const by = (sku: string) => kxRows.find((r) => r.sku === sku)!;
    t.ok("exempt kinds: installation labor is exempt in Pennsylvania, with the reason kept", by("TAXCHK-LABOR").exempt_reason === "labor_exempt" && by("TAXCHK-LABOR").tax_minor === "0"
      && by("TAXCHK-LABOR").exempt_minor === "5000");
    t.ok("exempt kinds: a taxable delivery fee and protection plan are taxed where the jurisdiction says so", by("TAXCHK-FEE").tax_minor === "240" && by("TAXCHK-PLAN").tax_minor === "180"
      && kxl.find((l) => l.sku === "TAXCHK-FEE")!.tax_minor === "240");
    await RS.post(t, OWNER, "/setup/tax/jurisdictions", { id: J.PA, code: "PA", name: "Pennsylvania", level: "state", state: "PA", taxesDelivery: false, taxesLabor: false, taxesWarranty: false });
    const kx2 = await order(OWNER, { kind: "sale", locationId: LOC.ENOLA, lines: [{ productId: kinds.fee, qty: 1, fulfillment: "pickup" }, { productId: kinds.plan, qty: 1, fulfillment: "pickup" }] });
    const kx2Rows = await rowsOf(kx2.id);
    t.ok("exempt kinds: once Pennsylvania exempts delivery and plans, they carry no tax and say why", kx2Rows.every((r) => r.tax_minor === "0")
      && kx2Rows.map((r) => r.exempt_reason).sort().join(",") === "delivery_exempt,warranty_exempt");
    await RS.post(t, OWNER, "/setup/tax/jurisdictions", { id: J.PA, code: "PA", name: "Pennsylvania", level: "state", state: "PA", taxesDelivery: true, taxesLabor: false, taxesWarranty: true });
    const pure = tax.computeLine([{ id: "a", code: "S", name: "S", level: "state", state: "TX", rateBps: 625, taxesDelivery: true, taxesLabor: false, taxesWarranty: true },
      { id: "b", code: "C", name: "C", level: "city", state: "TX", rateBps: 200, taxesDelivery: false, taxesLabor: false, taxesWarranty: true }],
      { netMinor: 10000n, itemClass: "delivery", taxable: true, cert: null });
    t.ok("exempt kinds: a delivery fee taxed by the state but not the city pays the state's rate only", pure.taxMinor === 625n && pure.rows[1].exemptReason === "delivery_exempt");

    // ------------------------------------------------------- certificates
    const certOk = await R.post(t, MGR, `/pos/customers/${CUST.BRIAN}/certificates`, { number: "PA-NP-77001", state: "PA", reason: "nonprofit", expiresOn: plus(20) }) as { id: string };
    t.ok("certificate: a manager keeps a customer's certificate on file with its state and expiry", !!certOk.id);
    await t.throws("certificate: sales cannot add one", () => R.post(t, MARIA, `/pos/customers/${CUST.BRIAN}/certificates`, { number: "X-1234", state: "PA", reason: "resale" }), /needs one of/);
    await t.throws("certificate: an already expired one is not taken", () => R.post(t, MGR, `/pos/customers/${CUST.BRIAN}/certificates`, { number: "PA-OLD-1", state: "PA",
      reason: "resale", expiresOn: plus(-3) }), /already expired/);
    const ex1 = await order(OWNER, { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.BRIAN, taxExemptRef: "PA-NP-77001", lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    const ex1Rows = await rowsOf(ex1.id);
    t.ok("certificate: a current one exempts the sale, and the exempt sale is kept by its reason", ex1Rows.length === 1 && ex1Rows[0].tax_minor === "0" && ex1Rows[0].exempt_reason === "nonprofit"
      && ex1Rows[0].exempt_minor === "5999");
    const riv = await order(OWNER, { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.RIVERSIDE, taxExemptRef: "PA-REV-1220-0042871", lines: [{ productId: P.LAMP, qty: 1, fulfillment: "carry" }] });
    await R.post(t, OWNER, `/pos/orders/${riv.id}/checkout`, { sessionId: enola.id, tenders: [{ method: "cash", amount: "59.99" }] });
    t.ok("certificate: the business customer's resale certificate from the seed exempts as resale", (await rowsOf(riv.id))[0].exempt_reason === "resale"
      && !!(await rowsOf(riv.id))[0].posted_on);
    await sys((c) => c.query(`update tax_exemption_certificate set expires_on = current_date - 1 where id = $1 and entity_id = $2`, [certOk.id, ENTITY]));
    await t.throws("certificate: an expired certificate is refused at the register", () => order(OWNER, { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.BRIAN,
      taxExemptRef: "PA-NP-77001", lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] }), /expired on .*taxed until the customer gives a current one/);
    await t.throws("certificate: and the draft written while it was good cannot be placed on it", () => R.post(t, OWNER, `/pos/orders/${ex1.id}/checkout`, { sessionId: enola.id,
      tenders: [{ method: "cash", amount: "60" }] }), /expired on/);
    await t.throws("certificate: one that is not on file is refused", () => order(OWNER, { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, taxExemptRef: "MADE-UP-1",
      lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] }), /not on file/);
    const listed = await R.get(t, `/pos/customers?q=Brian`) as { certificates: unknown[] | null }[];
    t.ok("certificate: the customer lookup lists only current certificates", listed.length > 0 && !listed[0].certificates);

    // ------------------------------------------------------------- returns
    const ret = await R.post(t, OWNER, `/pos/orders/${ps.id}/return`, { sessionId: pal.id, lines: [{ lineId: pv.lines[0].id, qty: 1, reason: "changed_mind", disposition: "restock" }],
      tenders: [{ method: "cash", amount: String((5999 + Number(half(5999n, 825))) / 100) }] }) as { id: string; taxMinor: bigint; journalEntryId: string };
    const rRows = (await rowsOf(ret.id)).filter((r) => r.kind === "return");
    t.ok("return: the tax comes back from the same three jurisdictions", rRows.map((r) => r.code).sort().join(",") === "TX,TX-JUNIPER,TX-MESAVERDE" && rRows.every((r) => !!r.posted_on));
    t.ok("return: each gives back its share for one of the two lamps", rRows.find((r) => r.code === "TX")!.tax_minor === "-375" && rRows.find((r) => r.code === "TX-MESAVERDE")!.tax_minor === "-90"
      && rRows.find((r) => r.code === "TX-JUNIPER")!.tax_minor === "-30" && rRows.every((r) => r.taxable_minor === "-5999"), rRows.map((r) => `${r.code} ${r.tax_minor}`).join(" "));
    const r2100 = await read<{ d: string }>(`select coalesce(sum(jl.debit_minor - jl.credit_minor),0)::text d from journal_line jl join gl_account g on g.id = jl.gl_account_id
      join journal_entry je on je.id = jl.journal_entry_id where je.entity_id = $2 and jl.journal_entry_id = $1 and g.code = '2100'`, [ret.journalEntryId, ENTITY]);
    t.ok("return: 2100 is debited exactly what the jurisdictions give back", BigInt(r2100[0].d) === -rRows.reduce((a, r) => a + BigInt(r.tax_minor), 0n) && BigInt(ret.taxMinor) === 495n);

    // --------------------------------------------------- deposit minimum
    const hud = await order(MARIA, { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, promisedOn: plus(35),
      lines: [{ productId: P.HUDSON, qty: 1, fulfillment: "pickup", choices: { size: "84", fabric: "linen-oat", legs: "walnut" } }] });
    const dep = await R.get(t, `/pos/orders/${hud.id}/deposit`) as { requiredMinor: bigint; onOrderMinor: bigint };
    const gross = 129900n + half(129900n, 600);
    t.ok("deposit: the tender screen is told 50% of the made-to-order sofa is needed", BigInt(dep.onOrderMinor) === gross && BigInt(dep.requiredMinor) === half(gross, 5000), `${dep.requiredMinor}`);
    await t.throws("deposit: checkout refuses a special order paid below the minimum", () => R.post(t, MARIA, `/pos/orders/${hud.id}/checkout`, { sessionId: enola.id,
      tenders: [{ method: "card", amount: "100.00", reference: "4242" }] }), /needs a deposit of at least \$688\.47.*A store manager can allow less/);
    await t.throws("deposit: a salesperson's reason is not a manager's override", () => R.post(t, MARIA, `/pos/orders/${hud.id}/checkout`, { sessionId: enola.id,
      tenders: [{ method: "card", amount: "100.00", reference: "4242" }], depositOverrideReason: "customer promised" }), /needs a deposit of at least/);
    t.ok("deposit: a refused checkout leaves the sale a draft with nothing taken", (await view(hud.id)).status === "draft" && (await view(hud.id)).paid_minor === "0");
    const ovr = await R.post(t, MGR, `/pos/orders/${hud.id}/checkout`, { sessionId: enola.id, tenders: [{ method: "card", amount: "100.00", reference: "4242" }],
      depositOverrideReason: "Long-time customer, balance on delivery" }) as { status: string; onOrder: number };
    const ovRow = await read<{ kind: string; reason: string; approved_by: string; requested_by: string }>(`select kind, reason, approved_by, requested_by from pos_override where entity_id = $1 and sales_order_id = $2`,
      [ENTITY, hud.id]);
    const ovAudit = await read<{ n: string }>(`select count(*)::text n from audit_event where entity_id = $1 and table_name = 'sales_order' and row_id = $2 and source_ref = 'pos deposit override'`, [ENTITY, hud.id]);
    t.ok("deposit: a store manager places it below the minimum with a reason, and who and why are kept", ovr.status === "open" && ovr.onOrder === 1 && ovRow.length === 1
      && ovRow[0].kind === "deposit" && ovRow[0].approved_by === MGR && ovRow[0].requested_by === MARIA && ovAudit[0].n === "1");
    const enough = await order(MARIA, { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, promisedOn: plus(35),
      lines: [{ productId: P.HUDSON, qty: 1, fulfillment: "pickup", choices: { size: "84", fabric: "linen-oat", legs: "walnut" } }] });
    const en = await R.post(t, MARIA, `/pos/orders/${enough.id}/checkout`, { sessionId: enola.id, tenders: [{ method: "card", amount: "688.47", reference: "4242" }] }) as { status: string };
    t.ok("deposit: exactly the minimum is enough", en.status === "open");
    const stocked = await order(MARIA, { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, promisedOn: plus(12), lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    const st = await R.post(t, MARIA, `/pos/orders/${stocked.id}/checkout`, { sessionId: enola.id, tenders: [] }) as { status: string; reserved: number };
    t.ok("deposit: stocked goods need nothing down by default (0%)", st.status === "open" && st.reserved === 1);
    await t.throws("deposit: only a manager changes the selling rules", () => R.post(t, MARIA, "/pos/settings", { specialOrderDepositPct: 10 }), /needs one of: store manager, controller/);
    await t.throws("deposit: a minimum over 100% is refused", () => R.post(t, MGR, "/pos/settings", { specialOrderDepositPct: 150 }), /between 0% and 100%/);

    // ---------------------------------------------------------- quote holds
    const q1 = await order(MARIA, { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.ALICIA, lines: [{ productId: P.LAMP, qty: 2, fulfillment: "pickup" },
      { productId: P.HUDSON, qty: 1, fulfillment: "pickup", choices: { size: "84", fabric: "linen-oat", legs: "walnut" } }] });
    await sys((c) => c.query(`update pos_setting set quote_holds_allowed = false where entity_id = $1`, [ENTITY]));
    await t.throws("hold: refused when the company does not allow holds", () => R.post(t, MARIA, `/pos/orders/${q1.id}/hold`), /does not let quotes hold stock/);
    await R.post(t, MGR, "/pos/settings", { quoteHoldsAllowed: true, quoteHoldMaxDays: 3 });
    await t.throws("hold: no longer than the setting allows", () => R.post(t, MARIA, `/pos/orders/${q1.id}/hold`, { days: 5 }), /1 to 3 days/);
    const lamp0 = await level(P.LAMP, LOC.ENOLA);
    const h1 = await R.post(t, MARIA, `/pos/orders/${q1.id}/hold`, {}) as { heldUntil: string; linesHeld: number; notHeld: number };
    t.ok("hold: the quote reserves the lamps it can, until three days out", h1.heldUntil === plus(3) && h1.linesHeld === 1 && (await level(P.LAMP, LOC.ENOLA)) === lamp0 + 2);
    const q1v = await view(q1.id);
    t.ok("hold: the made-to-order sofa is not held and nothing goes on order", q1v.lines.some((l) => l.sku === "CUW-SOFA-CUSTOM" && l.line_status === "open")
      && q1v.lines.some((l) => l.sku === "ACC-LAMP-01" && l.line_status === "reserved"));
    await t.throws("hold: one hold at a time", () => R.post(t, MARIA, `/pos/orders/${q1.id}/hold`), /already holds its stock/);
    await t.throws("hold: only a manager extends it", () => R.post(t, MARIA, `/pos/orders/${q1.id}/hold/extend`, { until: plus(6), reason: "x" }), /needs one of: store manager/);
    await t.throws("hold: an extension needs a reason", () => R.post(t, MGR, `/pos/orders/${q1.id}/hold/extend`, { until: plus(6) }), /say why/);
    await R.post(t, MGR, `/pos/orders/${q1.id}/hold/extend`, { until: plus(6), reason: "Customer measuring the room this weekend" });
    const ext = await read<{ held_until: string; extended_by: string }>(`select held_until::text, extended_by from pos_quote_hold where entity_id = $1 and sales_order_id = $2 and status = 'active'`, [ENTITY, q1.id]);
    t.ok("hold: a manager extends it with a reason, recorded as an override", ext[0]?.held_until === plus(6) && ext[0].extended_by === MGR
      && (await read(`select 1 from pos_override where entity_id = $1 and sales_order_id = $2 and kind = 'hold_extend'`, [ENTITY, q1.id])).length === 1);
    await sys((c) => c.query(`update pos_quote_hold set held_until = current_date - 1 where entity_id = $1 and sales_order_id = $2 and status = 'active'`, [ENTITY, q1.id]));
    const due = await runDueHolds(new Date(), { entityId: ENTITY });
    const after = await view(q1.id);
    t.ok("hold: the scheduler lets an expired hold go and the lamps are free again", due.some((d) => d.holds >= 1 && d.released >= 1) && (await level(P.LAMP, LOC.ENOLA)) === lamp0
      && after.lines.every((l) => l.line_status === "open") && (after.hold as { status: string }).status === "expired");
    await R.post(t, MARIA, `/pos/orders/${q1.id}/hold`, { days: 2 });
    t.ok("hold: held again", (await level(P.LAMP, LOC.ENOLA)) === lamp0 + 2);
    await R.post(t, MARIA, `/pos/orders/${q1.id}/convert`);
    t.ok("hold: converting the quote releases the hold; the sale reserves when it is placed", (await level(P.LAMP, LOC.ENOLA)) === lamp0
      && ((await view(q1.id)).hold as { status: string }).status === "converted");
    const q2 = await order(MARIA, { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.BRIAN, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    await R.post(t, MARIA, `/pos/orders/${q2.id}/hold`);
    await R.post(t, MARIA, `/pos/orders/${q2.id}/cancel`, { reason: "Bought elsewhere" });
    t.ok("hold: cancelling the quote releases it too", (await level(P.LAMP, LOC.ENOLA)) === lamp0 && ((await view(q2.id)).hold as { status: string }).status === "cancelled");
    const q3 = await order(MARIA, { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.BRIAN, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    await R.post(t, MARIA, `/pos/orders/${q3.id}/hold`);
    await R.post(t, MARIA, `/pos/orders/${q3.id}/hold/release`, { reason: "customer said not yet" });
    t.ok("hold: and the salesperson can let it go", (await level(P.LAMP, LOC.ENOLA)) === lamp0);

    // ----------------------------------------------------- the filing export
    const scope = { tenantId: (await t.company()).tenantId };
    const all = await tax.filing(c0, ENTITY, "2000-01-01", "2099-12-31");
    t.ok("filing: every dollar in GL 2100 from sales and returns belongs to a jurisdiction (it ties)", all.tie.ties && all.tie.differenceMinor === 0n,
      `${all.tie.note} gl ${all.tie.glSalesMinor} rows ${all.tie.collectedMinor}`);
    const month = new Date().toISOString().slice(0, 8) + "01";
    const fl = await tax.filing(c0, ENTITY, month, plus(0));
    const pa = fl.rows.find((r) => r.code === "TX-MESAVERDE")!;
    t.ok("filing: per jurisdiction it shows gross, taxable, tax and the returns", !!pa && pa.taxMinor >= 180n && pa.returnsTaxMinor <= -90n && pa.grossMinor >= pa.taxableMinor
      && pa.netTaxMinor === pa.taxMinor + pa.returnsTaxMinor);
    const paRow = fl.rows.find((r) => r.code === "PA")!;
    t.ok("filing: exempt sales are broken out by reason", (paRow.exemptBy.nonprofit ?? 0n) === 0n && (paRow.exemptBy.resale ?? 0n) >= 5999n && paRow.exemptMinor ===
      Object.values(paRow.exemptBy).reduce((a, b) => a + b, 0n));
    t.ok("filing: this month ties to 2100 too", fl.tie.ties, fl.tie.note);
    const csv = await RR.post(t, OWNER, "/reports/tax-filing/export", { from: month, to: plus(0) }) as { filename: string; csv: string; note: string | null };
    t.ok("filing: the CSV has a row per jurisdiction and says it ties", csv.filename.endsWith(".csv") && csv.csv.startsWith("Jurisdiction code,Jurisdiction,Level,State")
      && csv.csv.includes("TX-MESAVERDE,City of Mesa Verde,city,TX") && /Difference,0\.00,ties/.test(csv.csv) && csv.note === null);
    await t.throws("filing: sales cannot pull the filing", () => RR.post(t, MARIA, "/reports/tax-filing/export", { from: month, to: plus(0) }), /needs one of: owner, controller, viewer/);
    // A stray 2100 posting that no sale explains is flagged, not hidden.
    const stray = await sys(async (c) => {
      await c.query("savepoint stray");
      const { post } = await import("../../packages/core/posting.ts");
      await post(c, { tenantId: scope.tenantId, entityId: ENTITY, actor: { kind: "system", label: "t" } }, { date: plus(0), sourceType: "sale", sourceId: null,
        description: "test stray tax", lines: [{ code: "1050", debit: 123n }, { code: "2100", credit: 123n }] });
      const f = await tax.filing(c, ENTITY, month, plus(0));
      await c.query("rollback to savepoint stray");
      return f.tie;
    });
    t.ok("filing: a 2100 amount with no jurisdiction behind it is flagged with the difference", !stray.ties && stray.differenceMinor === 123n && /difference of \$1\.23/.test(stray.note));
    const ds = await RR.post(t, OWNER, "/reports/run", { definition: { dataset: "tax_by_jurisdiction", groupBy: [{ field: "jurisdiction_code" }],
      columns: [{ id: "m0", field: "tax" }] }, params: {} }).then((x) => x as { rows: unknown[] }, (e: Error) => ({ rows: [], error: e.message }));
    t.ok("filing: the tax_by_jurisdiction dataset runs in the report creator", Array.isArray(ds.rows) && ds.rows.length > 0, JSON.stringify(ds).slice(0, 120));

    // ------------------------------------------------------------ tear sheets
    const tq = await order(MARIA, { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.ALICIA, lines: [{ productId: P.HUDSON, qty: 1, fulfillment: "pickup",
      choices: { size: "96", fabric: "velvet-navy", legs: "brass" } }, { productId: P.LAMP, qty: 2, fulfillment: "pickup" }] });
    const page = await R.get(t, `/pos/orders/${tq.id}/tear-sheet`) as PublicPage;
    const html = page instanceof PublicPage ? page.text : "";
    t.ok("tear sheet: the quote's sheet shows photos, options chosen, prices, expiry and the store", html.includes("Hudson sofa") && html.includes("Velvet, navy") && html.includes("Fabric:")
      && html.includes("Prices good until") && html.includes("100 Main St") && /<img src="data:image\/jpeg;base64,/.test(html) && html.includes("$1,729.00"));
    t.ok("tear sheet: it has no script at all, no inline handlers or style attributes, and print rules", !/<script/i.test(html) && !/\son[a-z]+=/i.test(html) && !/\sstyle=/i.test(html)
      && html.includes("@media print") && html.includes('<style nonce="__NONCE__">'));
    const prodPage = await RC.get(t, `/catalog/products/${P.HUDSON}/tear-sheet`) as PublicPage;
    t.ok("tear sheet: a product's sheet from the catalog lists what it can be made in", prodPage instanceof PublicPage && prodPage.text.includes("Make it yours")
      && prodPage.text.includes("Top-grain leather, cognac") && !/<script/i.test(prodPage.text));
    const sent = await R.post(t, MARIA, `/pos/orders/${tq.id}/tear-sheet/send`, {}) as { token: string; path: string; messageId: string; channel: string };
    const msg = await read<{ kind: string; body: string; customer_id: string }>(`select kind, body, customer_id from customer_message where entity_id = $1 and id = $2`, [ENTITY, sent.messageId]);
    t.ok("tear sheet: the link goes to the customer through the customer message log", msg[0]?.kind === "tear_sheet" && msg[0].customer_id === CUST.ALICIA && msg[0].body.includes(sent.path)
      && sent.channel === "sms");
    const hashOnly = await read<{ n: string }>(`select count(*)::text n from tear_sheet_link where entity_id = $1 and token_sha256 = encode(sha256($2::bytea), 'hex')`, [ENTITY, sent.token]);
    t.ok("tear sheet: only the token's hash is kept", hashOnly[0].n === "1" && !(await read(`select 1 from tear_sheet_link where entity_id = $1 and token_sha256 = $2`, [ENTITY, sent.token])).length);
    await t.throws("tear sheet: a driver cannot send one", () => R.post(t, "55555555-0000-0000-0000-000000000015", `/pos/orders/${tq.id}/tear-sheet/send`, {}), /needs one of/);

    const yr = String(new Date().getUTCFullYear());
    t.ok("tear sheet: the header shows the day it was written, never Invalid Date", !html.includes("Invalid Date") && html.includes(yr));
    const pubOf = (tok: string) => sys((c) => sheet.publicSheet(c, tok));
    const rq = await order(MARIA, { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.ALICIA, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    const lk = await R.post(t, MARIA, `/pos/orders/${rq.id}/tear-sheet/send`, {}) as { token: string };
    await t.throws("tear sheet: a driver cannot stop a link", () => R.post(t, "55555555-0000-0000-0000-000000000015", `/pos/orders/${rq.id}/tear-sheet/revoke`), /needs one of/);
    await R.post(t, MARIA, `/pos/orders/${rq.id}/tear-sheet/revoke`);
    t.ok("tear sheet: a revoked link opens nothing", (await pubOf(lk.token)) === null);
    const cq = await order(MARIA, { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.ALICIA, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    const cqLink = await R.post(t, MARIA, `/pos/orders/${cq.id}/tear-sheet/send`, {}) as { token: string };
    await R.post(t, MARIA, `/pos/orders/${cq.id}/cancel`, { reason: "Changed their mind" });
    t.ok("tear sheet: cancelling the order kills its link", (await pubOf(cqLink.token)) === null);
    const vq = await order(MARIA, { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.ALICIA, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    const vqLink = await R.post(t, MARIA, `/pos/orders/${vq.id}/tear-sheet/send`, {}) as { token: string };
    await R.post(t, MARIA, `/pos/orders/${vq.id}/convert`);
    const afterConv = await pubOf(vqLink.token);
    const vqExp = await read<{ ok: boolean }>(`select expires_at > now() + interval '29 days' ok from tear_sheet_link where entity_id = $1 and sales_order_id = $2 and revoked_at is null`, [ENTITY, vq.id]);
    t.ok("tear sheet: after conversion the customer's link still works and shows the order", !!afterConv && /<h1>Order SO-/.test(afterConv.text) && vqExp[0]?.ok === true);
    const xq = await order(MARIA, { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.ALICIA, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    await sys((c) => c.query(`update pos_order set quote_expires_on = current_date - 1 where sales_order_id = $1 and entity_id = $2`, [xq.id, ENTITY]));
    await t.throws("tear sheet: an expired quote is not sent", () => R.post(t, MARIA, `/pos/orders/${xq.id}/tear-sheet/send`, {}), /expired on .*make a new quote/);

    const { createServer } = await import("../../server/index.ts");
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}${sent.path}`);
      const body = await res.text();
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      t.ok("tear sheet: the customer's link opens the sheet with the app's CSP and a style nonce", res.status === 200 && /script-src 'self'/.test(csp) && /img-src 'self' data:/.test(csp)
        && !!nonce && body.includes(`nonce="${nonce}"`) && !body.includes("__NONCE__") && body.includes("Hudson sofa"));
      t.ok("tear sheet: the public page carries no script and no back-office data", !/<script/i.test(body) && !body.includes("cost_minor") && !body.includes("620.00"));
      const bad = await fetch(`${base}/sheet/${"x".repeat(32)}`);
      t.ok("tear sheet: a wrong token reaches nothing", bad.status === 404 && !(await bad.text()).includes("Hudson"));
      t.ok("tear sheet: no token reaches nothing", (await fetch(`${base}/sheet/`)).status === 404 && (await fetch(`${base}/sheet`)).status === 404);
      const internal = await fetch(`${base}/api/c/${ENTITY}/pos/orders/${tq.id}/tear-sheet`);
      t.ok("tear sheet: the staff print page needs a sign-in", internal.status === 401);
      const again = await R.post(t, MARIA, `/pos/orders/${tq.id}/tear-sheet/send`, {}) as { path: string };
      t.ok("tear sheet: a new link replaces the old one", (await fetch(`${base}${sent.path}`)).status === 404 && (await fetch(`${base}${again.path}`)).status === 200);
      const post = await fetch(`${base}${again.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      t.ok("tear sheet: the link is read only", post.status === 405 || post.status === 404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    // ======================================== review fixes: every door taxes by the stack
    const SCOPE = { tenantId: TENANT, entityId: ENTITY, actor: { kind: "system" as const, label: "tax checks" } };
    const lineRows = (lineId: string) => read<{ code: string; tax_minor: string; owed_minor: string; sourced: string; exempt_reason: string | null; note: string | null }>(`
      select j.code, t.tax_minor::text, t.owed_minor::text, t.sourced, t.exempt_reason, t.note from sales_order_line_tax t join tax_jurisdiction j on j.id = t.jurisdiction_id
       where t.entity_id = $1 and t.sales_order_line_id = $2 and t.kind = 'sale' order by j.code`, [ENTITY, lineId]);
    const SOC = { line1: "9 Mesa Rd", city: "Canyon Ridge", state: "TX", postal: "00127" };
    const site = (await sys((c) => shop.siteBySlug(c, "riverside-home")))!;
    const ck = (over: Record<string, unknown>) => shop.parseCheckout({ cartId: `tax-${Math.random().toString(36).slice(2, 12)}`, email: "taxweb@example.com", name: "Tax Web",
      phone: "555-555-0177", fulfillment: "delivery", address: SOC, paymentToken: "tok_test_visa_4242", lines: [{ productId: P.LAMP, qty: 1 }], ...over });
    const prev = await sys((c) => shop.quote(c, site, ck({})));
    t.ok("web: the checkout preview for a Canyon Ridge delivery shows Canyon Ridge's 8.25%, not the shop's own rate", prev.taxRateBps === 825
      && prev.lines[0].taxMinor === half(5999n, 825).toString(), `${prev.taxRateBps} ${prev.lines[0].taxMinor}`);
    const web = await sys((c) => shop.placeWebOrder(c, site, ck({}), SCOPE));
    const webLine = (await read<{ id: string; tax_minor: string }>(`select l.id, l.tax_minor::text from sales_order_line l join sales_order so on so.id = l.sales_order_id
      where so.entity_id = $1 and so.number = $2 and l.sku = 'ACC-LAMP-01'`, [ENTITY, web.order.number]))[0];
    const webRows = await lineRows(webLine.id);
    t.ok("web: a delivery to another county is taxed at the address: Texas, Sun Valley County and Canyon Ridge", webLine.tax_minor === half(5999n, 825).toString()
      && webRows.map((r) => r.code).join(",") === "TX,TX-CANYONRIDGE,TX-SUNVALLEY" && webRows.every((r) => r.sourced === "destination" && r.owed_minor === r.tax_minor), JSON.stringify(webRows));
    const pk = await sys((c) => shop.placeWebOrder(c, site, ck({ fulfillment: "pickup", pickupLocationId: LOC.PALESTINE, address: undefined }), SCOPE));
    const pkLine = (await read<{ id: string; tax_minor: string }>(`select l.id, l.tax_minor::text from sales_order_line l join sales_order so on so.id = l.sales_order_id
      where so.entity_id = $1 and so.number = $2 and l.sku = 'ACC-LAMP-01'`, [ENTITY, pk.order.number]))[0];
    t.ok("web: a pickup is taxed at the pickup store's jurisdictions", (await lineRows(pkLine.id)).map((r) => r.code).join(",") === "TX,TX-JUNIPER,TX-MESAVERDE");

    const svc = await sys(async (c) => {
      const tk = await service.openTicket(c, SCOPE, { source: "phone", customerId: CUST.DANA, issueType: "other", description: "Recliner squeaks when it reclines" });
      await c.query(`update service_ticket set coverage = 'billable' where entity_id = $1 and id = $2`, [ENTITY, tk.id]);
      const labor = await service.addCharge(c, SCOPE, tk.id, { productId: kinds.labor, qty: 1 });
      const trip = await service.addCharge(c, SCOPE, tk.id, { productId: kinds.fee, qty: 1 });
      return { labor: labor.lineId, trip: trip.lineId };
    });
    const sLabor = await lineRows(svc.labor), sTrip = await lineRows(svc.trip);
    const tripTax = (await read<{ t: string }>(`select tax_minor::text t from sales_order_line where entity_id = $1 and id = $2`, [ENTITY, svc.trip]))[0].t;
    t.ok("service: a service charge is taxed by the stack; labor is exempt where the jurisdiction says, with the reason kept",
      sLabor.length > 0 && sLabor.every((r) => r.tax_minor === "0" && r.exempt_reason === "labor_exempt"), JSON.stringify(sLabor));
    t.ok("service: a taxable trip fee is split over the same jurisdictions and adds up", sTrip.length > 0 && sTrip.reduce((a, r) => a + BigInt(r.tax_minor), 0n) === BigInt(tripTax)
      && BigInt(tripTax) > 0n, JSON.stringify(sTrip));

    // ---------------------------- a mismatched charge is flagged, not spread silently
    const month0 = new Date().toISOString().slice(0, 8) + "01";
    const mis = await sys(async (c) => {
      await c.query("savepoint mis");
      const f0 = await tax.filing(c, ENTITY, month0, plus(0));
      const ed = (await t.q<{ id: string }>(c, `select id from customer_address where entity_id = $1 and customer_id = '88888888-0000-0000-0000-000000000006' and is_default`, [ENTITY]))[0].id;
      const o = (await t.q<{ id: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, status, fulfillment, ship_address_id)
        values ($1,'IMPORT-TAX-1','phone',$2,'88888888-0000-0000-0000-000000000006','open','delivery',$3) returning id`, [ENTITY, LOC.ENOLA, ed]))[0];
      const l = (await t.q<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, tax_minor, line_status)
        values ($1,$2,1,$3,'TAXCHK-PLAN','plan',1,3000,180,'fulfilled') returning id`, [ENTITY, o.id, kinds.plan]))[0];
      await c.query(`select sales_order_retotal($1) /* unscoped: test order */`, [o.id]);
      await invoiceFulfilment(c, SCOPE, o.id, [l.id], 0n);
      const rows = await t.q<{ tax: string; owed: string }>(c, `select sum(tax_minor)::text tax, sum(owed_minor)::text owed from sales_order_line_tax where entity_id = $1 and sales_order_line_id = $2`, [ENTITY, l.id]);
      const f = await tax.filing(c, ENTITY, month0, plus(0));
      await c.query("rollback to savepoint mis");
      return { rows: rows[0], f, before: f0.collection.underCollectedMinor };
    });
    t.ok("mismatch: an imported line charged 6% for a Canyon Ridge delivery keeps what was charged and what is owed (8.25%)", mis.rows.tax === "180" && mis.rows.owed === half(3000n, 825).toString());
    t.ok("mismatch: the filing still ties to 2100 and flags the tax under-collected, line by line", mis.f.tie.ties && mis.f.collection.underCollectedMinor - mis.before === half(3000n, 825) - 180n
      && /under-collected/.test(mis.f.collection.note ?? "") && mis.f.collection.lines.some((x) => x.order_number === "IMPORT-TAX-1"), mis.f.collection.note ?? "");

    // ------------------------------------ a ZIP no local jurisdiction covers
    const mca = (await R.post(t, MGR, `/pos/customers/${CUST.DANA}/addresses`, { label: "Lake house", line1: "500 Bicentennial Blvd", city: "McAllen", state: "TX", postal: "78501" })) as { id: string };
    const gapPal = await order(OWNER, { kind: "sale", locationId: LOC.PALESTINE, customerId: CUST.DANA, shipAddressId: mca.id, promisedOn: plus(9),
      lines: [{ productId: P.SOFA, qty: 1, fulfillment: "delivery" }] }) as { id: string; taxNotes: string[] };
    const gpSofa = (await view(gapPal.id)).lines.find((l) => l.sku === "ASH-2930338")!;
    const gpRows = await lineRows(gpSofa.id);
    t.ok("ZIP gap: McAllen has no local tax set up, so a Mesa Verde sale is taxed at the Mesa Verde store's stack, and says so",
      gpSofa.tax_minor === half(79999n, 825).toString() && gpRows.every((r) => r.sourced === "origin" && /ZIP 78501 has no local tax/.test(r.note ?? ""))
      && gapPal.taxNotes.some((n) => /78501/.test(n)), JSON.stringify(gpRows));
    const gapEn = await order(OWNER, { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.DANA, shipAddressId: mca.id, promisedOn: plus(9),
      lines: [{ productId: P.SOFA, qty: 1, fulfillment: "delivery" }] });
    const geSofa = (await view(gapEn.id)).lines.find((l) => l.sku === "ASH-2930338")!;
    const geRows = await lineRows(geSofa.id);
    t.ok("ZIP gap: from a store in another state it is Texas tax only, with the warning", geSofa.tax_minor === half(79999n, 625).toString()
      && geRows.length === 1 && geRows[0].code === "TX" && /state tax only/.test(geRows[0].note ?? ""));
    const gapF = await sys(async (c) => {
      await c.query("savepoint gap");
      await c.query(`update sales_order_line set line_status = 'fulfilled' where entity_id = $1 and id = $2`, [ENTITY, gpSofa.id]);
      await invoiceFulfilment(c, SCOPE, gapPal.id, [gpSofa.id], 0n);
      const f = await tax.filing(c, ENTITY, month0, plus(0));
      await c.query("rollback to savepoint gap");
      return f;
    });
    t.ok("ZIP gap: the filing lists the ZIPs that were not covered", gapF.uncoveredZips.some((z) => z.postal === "78501" && z.state === "TX") && gapF.tie.ties);

    // ------------------------------- a store that was there before the migration
    const pre = await sys(async (c) => {
      const mk = async (code: string) => (await t.q<{ id: string }>(c, `insert into location (entity_id, code, name, kind, state, tax_rate_bps, address)
        values ($1,$2,$3,'store','TX',825,'{"line1":"1 Oak Hollow Ave","city":"Harlingen","state":"TX","postal":"78550"}') returning id`, [ENTITY, code, `Harlingen ${code}`]))[0].id;
      const a = await mk("PRE1");
      const made = (await t.q<{ n: number }>(c, `select tax_make_standins($1, $2) n /* unscoped: the migration's own rule, for this one store */`, [ENTITY, a]))[0].n;
      const b = await mk("PRE2");   // as if added after the migration by a script, with no stand-in
      return { a, b, made };
    });
    const preA = await read<{ code: string }>(`select j.code from tax_jurisdiction j where j.entity_id = $1 and j.for_location_id = $2`, [ENTITY, pre.a]);
    t.ok("pre-migration: the migration gives an existing store with a rate its single-rate stand-in", pre.made >= 1 && preA[0]?.code === "LOC-PRE1");
    await RS.post(t, OWNER, "/setup/tax/jurisdictions", { code: "TX-CAMERON", name: "Cameron County", level: "county", state: "TX", ratePct: "0.5",
      taxesDelivery: true, taxesLabor: false, taxesWarranty: true, note: "check with your accountant" });
    const preRates = await read<{ id: string; tax_rate_bps: number }>(`select id, tax_rate_bps from location where entity_id = $1 and id = any($2)`, [ENTITY, [pre.a, pre.b]]);
    t.ok("pre-migration: a new Texas jurisdiction never cuts an existing 8.25% store to 6.25%", preRates.length === 2 && preRates.every((r) => r.tax_rate_bps === 825), JSON.stringify(preRates));
    const preSale = await order(OWNER, { kind: "sale", locationId: pre.b, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] });
    const psr = await rowsOf(preSale.id);
    t.ok("pre-migration: and its sales keep charging its own rate", psr.length === 1 && psr[0].code === "LOC-PRE2" && BigInt(psr[0].tax_minor) === half(5999n, 825));
    const noState = await t.as(OWNER, (c, co, a) => saveLocation(c, scopeOf(co, a), { code: "NOST", name: "Pop-up outlet", kind: "outlet", taxRateBps: 700 }));
    await t.throws("no state: a location with no state is refused at the register, plainly", () => order(OWNER, { kind: "sale", locationId: noState,
      lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] }), /has no state set, so its sales tax cannot be worked out/);

    // ----------------------------------------- partial returns never over-refund
    const mini = await sys(async (c) => (await t.q<{ id: string }>(c, `insert into product (entity_id, sku, name, kind, price_minor, cost_minor, taxable, ship_class)
      values ($1,'TAXCHK-MINI','Tax check mini plan','warranty',28,0,true,'none') returning id`, [ENTITY]))[0].id);
    const ms = await order(OWNER, { kind: "sale", locationId: LOC.ENOLA, sessionId: enola.id, lines: [{ productId: mini, qty: 3, fulfillment: "carry" }] });
    await R.post(t, OWNER, `/pos/orders/${ms.id}/checkout`, { sessionId: enola.id, tenders: [{ method: "cash", amount: "0.89" }] });
    const msLine = (await view(ms.id)).lines[0];
    const backs: bigint[] = [];
    for (let i = 0; i < 3; i++) backs.push(BigInt((await R.post(t, OWNER, `/pos/orders/${ms.id}/return`, { sessionId: enola.id,
      lines: [{ lineId: msLine.id, qty: 1, reason: "changed_mind", disposition: "restock" }], tenders: [] }) as { taxMinor: bigint }).taxMinor));
    t.ok("returns: three single returns give back exactly the 5 cents collected, the last one the remainder", msLine.tax_minor === "5"
      && backs.reduce((a, b) => a + b, 0n) === 5n && backs[2] === 1n, backs.join(","));

    // --------------------------------------- layaway with special-order goods
    const lay = await order(MARIA, { kind: "layaway", locationId: LOC.ENOLA, customerId: CUST.ALICIA,
      lines: [{ productId: P.HUDSON, qty: 1, fulfillment: "pickup", choices: { size: "84", fabric: "linen-oat", legs: "walnut" } }] });
    await t.throws("layaway: special-order goods need the higher special-order deposit, not just the layaway's 20%", () => R.post(t, MARIA, `/pos/orders/${lay.id}/checkout`,
      { sessionId: enola.id, tenders: [{ method: "card", amount: "300.00", reference: "4242" }] }), /special-order deposit, more than the 20% layaway minimum/);
    const layOk = await R.post(t, MARIA, `/pos/orders/${lay.id}/checkout`, { sessionId: enola.id, tenders: [{ method: "card", amount: "688.47", reference: "4242" }] }) as { status: string };
    t.ok("layaway: the special-order minimum is enough", layOk.status === "open");

    // --------------------------------------------------- an honest 2100 tie
    const honest = await sys(async (c) => {
      await c.query("savepoint honest");
      await glPost(c, SCOPE, { date: plus(0), sourceType: "manual", sourceId: null, description: "test manual tax entry", lines: [{ code: "1050", debit: 123n }, { code: "2100", credit: 123n }] });
      await glPost(c, SCOPE, { date: plus(0), sourceType: "invoice", sourceId: null, description: "test sales tax remittance", lines: [{ code: "2100", debit: 5000n }, { code: "2010", credit: 5000n }] });
      const f = await tax.filing(c, ENTITY, month0, plus(0));
      await c.query("rollback to savepoint honest");
      return f.tie;
    });
    t.ok("tie: a manual 2100 entry is counted and flagged; a payment of the tax to the state is shown but left out", !honest.ties && honest.differenceMinor === 123n
      && honest.glOtherMinor === 123n && honest.glRemittedMinor === 5000n, `${honest.differenceMinor} ${honest.glOtherMinor} ${honest.glRemittedMinor}`);

    // ---------------------------------------- exemption swapped off a draft
    await R.post(t, OWNER, `/pos/orders/${ex1.id}/exemption`, { taxExemptRef: null });
    const ex1v = await view(ex1.id);
    t.ok("exemption: a draft stuck on a dead certificate is cleared and taxed again", ex1v.tax_minor === half(5999n, 600).toString() && !ex1v.tax_exempt_ref
      && (await rowsOf(ex1.id)).every((r) => r.exempt_reason === null && r.tax_minor === ex1v.tax_minor));
    await t.throws("exemption: only a current certificate can be put on", () => R.post(t, OWNER, `/pos/orders/${ex1.id}/exemption`, { taxExemptRef: "PA-NP-77001" }), /expired on/);

    // ---------------------------------------------------- roles on the reads
    await t.throws("roles: the tax setup is not read anonymously", () => RS.get(t, "/setup/tax"), /pick who you are acting as/);
    await t.throws("roles: nor a customer's certificates", () => R.get(t, `/pos/customers/${CUST.BRIAN}/certificates`), /pick who you are acting as/);

    // -------------------------------------------------- tie still holds at the end
    const fin = await tax.filing(c0, ENTITY, "2000-01-01", "2099-12-31");
    t.ok("filing: after every check, 2100 and the jurisdictions still agree", fin.tie.ties, fin.tie.note);
    void pos;
  } finally {
    useImageFetch(undefined);
    c0.release();
  }
}
