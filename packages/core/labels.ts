// Labels: carton/box labels for pieces, bin labels and price tags, as ZPL for
// thermal printers (Zebra and compatibles) and as a print page (HTML with SVG
// barcodes, sized for the label, for a Dymo or any desktop printer). Owned by
// the lots module; reads inventory's pieces, the catalog's prices and the
// routes' stops, and writes only its own tables (label_template,
// label_printer, label_print_job).
//
// Barcodes are Code 128 set B, built by the catalog's code128() (shared, not
// copied); ZPL's ^BC draws its own bars from the same data, so the check
// digit we compute is written into each label as a comment for the record.
//
// Network printing is the one place the server opens a connection somewhere
// a person chose, so it is narrow on purpose: only printers the owner set up,
// only on a private-network IPv4/IPv6 literal (never a host name, so DNS
// cannot move it), only ports 9100-9109, and a request names a printer by id,
// never an address.

import net from "node:net";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import { code128 } from "./catalog.ts";
import { priceConfigured, PricingError } from "./pricing.ts";

export class LabelError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new LabelError(msg); };

export const KINDS = ["carton", "bin", "price_tag"] as const;
export type Kind = (typeof KINDS)[number];
export const FIELDS: Record<Kind, string[]> = {
  carton: ["sku", "description", "po", "piece", "barcode", "customer", "order", "stop", "serial", "lot", "location"],
  bin: ["bin", "location", "zone", "barcode"],
  price_tag: ["brand", "name", "sku", "retail", "sale", "package", "condition", "barcode"],
};
const DEFAULTS: Record<Kind, { name: string; width_in: number; height_in: number; dpi: number; fields: string[] }> = {
  carton: { name: "Carton 4 x 6", width_in: 4, height_in: 6, dpi: 203, fields: ["sku", "description", "po", "piece", "barcode", "customer", "order", "stop", "serial", "lot"] },
  bin: { name: "Bin 4 x 2", width_in: 4, height_in: 2, dpi: 203, fields: ["bin", "location", "barcode"] },
  price_tag: { name: "Price tag 4 x 3", width_in: 4, height_in: 3, dpi: 203, fields: ["brand", "name", "sku", "retail", "sale", "package", "condition", "barcode"] },
};

export type Template = { id: string | null; kind: Kind; name: string; width_in: number; height_in: number; dpi: number; fields: string[] };

// ------------------------------------------------------------- templates --

export async function templates(c: Client, entityId: string) {
  const r = await q<Template & { is_default: boolean; active: boolean }>(c, `select id, kind, name, width_in::float width_in, height_in::float height_in, dpi, fields, is_default, active
    from label_template where entity_id = $1 order by kind, is_default desc, name`, [entityId]);
  return { templates: r, fields: FIELDS, defaults: DEFAULTS };
}

export async function templateFor(c: Client, entityId: string, kind: Kind, id?: string | null): Promise<Template> {
  need(KINDS.includes(kind), "a label is a carton, bin or price tag label");
  const r = await q<Template>(c, `select id, kind, name, width_in::float width_in, height_in::float height_in, dpi, fields from label_template
    where entity_id = $1 and kind = $2 and active and (($3::uuid is not null and id = $3) or ($3::uuid is null and is_default)) limit 1`, [entityId, kind, id ?? null]);
  if (id) need(r.length, "no such label template");
  return r[0] ?? { id: null, kind, ...DEFAULTS[kind] };
}

export async function saveTemplate(c: Client, scope: Scope, e: { id?: string | null; kind: string; name: string; widthIn: number; heightIn: number; dpi?: number;
  fields: string[]; isDefault?: boolean; active?: boolean }) {
  const kind = e.kind as Kind;
  need(KINDS.includes(kind), "a label is a carton, bin or price tag label");
  const name = String(e.name ?? "").trim();
  need(name && name.length <= 60, "name the template (up to 60 characters)");
  need(Number.isFinite(e.widthIn) && e.widthIn >= 1 && e.widthIn <= 8, "a label is 1 to 8 inches wide");
  need(Number.isFinite(e.heightIn) && e.heightIn >= 0.5 && e.heightIn <= 12, "a label is half an inch to 12 inches tall");
  const dpi = e.dpi ?? 203;
  need([203, 300, 600].includes(dpi), "printers print at 203, 300 or 600 dots per inch");
  const fields = [...new Set((e.fields ?? []).map(String))];
  need(fields.length, "pick at least one field to print");
  const bad = fields.filter((f) => !FIELDS[kind].includes(f));
  need(!bad.length, `${bad.join(", ")} is not a field on a ${kind.replace("_", " ")} label; pick from ${FIELDS[kind].join(", ")}`);
  if (e.isDefault) await c.query(`update label_template set is_default = false where entity_id = $1 and kind = $2 and is_default`, [scope.entityId, kind]);
  let id = e.id ?? null;
  if (id) {
    const r = await c.query(`update label_template set name = $3, width_in = $4, height_in = $5, dpi = $6, fields = $7, is_default = $8, active = $9
      where id = $1 and entity_id = $2 and kind = $10`, [id, scope.entityId, name, e.widthIn, e.heightIn, dpi, fields, !!e.isDefault, e.active ?? true, kind]);
    need(r.rowCount, "no such label template");
  } else {
    const dup = await q(c, `select 1 from label_template where entity_id = $1 and kind = $2 and name = $3`, [scope.entityId, kind, name]);
    need(!dup.length, `there is already a ${kind.replace("_", " ")} template called ${name}`);
    id = (await one<{ id: string }>(c, `insert into label_template (entity_id, kind, name, width_in, height_in, dpi, fields, is_default, active, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [scope.entityId, kind, name, e.widthIn, e.heightIn, dpi, fields, !!e.isDefault, e.active ?? true, scope.actor.id || null])).id;
  }
  await audit(c, scope, { table: "label_template", rowId: id!, action: e.id ? "update" : "insert", after: { kind, name, fields } });
  return { id };
}

// ----------------------------------------------------------------- data --

export type CartonLabel = { barcode: string; sku: string; description: string; po: string | null; piece: string; customer: string | null; order: string | null;
  stop: string | null; serial: string | null; lot: string | null; location: string | null };
export type BinLabel = { barcode: string; bin: string; location: string; zone: string | null };
export type PriceTag = { barcode: string; name: string; brand: string | null; sku: string; retail: string; sale: string | null; package: string | null; condition: string | null };
export type LabelSet = { kind: Kind; labels: (CartonLabel | BinLabel | PriceTag)[]; source: string };

const $ = (m: bigint) => { const neg = m < 0n; const a = neg ? -m : m; return `${neg ? "-" : ""}$${(a / 100n).toLocaleString("en-US")}.${String(a % 100n).padStart(2, "0")}`; };

async function hasColumn(c: Client, table: string, column: string): Promise<boolean> {
  const r = await q(c, `select 1 from information_schema.columns where table_schema = current_schema() and table_name = $1 and column_name = $2 /* unscoped: schema lookup */`, [table, column]);
  return r.length > 0;
}

/** Carton labels for pieces by id: SKU, what it is, PO, carton x of y, the customer and stop when it is spoken for. */
async function piecesById(c: Client, entityId: string, ids: string[]): Promise<CartonLabel[]> {
  if (!ids.length) return [];
  const r = await q<{ label: string; carton_seq: number; carton_count: number; carton_label: string | null; serial_no: string | null; lot_code: string | null;
    sku: string; name: string; location: string; bin: string | null; order_number: string | null; customer: string | null; po: string | null; stop: string | null }>(c, `
    select pc.label, pc.carton_seq, pc.carton_count, pc.carton_label, pc.serial_no, pc.lot_code, p.sku, p.name, lo.name location, b.code bin,
           so.number order_number, cu.name customer,
           (select po.number from goods_receipt_line gl join goods_receipt gr on gr.id = gl.goods_receipt_id join purchase_order po on po.id = gr.purchase_order_id
             where gl.id = pc.goods_receipt_line_id and po.entity_id = pc.entity_id) po,
           (select concat(r.number, ' stop ', i.stop_seq) from route_load_item i join delivery_route r on r.id = i.route_id
             where i.entity_id = pc.entity_id and i.piece_id = pc.id and i.status <> 'removed' order by i.created_at desc limit 1) stop
      from inv_piece pc join product p on p.id = pc.product_id join location lo on lo.id = pc.location_id
      left join inv_bin b on b.id = pc.bin_id
      left join sales_order_line l on l.id = pc.sales_order_line_id left join sales_order so on so.id = l.sales_order_id
      left join customer cu on cu.id = so.customer_id
     where pc.entity_id = $1 and pc.id = any($2)
     order by pc.unit_id, pc.carton_seq`, [entityId, ids]);
  const reserved = (x: { order_number: string | null }) => !!x.order_number;
  return r.map((x) => ({ barcode: x.label, sku: x.sku, description: x.carton_label ? `${x.name} · ${x.carton_label}` : x.name, po: x.po,
    piece: `${x.carton_seq} of ${x.carton_count}`, customer: reserved(x) ? x.customer : null, order: x.order_number, stop: x.stop,
    serial: x.serial_no, lot: x.lot_code, location: [x.location, x.bin].filter(Boolean).join(" · ") }));
}

/** Labels for everything that came in on one goods receipt. Stock not tracked by piece gets one SKU label per unit. */
export async function forReceipt(c: Client, entityId: string, receiptId: string): Promise<LabelSet> {
  const gr = await q<{ id: string; number: string }>(c, `select gr.id, po.number from goods_receipt gr join purchase_order po on po.id = gr.purchase_order_id
    where gr.id = $1 and po.entity_id = $2`, [receiptId, entityId]);
  need(gr.length, "no such receipt");
  const pcs = await q<{ id: string }>(c, `select pc.id from inv_piece pc join goods_receipt_line gl on gl.id = pc.goods_receipt_line_id
    where pc.entity_id = $1 and gl.goods_receipt_id = $2 order by pc.label`, [entityId, receiptId]);
  const labels: CartonLabel[] = await piecesById(c, entityId, pcs.map((x) => x.id));
  const plain = await q<{ qty: string; sku: string; name: string; barcode: string | null; lot_code: string | null }>(c, `
    select gl.quantity::text qty, p.sku, p.name, p.barcode, gl.lot_code from goods_receipt_line gl
      join purchase_order_line pol on pol.id = gl.purchase_order_line_id join product p on p.id = pol.product_id and p.entity_id = $1
     where gl.goods_receipt_id = $2 and not p.serialized order by p.sku`, [entityId, receiptId]);
  for (const x of plain) {
    const n = Math.max(0, Math.min(500, Math.trunc(Number(x.qty))));
    for (let k = 1; k <= n; k++) labels.push({ barcode: x.barcode && /^[\x20-\x7e]{1,40}$/.test(x.barcode) ? x.barcode : x.sku, sku: x.sku, description: x.name, po: gr[0].number,
      piece: `${k} of ${n}`, customer: null, order: null, stop: null, serial: null, lot: x.lot_code, location: null });
  }
  return { kind: "carton", labels, source: `receipt on ${gr[0].number}` };
}

/** Labels for the pieces waiting on the prep queue (at one location, or everywhere). */
export async function forPrep(c: Client, entityId: string, locationId: string | null): Promise<LabelSet> {
  const pcs = await q<{ id: string }>(c, `select distinct pc.id, pc.label from wms_prep_job j join inv_piece pc on pc.entity_id = j.entity_id and pc.unit_id = j.unit_id
    where j.entity_id = $1 and j.status in ('queued','in_progress','problem') and ($2::uuid is null or j.location_id = $2) order by pc.label limit 500`, [entityId, locationId]);
  return { kind: "carton", labels: await piecesById(c, entityId, pcs.map((x) => x.id)), source: "prep queue" };
}

/** Labels for a route's loading manifest, with each piece's stop. */
export async function forManifest(c: Client, entityId: string, routeId: string): Promise<LabelSet> {
  const rt = await q<{ number: string }>(c, `select number from delivery_route where id = $1 and entity_id = $2`, [routeId, entityId]);
  need(rt.length, "no such route");
  const items = await q<{ piece_id: string | null; label: string; description: string; carton: string | null; stop_seq: number; customer: string | null; order_number: string | null }>(c, `
    select i.piece_id, i.label, i.description, i.carton, i.stop_seq, cu.name customer, so.number order_number
      from route_load_item i join delivery_stop s on s.id = i.stop_id
      left join customer cu on cu.id = s.customer_id left join sales_order so on so.id = s.sales_order_id
     where i.entity_id = $1 and i.route_id = $2 and i.status <> 'removed' order by i.load_group, i.stop_seq, i.ordinal`, [entityId, routeId]);
  const byPiece = new Map((await piecesById(c, entityId, items.map((x) => x.piece_id).filter(Boolean) as string[])).map((l) => [l.barcode, l]));
  const labels: CartonLabel[] = items.map((x) => {
    const stop = `${rt[0].number} stop ${x.stop_seq}`;
    const pl = x.piece_id ? byPiece.get(x.label) : undefined;
    return pl ? { ...pl, stop } : { barcode: x.label, sku: x.label, description: x.description, po: null, piece: x.carton ?? "1 of 1", customer: x.customer,
      order: x.order_number, stop, serial: null, lot: null, location: null };
  });
  return { kind: "carton", labels, source: `manifest ${rt[0].number}` };
}

/** Labels for scanned or typed piece labels. */
export async function forPieces(c: Client, entityId: string, labels: string[]): Promise<LabelSet> {
  const want = [...new Set(labels.map((x) => String(x).trim().toUpperCase()).filter(Boolean))].slice(0, 500);
  need(want.length, "scan or type at least one piece label");
  const r = await q<{ id: string; label: string }>(c, `select id, label from inv_piece where entity_id = $1 and upper(label) = any($2)`, [entityId, want]);
  const missing = want.filter((w) => !r.some((x) => x.label.toUpperCase() === w));
  need(!missing.length, `no piece is labelled ${missing.slice(0, 3).join(", ")}`);
  return { kind: "carton", labels: await piecesById(c, entityId, r.map((x) => x.id)), source: "pieces" };
}

export async function forBins(c: Client, entityId: string, e: { locationId?: string | null; binIds?: string[] }): Promise<LabelSet> {
  need(e.locationId || e.binIds?.length, "pick a location or the bins to label");
  const r = await q<{ code: string; location: string; zone: string | null }>(c, `
    select b.code, lo.name location, z.name zone from inv_bin b join location lo on lo.id = b.location_id left join inv_zone z on z.id = b.zone_id
     where b.entity_id = $1 and b.active and ($2::uuid is null or b.location_id = $2) and (cardinality($3::uuid[]) = 0 or b.id = any($3))
     order by lo.name, b.code limit 500`, [entityId, e.locationId ?? null, e.binIds ?? []]);
  return { kind: "bin", labels: r.map((x) => ({ barcode: x.code, bin: x.code, location: x.location, zone: x.zone })), source: "bins" };
}

/**
 * Price tags: retail (the ticket), sale (when a promotion or price list brings
 * it down), the package price (a set, or the set this piece belongs to) and
 * a condition grade when the catalog keeps one (that column may not exist).
 */
export async function forPriceTags(c: Client, entityId: string, e: { productIds: string[]; priceList?: string | null }): Promise<LabelSet> {
  need(e.productIds.length, "pick the products to tag");
  const grade = await hasColumn(c, "product", "condition_grade");
  const rows = await q<{ id: string; sku: string; name: string; brand: string | null; barcode: string | null; grade: string | null }>(c, `
    select p.id, p.sku, p.name, p.brand, p.barcode, ${grade ? "p.condition_grade::text" : "null::text"} grade from product p
     where p.entity_id = $1 and p.id = any($2) and p.status in ('active','floor_sample','drop') order by p.name limit 300`, [entityId, e.productIds]);
  const kits = await q<{ component_id: string; kit_id: string; name: string }>(c, `select k.component_id, k.kit_id, p.name from product_kit_component k
     join product p on p.id = k.kit_id where p.entity_id = $1 and k.component_id = any($2) and p.status = 'active'`, [entityId, rows.map((r) => r.id)]);
  const out: PriceTag[] = [];
  for (const r of rows) {
    let pc;
    try { pc = await priceConfigured(c, entityId, r.id, [], { priceList: e.priceList ?? null }); }
    catch (err) { if (err instanceof PricingError) continue; throw err; }
    const ticket = pc.ticketMinor ?? pc.unitPriceMinor;
    let pkg: string | null = null;
    if (pc.kit) pkg = `${$(pc.unitPriceMinor)} the set (separately ${$(pc.kit.componentTotalMinor)})`;
    else {
      const k = kits.find((x) => x.component_id === r.id);
      if (k) {
        try { const kp = await priceConfigured(c, entityId, k.kit_id, [], { priceList: e.priceList ?? null }); pkg = `${k.name} ${$(kp.unitPriceMinor)}`; }
        catch (err) { if (!(err instanceof PricingError)) throw err; }
      }
    }
    out.push({ barcode: r.barcode && /^[\x20-\x7e]{1,40}$/.test(r.barcode) ? r.barcode : r.sku, name: r.name, brand: r.brand, sku: r.sku,
      retail: $(ticket), sale: pc.unitPriceMinor < ticket ? $(pc.unitPriceMinor) : null, package: pkg, condition: r.grade });
  }
  return { kind: "price_tag", labels: out, source: "price tags" };
}

// ------------------------------------------------------------------ ZPL --

/** The Code 128-B check value for data (start B = 104, then each symbol times its place, mod 103). */
export function code128Check(text: string): number {
  let sum = 104;
  [...text].forEach((ch, i) => { sum += (ch.charCodeAt(0) - 32) * (i + 1); });
  return sum % 103;
}

/** Text for a ^FD under ^FH_: printable ASCII only, with the three characters ZPL reads as commands written as hex. */
export function zplText(v: unknown): string {
  return String(v ?? "").replace(/[^\x20-\x7e]/g, "?").replace(/[_^~]/g, (m) => "_" + m.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

type Line = { text: string; size: "xl" | "l" | "m" | "s"; strike?: boolean };

function linesFor(kind: Kind, l: CartonLabel | BinLabel | PriceTag, fields: string[]): Line[] {
  const has = (f: string) => fields.includes(f);
  const out: Line[] = [];
  const add = (f: string, text: string | null | undefined, size: Line["size"] = "m", strike = false) => { if (has(f) && text) out.push({ text, size, strike }); };
  if (kind === "carton") {
    const x = l as CartonLabel;
    add("sku", x.sku, "l"); add("description", x.description, "m"); add("piece", `Piece ${x.piece}`, "l");
    add("po", x.po ? `PO ${x.po}` : null, "s");
    add("serial", x.serial ? `Serial ${x.serial}` : null, "s"); add("lot", x.lot ? `Lot ${x.lot}` : null, "s");
    add("customer", x.customer, "m"); add("order", x.order ? `Order ${x.order}` : null, "s"); add("stop", x.stop ? x.stop.replace(/ stop /, " · Stop ") : null, "l");
    add("location", x.location, "s");
  } else if (kind === "bin") {
    const x = l as BinLabel;
    add("bin", x.bin, "xl"); add("location", x.location, "s"); add("zone", x.zone, "s");
  } else {
    const x = l as PriceTag;
    add("brand", x.brand, "s"); add("name", x.name, "l"); add("sku", x.sku, "s");
    add("retail", x.sale ? `Retail ${x.retail}` : x.retail, x.sale ? "m" : "xl", !!x.sale); add("sale", x.sale ? `Sale ${x.sale}` : null, "xl");
    add("package", x.package ? `Package: ${x.package}` : null, "s"); add("condition", x.condition ? `Condition ${x.condition}` : null, "m");
  }
  return out;
}

/** One label in ZPL II. */
export function zplLabel(t: Template, kind: Kind, l: CartonLabel | BinLabel | PriceTag): string {
  const w = Math.round(t.width_in * t.dpi), h = Math.round(t.height_in * t.dpi);
  const k = t.dpi / 203;
  const px = { xl: Math.round(64 * k), l: Math.round(40 * k), m: Math.round(30 * k), s: Math.round(24 * k) };
  const margin = Math.round(20 * k);
  const out: string[] = ["^XA", "^CI0", `^PW${w}`, `^LL${h}`, "^LH0,0"];
  let y = margin;
  for (const ln of linesFor(kind, l, t.fields)) {
    const size = px[ln.size];
    if (y + size > h - margin) break;
    out.push(`^FO${margin},${y}^A0N,${size},${size}^FB${w - margin * 2},1,0,L^FH_^FD${zplText(ln.text)}^FS`);
    if (ln.strike) out.push(`^FO${margin},${y + Math.round(size / 2)}^GB${Math.min(w - margin * 2, Math.round(ln.text.length * size * 0.55))},${Math.max(2, Math.round(2 * k))},${Math.max(2, Math.round(2 * k))}^FS`);
    y += size + Math.round(8 * k);
  }
  if (t.fields.includes("barcode") && l.barcode) {
    const data = l.barcode;
    const bars = code128(data);                       // refuses what Code 128-B cannot carry
    const modules = bars.reduce((a, b) => a + b, 0) + 20;
    const mod = Math.max(1, Math.min(4, Math.floor((w - margin * 2) / modules)));
    const bh = Math.max(Math.round(40 * k), Math.min(Math.round(120 * k), h - y - margin - Math.round(30 * k)));
    if (y + bh <= h - margin) {
      out.push(`^FX Code128-B ${zplText(data)} check ${code128Check(data)}^FS`);
      out.push(`^FO${margin},${y}^BY${mod},3,${bh}^BCN,${bh},Y,N,N^FH_^FD${zplText(data).replace(/>/g, "><")}^FS`);
    }
  }
  out.push("^PQ1", "^XZ");
  return out.join("\n");
}

export function zplFor(t: Template, set: LabelSet): string {
  need(set.labels.length, "nothing to print");
  need(set.kind === t.kind, `that template is for ${t.kind.replace("_", " ")} labels, not ${set.kind.replace("_", " ")} labels`);
  return set.labels.map((l) => zplLabel(t, set.kind, l)).join("\n") + "\n";
}

// ------------------------------------------------------------ print page --

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!));

/** A Code 128 symbol as SVG rects (no script, no style attribute: the page's policy holds). */
export function barcodeSvg(text: string, heightPx = 50): string {
  const bars = code128(text);
  const quiet = 10, total = bars.reduce((a, b) => a + b, 0) + quiet * 2;
  let x = quiet, rects = "";
  bars.forEach((wd, i) => { if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${wd}" height="${heightPx}"/>`; x += wd; });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${heightPx + 11}" preserveAspectRatio="none" role="img" aria-label="Barcode ${esc(text)}">${rects}` +
    `<text x="${total / 2}" y="${heightPx + 10}" text-anchor="middle" font-size="10" font-family="monospace">${esc(text)}</text></svg>`;
}

/** A print page: one label per printed page at the template's size (Dymo and desktop printers), browser's own Print. */
export function printPage(t: Template, set: LabelSet, title: string): string {
  need(set.labels.length, "nothing to print");
  const pt = { xl: "26pt", l: "16pt", m: "11pt", s: "9pt" };
  const body = set.labels.map((l) => {
    const lines = linesFor(set.kind, l, t.fields).map((ln) => `<div class="${ln.size}${ln.strike ? " strike" : ""}">${esc(ln.text)}</div>`).join("");
    const bc = t.fields.includes("barcode") && l.barcode ? `<div class="bc">${barcodeSvg(l.barcode)}</div>` : "";
    return `<section class="label">${lines}${bc}</section>`;
  }).join("\n");
  const style = `@page{size:${t.width_in}in ${t.height_in}in;margin:0}*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#000;background:#fff}
.note{padding:10px 14px;font-size:14px;background:#f4f2ee;border-bottom:1px solid #ccc}
.label{width:${t.width_in}in;height:${t.height_in}in;padding:.12in .16in;overflow:hidden;page-break-after:always;break-after:page;display:flex;flex-direction:column;gap:2px;border:1px dashed #bbb;margin:8px auto}
.xl{font-size:${pt.xl};font-weight:800;line-height:1.05}.l{font-size:${pt.l};font-weight:700}.m{font-size:${pt.m}}.s{font-size:${pt.s};color:#222}
.strike{text-decoration:line-through}.bc{margin-top:auto}.bc svg{width:100%;height:${Math.max(0.35, Math.min(1.1, t.height_in * 0.25))}in}
@media print{.note{display:none}.label{border:0;margin:0}}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style nonce="__NONCE__">${style}</style></head>
<body><div class="note">${esc(`${set.labels.length} ${set.kind.replace("_", " ")} label${set.labels.length === 1 ? "" : "s"} · ${t.name} (${t.width_in} × ${t.height_in} in) · ${set.source}`)}. Use the browser's Print, with the label printer picked and margins off.</div>
${body}</body></html>`;
}

// ------------------------------------------------------------- printers --

/** An address a label printer may have: an IPv4 or IPv6 literal on a private network. Host names, loopback, link-local and public addresses are refused. */
export function privatePrinterHost(host: unknown): string {
  const h = String(host ?? "").trim();
  need(h, "type the printer's network address, like 192.168.1.50");
  const v = net.isIP(h);
  need(v, `${h.slice(0, 60)} is not an IP address; give the printer a fixed address on the store network and type that (host names are not accepted)`);
  if (v === 4) {
    const [a, b] = h.split(".").map(Number);
    need(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168),
      `${h} is not on a private network (10.x, 172.16-31.x or 192.168.x); labels are only sent to printers inside the business`);
  } else {
    need(/^f[cd][0-9a-f]{2}:/i.test(h), `${h} is not a private (unique-local fc00::/7) IPv6 address; labels are only sent to printers inside the business`);
  }
  return h;
}

export async function printers(c: Client, entityId: string) {
  return q(c, `select lp.id, lp.name, host(lp.host) host, lp.port, lp.active, lo.name location, lp.location_id from label_printer lp
    left join location lo on lo.id = lp.location_id where lp.entity_id = $1 order by lp.active desc, lp.name`, [entityId]);
}

/** The ports a label printer may be on: 9100, unless the owner set others (9100-9109) in labels.printer_ports. */
export async function printerPorts(c: Client, entityId: string): Promise<number[]> {
  const r = await q<{ value: unknown }>(c, `select value from entity_setting where entity_id = $1 and key = 'labels.printer_ports'`, [entityId]);
  const v = Array.isArray(r[0]?.value) ? (r[0].value as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 9100 && n <= 9109) : [];
  return v.length ? v : [9100];
}

/** Set up (or change) a printer. The caller checks that this is the owner. */
export async function savePrinter(c: Client, scope: Scope, e: { id?: string | null; name: string; host: string; port?: number; locationId?: string | null; active?: boolean }) {
  const name = String(e.name ?? "").trim();
  need(name && name.length <= 60, "name the printer (up to 60 characters)");
  const host = privatePrinterHost(e.host);
  const port = e.port ?? 9100;
  const allowed = await printerPorts(c, scope.entityId);
  need(Number.isInteger(port) && allowed.includes(port), `label printers listen on port ${allowed.join(" or ")}; another port is set by the owner in the company's settings (labels.printer_ports)`);
  if (e.locationId) need((await q(c, `select 1 from location where id = $1 and entity_id = $2`, [e.locationId, scope.entityId])).length, "no such location");
  let id = e.id ?? null;
  if (id) {
    const r = await c.query(`update label_printer set name = $3, host = $4::inet, port = $5, location_id = $6, active = $7 where id = $1 and entity_id = $2`,
      [id, scope.entityId, name, host, port, e.locationId ?? null, e.active ?? true]);
    need(r.rowCount, "no such printer");
  } else {
    const dup = await q(c, `select 1 from label_printer where entity_id = $1 and name = $2`, [scope.entityId, name]);
    need(!dup.length, `there is already a printer called ${name}`);
    id = (await one<{ id: string }>(c, `insert into label_printer (entity_id, name, host, port, location_id, active, created_by) values ($1,$2,$3::inet,$4,$5,$6,$7) returning id`,
      [scope.entityId, name, host, port, e.locationId ?? null, e.active ?? true, scope.actor.id || null])).id;
  }
  await audit(c, scope, { table: "label_printer", rowId: id!, action: e.id ? "update" : "insert", after: { name, host, port } });
  return { id, name, host, port };
}

/** How bytes reach a printer. Replaced in the checks; the real one is raw TCP with a short timeout. */
export type Transport = (host: string, port: number, data: string) => Promise<void>;
export const tcpTransport: Transport = (host, port, data) => new Promise((resolve, reject) => {
  const sock = net.connect({ host, port, family: net.isIP(host) });
  const done = (err?: Error) => { sock.destroy(); err ? reject(err) : resolve(); };
  sock.setTimeout(5000, () => done(new Error("the printer did not answer within 5 seconds")));
  sock.once("error", (err) => done(err));
  sock.once("connect", () => sock.end(data, "latin1", () => done()));
});
let transport: Transport = tcpTransport;
/** For the checks only. */
export function useTransport(t: Transport | null) { transport = t ?? tcpTransport; }

/**
 * Send ZPL to a printer the owner set up. The printer is looked up by id in
 * this company; its address is checked again before connecting. Nothing in
 * the request can name a host or port.
 */
export async function sendToPrinter(c: Client, scope: Scope, printerId: string, zpl: string, source: string, count: number) {
  const r = await q<{ id: string; name: string; host: string; port: number; active: boolean }>(c,
    `select id, name, host(host) host, port, active from label_printer where id = $1 and entity_id = $2`, [printerId, scope.entityId]);
  need(r.length, "that is not one of this company's printers; the owner sets printers up in Labels");
  need(r[0].active, `${r[0].name} is switched off in Labels`);
  const host = privatePrinterHost(r[0].host);
  need((await printerPorts(c, scope.entityId)).includes(r[0].port), `${r[0].name} is set to port ${r[0].port}, which the company's settings no longer allow`);
  need(zpl.length <= 2_000_000, "that is too many labels to send at once; send them in smaller batches");
  let error: string | null = null;
  try { await transport(host, r[0].port, zpl); }
  catch (e) { error = (e as Error).message || "the printer could not be reached"; }
  await c.query(`insert into label_print_job (entity_id, printer_id, how, source, labels, bytes, status, error, by_user) values ($1,$2,'network',$3,$4,$5,$6,$7,$8)`,
    [scope.entityId, printerId, source.slice(0, 120), count, zpl.length, error ? "failed" : "sent", error, scope.actor.id || null]);
  need(!error, `${r[0].name} (${host}) did not take the labels: ${error}`);
  return { printer: r[0].name, labels: count, bytes: zpl.length };
}

export async function logMade(c: Client, scope: Scope, how: "download" | "browser", source: string, count: number, bytes = 0) {
  await c.query(`insert into label_print_job (entity_id, how, source, labels, bytes, status, by_user) values ($1,$2,$3,$4,$5,'made',$6)`,
    [scope.entityId, how, source.slice(0, 120), count, bytes, scope.actor.id || null]);
}

export async function recentJobs(c: Client, entityId: string) {
  return q(c, `select j.at, j.how, j.source, j.labels, j.status, j.error, lp.name printer, u.name by_name from label_print_job j
    left join label_printer lp on lp.id = j.printer_id left join app_user u on u.id = j.by_user where j.entity_id = $1 order by j.at desc limit 30`, [entityId]);
}
