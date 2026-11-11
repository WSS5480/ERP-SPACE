// The configurator (migration 0043). Sectionals built from pieces, fabric and
// leather grades with a swatch library, option rules, condition grades on
// as-is pieces, and the vendor catalog extras that feed them.
//
// It sells nothing itself. A sectional priced here comes back as parts, one
// per piece, each a real SKU; POS (insertLines), the endless aisle and the web
// store write those parts as ordinary order lines and record the set with
// recordSet, so inventory reserves, purchasing orders, the fleet loads and
// POS returns piece by piece. Who may do what is decided in
// server/modules/configurator.ts.

import { today as bizToday } from "./clock.ts";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import { priceConfigured, listPrice, PricingError, checkOptionRules, optionRules, type Choice, type OptionRule } from "./pricing.ts";
import { imageByUrl, code128, createProduct, updateProduct, CatalogError, type ImageFetch } from "./catalog.ts";
import { pieceAction, setAsIsPrice, setLotClass, InventoryError } from "./inventory.ts";

export class ConfigError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new ConfigError(msg); };
const bps = (m: bigint, rate: number): bigint => { const neg = m < 0n; const a = neg ? -m : m; const r = (a * BigInt(rate) + 5000n) / 10000n; return neg ? -r : r; };
const usd = (m: bigint) => `$${(m / 100n).toLocaleString("en-US")}.${String(m % 100n).padStart(2, "0")}`;
const U = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Core refusals from the modules this one calls, as configurator refusals. */
async function relay<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof PricingError || e instanceof CatalogError || e instanceof InventoryError) throw new ConfigError(e.message);
    throw e;
  }
}

// =============================================================== pieces

export const PIECE_TYPES = ["laf_sofa", "raf_sofa", "laf_loveseat", "raf_loveseat", "laf_chair", "raf_chair", "armless_chair", "armless_loveseat",
  "wedge", "corner", "ottoman", "laf_chaise", "raf_chaise", "console"] as const;
export type PieceType = typeof PIECE_TYPES[number];
export const MOTIONS = ["none", "manual", "power"] as const;

/** Which sides carry an arm, as you face the piece: [left, right]. An ottoman stands free. */
export function sidesOf(t: string): ["arm" | "open", "arm" | "open"] | null {
  if (t === "ottoman") return null;
  if (t.startsWith("laf_")) return ["arm", "open"];
  if (t.startsWith("raf_")) return ["open", "arm"];
  return ["open", "open"];
}
/** Pieces that turn the run 90 degrees. */
export const TURNS = new Set(["wedge", "corner"]);
export const pieceWords = (t: string) => t.replace(/^laf_/, "LAF ").replace(/^raf_/, "RAF ").replace(/_/g, " ");

export type PieceRow = {
  id: string; product_id: string; code: string; piece_type: string; motion: string; width_in: number; depth_in: number; height_in: number | null;
  seats: number; seq: number; active: boolean; sku: string; name: string; price_minor: string; cost_minor: string; cubic_ft: number | null;
  weight_lb: number | null; vendor_sku: string | null; status: string; kind: string; taxable: boolean; ship_class: string;
};
export type FamilyRow = {
  product_id: string; sku: string; name: string; status: string; vendor_id: string | null; min_pieces: number; max_pieces: number;
  bundle_discount_bps: number; bundle_min_pieces: number; grade_table_id: string | null; stock_swatch_id: string | null; notes: string | null; active: boolean;
};
type LayoutRow = { id: string; code: string; name: string; pieces: string[]; popular: boolean; seq: number; active: boolean };

export async function familyRow(c: Client, entityId: string, productId: string): Promise<FamilyRow | null> {
  if (!U.test(productId)) return null;
  return (await q<FamilyRow>(c, `
    select f.product_id, p.sku, p.name, p.status, p.vendor_id, f.min_pieces, f.max_pieces, f.bundle_discount_bps, f.bundle_min_pieces,
           f.grade_table_id, f.stock_swatch_id, f.notes, f.active
      from sectional_family f join product p on p.id = f.product_id and p.entity_id = f.entity_id
     where f.entity_id = $1 and f.product_id = $2`, [entityId, productId]))[0] ?? null;
}
export const isFamily = async (c: Client, entityId: string, productId: string) => !!(await familyRow(c, entityId, productId));

async function piecesOf(c: Client, entityId: string, familyId: string, activeOnly = true): Promise<PieceRow[]> {
  return q<PieceRow>(c, `
    select sp.id, sp.product_id, sp.code, sp.piece_type, sp.motion, sp.width_in::float width_in, sp.depth_in::float depth_in, sp.height_in::float height_in,
           sp.seats, sp.seq, sp.active, p.sku, p.name, p.price_minor, p.cost_minor, p.cubic_ft::float cubic_ft, p.weight_lb::float weight_lb, p.vendor_sku,
           p.status, p.kind, p.taxable, p.ship_class
      from sectional_piece sp join product p on p.id = sp.product_id and p.entity_id = sp.entity_id
     where sp.entity_id = $1 and sp.family_id = $2 and ($3 = false or sp.active) order by sp.seq, sp.code`, [entityId, familyId, activeOnly]);
}
async function layoutsOf(c: Client, entityId: string, familyId: string): Promise<LayoutRow[]> {
  return q<LayoutRow>(c, `select id, code, name, pieces, popular, seq, active from sectional_layout
    where entity_id = $1 and family_id = $2 and active order by seq, name`, [entityId, familyId]);
}

// ======================================================== layout rules

/**
 * A layout reads left to right as you face the sectional. Its ends must be
 * arms facing out, and pieces join only where both touching sides are open.
 * Ottomans stand free and do not join. Every refusal is a sentence.
 */
export function validateLayout(fam: Pick<FamilyRow, "name" | "min_pieces" | "max_pieces">, chosen: Pick<PieceRow, "code" | "piece_type" | "name">[]): void {
  need(chosen.length, `Choose the pieces of the ${fam.name}.`);
  need(chosen.length >= fam.min_pieces && chosen.length <= fam.max_pieces,
    `A ${fam.name} is ${fam.min_pieces} to ${fam.max_pieces} pieces; this one has ${chosen.length}.`);
  const run = chosen.filter((p) => p.piece_type !== "ottoman");
  need(run.length, "An ottoman alone is not a sectional; add the seating pieces.");
  const w = (p: { piece_type: string }) => pieceWords(p.piece_type);
  const first = run[0], last = run[run.length - 1];
  need(sidesOf(first.piece_type)![0] === "arm",
    `The left end is the ${w(first)}, which has an open side facing out. A sectional ends in an arm at each end: start it with a LAF piece.`);
  need(sidesOf(last.piece_type)![1] === "arm",
    `The right end is the ${w(last)}, which has an open side facing out. A sectional ends in an arm at each end: finish it with a RAF piece.`);
  for (let i = 0; i + 1 < run.length; i++) {
    const a = run[i], b = run[i + 1];
    need(sidesOf(a.piece_type)![1] === "open", `The ${w(a)}'s arm would face into the ${w(b)}; pieces join only on their armless sides.`);
    need(sidesOf(b.piece_type)![0] === "open", `The ${w(b)}'s arm would face into the ${w(a)}; pieces join only on their armless sides.`);
    need(!(TURNS.has(a.piece_type) && TURNS.has(b.piece_type)), `Two corner pieces (${w(a)} and ${w(b)}) cannot sit side by side.`);
  }
  const turns = run.filter((p) => TURNS.has(p.piece_type)).length;
  need(turns <= 2, `A sectional turns at most two corners; this one has ${turns} corner pieces.`);
}

// ============================================================== geometry

export type Rect = { x: number; y: number; w: number; h: number };
export type PlanPiece = Rect & { code: string; type: string; label: string; seats: number; arms: Rect[]; back: Rect[]; free: boolean };
export type Geometry = { widthIn: number; depthIn: number; seats: number; pieces: PlanPiece[]; viewW: number; viewH: number };

const ARM = 6, BACK = 8;
function box(pts: [number, number][]): Rect {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
const half = (n: number) => Math.round(n * 2) / 2;

/**
 * The plan, top down, in inches, read left to right as you face it. A corner
 * or wedge turns the run 90 degrees. Overall width and
 * depth are the seating's outside box (ottomans stand in front, not counted).
 */
export function geometry(chosen: Pick<PieceRow, "code" | "piece_type" | "width_in" | "depth_in" | "seats" | "name">[]): Geometry {
  // An L starts along the back wall and its return comes forward on the right; a U starts up
  // the left wall, runs along the back and comes forward on the right.
  const turns = chosen.filter((x) => TURNS.has(x.piece_type)).length;
  let cx = 0, cy = 0, hx = turns >= 2 ? 0 : 1, hy = turns >= 2 ? -1 : 0;
  const out: PlanPiece[] = [];
  const at = (ax: number, ay: number, along: number, inside: number): [number, number] => {
    const nx = -hy, ny = hx;
    return [ax + hx * along + nx * inside, ay + hy * along + ny * inside];
  };
  for (const p of chosen.filter((x) => x.piece_type !== "ottoman")) {
    const W = Number(p.width_in), D = Number(p.depth_in);
    const r = box([at(cx, cy, 0, 0), at(cx, cy, W, 0), at(cx, cy, W, D), at(cx, cy, 0, D)]);
    const sides = sidesOf(p.piece_type)!;
    const arms: Rect[] = [];
    if (sides[0] === "arm") arms.push(box([at(cx, cy, 0, 0), at(cx, cy, ARM, D)]));
    if (sides[1] === "arm") arms.push(box([at(cx, cy, W - ARM, 0), at(cx, cy, W, D)]));
    const back: Rect[] = [box([at(cx, cy, 0, 0), at(cx, cy, W, BACK)])];
    if (TURNS.has(p.piece_type)) back.push(box([at(cx, cy, W - BACK, 0), at(cx, cy, W, D)]));
    out.push({ ...r, code: p.code, type: p.piece_type, label: pieceWords(p.piece_type), seats: p.seats, arms, back, free: false });
    if (TURNS.has(p.piece_type)) {
      const [nx, ny] = [-hy, hx];
      cx = cx + hx * W + nx * D; cy = cy + hy * W + ny * D;
      [hx, hy] = [nx, ny];
    } else { cx += hx * W; cy += hy * W; }
  }
  const all = out.length ? out : [{ x: 0, y: 0, w: 0, h: 0 } as PlanPiece];
  const minX = Math.min(...all.map((r) => r.x)), minY = Math.min(...all.map((r) => r.y));
  const shift = (r: Rect) => { r.x = half(r.x - minX); r.y = half(r.y - minY); r.w = half(r.w); r.h = half(r.h); };
  for (const p of out) { shift(p); p.arms.forEach(shift); p.back.forEach(shift); }
  const width = Math.max(0, ...out.map((r) => r.x + r.w)), depth = Math.max(0, ...out.map((r) => r.y + r.h));
  // Ottomans in front of the seating, side by side, centred.
  const ots = chosen.filter((x) => x.piece_type === "ottoman");
  let ox = Math.max(0, (width - ots.reduce((a, o) => a + Number(o.width_in) + 6, -6)) / 2);
  const oy = depth + 14;
  for (const o of ots) {
    out.push({ x: half(ox), y: half(oy), w: Number(o.width_in), h: Number(o.depth_in), code: o.code, type: o.piece_type, label: "ottoman", seats: 0, arms: [], back: [], free: true });
    ox += Number(o.width_in) + 6;
  }
  const viewW = Math.max(width, ...out.map((r) => r.x + r.w)), viewH = Math.max(depth, ...out.map((r) => r.y + r.h));
  return { widthIn: half(width), depthIn: half(depth), seats: chosen.reduce((a, p) => a + Number(p.seats), 0), pieces: out, viewW, viewH };
}

const xml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
/** The plan as a standalone SVG (no script, no style element, every word escaped) for printing and tags. */
export function layoutSvg(g: Geometry): string {
  const pad = 4, W = g.viewW + pad * 2, H = g.viewH + pad * 2 + 10;
  const r = (x: Rect, fill: string, stroke = "#3d3a36") =>
    `<rect x="${x.x + pad}" y="${x.y + pad}" width="${x.w}" height="${x.h}" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/>`;
  const parts = g.pieces.map((p) => [r(p, p.free ? "#efe9df" : "#e3d9c8"), ...p.back.map((b) => r(b, "#b9ab94")), ...p.arms.map((a) => r(a, "#9c8b72")),
    `<text x="${p.x + pad + p.w / 2}" y="${p.y + pad + p.h / 2 + 2}" font-size="5" text-anchor="middle" fill="#2b2925">${xml(p.label)}</text>`].join(""));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${xml(`Sectional plan, ${g.widthIn} by ${g.depthIn} inches, seats ${g.seats}`)}">`
    + parts.join("") + `<text x="${pad}" y="${H - 2}" font-size="5" fill="#2b2925">${xml(`${g.widthIn}" W × ${g.depthIn}" D · seats ${g.seats}`)}</text></svg>`;
}

// ============================================================== pricing

export type Build = { layout?: string | null; pieces?: string[]; cover?: string | null; pieceOptions?: Choice[][] };
export type SwatchRow = { id: string; code: string; cover_name: string; grade_code: string; material: string; color_family: string; color: string | null;
  content: string | null; cleaning_code: string | null; vendor_code: string | null; image_url: string | null; hex: string | null;
  discontinued_on: string | null; active: boolean; grade_table_id: string };
export type Part = {
  productId: string; sku: string; name: string; description: string; pieceCode: string; pieceType: string; position: number;
  kind: string; taxable: boolean; shipClass: string; cubicFt: number; weightLb: number;
  baseMinor: bigint; gradeAdderMinor: bigint; optionsMinor: bigint; grossMinor: bigint; bundleShareMinor: bigint; netMinor: bigint; costMinor: bigint;
  leadDays: number; special: boolean; options: { group: string; code: string; label: string; vendorCode: string | null; deltaMinor: string }[];
  config: Record<string, unknown>;
  /** the price list that priced the piece (a trade account's), and its retail before the list */
  priceList?: string | null; retailMinor?: bigint;
  /** the least this piece may sell for at retail (MAP plus its grade and options), when it has a MAP */
  mapFloorMinor?: bigint | null;
};
export type Priced = {
  familyId: string; familySku: string; familyName: string; layoutCode: string | null; layoutName: string;
  cover: { code: string; name: string; grade: string; gradeLabel: string; vendorCode: string | null; color: string | null; hex: string | null; stock: boolean } | null;
  parts: Part[]; listMinor: bigint; bundleDiscountMinor: bigint; bundleDiscountBps: number; totalMinor: bigint; costMinor: bigint;
  geometry: Geometry; leadDays: number; special: boolean; description: string;
};

async function swatchOf(c: Client, entityId: string, tableId: string, code: string): Promise<SwatchRow | null> {
  return (await q<SwatchRow>(c, `select id, code, cover_name, grade_code, material, color_family, color, content, cleaning_code, vendor_code, image_url, hex,
      discontinued_on::text, active, grade_table_id from swatch where entity_id = $1 and grade_table_id = $2 and code = $3`, [entityId, tableId, code]))[0] ?? null;
}

/** Price a sectional build: the pieces, the cover's grade on each, each piece's options, less any bundle discount. */
/**
 * popts.priceList: a price list (a trade account's) prices each piece by its
 * own list price or its category's rule (pricing.listPrice), on the piece's
 * configured retail and cost; the lower of that and retail wins, per piece.
 */
export async function priceBuild(c: Client, entityId: string, familyId: string, build: Build, popts: { priceList?: string | null } = {}): Promise<Priced> {
  const fam = await familyRow(c, entityId, familyId);
  need(fam, "That is not a sectional this company sells.");
  need(fam!.active && fam!.status === "active", `The ${fam!.name} is not for sale.`);
  const all = await piecesOf(c, entityId, familyId, false);
  let codes = (build.pieces ?? []).map((x) => String(x ?? "").trim()).filter(Boolean);
  let layout: LayoutRow | null = null;
  if (build.layout) {
    layout = (await layoutsOf(c, entityId, familyId)).find((l) => l.code === build.layout) ?? null;
    need(layout, `The ${fam!.name} has no layout called ${build.layout}.`);
    if (!codes.length) codes = layout!.pieces;
  }
  need(codes.length, `Choose a layout or the pieces of the ${fam!.name}.`);
  need(codes.length <= 12, "Twelve pieces at most.");
  const chosen = codes.map((code) => {
    const p = all.find((x) => x.code === code);
    need(p, `The ${fam!.name} has no piece called ${code}.`);
    need(p!.active && p!.status !== "discontinued" && p!.status !== "draft", `The ${p!.name} is no longer made.`);
    return p!;
  });
  validateLayout(fam!, chosen);
  const geo = geometry(chosen);
  const sameAsLayout = layout && layout.pieces.join("|") === codes.join("|");
  const layoutName = sameAsLayout ? layout!.name : `${chosen.length}-pc custom: ${chosen.map((p) => pieceWords(p.piece_type)).join(" / ")}`;

  // The cover and its grade.
  let cover: Priced["cover"] = null;
  let grade: { id: string; code: string; label: string; uplift_bps: number; cost_uplift_bps: number } | null = null;
  let adders: { piece_type: string; price_adder_minor: string; cost_adder_minor: string }[] = [];
  if (fam!.grade_table_id) {
    const stock = fam!.stock_swatch_id ? (await q<{ code: string }>(c, `select code from swatch where id = $1 and entity_id = $2`, [fam!.stock_swatch_id, entityId]))[0]?.code : null;
    const code = String(build.cover ?? "").trim() || stock;
    need(code, `Choose a cover for the ${fam!.name}.`);
    const sw = await swatchOf(c, entityId, fam!.grade_table_id, code!);
    need(sw, `${code} is not a cover offered on the ${fam!.name}.`);
    need(sw!.active, `${sw!.cover_name} is not offered any more; pick another cover.`);
    need(!sw!.discontinued_on || sw!.discontinued_on > (await bizToday(c, entityId)), `${sw!.cover_name} was discontinued on ${sw!.discontinued_on}; pick another cover.`);
    grade = (await q<typeof grade & object>(c, `select id, code, label, uplift_bps, cost_uplift_bps from fabric_grade where entity_id = $1 and table_id = $2 and code = $3`,
      [entityId, fam!.grade_table_id, sw!.grade_code]))[0] ?? null;
    need(grade, `${sw!.cover_name} is grade ${sw!.grade_code}, which the grade table does not price; ask the buyer to add it.`);
    adders = await q(c, `select piece_type, price_adder_minor, cost_adder_minor from fabric_grade_adder where entity_id = $1 and grade_id = $2`, [entityId, grade!.id]);
    cover = { code: sw!.code, name: sw!.cover_name, grade: grade!.code, gradeLabel: grade!.label, vendorCode: sw!.vendor_code, color: sw!.color, hex: sw!.hex,
      stock: !!fam!.stock_swatch_id && sw!.id === fam!.stock_swatch_id };
  }

  // The family's options (motion, power, charging) and their rules.
  const groups = await q<{ id: string; code: string; label: string; multi: boolean }>(c,
    `select id, code, label, multi from product_option_group where entity_id = $1 and product_id = $2 order by seq`, [entityId, familyId]);
  const opts = await q<{ group_id: string; code: string; label: string; price_delta_minor: string; cost_delta_minor: string; lead_days: number; vendor_code: string | null }>(c, `
    select group_id, code, label, price_delta_minor, cost_delta_minor, lead_days, vendor_code from product_option
     where entity_id = $1 and active and group_id = any($2::uuid[]) order by seq`, [entityId, groups.map((g) => g.id)]);
  const rules: OptionRule[] = await optionRules(c, entityId, familyId);
  const label = (g: string, code: string | null) => {
    const gr = groups.find((x) => x.code === g);
    if (!code) return gr?.label ?? g;
    return opts.find((o) => o.group_id === gr?.id && o.code === code)?.label ?? code;
  };

  const parts: Part[] = [];
  for (const [i, p] of chosen.entries()) {
    const base = await relay(() => priceConfigured(c, entityId, p.product_id, []));
    const add = adders.find((a) => a.piece_type === p.piece_type);
    // A trade account's list price for the bare piece: a percent grade goes on that, not on retail.
    const cat = popts.priceList ? (await q<{ category: string | null }>(c, `select category from product where id = $1 and entity_id = $2`, [p.product_id, entityId]))[0]?.category ?? null : null;
    const lpBase = popts.priceList ? await listPrice(c, entityId, popts.priceList, { productId: p.product_id, category: cat, ticketMinor: base.unitPriceMinor, costMinor: base.unitCostMinor }) : null;
    const listBase = lpBase && lpBase.priceMinor < base.unitPriceMinor ? lpBase.priceMinor : null;
    const gAdd = !grade ? 0n : add ? BigInt(add.price_adder_minor) : bps(base.unitPriceMinor, grade.uplift_bps);
    const gAddList = !grade ? 0n : add ? BigInt(add.price_adder_minor) : bps(listBase ?? base.unitPriceMinor, grade.uplift_bps);
    const gCost = !grade ? 0n : add ? BigInt(add.cost_adder_minor) : bps(base.unitCostMinor, grade.cost_uplift_bps);
    const choices = (build.pieceOptions?.[i] ?? []).filter((ch) => ch && ch.group && ch.option && (!Array.isArray(ch.option) || ch.option.length));
    const picked = new Map<string, string[]>();
    const chosenOpts: Part["options"] = [];
    let oPrice = 0n, oCost = 0n, lead = 0;
    for (const ch of choices) {
      const g = groups.find((x) => x.code === ch.group);
      need(g, `The ${fam!.name} has no ${ch.group} option.`);
      const list = Array.isArray(ch.option) ? ch.option : [ch.option];
      need(g!.multi || list.length === 1, `Choose one ${g!.label.toLowerCase()} for the ${p.name}.`);
      for (const code of list) {
        const o = opts.find((x) => x.group_id === g!.id && x.code === code);
        need(o, `${code} is not a ${g!.label.toLowerCase()} for the ${fam!.name}.`);
        oPrice += BigInt(o!.price_delta_minor); oCost += BigInt(o!.cost_delta_minor); lead = Math.max(lead, o!.lead_days);
        chosenOpts.push({ group: g!.code, code: o!.code, label: o!.label, vendorCode: o!.vendor_code, deltaMinor: o!.price_delta_minor });
      }
      picked.set(g!.code, [...(picked.get(g!.code) ?? []), ...list]);
    }
    // A piece that reclines by itself counts as that recline for the rules.
    if (p.motion !== "none" && groups.some((g) => g.code === "recline")) {
      need(!picked.has("recline"), `The ${p.name} already has ${p.motion} recline; it takes no recline option.`);
      picked.set("recline", [p.motion]);
    }
    try { checkOptionRules(rules, picked, label, p.piece_type); }
    catch (e) { if (e instanceof PricingError) throw new ConfigError(`${p.name}: ${e.message}`); throw e; }
    let gross = base.unitPriceMinor + gAdd + oPrice;
    const cost = base.unitCostMinor + gCost + oCost;
    const retail = gross;
    let listed: string | null = null;
    if (popts.priceList) {
      // A list price for the piece takes the grade (on the list price) and the options on top; a list rule prices the configured piece.
      const lp = await listPrice(c, entityId, popts.priceList, { productId: p.product_id, category: cat, ticketMinor: gross, costMinor: cost, optionsDeltaMinor: gAddList + oPrice });
      if (lp && lp.priceMinor < gross) { gross = lp.priceMinor; listed = lp.code; }
    }
    // Retail stays at or above MAP (plus the grade and options) when the piece has one; a trade list is not advertised.
    const mapFloor = !listed && base.mapMinor != null ? base.mapMinor + gAdd + oPrice : null;
    const special = !cover || !cover.stock || chosenOpts.length > 0;
    const desc = [cover ? `${cover.name} (grade ${cover.grade})` : null, ...chosenOpts.map((o) => o.label)].filter(Boolean).join(", ");
    parts.push({
      productId: p.product_id, sku: p.sku, name: p.name, description: `${p.name} — ${fam!.name}, piece ${i + 1} of ${chosen.length}${desc ? `: ${desc}` : ""}`,
      pieceCode: p.code, pieceType: p.piece_type, position: i + 1, kind: p.kind, taxable: p.taxable, shipClass: p.ship_class,
      cubicFt: Number(p.cubic_ft ?? 0), weightLb: Number(p.weight_lb ?? 0),
      baseMinor: base.unitPriceMinor, gradeAdderMinor: gAdd, optionsMinor: oPrice, grossMinor: gross, bundleShareMinor: 0n, netMinor: gross, costMinor: cost,
      leadDays: lead, special, options: chosenOpts, config: {}, priceList: listed, retailMinor: retail, mapFloorMinor: mapFloor,
    });
  }
  const list = parts.reduce((a, x) => a + x.grossMinor, 0n);
  const bundleOn = fam!.bundle_discount_bps > 0 && parts.length >= fam!.bundle_min_pieces;
  const want = bundleOn ? bps(list, fam!.bundle_discount_bps) : 0n;
  // The bundle discount comes after any trade list price and any promotion, and never takes a piece below its MAP.
  let left = want, bundle = 0n;
  for (const [i, x] of parts.entries()) {
    let share = i === parts.length - 1 ? left : list > 0n ? (want * x.grossMinor) / list : 0n;
    left -= share;
    if (x.mapFloorMinor != null && x.grossMinor - share < x.mapFloorMinor) share = x.grossMinor > x.mapFloorMinor ? x.grossMinor - x.mapFloorMinor : 0n;
    bundle += share;
    x.bundleShareMinor = share; x.netMinor = x.grossMinor - share;
    x.config = {
      cfg: { family: fam!.sku, piece: x.pieceCode, type: x.pieceType, position: x.position, of: parts.length, layout: layoutName,
        unitCostMinor: x.costMinor.toString(), gradeAdderMinor: x.gradeAdderMinor.toString(), bundleShareMinor: share.toString(),
        options: x.options.map((o) => ({ group: o.group, code: o.code, label: o.label, vendorCode: o.vendorCode })) },
      ...(cover ? { cover: { code: cover.code, name: cover.name, grade: cover.grade, vendorCode: cover.vendorCode, color: cover.color } } : {}),
    };
  }
  const leadDays = Math.max(0, ...parts.map((x) => x.leadDays));
  return {
    familyId, familySku: fam!.sku, familyName: fam!.name, layoutCode: sameAsLayout ? layout!.code : null, layoutName, cover, parts,
    listMinor: list, bundleDiscountMinor: bundle, bundleDiscountBps: bundleOn ? fam!.bundle_discount_bps : 0, totalMinor: list - bundle,
    costMinor: parts.reduce((a, x) => a + x.costMinor, 0n), geometry: geo, leadDays, special: parts.some((x) => x.special),
    description: `${fam!.name} — ${layoutName}${cover ? `, ${cover.name}` : ""}`,
  };
}

/** A priced build for a screen: money as strings, and for the web no cost or vendor codes. */
export function pricedView(p: Priced, forWeb = false) {
  return {
    familyId: p.familyId, familySku: p.familySku, familyName: p.familyName, layoutCode: p.layoutCode, layoutName: p.layoutName, description: p.description,
    cover: p.cover ? { code: p.cover.code, name: p.cover.name, grade: p.cover.grade, gradeLabel: p.cover.gradeLabel, color: p.cover.color, hex: p.cover.hex,
      stock: p.cover.stock, ...(forWeb ? {} : { vendorCode: p.cover.vendorCode }) } : null,
    listMinor: p.listMinor.toString(), bundleDiscountMinor: p.bundleDiscountMinor.toString(), bundleDiscountBps: p.bundleDiscountBps, totalMinor: p.totalMinor.toString(),
    ...(forWeb ? {} : { costMinor: p.costMinor.toString() }),
    widthIn: p.geometry.widthIn, depthIn: p.geometry.depthIn, seats: p.geometry.seats, geometry: p.geometry, leadDays: p.leadDays, madeToOrder: p.special,
    cubicFt: Math.round(p.parts.reduce((a, x) => a + x.cubicFt, 0) * 10) / 10, weightLb: Math.round(p.parts.reduce((a, x) => a + x.weightLb, 0)),
    pieces: p.parts.map((x) => ({ position: x.position, productId: x.productId, code: x.pieceCode, type: x.pieceType, sku: x.sku, name: x.name, priceMinor: x.grossMinor.toString(),
      baseMinor: x.baseMinor.toString(), gradeAdderMinor: x.gradeAdderMinor.toString(), optionsMinor: x.optionsMinor.toString(), netMinor: x.netMinor.toString(),
      madeToOrder: x.special, options: x.options.map((o) => ({ group: o.group, code: o.code, label: o.label, deltaMinor: o.deltaMinor })),
      ...(forWeb ? {} : { costMinor: x.costMinor.toString() }) })),
  };
}

/** What a builder screen needs about a family: pieces, layouts, covers, options and the rules (so pickers offer only what fits). */
export async function familyView(c: Client, entityId: string, familyId: string, forWeb = false) {
  const fam = await familyRow(c, entityId, familyId);
  if (!fam) return null;
  const [pieces, layouts, covers, groups, rules] = [await piecesOf(c, entityId, familyId, forWeb), await layoutsOf(c, entityId, familyId),
    fam.grade_table_id ? await swatches(c, entityId, { tableId: fam.grade_table_id, includeRetired: false }) : [],
    await q<{ id: string; code: string; label: string; multi: boolean }>(c, `select id, code, label, multi from product_option_group where entity_id = $1 and product_id = $2 order by seq`, [entityId, familyId]),
    await optionRules(c, entityId, familyId)];
  const opts = await q<{ group_id: string; code: string; label: string; price_delta_minor: string; lead_days: number }>(c,
    `select group_id, code, label, price_delta_minor, lead_days from product_option where entity_id = $1 and active and group_id = any($2::uuid[]) order by seq`,
    [entityId, groups.map((g) => g.id)]);
  const grades = fam.grade_table_id ? await q<{ code: string; label: string; uplift_bps: number }>(c,
    `select code, label, uplift_bps from fabric_grade where entity_id = $1 and table_id = $2 order by seq, code`, [entityId, fam.grade_table_id]) : [];
  const stock = fam.stock_swatch_id ? (await q<{ code: string }>(c, `select code from swatch where id = $1 and entity_id = $2`, [fam.stock_swatch_id, entityId]))[0]?.code ?? null : null;
  return {
    productId: fam.product_id, sku: fam.sku, name: fam.name, minPieces: fam.min_pieces, maxPieces: fam.max_pieces, active: fam.active,
    bundleDiscountBps: fam.bundle_discount_bps, bundleMinPieces: fam.bundle_min_pieces, gradeTableId: fam.grade_table_id, stockCover: stock, notes: fam.notes,
    pieces: pieces.map((p) => ({ code: p.code, type: p.piece_type, label: pieceWords(p.piece_type), motion: p.motion, name: p.name, sku: p.sku, widthIn: p.width_in,
      depthIn: p.depth_in, heightIn: p.height_in, seats: p.seats, priceMinor: p.price_minor, active: p.active, sides: sidesOf(p.piece_type),
      ...(forWeb ? {} : { productId: p.product_id, costMinor: p.cost_minor, cubicFt: p.cubic_ft, weightLb: p.weight_lb, vendorSku: p.vendor_sku }) })),
    layouts: layouts.map((l) => ({ code: l.code, name: l.name, pieces: l.pieces, popular: l.popular })),
    grades, covers: covers.map((s) => swatchView(s, forWeb)),
    options: groups.map((g) => ({ code: g.code, label: g.label, multi: g.multi,
      options: opts.filter((o) => o.group_id === g.id).map((o) => ({ code: o.code, label: o.label, priceDeltaMinor: o.price_delta_minor, leadDays: o.lead_days })) })),
    rules: rules.map((r) => ({ group: r.group_code, option: r.option_code, kind: r.kind, targetGroup: r.target_group, targetOptions: r.target_options,
      pieceTypes: r.piece_types, message: r.message })),
  };
}

// ======================================================= grades, swatches

export const COLOR_FAMILIES = ["neutral", "white", "gray", "black", "brown", "beige", "blue", "green", "red", "orange", "yellow", "purple", "pink", "multi"];
export const CLEANING = { W: "Water-based cleaner", S: "Solvent only", WS: "Water or solvent", SW: "Water or solvent", X: "Vacuum only" } as Record<string, string>;

export function swatchView(s: SwatchRow, forWeb = false) {
  return { id: s.id, code: s.code, name: s.cover_name, grade: s.grade_code, material: s.material, colorFamily: s.color_family, color: s.color, content: s.content,
    cleaningCode: s.cleaning_code, cleaning: s.cleaning_code ? CLEANING[s.cleaning_code] : null, hex: s.hex, hasImage: !!s.image_url,
    discontinuedOn: s.discontinued_on, active: s.active, ...(forWeb ? {} : { vendorCode: s.vendor_code, imageUrl: s.image_url, gradeTableId: s.grade_table_id }) };
}

export async function swatches(c: Client, entityId: string, f: { tableId?: string | null; grade?: string | null; colorFamily?: string | null; includeRetired?: boolean; q?: string | null } = {}) {
  return q<SwatchRow>(c, `
    select id, code, cover_name, grade_code, material, color_family, color, content, cleaning_code, vendor_code, image_url, hex, discontinued_on::text, active, grade_table_id
      from swatch where entity_id = $1 and ($2::uuid is null or grade_table_id = $2) and ($3::text is null or grade_code = $3)
       and ($4::text is null or color_family = $4)
       and ($5 or (active and (discontinued_on is null or discontinued_on > business_today($1))))
       and ($6::text is null or cover_name ilike '%' || $6 || '%' or code ilike '%' || $6 || '%' or color ilike '%' || $6 || '%')
     order by grade_code, cover_name limit 500`,
    [entityId, f.tableId && U.test(f.tableId) ? f.tableId : null, f.grade || null, f.colorFamily || null, f.includeRetired === true, f.q ? f.q.replace(/[%_\\]/g, "") : null]);
}

export async function gradeTables(c: Client, entityId: string) {
  const tables = await q<{ id: string; code: string; name: string; vendor_id: string | null; vendor: string | null; active: boolean }>(c, `
    select t.id, t.code, t.name, t.vendor_id, coalesce(v.dba, v.legal_name) vendor, t.active from fabric_grade_table t left join vendor v on v.id = t.vendor_id
     where t.entity_id = $1 order by t.name`, [entityId]);
  const grades = await q<{ id: string; table_id: string; code: string; label: string; uplift_bps: number; cost_uplift_bps: number; seq: number }>(c,
    `select id, table_id, code, label, uplift_bps, cost_uplift_bps, seq from fabric_grade where entity_id = $1 order by seq, code`, [entityId]);
  const adders = await q<{ grade_id: string; piece_type: string; price_adder_minor: string; cost_adder_minor: string }>(c,
    `select grade_id, piece_type, price_adder_minor, cost_adder_minor from fabric_grade_adder where entity_id = $1 order by piece_type`, [entityId]);
  return tables.map((t) => ({ ...t, grades: grades.filter((g) => g.table_id === t.id).map((g) => ({ ...g, adders: adders.filter((a) => a.grade_id === g.id) })) }));
}

const GRADE_CODE = /^[A-Z0-9][A-Z0-9_-]{0,11}$/;
export type GradeIn = { code: string; label?: string; upliftBps?: number; costUpliftBps?: number; adders?: { pieceType: string; priceMinor: bigint; costMinor?: bigint }[] };

/** A vendor's grade table: grade A..Z or their own codes, each with adders per piece type or a percent uplift. */
export async function saveGradeTable(c: Client, s: Scope, t: { code: string; name: string; vendorId?: string | null; grades: GradeIn[] }): Promise<string> {
  const code = String(t.code ?? "").trim().toUpperCase();
  need(/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(code), "A grade table code is capital letters and digits, like CUW.");
  need(String(t.name ?? "").trim(), "Give the grade table a name.");
  if (t.vendorId) need((await q(c, `select 1 from vendor_entity where entity_id = $1 and vendor_id = $2`, [s.entityId, t.vendorId])).length, "That vendor is not set up for this company.");
  need(Array.isArray(t.grades) && t.grades.length && t.grades.length <= 40, "A grade table has 1 to 40 grades.");
  const r = await one<{ id: string }>(c, `insert into fabric_grade_table (entity_id, vendor_id, code, name) values ($1,$2,$3,$4)
    on conflict (entity_id, code) do update set name = excluded.name, vendor_id = excluded.vendor_id, active = true returning id /* unscoped: insert carries entity_id */`,
    [s.entityId, t.vendorId ?? null, code, t.name.trim()]);
  for (const [i, g] of t.grades.entries()) {
    const gc = String(g.code ?? "").trim().toUpperCase();
    need(GRADE_CODE.test(gc), `Grade ${g.code || "(blank)"} is not a grade code; use A to Z or the vendor's code, like L1.`);
    for (const [v, w] of [[g.upliftBps ?? 0, "price"], [g.costUpliftBps ?? 0, "cost"]] as const)
      need(Number.isInteger(v) && v >= 0 && v <= 30000, `Grade ${gc}'s ${w} uplift is 0% to 300%.`);
    const gr = await one<{ id: string }>(c, `insert into fabric_grade (entity_id, table_id, code, label, uplift_bps, cost_uplift_bps, seq) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (table_id, code) do update set label = excluded.label, uplift_bps = excluded.uplift_bps, cost_uplift_bps = excluded.cost_uplift_bps, seq = excluded.seq
      returning id /* unscoped: insert carries entity_id */`, [s.entityId, r.id, gc, String(g.label ?? "").trim() || `Grade ${gc}`, g.upliftBps ?? 0, g.costUpliftBps ?? 0, i + 1]);
    if (g.adders) {
      await c.query(`delete from fabric_grade_adder where entity_id = $1 and grade_id = $2`, [s.entityId, gr.id]);   // a price table, replaced whole; history is the audit
      for (const a of g.adders) {
        need((PIECE_TYPES as readonly string[]).includes(a.pieceType), `${a.pieceType} is not a sectional piece type.`);
        need(a.priceMinor >= 0n && (a.costMinor ?? 0n) >= 0n, "An adder cannot be negative.");
        await c.query(`insert into fabric_grade_adder (entity_id, grade_id, piece_type, price_adder_minor, cost_adder_minor) values ($1,$2,$3,$4,$5)`,
          [s.entityId, gr.id, a.pieceType, a.priceMinor.toString(), (a.costMinor ?? 0n).toString()]);
      }
    }
  }
  await audit(c, s, { table: "fabric_grade_table", rowId: r.id, action: "update",
    after: { code, name: t.name, grades: t.grades.map((g) => ({ ...g, adders: g.adders?.map((a) => ({ ...a, priceMinor: a.priceMinor.toString(), costMinor: (a.costMinor ?? 0n).toString() })) })) } });
  return r.id;
}

export type SwatchIn = { tableId: string; code: string; name: string; grade: string; material?: string; colorFamily?: string; color?: string | null;
  content?: string | null; cleaningCode?: string | null; vendorCode?: string | null; imageUrl?: string | null; hex?: string | null; discontinuedOn?: string | null };

export async function saveSwatch(c: Client, s: Scope, w: SwatchIn): Promise<string> {
  need(U.test(w.tableId ?? ""), "Pick the grade table the cover belongs to.");
  need((await q(c, `select 1 from fabric_grade_table where id = $1 and entity_id = $2`, [w.tableId, s.entityId])).length, "No such grade table.");
  const code = String(w.code ?? "").trim().toLowerCase();
  need(/^[a-z0-9][a-z0-9_-]{0,59}$/.test(code), "A cover code is lower-case letters, digits and dashes, like navy-velvet.");
  need(String(w.name ?? "").trim(), "Give the cover its name.");
  const grade = String(w.grade ?? "").trim().toUpperCase();
  need((await q(c, `select 1 from fabric_grade where table_id = $1 and entity_id = $2 and code = $3`, [w.tableId, s.entityId, grade])).length,
    `Grade ${grade || "(blank)"} is not in that grade table.`);
  const material = w.material ?? "fabric";
  need(["fabric", "leather", "vinyl", "performance"].includes(material), "A cover is fabric, leather, vinyl or performance fabric.");
  const fam = w.colorFamily ?? "neutral";
  need(COLOR_FAMILIES.includes(fam), `Pick a color family: ${COLOR_FAMILIES.join(", ")}.`);
  if (w.cleaningCode) need(Object.keys(CLEANING).includes(w.cleaningCode), "A cleaning code is W, S, WS or X.");
  if (w.imageUrl) need(/^https:\/\/\S+$/i.test(w.imageUrl) && w.imageUrl.length <= 1000, "A swatch photo is an https address.");
  if (w.hex) need(/^#[0-9a-fA-F]{6}$/.test(w.hex), "A swatch color is a hex color like #1f2a44.");
  if (w.discontinuedOn) need(/^\d{4}-\d{2}-\d{2}$/.test(w.discontinuedOn), "The discontinued date is a day.");
  const r = await one<{ id: string }>(c, `
    insert into swatch (entity_id, grade_table_id, grade_code, code, cover_name, material, color_family, color, content, cleaning_code, vendor_code, image_url, hex, discontinued_on)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    on conflict (entity_id, grade_table_id, code) do update set grade_code = excluded.grade_code, cover_name = excluded.cover_name, material = excluded.material,
      color_family = excluded.color_family, color = excluded.color, content = excluded.content, cleaning_code = excluded.cleaning_code,
      vendor_code = excluded.vendor_code, image_url = coalesce(excluded.image_url, swatch.image_url), hex = coalesce(excluded.hex, swatch.hex),
      discontinued_on = excluded.discontinued_on, active = true
    returning id /* unscoped: insert carries entity_id */`,
    [s.entityId, w.tableId, grade, code, w.name.trim(), material, fam, w.color ?? null, w.content ?? null, w.cleaningCode || null, w.vendorCode ?? null,
     w.imageUrl || null, w.hex || null, w.discontinuedOn || null]);
  await audit(c, s, { table: "swatch", rowId: r.id, action: "update", after: w });
  return r.id;
}

/** A swatch's photo, through the catalog's own photo proxy and cache. */
export async function swatchImage(c: Client, entityId: string, swatchId: string, fetchImpl?: ImageFetch) {
  if (!U.test(swatchId)) return null;
  const s = (await q<{ image_url: string | null }>(c, `select image_url from swatch where id = $1 and entity_id = $2`, [swatchId, entityId]))[0];
  if (!s?.image_url) return null;
  return relay(() => imageByUrl(c, entityId, s.image_url!, fetchImpl));
}

// ======================================================= family set-up

export type FamilyIn = { productId?: string | null; sku?: string; name?: string; vendorId?: string | null; priceMinor?: bigint;
  minPieces?: number; maxPieces?: number; bundleDiscountBps?: number; bundleMinPieces?: number; gradeTableId?: string | null; stockCover?: string | null;
  notes?: string | null; active?: boolean };

export async function saveFamily(c: Client, s: Scope, f: FamilyIn): Promise<string> {
  let pid = f.productId && U.test(f.productId) ? f.productId : null;
  if (!pid) {
    need(f.sku && f.name, "A new sectional needs a SKU and a name.");
    pid = await relay(() => createProduct(c, s, { sku: f.sku!.toUpperCase(), name: f.name!, kind: "configurable", vendorId: f.vendorId ?? null,
      priceMinor: f.priceMinor ?? 0n, costMinor: 0n, category: "Living room", subcategory: "Sectionals", shipClass: "delivery" },
      { status: (f.priceMinor ?? 0n) > 0n ? "active" : "draft" }));   // with no "from" price it waits as a draft for the buyer
  }
  const p = (await q<{ kind: string; name: string }>(c, `select kind, name from product where id = $1 and entity_id = $2`, [pid, s.entityId]))[0];
  need(p, "No such product.");
  need(p.kind === "configurable", `${p.name} is a ${p.kind.replace("_", " ")} product; a sectional family is a configurable one.`);
  const cur = await familyRow(c, s.entityId, pid!);
  const min = f.minPieces ?? cur?.min_pieces ?? 2, max = f.maxPieces ?? cur?.max_pieces ?? 7;
  need(Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max <= 12 && min <= max, "Pieces run from at least 1 to at most 12, and the least is not more than the most.");
  const disc = f.bundleDiscountBps ?? cur?.bundle_discount_bps ?? 0;
  need(Number.isInteger(disc) && disc >= 0 && disc <= 5000, "A bundle discount is 0% to 50%.");
  const bmin = f.bundleMinPieces ?? cur?.bundle_min_pieces ?? 3;
  need(Number.isInteger(bmin) && bmin >= 1, "The bundle discount starts at one piece or more.");
  const table = f.gradeTableId !== undefined ? f.gradeTableId : cur?.grade_table_id ?? null;
  if (table) need(U.test(table) && (await q(c, `select 1 from fabric_grade_table where id = $1 and entity_id = $2`, [table, s.entityId])).length, "No such grade table.");
  let stock = cur?.stock_swatch_id ?? null;
  if (f.stockCover !== undefined) {
    stock = null;
    if (f.stockCover) {
      need(table, "Pick the grade table before the stock cover.");
      const sw = await swatchOf(c, s.entityId, table!, f.stockCover);
      need(sw, `${f.stockCover} is not a cover in that grade table.`);
      stock = sw!.id;
    }
  }
  await c.query(`insert into sectional_family (product_id, entity_id, min_pieces, max_pieces, bundle_discount_bps, bundle_min_pieces, grade_table_id, stock_swatch_id, notes, active, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict (product_id) do update set min_pieces = excluded.min_pieces, max_pieces = excluded.max_pieces, bundle_discount_bps = excluded.bundle_discount_bps,
      bundle_min_pieces = excluded.bundle_min_pieces, grade_table_id = excluded.grade_table_id, stock_swatch_id = excluded.stock_swatch_id,
      notes = excluded.notes, active = excluded.active`,
    [pid, s.entityId, min, max, disc, bmin, table, stock, f.notes !== undefined ? f.notes : cur?.notes ?? null, f.active ?? cur?.active ?? true, s.actor.id || null]);
  await audit(c, s, { table: "sectional_family", rowId: pid!, action: cur ? "update" : "insert", before: cur, after: { ...f, priceMinor: f.priceMinor?.toString() } });
  return pid!;
}

export type PieceIn = { familyId: string; code: string; pieceType: string; motion?: string; widthIn: number; depthIn: number; heightIn?: number | null; seats?: number;
  productId?: string | null; sku?: string; name?: string; priceMinor?: bigint; costMinor?: bigint; cubicFt?: number | null; weightLb?: number | null; vendorSku?: string | null;
  active?: boolean };

/** A piece of a family: its own SKU (made here when new, through the catalog) and what kind of piece it is. */
export async function savePiece(c: Client, s: Scope, x: PieceIn): Promise<string> {
  const fam = await familyRow(c, s.entityId, x.familyId);
  need(fam, "No such sectional.");
  const code = String(x.code ?? "").trim().toLowerCase();
  need(/^[a-z0-9][a-z0-9-]{0,39}$/.test(code), "A piece code is lower-case letters, digits and dashes, like laf-sofa.");
  need((PIECE_TYPES as readonly string[]).includes(x.pieceType), `Pick the kind of piece: ${PIECE_TYPES.map(pieceWords).join(", ")}.`);
  const motion = x.motion ?? "none";
  need((MOTIONS as readonly string[]).includes(motion), "Motion is none, manual or power.");
  for (const [v, w] of [[x.widthIn, "width"], [x.depthIn, "depth"]] as const) need(Number.isFinite(v) && v > 0 && v < 400, `Give the piece's ${w} in inches.`);
  const seats = x.seats ?? 0;
  need(Number.isInteger(seats) && seats >= 0 && seats <= 6, "A piece seats 0 to 6.");
  let pid = x.productId && U.test(x.productId) ? x.productId : null;
  const existing = (await q<{ id: string; product_id: string }>(c, `select id, product_id from sectional_piece where entity_id = $1 and family_id = $2 and code = $3`,
    [s.entityId, x.familyId, code]))[0];
  pid = pid ?? existing?.product_id ?? null;
  const fields = { name: x.name, priceMinor: x.priceMinor, costMinor: x.costMinor, cubicFt: x.cubicFt, weightLb: x.weightLb, vendorSku: x.vendorSku };
  if (!pid) {
    need(x.sku && x.name && x.priceMinor != null, "A new piece needs its SKU, name and price.");
    pid = await relay(() => createProduct(c, s, { sku: x.sku!.toUpperCase(), name: x.name!, kind: "stock", vendorId: fam!.vendor_id, vendorSku: x.vendorSku ?? null,
      priceMinor: x.priceMinor!, costMinor: x.costMinor ?? 0n, cubicFt: x.cubicFt ?? null, weightLb: x.weightLb ?? null, category: "Living room",
      subcategory: "Sectional pieces", shipClass: "delivery" }, { status: x.priceMinor! > 0n ? "active" : "draft" }));
  } else if (Object.values(fields).some((v) => v !== undefined)) {
    await relay(() => updateProduct(c, s, pid!, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))));
  }
  const p = (await q<{ kind: string; name: string; lot_class: string | null }>(c, `select kind, name, lot_class from product where id = $1 and entity_id = $2`, [pid, s.entityId]))[0];
  need(p, "No such product.");
  need(p.kind === "stock", `${p.name} is ${p.kind.replace("_", " ")}; a sectional piece is a stock SKU of its own.`);
  // Upholstery and leather are matched by dye lot: a piece takes its family's lot class (dye lot when the family names none).
  if (!p.lot_class) {
    const famClass = (await q<{ lot_class: string | null }>(c, `select lot_class from product where id = $1 and entity_id = $2`, [x.familyId, s.entityId]))[0]?.lot_class ?? "dye_lot";
    await relay(() => setLotClass(c, s, pid!, { lotClass: famClass }));
  }
  const r = await one<{ id: string }>(c, `
    insert into sectional_piece (entity_id, family_id, product_id, code, piece_type, motion, width_in, depth_in, height_in, seats, active, seq)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce((select max(seq) + 1 from sectional_piece where entity_id = $1 and family_id = $2), 1))
    on conflict (family_id, code) do update set product_id = excluded.product_id, piece_type = excluded.piece_type, motion = excluded.motion,
      width_in = excluded.width_in, depth_in = excluded.depth_in, height_in = excluded.height_in, seats = excluded.seats, active = excluded.active
    returning id /* unscoped: insert carries entity_id */`,
    [s.entityId, x.familyId, pid, code, x.pieceType, motion, x.widthIn, x.depthIn, x.heightIn ?? null, seats, x.active ?? true]);
  await audit(c, s, { table: "sectional_piece", rowId: r.id, action: existing ? "update" : "insert",
    after: { ...x, priceMinor: x.priceMinor?.toString(), costMinor: x.costMinor?.toString() } });
  return r.id;
}

/** A named popular layout. It is checked like any build, so a layout that cannot be sold cannot be saved. */
export async function saveLayout(c: Client, s: Scope, l: { familyId: string; code: string; name: string; pieces: string[]; popular?: boolean; active?: boolean }) {
  const fam = await familyRow(c, s.entityId, l.familyId);
  need(fam, "No such sectional.");
  const code = String(l.code ?? "").trim().toLowerCase();
  need(/^[a-z0-9][a-z0-9-]{0,59}$/.test(code), "A layout code is lower-case letters, digits and dashes.");
  need(String(l.name ?? "").trim(), "Name the layout the way the sales floor says it, like 3-pc LAF sofa / wedge / RAF loveseat.");
  const all = await piecesOf(c, s.entityId, l.familyId);
  const chosen = (l.pieces ?? []).map((pc) => { const p = all.find((x) => x.code === pc); need(p, `The ${fam!.name} has no piece called ${pc}.`); return p!; });
  if (l.active !== false) validateLayout(fam!, chosen);
  const r = await one<{ id: string }>(c, `insert into sectional_layout (entity_id, family_id, code, name, pieces, popular, active, seq)
    values ($1,$2,$3,$4,$5,$6,$7, coalesce((select max(seq) + 1 from sectional_layout where entity_id = $1 and family_id = $2), 1))
    on conflict (family_id, code) do update set name = excluded.name, pieces = excluded.pieces, popular = excluded.popular, active = excluded.active
    returning id /* unscoped: insert carries entity_id */`, [s.entityId, l.familyId, code, l.name.trim(), l.pieces, l.popular ?? true, l.active ?? true]);
  await audit(c, s, { table: "sectional_layout", rowId: r.id, action: "update", after: l });
  return r.id;
}

export async function families(c: Client, entityId: string) {
  return q(c, `select f.product_id, p.sku, p.name, p.status, f.active, f.min_pieces, f.max_pieces, f.bundle_discount_bps,
      (select count(*) from sectional_piece sp where sp.entity_id = f.entity_id and sp.family_id = f.product_id and sp.active)::int pieces,
      (select count(*) from sectional_layout sl where sl.entity_id = f.entity_id and sl.family_id = f.product_id and sl.active)::int layouts,
      (select count(*) from cfg_set cs where cs.entity_id = f.entity_id and cs.family_id = f.product_id)::int sold,
      t.name grade_table
    from sectional_family f join product p on p.id = f.product_id left join fabric_grade_table t on t.id = f.grade_table_id
   where f.entity_id = $1 order by p.name`, [entityId]);
}

// ============================================================ option rules

export type RuleIn = { productId: string; group: string; option?: string | null; kind: string; targetGroup?: string | null; targetOptions?: string[];
  pieceTypes?: string[]; message?: string | null };

/** A rule over a product's options: A requires B, A excludes C, or A only on these pieces. */
export async function saveRule(c: Client, s: Scope, r: RuleIn): Promise<string> {
  need(["requires", "excludes", "only_on"].includes(r.kind), "A rule says an option requires another, excludes another, or is only on some pieces.");
  const groups = await q<{ id: string; code: string; label: string }>(c, `select id, code, label from product_option_group where entity_id = $1 and product_id = $2`, [s.entityId, r.productId]);
  need(groups.length, "That product has no options to make rules about.");
  const opts = await q<{ group_id: string; code: string }>(c, `select group_id, code from product_option where entity_id = $1 and group_id = any($2::uuid[])`, [s.entityId, groups.map((g) => g.id)]);
  const g = groups.find((x) => x.code === r.group);
  need(g, `The product has no ${r.group} option group.`);
  if (r.option) need(opts.some((o) => o.group_id === g!.id && o.code === r.option), `${r.option} is not a ${g!.label.toLowerCase()} option.`);
  let target: string | null = null, targets: string[] = [], pieces: string[] = [];
  if (r.kind === "only_on") {
    pieces = (r.pieceTypes ?? []).filter(Boolean);
    need(pieces.length, "Say which pieces the option is allowed on.");
    for (const t of pieces) need((PIECE_TYPES as readonly string[]).includes(t), `${t} is not a sectional piece type.`);
  } else {
    const tg = groups.find((x) => x.code === r.targetGroup);
    need(tg, `Say which option group the ${r.kind === "requires" ? "requirement" : "exclusion"} is about.`);
    need(tg!.code !== g!.code || r.kind === "excludes", "An option cannot require its own group.");
    target = tg!.code;
    targets = (r.targetOptions ?? []).filter(Boolean);
    for (const t of targets) need(opts.some((o) => o.group_id === tg!.id && o.code === t), `${t} is not a ${tg!.label.toLowerCase()} option.`);
  }
  const row = await one<{ id: string }>(c, `insert into product_option_rule (entity_id, product_id, group_code, option_code, kind, target_group, target_options, piece_types, message, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [s.entityId, r.productId, g!.code, r.option || null, r.kind, target, targets, pieces, String(r.message ?? "").trim() || null, s.actor.id || null]);
  await audit(c, s, { table: "product_option_rule", rowId: row.id, action: "insert", after: r });
  return row.id;
}

export async function retireRule(c: Client, s: Scope, id: string, reason: string) {
  need(String(reason ?? "").trim(), "Say why the rule is retired.");
  const r = await q(c, `update product_option_rule set active = false where id = $1 and entity_id = $2 and active returning id`, [id, s.entityId]);
  need(r.length, "No such rule in force.");
  await audit(c, s, { table: "product_option_rule", rowId: id, action: "transition", after: { active: false }, reason });
}

export async function rulesFor(c: Client, entityId: string, productId: string | null) {
  return q(c, `select r.id, r.product_id, p.sku, p.name product, r.group_code, r.option_code, r.kind, r.target_group, r.target_options, r.piece_types, r.message, r.created_at
    from product_option_rule r join product p on p.id = r.product_id where r.entity_id = $1 and r.active and ($2::uuid is null or r.product_id = $2)
   order by p.name, r.created_at`, [entityId, productId && U.test(productId) ? productId : null]);
}

// ======================================================== sold sectionals

/** Record a sold sectional: the set, and which order line is which piece. Called by POS, the aisle and the web store right after the lines. */
export async function recordSet(c: Client, entityId: string, e: { orderId: string; priced: Priced; lineIds: string[]; channel: "pos" | "aisle" | "web"; by?: string | null }) {
  need(e.lineIds.length === e.priced.parts.length, "Every piece of the sectional needs its own order line.");
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'cfg_set', 'CS-') n /* unscoped: numbering keyed by the entity argument */`, [entityId])).n;
  const p = e.priced;
  const r = await one<{ id: string }>(c, `insert into cfg_set (entity_id, number, sales_order_id, family_id, channel, layout_code, layout_name, cover, width_in, depth_in, seats,
      pieces, list_minor, bundle_discount_minor, total_minor, diagram, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
    [entityId, number, e.orderId, p.familyId, e.channel, p.layoutCode, p.layoutName, JSON.stringify(p.cover ?? {}), p.geometry.widthIn, p.geometry.depthIn, p.geometry.seats,
     p.parts.length, p.listMinor.toString(), p.bundleDiscountMinor.toString(), p.totalMinor.toString(), JSON.stringify(p.geometry), e.by ?? null]);
  for (const [i, x] of p.parts.entries())
    await c.query(`insert into cfg_set_line (entity_id, set_id, sales_order_line_id, position, piece_code, piece_type) values ($1,$2,$3,$4,$5,$6)`,
      [entityId, r.id, e.lineIds[i], x.position, x.pieceCode, x.pieceType]);
  return { setId: r.id, number };
}

/** The sectionals on an order, each with its pieces and where each piece stands. */
export async function setsForOrder(c: Client, entityId: string, orderId: string) {
  const sets = await q<{ id: string; number: string; layout_name: string; cover: Record<string, unknown>; width_in: string; depth_in: string; seats: number; pieces: number;
    list_minor: string; bundle_discount_minor: string; total_minor: string; diagram: Geometry; family: string; channel: string }>(c, `
    select s.id, s.number, s.layout_name, s.cover, s.width_in::text, s.depth_in::text, s.seats, s.pieces, s.list_minor, s.bundle_discount_minor, s.total_minor,
           s.diagram, p.name family, s.channel
      from cfg_set s join product p on p.id = s.family_id where s.entity_id = $1 and s.sales_order_id = $2 order by s.created_at`, [entityId, orderId]);
  const lines = await q<{ set_id: string; line_id: string; position: number; piece_code: string; sku: string; description: string; line_status: string; qty: string;
    unit_price_minor: string; cubic_ft: number | null; weight_lb: number | null }>(c, `
    select sl.set_id, l.id line_id, sl.position, sl.piece_code, l.sku, l.description, l.line_status, l.qty::text, l.unit_price_minor,
           p.cubic_ft::float cubic_ft, p.weight_lb::float weight_lb
      from cfg_set_line sl join sales_order_line l on l.id = sl.sales_order_line_id left join product p on p.id = l.product_id
     where sl.entity_id = $1 and sl.set_id = any($2::uuid[]) order by sl.position`, [entityId, sets.map((x) => x.id)]);
  return sets.map((x) => {
    const mine = lines.filter((l) => l.set_id === x.id);
    return { ...x, lines: mine, cubicFt: Math.round(mine.reduce((a, l) => a + Number(l.cubic_ft ?? 0) * Number(l.qty), 0) * 10) / 10,
      weightLb: Math.round(mine.reduce((a, l) => a + Number(l.weight_lb ?? 0) * Number(l.qty), 0)) };
  });
}

/** The set a line belongs to, with all its line ids (for voiding a sectional as one). */
export async function setOfLine(c: Client, entityId: string, lineId: string): Promise<{ setId: string; number: string; lineIds: string[] } | null> {
  const r = await q<{ set_id: string; number: string }>(c, `select sl.set_id, s.number from cfg_set_line sl join cfg_set s on s.id = sl.set_id
    where sl.entity_id = $1 and sl.sales_order_line_id = $2`, [entityId, lineId]);
  if (!r.length) return null;
  const ids = await q<{ id: string }>(c, `select sales_order_line_id id from cfg_set_line where entity_id = $1 and set_id = $2 order by position`, [entityId, r[0].set_id]);
  return { setId: r[0].set_id, number: r[0].number, lineIds: ids.map((x) => x.id) };
}

/**
 * A sectional is sold and delivered as a set. When a delivery or a hand-over
 * takes some of a set's pieces and not the rest, say so in a sentence (a
 * warning: the dispatcher may still send what is ready).
 */
export async function partialSetWarning(c: Client, entityId: string, lineIds: string[]): Promise<string | null> {
  if (!lineIds.length) return null;
  const rows = await q<{ set_id: string; number: string; layout_name: string; line_id: string; sku: string; line_status: string; piece_code: string }>(c, `
    select s.id set_id, s.number, s.layout_name, l.id line_id, l.sku, l.line_status, sl.piece_code
      from cfg_set s join cfg_set_line sl on sl.set_id = s.id join sales_order_line l on l.id = sl.sales_order_line_id
     where s.entity_id = $1 and s.id in (select set_id from cfg_set_line where entity_id = $1 and sales_order_line_id = any($2::uuid[]))
     order by s.number, sl.position`, [entityId, lineIds]);
  const out: string[] = [];
  for (const id of new Set(rows.map((r) => r.set_id))) {
    const mine = rows.filter((r) => r.set_id === id);
    const left = mine.filter((r) => !lineIds.includes(r.line_id) && !["cancelled", "returned", "fulfilled"].includes(r.line_status));
    if (!left.length) continue;
    const words = left.map((r) => `${r.sku} (${r.line_status === "on_order" ? "still on order" : r.line_status === "open" ? "not reserved yet" : r.line_status})`);
    out.push(`Sectional ${mine[0].number} (${mine[0].layout_name}) is sold and delivered as a set, but ${left.length === 1 ? "1 of its pieces is" : `${left.length} of its ${mine.length} pieces are`} not on this one: ${words.join(", ")}. Deliver it complete, or tell the customer the rest follows.`);
  }
  return out.length ? out.join(" ") : null;
}

// ======================================================= condition grades

export const CONDITIONS = ["new", "like_new", "good", "fair", "damaged"] as const;
export const CONDITION_WORDS: Record<string, string> = { new: "New", like_new: "Like new", good: "Good", fair: "Fair", damaged: "Damaged" };
const DEFAULT_PCT: Record<string, number> = { new: 10000, like_new: 8500, good: 7000, fair: 5000, damaged: 3000 };

export async function gradeRules(c: Client, entityId: string): Promise<Record<string, number>> {
  const r = await q<{ grade: string; pct_bps: number }>(c, `select grade, pct_bps from condition_grade_rule where entity_id = $1`, [entityId]);
  return Object.fromEntries(CONDITIONS.map((g) => [g, r.find((x) => x.grade === g)?.pct_bps ?? DEFAULT_PCT[g]]));
}

/** The company's share of retail per condition grade. A worse grade never sells for more than a better one. */
export async function saveGradeRules(c: Client, s: Scope, rules: Record<string, number>) {
  const before = await gradeRules(c, s.entityId);
  const next = { ...before };
  for (const [g, v] of Object.entries(rules ?? {})) {
    need((CONDITIONS as readonly string[]).includes(g), `${g} is not a condition grade.`);
    need(Number.isInteger(v) && v >= 0 && v <= 10000, `${CONDITION_WORDS[g]} sells for 0% to 100% of retail.`);
    next[g] = v;
  }
  for (let i = 1; i < CONDITIONS.length; i++)
    need(next[CONDITIONS[i]] <= next[CONDITIONS[i - 1]], `${CONDITION_WORDS[CONDITIONS[i]]} cannot sell for more of retail than ${CONDITION_WORDS[CONDITIONS[i - 1]]}.`);
  for (const g of CONDITIONS)
    await c.query(`insert into condition_grade_rule (entity_id, grade, pct_bps, updated_by) values ($1,$2,$3,$4)
      on conflict (entity_id, grade) do update set pct_bps = excluded.pct_bps, updated_by = excluded.updated_by, updated_at = now()`, [s.entityId, g, next[g], s.actor.id || null]);
  await audit(c, s, { table: "condition_grade_rule", rowId: s.entityId, action: "update", before, after: next });
  return next;
}

function cleanPhotos(urls: unknown): string[] {
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u ?? "").trim()).filter(Boolean).slice(0, 8);
  for (const u of list) need((/^https:\/\/\S+$/i.test(u) && u.length <= 1000) || (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length <= 1_500_000),
    "Photos are https addresses or pictures taken here.");
  return list;
}

type PieceLite = { id: string; unit_id: string; label: string; product_id: string; status: string; sku: string; name: string; price_minor: string; product_status: string; location: string };
async function pieceLite(c: Client, entityId: string, label: string): Promise<PieceLite> {
  const r = await q<PieceLite>(c, `select x.id, x.unit_id, x.label, x.product_id, x.status, p.sku, p.name, p.price_minor, p.status product_status, l.name location
    from inv_piece x join product p on p.id = x.product_id join location l on l.id = x.location_id
   where x.entity_id = $1 and upper(x.label) = upper($2) order by x.carton_seq limit 1`, [entityId, String(label ?? "").trim()]);
  need(r.length, `No piece is labelled ${label}.`);
  return r[0];
}

export type GradeIn2 = { grade: string; source?: string | null; notes?: string | null; photos?: string[]; overrideMinor?: bigint | null; overrideReason?: string | null };

/**
 * Grade an as-is, floor-sample or returned piece. The price is the grade's
 * share of retail, unless a manager sets one by hand with a reason. An as-is
 * piece carries the price on its tag; a piece in regular stock graded as-is
 * is marked as-is at that price. Every grading is kept.
 */
export async function gradePiece(c: Client, s: Scope, label: string, e: GradeIn2, mayOverride: boolean) {
  need((CONDITIONS as readonly string[]).includes(e.grade), "Pick the grade: new, like new, good, fair or damaged.");
  const pc = await pieceLite(c, s.entityId, label);
  need(["in_stock", "as_is", "returned", "damaged", "in_repair"].includes(pc.status),
    `${pc.label} is ${pc.status.replace(/_/g, " ")}; only a piece on hand that is not sold can be graded.`);
  const source = e.source || (pc.status === "as_is" ? "as_is" : pc.status === "returned" ? "return" : pc.product_status === "floor_sample" ? "floor_sample" : null);
  need(source && ["as_is", "floor_sample", "return"].includes(source), `Say whether ${pc.label} is an as-is piece, a floor sample or a return.`);
  const rules = await gradeRules(c, s.entityId);
  const retail = BigInt(pc.price_minor);
  const pct = rules[e.grade];
  const auto = bps(retail, pct);
  let override: bigint | null = null, reason: string | null = null;
  if (e.overrideMinor != null) {
    need(mayOverride, "Setting an as-is price by hand needs a store manager.");
    reason = String(e.overrideReason ?? "").trim() || null;
    need(reason, "Say why the price differs from the grade's price.");
    need(e.overrideMinor >= 0n, "A price cannot be negative.");
    override = e.overrideMinor;
  }
  const price = override ?? auto;
  const photos = cleanPhotos(e.photos);
  await c.query(`update inv_condition set superseded_at = now() where entity_id = $1 and unit_id = $2 and superseded_at is null`, [s.entityId, pc.unit_id]);
  const r = await one<{ id: string }>(c, `insert into inv_condition (entity_id, unit_id, label, product_id, source, grade, notes, photos, retail_minor, pct_bps, auto_price_minor,
      override_price_minor, override_reason, price_minor, graded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
    [s.entityId, pc.unit_id, pc.label, pc.product_id, source, e.grade, String(e.notes ?? "").trim().slice(0, 1000) || null, photos, retail.toString(), pct,
     auto.toString(), override?.toString() ?? null, reason, price.toString(), s.actor.id || null]);
  if (source === "as_is" && pc.status === "in_stock")
    await relay(() => pieceAction(c, s, pc.label, "as_is", { reason: `graded ${CONDITION_WORDS[e.grade].toLowerCase()}`, asIsPriceMinor: price }));
  else if (pc.status === "as_is") await relay(() => setAsIsPrice(c, s.entityId, pc.unit_id, price, `graded ${CONDITION_WORDS[e.grade].toLowerCase()}`));
  await audit(c, s, { table: "inv_condition", rowId: r.id, action: "insert", reason: reason ?? undefined,
    after: { label: pc.label, grade: e.grade, source, auto: auto.toString(), price: price.toString(), override: override?.toString() ?? null } });
  return conditionOf(c, s.entityId, pc.label);
}

export async function conditionOf(c: Client, entityId: string, label: string) {
  const pc = await pieceLite(c, entityId, label);
  const hist = await q<{ id: string; grade: string; source: string; notes: string | null; photos: string[]; retail_minor: string; pct_bps: number; auto_price_minor: string;
    override_price_minor: string | null; override_reason: string | null; price_minor: string; graded_at: string; graded_by: string | null; superseded_at: string | null }>(c, `
    select ic.id, ic.grade, ic.source, ic.notes, ic.photos, ic.retail_minor, ic.pct_bps, ic.auto_price_minor, ic.override_price_minor, ic.override_reason, ic.price_minor,
           ic.graded_at, u.name graded_by, ic.superseded_at
      from inv_condition ic left join app_user u on u.id = ic.graded_by where ic.entity_id = $1 and ic.unit_id = $2 order by ic.graded_at desc, ic.id`, [entityId, pc.unit_id]);
  const cur = hist.find((h) => !h.superseded_at) ?? null;
  return { label: pc.label, sku: pc.sku, name: pc.name, status: pc.status, location: pc.location, retailMinor: pc.price_minor,
    current: cur ? { ...cur, gradeWords: CONDITION_WORDS[cur.grade] } : null, history: hist };
}

/** The grade of each as-is or graded unit of some products (for POS and the catalog's tags). */
export async function gradesForProducts(c: Client, entityId: string, productIds: string[]) {
  if (!productIds.length) return [];
  return q<{ product_id: string; label: string; status: string; grade: string | null; price_minor: string | null; location: string }>(c, `
    select x.product_id, x.label, x.status, ic.grade, coalesce(ic.price_minor, x.as_is_price_minor)::text price_minor, l.name location
      from inv_piece x join location l on l.id = x.location_id
      left join inv_condition ic on ic.entity_id = x.entity_id and ic.unit_id = x.unit_id and ic.superseded_at is null
     where x.entity_id = $1 and x.product_id = any($2::uuid[]) and x.carton_seq = 1
       and (x.status = 'as_is' or (ic.id is not null and x.status in ('in_stock','returned')))
     order by x.product_id, x.label`, [entityId, productIds]);
}

const AGE = [[30, "0 to 30 days"], [60, "31 to 60 days"], [90, "61 to 90 days"], [100000, "over 90 days"]] as const;

/** As-is stock by grade and by age (days since it was first graded, else since the piece came in). */
export async function asIsReport(c: Client, entityId: string, f: { locationId?: string | null } = {}) {
  const rows = await q<{ label: string; sku: string; name: string; location: string; status: string; grade: string | null; source: string | null;
    retail_minor: string; price_minor: string | null; age_days: number }>(c, `
    select x.label, p.sku, p.name, l.name location, x.status, ic.grade, ic.source, p.price_minor retail_minor,
           coalesce(ic.price_minor, x.as_is_price_minor)::text price_minor,
           (business_today($1) - coalesce((select min(h.graded_at) from inv_condition h where h.entity_id = x.entity_id and h.unit_id = x.unit_id), x.created_at)::date)::int age_days
      from inv_piece x join product p on p.id = x.product_id join location l on l.id = x.location_id
      left join inv_condition ic on ic.entity_id = x.entity_id and ic.unit_id = x.unit_id and ic.superseded_at is null
     where x.entity_id = $1 and x.carton_seq = 1 and ($2::uuid is null or x.location_id = $2)
       and (x.status = 'as_is' or (ic.id is not null and x.status in ('in_stock','returned','damaged','in_repair')))
     order by age_days desc, x.label`, [entityId, f.locationId && U.test(f.locationId) ? f.locationId : null]);
  const bucketOf = (d: number) => AGE.find(([n]) => d <= n)![1];
  const grades = [...CONDITIONS, "ungraded"].map((g) => {
    const mine = rows.filter((r) => (r.grade ?? "ungraded") === g);
    return { grade: g, words: CONDITION_WORDS[g] ?? "Not graded", pieces: mine.length,
      retailMinor: mine.reduce((a, r) => a + BigInt(r.retail_minor), 0n).toString(),
      priceMinor: mine.reduce((a, r) => a + BigInt(r.price_minor ?? 0), 0n).toString(),
      byAge: AGE.map(([, w]) => ({ bucket: w, pieces: mine.filter((r) => bucketOf(r.age_days) === w).length })) };
  });
  return { grades, items: rows.map((r) => ({ ...r, gradeWords: r.grade ? CONDITION_WORDS[r.grade] : "Not graded", bucket: bucketOf(r.age_days) })), buckets: AGE.map(([, w]) => w) };
}

/** As-is tags: grade, price, retail and the barcode bars of each label. */
export async function asIsTags(c: Client, entityId: string, labels: string[]) {
  const out = [];
  for (const l of labels.slice(0, 60)) {
    const x = await conditionOf(c, entityId, l);
    out.push({ label: x.label, sku: x.sku, name: x.name, location: x.location, grade: x.current?.grade ?? null, gradeWords: x.current ? CONDITION_WORDS[x.current.grade] : "Not graded",
      notes: x.current?.notes ?? null, priceMinor: x.current?.price_minor ?? null, retailMinor: x.retailMinor, barcode: { text: x.label, bars: code128(x.label) } });
  }
  return out;
}

// ============================================== vendor catalog extras (832, feeds)
// Best effort: a vendor that says which sectional a model belongs to and what
// kind of piece it is gets the piece set up; one that sends covers with their
// grade gets them in its grade table. Nothing here stops a catalog import.

export type VendorExtra =
  | { kind: "piece"; vendorSku: string; family: string; familyName?: string | null; pieceType: string; motion?: string | null; widthIn?: number | null;
      depthIn?: number | null; heightIn?: number | null; seats?: number | null; gradeAdders?: { grade: string; priceMinor: bigint }[] }
  | { kind: "swatch"; code: string; name: string; grade: string; colorFamily?: string | null; color?: string | null; content?: string | null;
      cleaningCode?: string | null; imageUrl?: string | null; discontinuedOn?: string | null; material?: string | null };

/** Vendor piece words to ours: "LAF SOFA", "LAF-SOFA", "RAF CHAISE", "ARMLESS LOVESEAT", "WEDGE". */
export function pieceTypeFrom(v: string): string | null {
  const s = String(v ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (!s) return null;
  const side = /\b(laf|left)\b/.test(s) ? "laf" : /\b(raf|right)\b/.test(s) ? "raf" : /\barmless\b/.test(s) ? "armless" : null;
  const kind = /chaise/.test(s) ? "chaise" : /wedge/.test(s) ? "wedge" : /corner/.test(s) ? "corner" : /ottoman/.test(s) ? "ottoman" : /console/.test(s) ? "console"
    : /love/.test(s) ? "loveseat" : /sofa/.test(s) ? "sofa" : /chair|recliner|seat/.test(s) ? "chair" : null;
  if (!kind) return null;
  if (["wedge", "corner", "ottoman", "console"].includes(kind)) return kind;
  if (kind === "chaise") return side === "raf" ? "raf_chaise" : side === "laf" ? "laf_chaise" : null;
  const t = `${side ?? ""}_${kind}`;
  return (PIECE_TYPES as readonly string[]).includes(t) ? t : null;
}
const motionFrom = (v: string | null | undefined) => /power/i.test(v ?? "") ? "power" : /manual|recl/i.test(v ?? "") ? "manual" : "none";
const colorFamilyFrom = (v: string | null | undefined) => { const s = String(v ?? "").toLowerCase(); return COLOR_FAMILIES.find((f) => s.includes(f)) ?? (s.includes("grey") ? "gray" : s.includes("tan") ? "beige" : "neutral"); };

const ALIAS = {
  family: ["sectional_family", "sectional", "family", "sectional_model", "group_model"],
  piece: ["piece_type", "piece", "sectional_piece", "component_type", "position"],
  motion: ["motion", "recline", "power"],
  width: ["width_in", "width", "w"], depth: ["depth_in", "depth", "d", "length"], height: ["height_in", "height", "h"], seats: ["seats", "seating"],
  swatch: ["swatch_code", "cover_code", "fabric_code"], swatchName: ["cover_name", "fabric_name", "cover"], grade: ["grade", "fabric_grade", "swatch_grade", "price_grade"],
  color: ["color", "colour", "color_name"], colorFamily: ["color_family"], content: ["content", "fabric_content"], cleaning: ["cleaning_code", "cleaning"],
  image: ["swatch_image", "swatch_image_url", "image_url"], discontinued: ["discontinued_on", "discontinued", "drop_date"], vendorSku: ["vendor_sku", "sku", "item_number", "model"],
};
const pick = (r: Record<string, string>, keys: readonly string[]) => {
  const norm = new Map(Object.keys(r).map((k) => [k.toLowerCase().replace(/[^a-z0-9]/g, ""), k]));
  for (const k of keys) { const hit = norm.get(k.replace(/[^a-z0-9]/g, "")); if (hit && String(r[hit] ?? "").trim()) return String(r[hit]).trim(); }
  return "";
};
const num = (v: string) => { const n = Number(String(v).replace(/[^0-9.]/g, "")); return v && Number.isFinite(n) && n > 0 ? n : null; };

/** Sort a vendor feed's rows: swatch rows (a cover code with a grade and no price) are not products. */
export function extrasFromRows(rows: Record<string, string>[]): { productRows: Record<string, string>[]; extras: VendorExtra[] } {
  const productRows: Record<string, string>[] = [], extras: VendorExtra[] = [];
  for (const r of rows) {
    const sw = pick(r, ALIAS.swatch), grade = pick(r, ALIAS.grade);
    if (sw && grade) {
      extras.push({ kind: "swatch", code: sw, name: pick(r, ALIAS.swatchName) || sw, grade, color: pick(r, ALIAS.color) || null,
        colorFamily: pick(r, ALIAS.colorFamily) || null, content: pick(r, ALIAS.content) || null, cleaningCode: pick(r, ALIAS.cleaning) || null,
        imageUrl: pick(r, ALIAS.image) || null, discontinuedOn: pick(r, ALIAS.discontinued) || null });
      continue;
    }
    productRows.push(r);
    const fam = pick(r, ALIAS.family), piece = pieceTypeFrom(pick(r, ALIAS.piece));
    const vs = pick(r, ALIAS.vendorSku);
    if (fam && piece && vs) extras.push({ kind: "piece", vendorSku: vs, family: fam, pieceType: piece, motion: motionFrom(pick(r, ALIAS.motion)),
      widthIn: num(pick(r, ALIAS.width)), depthIn: num(pick(r, ALIAS.depth)), heightIn: num(pick(r, ALIAS.height)), seats: num(pick(r, ALIAS.seats)) });
  }
  return { productRows, extras };
}

const DEFAULT_SEATS: Record<string, number> = { sofa: 3, loveseat: 2, chair: 1, wedge: 1, corner: 1, chaise: 1, ottoman: 0, console: 0 };
const DEFAULT_SIZE: Record<string, [number, number]> = { sofa: [88, 38], loveseat: [64, 38], chair: [38, 38], wedge: [48, 48], corner: [38, 38], chaise: [36, 64], ottoman: [36, 28], console: [14, 38] };
const base = (t: string) => t.replace(/^(laf|raf|armless)_/, "");

/**
 * Apply what a vendor's catalog said about sectionals and covers: each piece
 * is set up under its family (the family is made once, named by the vendor),
 * and each cover lands in the vendor's grade table (made once, code from the
 * vendor's SKU prefix). Returns plain notes of what happened.
 */
export async function applyVendorExtras(c: Client, s: Scope, vendorId: string, extras: VendorExtra[]) {
  const notes: string[] = [];
  let pieces = 0, covers = 0, skipped = 0;
  if (!extras.length) return { pieces, covers, skipped, notes };
  const v = (await q<{ name: string; prefix: string | null }>(c, `select coalesce(v.dba, v.legal_name) name, vp.sku_prefix prefix from vendor v
      left join vendor_profile vp on vp.vendor_id = v.id and vp.entity_id = $1 where v.id = $2`, [s.entityId, vendorId]))[0];
  const tableCode = (v?.prefix || (v?.name ?? "VENDOR").replace(/[^A-Za-z0-9]/g, "").slice(0, 8)).toUpperCase() || "VENDOR";
  let table = (await q<{ id: string }>(c, `select id from fabric_grade_table where entity_id = $1 and (vendor_id = $2 or code = $3) order by (vendor_id = $2) desc limit 1`,
    [s.entityId, vendorId, tableCode]))[0]?.id ?? null;
  const ensureTable = async (grades: string[]) => {
    if (!table) table = await saveGradeTable(c, s, { code: tableCode, name: `${v?.name ?? "Vendor"} covers`, vendorId, grades: grades.map((g) => ({ code: g })) });
    for (const g of grades) await c.query(`insert into fabric_grade (entity_id, table_id, code, label, seq) values ($1,$2,$3,$4,99) on conflict (table_id, code) do nothing`,
      [s.entityId, table, g, `Grade ${g}`]);
    return table!;
  };
  for (const x of extras) {
    await c.query("savepoint cfg_extra");
    try {
      if (x.kind === "swatch") {
        const grade = x.grade.toUpperCase().trim();
        need(GRADE_CODE.test(grade), `cover ${x.code}: grade ${x.grade} is not a grade code`);
        const t = await ensureTable([grade]);
        const code = x.code.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
        const disc = x.discontinuedOn && /^\d{4}-?\d{2}-?\d{2}$/.test(x.discontinuedOn) ? x.discontinuedOn.replace(/^(\d{4})-?(\d{2})-?(\d{2})$/, "$1-$2-$3") : null;
        await saveSwatch(c, s, { tableId: t, code, name: x.name, grade, colorFamily: x.colorFamily && COLOR_FAMILIES.includes(x.colorFamily.toLowerCase()) ? x.colorFamily.toLowerCase() : colorFamilyFrom(x.color ?? x.name),
          color: x.color ?? null, content: x.content ?? null, cleaningCode: x.cleaningCode && Object.keys(CLEANING).includes(x.cleaningCode.toUpperCase()) ? x.cleaningCode.toUpperCase() : null,
          vendorCode: x.code, imageUrl: x.imageUrl && /^https:\/\//i.test(x.imageUrl) ? x.imageUrl : null, discontinuedOn: disc,
          material: x.material && ["fabric", "leather", "vinyl", "performance"].includes(x.material) ? x.material : /leather/i.test(x.name) ? "leather" : "fabric" });
        covers++;
      } else {
        const prod = (await q<{ id: string; kind: string; name: string }>(c, `select id, kind, name from product where entity_id = $1 and vendor_id = $2 and upper(vendor_sku) = upper($3)`,
          [s.entityId, vendorId, x.vendorSku]))[0];
        need(prod, `piece ${x.vendorSku} is not in the catalog`);
        need(prod.kind === "stock", `${x.vendorSku} is ${prod.kind}; a piece is a stock SKU`);
        const famSku = `${tableCode}-${x.family}`.toUpperCase().replace(/[^A-Z0-9-]+/g, "-").slice(0, 40);
        let fam = (await q<{ id: string }>(c, `select p.id from product p join sectional_family f on f.product_id = p.id
           where p.entity_id = $1 and p.vendor_id = $2 and (upper(p.vendor_sku) = upper($3) or p.sku = $4) limit 1`, [s.entityId, vendorId, x.family, famSku]))[0]?.id;
        if (!fam) {
          fam = await saveFamily(c, s, { sku: famSku, name: `${x.familyName || x.family} sectional`, vendorId, priceMinor: 0n, gradeTableId: table });
          await c.query(`update product set vendor_sku = $3, updated_at = now() where id = $1 and entity_id = $2 and vendor_sku is null`, [fam, s.entityId, x.family]);
          notes.push(`made the ${x.familyName || x.family} sectional`);
        }
        const [dw, dd] = DEFAULT_SIZE[base(x.pieceType)] ?? [40, 38];
        const code = x.pieceType.replace(/_/g, "-") + (x.motion && x.motion !== "none" ? `-${x.motion}` : "");
        await savePiece(c, s, { familyId: fam, productId: prod.id, code, pieceType: x.pieceType, motion: x.motion ?? "none", widthIn: x.widthIn ?? dw, depthIn: x.depthIn ?? dd,
          heightIn: x.heightIn ?? null, seats: x.seats != null ? Math.round(x.seats) : DEFAULT_SEATS[base(x.pieceType)] ?? 1 });
        if (x.gradeAdders?.length) {
          const t = await ensureTable(x.gradeAdders.map((g) => g.grade.toUpperCase()));
          for (const g of x.gradeAdders) {
            const gid = (await one<{ id: string }>(c, `select id from fabric_grade where entity_id = $1 and table_id = $2 and code = $3`, [s.entityId, t, g.grade.toUpperCase()])).id;
            await c.query(`insert into fabric_grade_adder (entity_id, grade_id, piece_type, price_adder_minor) values ($1,$2,$3,$4)
              on conflict (grade_id, piece_type) do update set price_adder_minor = excluded.price_adder_minor`, [s.entityId, gid, x.pieceType, g.priceMinor.toString()]);
          }
          await c.query(`update sectional_family set grade_table_id = coalesce(grade_table_id, $3) where product_id = $1 and entity_id = $2`, [fam, s.entityId, t]);
        }
        pieces++;
      }
      await c.query("release savepoint cfg_extra");
    } catch (e) {
      await c.query("rollback to savepoint cfg_extra");
      if (!(e instanceof ConfigError || e instanceof CatalogError || e instanceof PricingError)) throw e;
      skipped++;
      if (notes.length < 12) notes.push(e.message);
    }
  }
  return { pieces, covers, skipped, notes };
}

/** usd and plural are kept for the sentences callers build from these results. */
export const words = { usd, plural };
