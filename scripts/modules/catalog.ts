// Catalog checks: pricing (lists, promotions, MAP, packages), lifecycle,
// options and templates, cartons, images, tags and barcodes, the vendor feed
// import, roles, and that another company sees none of it.
import { type T, ENTITY, RIO_ENTITY, LOC, PEOPLE } from "./harness.ts";
import { tx, q, type Client, type Scope } from "../../packages/core/db.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";
import { module as catalogModule } from "../../server/modules/catalog.ts";
import * as cat from "../../packages/core/catalog.ts";
import { priceConfigured } from "../../packages/core/pricing.ts";

export const P = {
  DARCY: "77777777-0000-0000-0000-000000000001",
  LOVESEAT: "77777777-0000-0000-0000-000000000002",
  TABLE: "77777777-0000-0000-0000-000000000005",
  CHAIRS: "77777777-0000-0000-0000-000000000006",
  RECLINER: "77777777-0000-0000-0000-000000000007",
  HUDSON: "77777777-0000-0000-0000-000000000010",
  DELIVERY: "77777777-0000-0000-0000-000000000011",
  NIGHTSTAND: "77777777-0000-0000-0000-000000000021",
  OTTOMAN: "77777777-0000-0000-0000-000000000022",
  FLOOR: "77777777-0000-0000-0000-000000000023",
  SET: "77777777-0000-0000-0000-000000000024",
  LIFT: "77777777-0000-0000-0000-000000000025",
  CHAIR: "77777777-0000-0000-0000-000000000026",
};
export const V = { ASHLEY: "66666666-0000-0000-0000-0000000000a1", COASTER: "66666666-0000-0000-0000-0000000000a2",
  GLOBAL: "66666666-0000-0000-0000-0000000000a3", CUW: "66666666-0000-0000-0000-0000000000a4" };
export const BUYER = "55555555-0000-0000-0000-000000000016";
export const STORE_MGR = "55555555-0000-0000-0000-000000000018";
export const DC = "33333333-0000-0000-0000-0000000000dc";
const TEMPLATE = "79797979-0000-0000-0000-000000000001";
const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// The shared harness's company() reads entity by id without naming it as
// unscoped, so db.guard refuses it; these checks load the company themselves.
export async function companyOf(t: T, entityId = ENTITY): Promise<Company> {
  const c = await t.pool.connect();
  try {
    const x = (await q<Record<string, string>>(c, `
      select e.id, e.tenant_id, e.name, e.legal_name, t.name tenant_name, t.vertical, t.location_label, t.profit_object_label
        from entity e join tenant t on t.id = e.tenant_id where e.id = $1 /* unscoped: loading the company by its id */`, [entityId]))[0];
    return { id: x.id, tenantId: x.tenant_id, name: x.name, legalName: x.legal_name, tenantName: x.tenant_name, vertical: x.vertical,
      locationLabel: x.location_label, profitObjectLabel: x.profit_object_label } as Company;
  } finally { c.release(); }
}

/** Run as a person in one transaction, the way a coPost route does. */
export async function asPerson<R>(t: T, personId: string, fn: (c: Client, co: Company, a: Actor) => Promise<R>, entityId = ENTITY): Promise<R> {
  const co = await companyOf(t, entityId);
  const a: Actor = { personId, personName: "check", label: "check" };
  return tx({ kind: "user", id: personId, label: "check" }, (c) => fn(c, co, a));
}

type Fn = (...a: unknown[]) => Promise<unknown>;
/** The module's own routes, called the way the server calls them. */
export function routes(t: T, mod: { register: (k: never) => void }) {
  const gets = new Map<string, Fn>(), posts = new Map<string, Fn>();
  mod.register({ coGet: (tail: string, fn: Fn) => gets.set(tail, fn), coPost: (tail: string, fn: Fn) => posts.set(tail, fn), publicRoute: () => {} } as never);
  const ID = "([0-9a-fA-F-]{36})";
  const key = (tail: string) => tail.replace(":id", ID);
  return {
    post: <R = Record<string, unknown>>(tail: string, who: string, body: Record<string, unknown>, id?: string) =>
      asPerson(t, who, (c, co, a) => posts.get(key(tail))!(c, co, a, body, ["", co.id, id]) as Promise<R>),
    get: async <R = Record<string, unknown>>(tail: string, query = "", id?: string | string[], entityId = ENTITY): Promise<R> => {
      const c = await t.pool.connect();
      try {
        const co = await companyOf(t, entityId);
        return await gets.get(key(tail))!(c, co, new URL("http://x/" + query), ["", co.id, ...(Array.isArray(id) ? id : [id])], null) as R;
      } finally { c.release(); }
    },
  };
}

export async function rio<R>(t: T, fn: (c: Client, s: Scope) => Promise<R>): Promise<R> {
  const co = await companyOf(t, RIO_ENTITY);
  return tx({ kind: "user", id: PEOPLE.STEVE, label: "check" }, (c) => fn(c, { tenantId: co.tenantId, entityId: RIO_ENTITY, actor: { kind: "user", id: PEOPLE.STEVE, label: "check" } }));
}

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = await t.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};

export async function run(t: T) {
  const r = routes(t, catalogModule);

  // ------------------------------------------------------------ barcodes
  t.ok("code 128: every pattern is 11 modules wide, the stop 13, all different",
    cat.CODE128_PATTERNS.length === 107 && cat.CODE128_PATTERNS.slice(0, 106).every((p) => p.split("").reduce((a, b) => a + Number(b), 0) === 11)
    && cat.CODE128_PATTERNS[106].split("").reduce((a, b) => a + Number(b), 0) === 13 && new Set(cat.CODE128_PATTERNS).size === 107);
  t.ok("code 128: a SKU encodes and reads back, check digit and all", cat.decode128(cat.code128("ASH-2930338")) === "ASH-2930338");
  t.ok("code 128: symbol is 11 modules per character plus start, check and stop", cat.code128("AB").reduce((a, b) => a + b, 0) === 11 * 4 + 13);
  await t.throws("code 128: a character outside printable ASCII is refused", async () => cat.code128("Sofá"), /cannot be printed/);

  // ------------------------------------------------------- csv and mapping
  const parsed = cat.parseCsv('a,b,c\r\n"x, y","say ""hi""","two\nlines"\n\n1,2,3');
  t.ok("csv: quoted commas, doubled quotes, embedded newlines, blank lines", parsed.length === 3 && parsed[1][0] === "x, y" && parsed[1][1] === 'say "hi"' && parsed[1][2] === "two\nlines");
  const auto = cat.automap(["Model #", "Description", "Regular Cost", "Retail", "UPC", "Cube", "Weight", "Cartons", "Item Status", "Item Image"]);
  t.ok("automap: vendor headings land on the right fields", auto.vendor_sku === "Model #" && auto.name === "Description" && auto.cost === "Regular Cost"
    && auto.price === "Retail" && auto.barcode === "UPC" && auto.cubic_ft === "Cube" && auto.pieces === "Cartons" && auto.status === "Item Status" && auto.image_url === "Item Image");
  t.ok("automap: a column feeds one field only, and missing required fields are named",
    cat.missingRequired(cat.automap(["Item", "Color"])).join(",") === "vendor_sku,cost");

  // --------------------------------------------------------------- pricing
  await read(t, async (c) => {
    const darcy = await priceConfigured(c, ENTITY, P.DARCY, []);
    t.ok("pricing: a product with no promotion keeps its ticket price", darcy.unitPriceMinor === 79999n && darcy.promotion === null && darcy.mapMinor === 74999n);
    const ns = await priceConfigured(c, ENTITY, P.NIGHTSTAND, []);
    t.ok("pricing: the live 20% promotion applies", ns.unitPriceMinor === 18399n && ns.ticketMinor === 22999n && ns.promotion?.name === "Nightstand event", String(ns.unitPriceMinor));
    const nsList = await priceConfigured(c, ENTITY, P.NIGHTSTAND, [], { priceList: "contract" });
    t.ok("pricing: the lower of contract list and promotion wins", nsList.unitPriceMinor === 18399n && nsList.priceList === null);
    const later = await priceConfigured(c, ENTITY, P.NIGHTSTAND, [], { priceList: "CONTRACT", on: day(60) });
    t.ok("pricing: after the promotion ends the contract list price applies", later.unitPriceMinor === 18999n && later.priceList === "CONTRACT");
    const plain = await priceConfigured(c, ENTITY, P.NIGHTSTAND, [], { on: day(60) });
    t.ok("pricing: after the promotion ends, no list, ticket price", plain.unitPriceMinor === 22999n && !plain.promotion);
    const hud = await priceConfigured(c, ENTITY, P.HUDSON, [{ group: "size", option: "96" }, { group: "fabric", option: "velvet-navy" }, { group: "legs", option: "walnut" }]);
    t.ok("pricing: configured sofa is base plus option deltas, cost too", hud.unitPriceMinor === 164900n && hud.unitCostMinor === 78000n && hud.config.fabric[0].vendorCode === "VV-NAV");
    const set = await priceConfigured(c, ENTITY, P.SET, []);
    t.ok("pricing: a package sells at its package price and shows what its pieces would cost",
      set.unitPriceMinor === 79999n && set.kit?.componentTotalMinor === 84997n && set.kit?.components.length === 2);
    const parts = await cat.explodeKit(c, ENTITY, P.SET, 79999n);
    t.ok("packages: exploded lines carry the package price to the cent", parts.reduce((a, b) => a + b.extendedMinor, 0n) === 79999n && parts.length === 2);
    const ott = await priceConfigured(c, ENTITY, P.OTTOMAN, []);
    t.ok("pricing: a dropped product still sells through", ott.unitPriceMinor === 24999n);
  });
  await read(t, (c) => t.throws("pricing: a draft product is not for sale", () => priceConfigured(c, ENTITY, P.LIFT, []), /draft and not for sale/));
  await read(t, (c) => t.throws("pricing: a made-to-order sofa without its choices is refused", () => priceConfigured(c, ENTITY, P.HUDSON, []), /choose a size/));

  // A promotion that would cut under MAP stops at MAP. Dated well ahead so no one else's prices move.
  const mapPromo = await r.post<{ id: string }>("/catalog/promotions", BUYER, { name: "Check: deep Darcy cut", kind: "percent", pct: 30, productId: P.DARCY,
    startsOn: day(200), endsOn: day(210) });
  await read(t, async (c) => {
    const x = await priceConfigured(c, ENTITY, P.DARCY, [], { on: day(205) });
    t.ok("pricing: a promotion that respects MAP stops at MAP", x.unitPriceMinor === 74999n && x.promotion?.savingsMinor === 5000n, String(x.unitPriceMinor));
    const now = await priceConfigured(c, ENTITY, P.DARCY, []);
    t.ok("pricing: a scheduled promotion does nothing before its start date", now.unitPriceMinor === 79999n);
  });
  await t.throws("promotions: ending one early needs a reason", () => r.post("/catalog/promotions/:id/end", BUYER, { reason: "" }, mapPromo.id), /say why/);
  await r.post("/catalog/promotions/:id/end", BUYER, { reason: "check finished" }, mapPromo.id);
  await read(t, async (c) => t.ok("promotions: an ended promotion no longer prices", (await priceConfigured(c, ENTITY, P.DARCY, [], { on: day(205) })).unitPriceMinor === 79999n));
  await t.throws("promotions: cannot end before it starts", () => r.post("/catalog/promotions", BUYER, { name: "x", kind: "percent", pct: 10, category: "Bedroom", startsOn: day(10), endsOn: day(5) }), /cannot end before/);
  await t.throws("promotions: a fixed price is for one product", () => r.post("/catalog/promotions", BUYER, { name: "x", kind: "fixed_price", amount: "99", category: "Bedroom", startsOn: day(1), endsOn: day(5) }), /one product/);
  await t.throws("promotions: an accounts-payable clerk cannot set prices", () => r.post("/catalog/promotions", PEOPLE.CLERK, { name: "x", kind: "percent", pct: 10, category: "Bedroom", startsOn: day(1), endsOn: day(5) }), /needs one of: buyer/);

  // --------------------------------------------------------- product master
  const made = await r.post<{ id: string }>("/catalog/products", BUYER, { sku: "GLB-CHK-01", name: "Check recliner", kind: "stock", vendorId: V.GLOBAL,
    vendorSku: "chk-01", category: "Living room", price: "499.00", cost: "210.00", map: "449" });
  t.ok("products: a buyer adds one and it starts as a draft", !!made.id);
  await t.throws("products: a SKU already used is refused", () => r.post("/catalog/products", BUYER, { sku: "ASH-2930338", name: "Again", price: "1", cost: "1" }), /already used/);
  await t.throws("products: a SKU with spaces is refused", () => r.post("/catalog/products", BUYER, { sku: "bad sku", name: "x" }), /capital letters/);
  await t.throws("products: the same vendor model twice is refused", () => r.post("/catalog/products", BUYER, { sku: "GLB-CHK-02", name: "x", vendorId: V.GLOBAL, vendorSku: "CHK-01" }), /already GLB-CHK-01/);
  await t.throws("products: a sales clerk without a buying role cannot add products", () => r.post("/catalog/products", PEOPLE.CLERK, { sku: "ZZ-1", name: "x" }), /needs one of: buyer/);
  await r.post("/catalog/products/:id/status", BUYER, { status: "active" }, made.id);
  await t.throws("products: an active product cannot be priced at zero", () => r.post("/catalog/products/:id", BUYER, { price: "0" }, made.id), /needs a price/);
  await r.post("/catalog/products/:id", BUYER, { price: "529.00", color: "Charcoal" }, made.id);
  const det = await r.get<{ product: Record<string, unknown>; marginBps: number }>("/catalog/products/:id", "", made.id);
  t.ok("products: an edit lands and the margin view follows it", det.product.price_minor === "52900" && det.product.color === "Charcoal" && det.marginBps === 6030, String(det.marginBps));
  await t.throws("products: activating a product with no price is refused", () => r.post("/catalog/products/:id/status", BUYER, { status: "active" }, P.LIFT), /needs a price/);
  await t.throws("status: a floor sample says why", () => r.post("/catalog/products/:id/status", STORE_MGR, { status: "floor_sample" }, made.id), /say why/);
  await r.post("/catalog/products/:id/status", STORE_MGR, { status: "floor_sample", note: "Enola showroom model" }, made.id);
  await t.throws("status: an AP clerk cannot change it", () => r.post("/catalog/products/:id/status", PEOPLE.CLERK, { status: "active" }, made.id), /needs one of/);
  const live = await r.post<{ id: string }>("/catalog/products", BUYER, { sku: "GLB-CHK-03", name: "Check glider", vendorId: V.GLOBAL, price: "349", cost: "150", status: "active" });
  const liveDet = await r.get<{ product: Record<string, unknown> }>("/catalog/products/:id", "", live.id);
  t.ok("products: a new product asked to be active is created active", liveDet.product.status === "active");
  await t.throws("products: a new product cannot start active without a price", () => r.post("/catalog/products", BUYER, { sku: "GLB-CHK-04", name: "Unpriced", cost: "10", status: "active" }), /needs a price before it can be active/);
  await t.throws("products: a new floor sample says why", () => r.post("/catalog/products", BUYER, { sku: "GLB-CHK-05", name: "Showroom", price: "100", status: "floor_sample" }), /say why/);
  await t.throws("products: an unknown starting status is refused", () => r.post("/catalog/products", BUYER, { sku: "GLB-CHK-06", name: "Odd", price: "100", status: "selling" }), /status must be one of/);
  const plainNew = await r.post<{ id: string }>("/catalog/products", BUYER, { sku: "GLB-CHK-07", name: "Check rocker", vendorId: V.GLOBAL, price: "299", cost: "120" });
  const plainDet = await r.get<{ product: Record<string, unknown> }>("/catalog/products/:id", "", plainNew.id);
  t.ok("products: with no status asked for, a new product is still a draft", plainDet.product.status === "draft");
  const list = await r.get<{ items: { id: string; status: string }[]; total: number }>("/catalog/products", `?vendor=${V.GLOBAL}&status=floor_sample`);
  t.ok("products: search by vendor and status finds it", list.items.some((x) => x.id === made.id) && list.items.every((x) => x.status === "floor_sample"));
  const search = await r.get<{ items: { sku: string }[] }>("/catalog/products", "?q=willowton&category=Bedroom");
  t.ok("products: text search with a category filter", search.items.length >= 3 && search.items.every((x) => /^ASH-B192/.test(x.sku)));

  // ---------------------------------------------------------- cartons, images
  await r.post("/catalog/products/:id/pieces", BUYER, { pieces: [{ label: "Back", cubicFt: 20, weightLb: 50 }, { label: "Seat and arms", cubicFt: 14.5, weightLb: 45 }] }, made.id);
  const withPieces = await r.get<{ product: Record<string, string>; pieces: unknown[] }>("/catalog/products/:id", "", made.id);
  t.ok("cartons: two pieces, and the product's cube and weight are their totals", withPieces.pieces.length === 2 && Number(withPieces.product.cubic_ft) === 34.5 && Number(withPieces.product.weight_lb) === 95);
  await t.throws("cartons: each piece needs a label", () => r.post("/catalog/products/:id/pieces", BUYER, { pieces: [{ label: "", cubicFt: 1 }] }, made.id), /needs a label/);
  await t.throws("images: an address that is not http(s) is refused", () => r.post("/catalog/products/:id/images", BUYER, { images: [{ url: "javascript:alert(1)" }] }, made.id), /not a web address/);
  await r.post("/catalog/products/:id/images", BUYER, { images: [{ url: "https://img.example.com/a.jpg" }, { url: "https://img.example.com/b.jpg", alt: "side" }] }, made.id);

  // ------------------------------------------------------------- packages
  await t.throws("packages: a package cannot contain itself", () => r.post("/catalog/products/:id/kit", BUYER, { components: [{ productId: P.SET, qty: 1 }, { productId: P.TABLE, qty: 1 }] }, P.SET), /cannot contain itself/);
  await t.throws("packages: a service cannot go in a package", () => r.post("/catalog/products/:id/kit", BUYER, { components: [{ productId: P.DELIVERY, qty: 1 }, { productId: P.TABLE, qty: 1 }] }, P.SET), /cannot go in a package/);
  await t.throws("packages: only a kit-kind product holds components", () => r.post("/catalog/products/:id/kit", BUYER, { components: [{ productId: P.TABLE, qty: 1 }, { productId: P.CHAIRS, qty: 2 }] }, P.DARCY), /not a package/);
  await r.post("/catalog/products/:id/kit", BUYER, { components: [{ productId: P.TABLE, qty: 1 }, { productId: P.CHAIRS, qty: 3 }] }, P.SET);
  const kitDet = await r.get<{ product: Record<string, string>; kit: unknown[] }>("/catalog/products/:id", "", P.SET);
  t.ok("packages: the package's cost follows its components", kitDet.product.cost_minor === String(19000 + 3 * 8200) && kitDet.kit.length === 2);
  await r.post("/catalog/products/:id/kit", BUYER, { components: [{ productId: P.TABLE, qty: 1 }, { productId: P.CHAIRS, qty: 2 }] }, P.SET);

  // ------------------------------------------------- options and templates
  await t.throws("options: a plain stock item takes no option groups", () => r.post("/catalog/products/:id/options", BUYER, { code: "fabric", label: "Fabric", options: [{ code: "a", label: "A" }] }, P.DARCY), /options go on configurable/);
  await t.throws("templates: a CUW template does not go on an Ashley product", () => r.post("/catalog/products/:id/apply-template", BUYER, { templateId: TEMPLATE }, P.NIGHTSTAND), /another vendor/);
  const ap = await r.post<{ groups: number }>("/catalog/products/:id/apply-template", BUYER, { templateId: TEMPLATE }, P.CHAIR);
  t.ok("templates: applying copies the vendor's groups onto the product", ap.groups === 2);
  await read(t, async (c) => {
    const ch = await priceConfigured(c, ENTITY, P.CHAIR, [{ group: "fabric", option: "grade-b-navy" }, { group: "legs", option: "black" }]);
    t.ok("templates: the applied options price and lead like the template", ch.unitPriceMinor === 77900n && ch.leadDays === 7 && ch.config.fabric[0].vendorCode === "GB-NAV");
  });
  await r.post("/catalog/products/:id/options", BUYER, { code: "fabric", label: "Fabric", options: [{ code: "grade-a-oat", label: "Grade A linen, oat" }, { code: "grade-c-cognac", label: "Grade C leather, cognac", priceDelta: "300", costDelta: "150", leadDays: 21, vendorCode: "GC-COG" }] }, P.CHAIR);
  await read(t, (c) => t.throws("options: an option left out of an edit is retired, not sold", () => priceConfigured(c, ENTITY, P.CHAIR, [{ group: "fabric", option: "grade-b-navy" }, { group: "legs", option: "black" }]), /not a fabric/));
  await t.throws("templates: a template needs a vendor or category", () => r.post("/catalog/templates", BUYER, { name: "Loose", groups: [{ code: "x", label: "X", options: [{ code: "a", label: "A" }] }] }), /vendor, a category/);
  const tpl = await r.post<{ id: string }>("/catalog/templates", BUYER, { name: "Check dining finishes", category: "Dining", groups: [{ code: "finish", label: "Finish", options: [{ code: "oak", label: "Oak" }, { code: "espresso", label: "Espresso", priceDelta: "40" }] }] });
  const tlist = await r.get<{ templates: { id: string; groups: { options: unknown[] }[] }[] }>("/catalog/templates");
  t.ok("templates: a category template is saved with its groups and options", tlist.templates.some((x) => x.id === tpl.id && x.groups[0].options.length === 2));

  // --------------------------------------------------------- price lists
  await t.throws("price lists: a negative price is refused", () => r.post("/catalog/price-lists/:id/items", BUYER, { items: [{ productId: P.DARCY, price: "-5" }] }, "7a7a7a7a-0000-0000-0000-000000000001"), /negative/);
  const pl = await r.post<{ id: string }>("/catalog/price-lists", BUYER, { code: "employee", name: "Employee pricing" });
  await r.post("/catalog/price-lists/:id/items", BUYER, { items: [{ productId: made.id, price: "399" }] }, pl.id);
  await r.post("/catalog/products/:id/status", BUYER, { status: "active" }, made.id);
  const emp = await r.get<{ unitPriceMinor: bigint; priceList: string }>("/catalog/price/:id", "?list=EMPLOYEE", made.id);
  t.ok("price lists: a named list prices through the price route", emp.unitPriceMinor === 39900n && emp.priceList === "EMPLOYEE");

  // ------------------------------------------------------- margins and tags
  const mg = await r.get<{ items: { id: string; landed_minor: string; margin_bps: number; promo_minor: string | null; below_map: boolean }[] }>("/catalog/margins", `?location=${DC}&vendor=${V.ASHLEY}`);
  const dm = mg.items.find((x) => x.id === P.DARCY)!;
  t.ok("margins: landed cost is cost plus the vendor's freight to that place", dm.landed_minor === String(38500 + 2310) && dm.margin_bps === Math.trunc(((79999 - 40810) * 10000) / 79999), `${dm.landed_minor} ${dm.margin_bps}`);
  t.ok("margins: the promoted price and its margin show beside the ticket", mg.items.find((x) => x.id === P.NIGHTSTAND)?.promo_minor === "18399");
  const tags = await r.get<{ items: { id: string; price_minor: string; promotion: unknown; barcode: { text: string; bars: number[] }; kit: unknown }[] }>("/catalog/labels", `?ids=${P.NIGHTSTAND},${P.SET},${P.LIFT}`);
  const nsTag = tags.items.find((x) => x.id === P.NIGHTSTAND)!;
  t.ok("tags: a promoted item's tag carries the sale price and a readable barcode",
    nsTag.price_minor === "18399" && !!nsTag.promotion && cat.decode128(nsTag.barcode.bars) === "ASH-B192-92");
  t.ok("tags: a package tag lists its pieces; a draft gets no tag", !!tags.items.find((x) => x.id === P.SET)?.kit && !tags.items.some((x) => x.id === P.LIFT));
  const barTag = await r.get<{ items: { barcode: { text: string } }[] }>("/catalog/labels", `?ids=${P.DARCY}`);
  t.ok("tags: the vendor's UPC is the barcode when there is one", barTag.items[0]?.barcode.text === "024052293033");

  // ---------------------------------------------------- vendor facts, freight
  await t.throws("vendors: an order email must be an address", () => r.post("/catalog/vendors/:id", BUYER, { orderEmail: "not-an-email" }, V.GLOBAL), /not an email/);
  await r.post("/catalog/vendors/:id", BUYER, { freightMin: "1200", leadDays: 35 }, V.GLOBAL);
  await r.post("/catalog/vendors/:id/freight", BUYER, { locationId: LOC.SOCORRO, pct: 11.5, perUnit: "20" }, V.GLOBAL);
  const vs = await r.get<{ vendors: { id: string; lead_days: number; freight_min_minor: string; order_email: string; freight: { location_id: string; freight_bps: number }[] }[] }>("/catalog/vendors");
  const g = vs.vendors.find((x) => x.id === V.GLOBAL)!;
  t.ok("vendors: lead time and freight minimum change, the order email stays", g.lead_days === 35 && g.freight_min_minor === "120000" && g.order_email === "sales@globalfurniture.example"
    && g.freight.some((f) => f.location_id === LOC.SOCORRO && f.freight_bps === 1150));

  // -------------------------------------------------------------- the import
  const csv = [
    "Model #,Description,Regular Cost,Retail,Cube,Weight,Cartons,Item Status,Image",
    "U8303,\"Recliner, power\",290.00,,,,,active,",              // same as on file; blanks erase nothing
    "U9900,\"Lift chair, power\",$420.00,,,,,,",                 // cost changed
    "U7000,Glider recliner,250.00,599.00,30,90,2,,https://img.example.com/u7000.jpg",   // new, priced, two cartons
    "U7001,Wall hugger recliner,230.00,,,,,,",                  // new, unpriced: draft
    ",No model number,1.00,,,,,,",                              // skipped
    "U7000,Glider again,250.00,599.00,,,,,",                    // repeated model: skipped
    "U7002,Bad cost,twelve,,,,,,",                              // skipped
  ].join("\n");
  const cols = await r.post<{ mapping: Record<string, string>; missing: string[] }>("/catalog/import/columns", BUYER, { csv });
  t.ok("import: the columns are read and mapped by their headings", cols.missing.length === 0 && cols.mapping.vendor_sku === "Model #" && cols.mapping.price === "Retail");
  await t.throws("import: preview refuses until every required field has a column", () => r.post("/catalog/import/preview", BUYER, { vendorId: V.GLOBAL, csv, mapping: { vendor_sku: "Model #", name: "Description" } }), /pick a column for cost/);
  await t.throws("import: an AP clerk cannot import", () => r.post("/catalog/import/columns", PEOPLE.CLERK, { csv }), /needs one of: buyer/);
  const pv = await r.post<{ runId: string; add: number; change: number; same: number; skip: number }>("/catalog/import/preview", BUYER, { vendorId: V.GLOBAL, csv, mapping: cols.mapping, filename: "global.csv" });
  t.ok("import: the preview counts what building would do", pv.add === 2 && pv.change === 1 && pv.same === 1 && pv.skip === 3, JSON.stringify(pv));
  const before = await r.get<{ product: Record<string, string> }>("/catalog/products/:id", "", P.LIFT);
  t.ok("import: a preview changes nothing", before.product.cost_minor === "41000");
  const runDet = await r.get<{ rows: { action: string; message: string | null; changes: Record<string, unknown> }[] }>("/catalog/import/runs/:id", "", pv.runId);
  t.ok("import: skipped rows say why, changed rows say what", runDet.rows.filter((x) => x.action === "skip").every((x) => !!x.message)
    && runDet.rows.some((x) => x.action === "change" && JSON.stringify(x.changes) === '{"cost_minor":["41000","42000"]}'));
  const ap1 = await r.post<{ add: number; change: number; same: number; skip: number }>("/catalog/import/runs/:id/apply", BUYER, {}, pv.runId);
  t.ok("import: applying adds, changes and leaves the rest", ap1.add === 2 && ap1.change === 1 && ap1.same === 1 && ap1.skip === 3);
  const after = await r.get<{ product: Record<string, string> }>("/catalog/products/:id", "", P.LIFT);
  t.ok("import: the changed cost is on the product, its draft status kept", after.product.cost_minor === "42000" && after.product.status === "draft");
  const added = await r.get<{ items: { id: string; sku: string; status: string; pieces: string; image: string | null }[] }>("/catalog/products", "?q=GLB-U70");
  const u7000 = added.items.find((x) => x.sku === "GLB-U7000"), u7001 = added.items.find((x) => x.sku === "GLB-U7001");
  t.ok("import: new products get the vendor's SKU prefix; priced ones are active with cartons and image",
    u7000?.status === "active" && Number(u7000?.pieces) === 2 && u7000?.image === "https://img.example.com/u7000.jpg");
  t.ok("import: an unpriced new product arrives as a draft", u7001?.status === "draft");
  await t.throws("import: a run cannot be applied twice", () => r.post("/catalog/import/runs/:id/apply", BUYER, {}, pv.runId), /already applied/);
  const pv2 = await r.post<{ add: number; change: number; same: number }>("/catalog/import/preview", BUYER, { vendorId: V.GLOBAL, csv, mapping: cols.mapping });
  t.ok("import: the same file again is all unchanged", pv2.add === 0 && pv2.change === 0 && pv2.same === 4, JSON.stringify(pv2));
  const disc = await r.post<{ runId: string; change: number }>("/catalog/import/preview", BUYER, { vendorId: V.GLOBAL, csv: "model,name,cost,status\nU7000,Glider recliner,250,discontinued\n", mapping: { vendor_sku: "model", name: "name", cost: "cost", status: "status" } });
  await r.post("/catalog/import/runs/:id/apply", BUYER, {}, disc.runId);
  const dropped = await r.get<{ items: { status: string }[] }>("/catalog/products", "?q=GLB-U7000");
  t.ok("import: a vendor discontinuing a model makes it a drop (sell through, never reorder)", dropped.items[0]?.status === "drop" && disc.change === 1);

  // ------------------------------------------------------------ isolation
  await rio(t, (c) => t.throws("isolation: another company cannot price this company's product", () => priceConfigured(c, RIO_ENTITY, P.DARCY, []), /no such product/));
  await rio(t, (c, s) => t.throws("isolation: another company cannot import into this company's vendor", () => cat.previewImport(c, s, { vendorId: V.ASHLEY, csv, mapping: cols.mapping }), /not set up for this company/));
  await rio(t, (c, s) => t.throws("isolation: another company cannot edit this company's product", () => cat.updateProduct(c, s, P.DARCY, { name: "Hijacked" }), /no such product/));
  await rio(t, (c, s) => t.throws("isolation: another company cannot apply this company's template", () => cat.applyTemplate(c, s, TEMPLATE, P.CHAIR), /no such template/));
  const rioList = await r.get<{ total: number }>("/catalog/products", "", undefined, RIO_ENTITY);
  const rioRuns = await r.get<{ runs: unknown[] }>("/catalog/import/runs", "", undefined, RIO_ENTITY);
  t.ok("isolation: another company's catalog and import history show none of this company's", rioList.total === 0 && rioRuns.runs.length === 0);
  const rioDet = await r.get("/catalog/products/:id", "", P.DARCY, RIO_ENTITY);
  t.ok("isolation: another company asking for this company's product gets not found", rioDet === null);

  // --------------------------------------------- photo fetcher stays public
  const priv = ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"];
  t.ok("photos: every private, loopback, link-local and carrier-NAT address is refused", priv.every((ip) => cat.isPrivateIp(ip)));
  t.ok("photos: public addresses are allowed", ["8.8.8.8", "151.101.1.69", "2606:4700::1111"].every((ip) => !cat.isPrivateIp(ip)));
  {
    const c = await t.pool.connect();
    try {
      const prod = (await c.query(`select product_id, seq from product_image where entity_id = $1 limit 1`, [ENTITY])).rows[0];
      if (prod) {
        await c.query(`delete from catalog_image_cache where entity_id = $1`, [ENTITY]);
        const asked: string[] = [];
        const redirecting: cat.ImageFetch = async (url) => { asked.push(url);
          return { status: 302, headers: { get: (k: string) => (k === "location" ? "https://169.254.169.254/latest/meta-data" : null) }, arrayBuffer: async () => new ArrayBuffer(0) }; };
        let msg = "";
        try { await cat.productImage(c, ENTITY, prod.product_id, prod.seq, redirecting); } catch (e) { msg = (e as Error).message; }
        t.ok("photos: a redirect to a private address is refused before it is asked", /private networks/.test(msg) && asked.length === 1, msg);
      } else t.ok("photos: a demo product has a photo to test with", false);
    } finally { c.release(); }
  }

}
