// configurator module -- sectionals, grades and swatches, option rules, and
// condition grades on as-is pieces. See docs/MODULES.md "Configurator".
// Routes under /api/c/<company>/cfg/... The rules live in
// packages/core/configurator.ts (and the rule engine in pricing.ts); this file
// decides who may do what and reads requests.
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, need, requireRole, str, uuid, int, minor, seesCost, scrubCost } from "./kit.ts";
import { priceListOf } from "../../packages/core/pos.ts";
import { q } from "../../packages/core/db.ts";
import { scopeOf } from "../actions.ts";
import * as cfg from "../../packages/core/configurator.ts";
import { PricingError, type Choice } from "../../packages/core/pricing.ts";
import { CatalogError } from "../../packages/core/catalog.ts";
import { InventoryError } from "../../packages/core/inventory.ts";
import { currentImageFetch } from "./catalog.ts";
import { sectionalBuild } from "./pos.ts";

const ID = "([0-9a-fA-F-]{36})";
const LABEL = "([A-Za-z0-9][A-Za-z0-9_-]{0,39})";
/** Who sets up sectionals, grades, covers and rules: the buyer, as for the rest of the catalog. */
const BUY = ["buyer"];
/** Who prices a build for a customer: the sales floor, the register, the tablet and the web admin. */
const SELL = ["sales", "cashier", "store_manager", "web_admin", "buyer", "designer"];
/** Who grades a piece: the people who handle as-is stock. */
const GRADE = ["warehouse", "store_manager", "buyer"];
/** Who sets a price by hand or changes the company's grade percentages. */
const MANAGER = ["store_manager"];
const RULES = ["controller"];

async function refuse<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof cfg.ConfigError || e instanceof PricingError || e instanceof CatalogError || e instanceof InventoryError) throw new ModuleError(e.message);
    throw e;
  }
}
const sc = (co: Company, a: Actor) => scopeOf(co, a);
const num = (v: unknown, what: string) => { const n = Number(v); need(v !== "" && v != null && Number.isFinite(n), `Give the ${what} as a number.`); return n; };
const optNum = (v: unknown) => (v === "" || v == null ? null : Number(v));
const pct = (v: unknown, what: string) => { const n = Number(v); need(v !== "" && v != null && Number.isFinite(n), `Give ${what} as a percent.`); return Math.round(n * 100); };
const codes = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => str(x, 60)).filter(Boolean);
function choicesOf(v: unknown): Choice[] {
  if (Array.isArray(v)) return v.map((x: Record<string, unknown>) => ({ group: str(x?.group, 40), option: Array.isArray(x?.option) ? x.option.map((o) => str(o, 60)) : str(x?.option, 60) }));
  return [];
}

async function options(c: Client, co: Company) {
  const [fams, tables, locations] = [await cfg.families(c, co.id), await cfg.gradeTables(c, co.id),
    (await q(c, `select id, code, name, kind from location where entity_id = $1 and status = 'active' and kind in ('store','outlet','warehouse') order by kind desc, name`, [co.id]))];
  const vendors = await q(c, `select v.id, coalesce(v.dba, v.legal_name) name from vendor_entity ve join vendor v on v.id = ve.vendor_id
    where ve.entity_id = $1 and ve.status = 'active' order by 2`, [co.id]);
  const configurable = await q(c, `select id, sku, name from product where entity_id = $1 and kind = 'configurable' and status <> 'discontinued'
    and exists (select 1 from product_option_group g where g.entity_id = product.entity_id and g.product_id = product.id) order by name limit 300`, [co.id]);
  return { families: fams, gradeTables: tables, locations, vendors, configurable, pieceTypes: cfg.PIECE_TYPES.map((t) => ({ code: t, label: cfg.pieceWords(t), sides: cfg.sidesOf(t) })),
    motions: cfg.MOTIONS, colorFamilies: cfg.COLOR_FAMILIES, cleaning: cfg.CLEANING, conditions: cfg.CONDITIONS.map((g) => ({ code: g, label: cfg.CONDITION_WORDS[g] })),
    conditionRules: await cfg.gradeRules(c, co.id) };
}

export const module: ErpModule = {
  id: "configurator",
  register({ coGet, coPost }) {
    // ------------------------------------------------------------ reading
    // Costs (piece cost, grade cost adders and uplifts) only for those who may see them.
    const guard = async <R>(c: Client, co: Company, p: string | null, v: R) => (await seesCost(c, co, p) ? v : scrubCost(v));
    coGet("/cfg/options", async (c, co, _u, _m, p) => guard(c, co, p, await options(c, co)));
    coGet("/cfg/families", (c, co) => cfg.families(c, co.id));
    coGet(`/cfg/families/${ID}`, async (c, co, _u, m, p) => guard(c, co, p, await cfg.familyView(c, co.id, m[2])));
    coGet("/cfg/grade-tables", async (c, co, _u, _m, p) => guard(c, co, p, await cfg.gradeTables(c, co.id)));
    coGet("/cfg/swatches", async (c, co, url) => {
      const p = url.searchParams;
      return (await cfg.swatches(c, co.id, { tableId: uuid(p.get("table")), grade: str(p.get("grade"), 12).toUpperCase() || null, colorFamily: str(p.get("color"), 20) || null,
        includeRetired: p.get("retired") === "1", q: str(p.get("q"), 60) || null })).map((x) => cfg.swatchView(x));
    });
    coGet(`/cfg/swatches/${ID}/image`, (c, co, _u, m) => refuse(() => cfg.swatchImage(c, co.id, m[2], currentImageFetch())));
    coGet("/cfg/rules", (c, co, url) => cfg.rulesFor(c, co.id, uuid(url.searchParams.get("product"))));
    coGet(`/cfg/orders/${ID}/sets`, async (c, co, _u, m, p) => guard(c, co, p, await cfg.setsForOrder(c, co.id, m[2])));
    coGet("/cfg/condition/rules", (c, co) => cfg.gradeRules(c, co.id));
    coGet(`/cfg/condition/${LABEL}`, (c, co, _u, m) => refuse(() => cfg.conditionOf(c, co.id, m[2])));
    coGet("/cfg/asis/report", (c, co, url) => cfg.asIsReport(c, co.id, { locationId: uuid(url.searchParams.get("location")) }));
    coGet("/cfg/asis/tags", (c, co, url) => refuse(() => cfg.asIsTags(c, co.id, codes(url.searchParams.get("labels")))));

    // ------------------------------------------------- pricing a build
    coPost("/cfg/price", async (c, co, a, b) => {
      const held = await requireRole(c, co, a, SELL, "pricing a sectional");
      const build = sectionalBuild(b.sectional ?? b);
      need(build, "Choose a layout or the pieces.");
      // A customer with a trade account is priced by its list, as the register will ring it.
      const priceList = await priceListOf(c, co.id, uuid(b.customerId));
      const priced = await refuse(() => cfg.priceBuild(c, co.id, uuid(b.productId) ?? "", build!, { priceList }));
      const out = { ...cfg.pricedView(priced), priceList: priced.parts.find((x) => x.priceList)?.priceList ?? null, svg: cfg.layoutSvg(priced.geometry) };
      return held.has("owner") || ["buyer", "controller", "store_manager"].some((r) => held.has(r)) ? out : scrubCost(out);
    });

    // ------------------------------------------------------- set-up
    coPost("/cfg/families", async (c, co, a, b) => {
      await requireRole(c, co, a, BUY, "setting up a sectional");
      const id = await refuse(() => cfg.saveFamily(c, sc(co, a), {
        productId: uuid(b.productId), sku: str(b.sku, 40) || undefined, name: str(b.name, 200) || undefined, vendorId: uuid(b.vendorId),
        priceMinor: b.price != null && b.price !== "" ? minor(b.price) : undefined,
        minPieces: b.minPieces != null && b.minPieces !== "" ? int(b.minPieces) : undefined, maxPieces: b.maxPieces != null && b.maxPieces !== "" ? int(b.maxPieces) : undefined,
        bundleDiscountBps: b.bundlePct != null && b.bundlePct !== "" ? pct(b.bundlePct, "the bundle discount") : undefined,
        bundleMinPieces: b.bundleMinPieces != null && b.bundleMinPieces !== "" ? int(b.bundleMinPieces) : undefined,
        gradeTableId: b.gradeTableId === undefined ? undefined : uuid(b.gradeTableId), stockCover: b.stockCover === undefined ? undefined : (str(b.stockCover, 60) || null),
        notes: b.notes === undefined ? undefined : (str(b.notes, 1000) || null), active: b.active === undefined ? undefined : b.active === true || b.active === "true" }));
      return { id };
    });
    coPost(`/cfg/families/${ID}/pieces`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BUY, "setting up a sectional piece");
      const id = await refuse(() => cfg.savePiece(c, sc(co, a), {
        familyId: m[2], code: str(b.code, 40), pieceType: str(b.pieceType, 30), motion: str(b.motion, 10) || undefined,
        widthIn: num(b.widthIn, "width"), depthIn: num(b.depthIn, "depth"), heightIn: optNum(b.heightIn), seats: b.seats == null || b.seats === "" ? undefined : int(b.seats),
        productId: uuid(b.productId), sku: str(b.sku, 40) || undefined, name: str(b.name, 200) || undefined,
        priceMinor: b.price != null && b.price !== "" ? minor(b.price) : undefined, costMinor: b.cost != null && b.cost !== "" ? minor(b.cost) : undefined,
        cubicFt: b.cubicFt === undefined ? undefined : optNum(b.cubicFt), weightLb: b.weightLb === undefined ? undefined : optNum(b.weightLb),
        vendorSku: b.vendorSku === undefined ? undefined : (str(b.vendorSku, 60).toUpperCase() || null), active: b.active === undefined ? undefined : b.active !== false }));
      return { id };
    });
    coPost(`/cfg/families/${ID}/layouts`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BUY, "saving a sectional layout");
      const id = await refuse(() => cfg.saveLayout(c, sc(co, a), { familyId: m[2], code: str(b.code, 60), name: str(b.name, 160), pieces: codes(b.pieces),
        popular: b.popular !== false, active: b.active !== false }));
      return { id };
    });
    coPost("/cfg/grade-tables", async (c, co, a, b) => {
      await requireRole(c, co, a, BUY, "changing a vendor's grade table");
      const grades = (Array.isArray(b.grades) ? b.grades : []).slice(0, 40).map((g: Record<string, unknown>) => ({
        code: str(g.code, 12), label: str(g.label, 60) || undefined,
        upliftBps: g.upliftPct == null || g.upliftPct === "" ? 0 : pct(g.upliftPct, "the uplift"),
        costUpliftBps: g.costUpliftPct == null || g.costUpliftPct === "" ? 0 : pct(g.costUpliftPct, "the cost uplift"),
        adders: Array.isArray(g.adders) ? g.adders.slice(0, 20).map((x: Record<string, unknown>) => ({ pieceType: str(x.pieceType, 30), priceMinor: minor(x.price ?? 0),
          costMinor: minor(x.cost ?? 0) })) : undefined }));
      const id = await refuse(() => cfg.saveGradeTable(c, sc(co, a), { code: str(b.code, 24), name: str(b.name, 120), vendorId: uuid(b.vendorId), grades }));
      return { id };
    });
    coPost("/cfg/swatches", async (c, co, a, b) => {
      await requireRole(c, co, a, BUY, "changing the swatch library");
      const id = await refuse(() => cfg.saveSwatch(c, sc(co, a), { tableId: uuid(b.tableId) ?? "", code: str(b.code, 60), name: str(b.name, 120), grade: str(b.grade, 12),
        material: str(b.material, 20) || undefined, colorFamily: str(b.colorFamily, 20) || undefined, color: str(b.color, 60) || null, content: str(b.content, 160) || null,
        cleaningCode: str(b.cleaningCode, 2).toUpperCase() || null, vendorCode: str(b.vendorCode, 60) || null, imageUrl: str(b.imageUrl, 1000) || null,
        hex: str(b.hex, 7) || null, discontinuedOn: str(b.discontinuedOn, 10) || null }));
      return { id };
    });
    coPost("/cfg/rules", async (c, co, a, b) => {
      await requireRole(c, co, a, BUY, "setting an option rule");
      const id = await refuse(() => cfg.saveRule(c, sc(co, a), { productId: uuid(b.productId) ?? "", group: str(b.group, 40), option: str(b.option, 60) || null,
        kind: str(b.kind, 10), targetGroup: str(b.targetGroup, 40) || null, targetOptions: codes(b.targetOptions), pieceTypes: codes(b.pieceTypes), message: str(b.message, 300) || null }));
      return { id };
    });
    coPost(`/cfg/rules/${ID}/retire`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BUY, "retiring an option rule");
      await refuse(() => cfg.retireRule(c, sc(co, a), m[2], str(b.reason, 300)));
      return { ok: true };
    });

    // ------------------------------------------------- condition grades
    coPost("/cfg/condition/rules", async (c, co, a, b) => {
      await requireRole(c, co, a, RULES, "changing the as-is price per grade");
      const rules: Record<string, number> = {};
      for (const g of cfg.CONDITIONS) if (b[g] != null && b[g] !== "") rules[g] = pct(b[g], `the ${cfg.CONDITION_WORDS[g].toLowerCase()} price`);
      return refuse(() => cfg.saveGradeRules(c, sc(co, a), rules));
    });
    coPost(`/cfg/condition/${LABEL}/grade`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, GRADE, "grading an as-is piece");
      const mgr = held.has("owner") || MANAGER.some((r) => held.has(r));
      const override = b.price != null && b.price !== "" ? minor(b.price) : null;
      return refuse(() => cfg.gradePiece(c, sc(co, a), m[2], { grade: str(b.grade, 12), source: str(b.source, 20) || null, notes: str(b.notes, 1000) || null,
        photos: Array.isArray(b.photos) ? b.photos.map((x) => String(x ?? "")) : [], overrideMinor: override, overrideReason: str(b.reason, 300) || null }, mgr));
    });
  },
};
