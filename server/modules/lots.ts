// lots module -- serial numbers and dye lots (extends inventory), label
// printing (ZPL, network printers, print pages), and finance company
// settlement reconciliation (extends A/R's third-party finance).
// Routes under /api/c/<company>/lots/..., /labels/... and /settlements/...
// The rules live in packages/core/inventory.ts (serials and lots),
// packages/core/labels.ts and packages/core/ar_settlement.ts; this file
// checks who may do what and reads the request.
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { need, requireRole, str, uuid, minor, ModuleError, PublicPage, lookOnly } from "./kit.ts";
import { q } from "../../packages/core/db.ts";
import { scopeOf, rolesOf } from "../actions.ts";
import * as inv from "../../packages/core/inventory.ts";
import * as L from "../../packages/core/labels.ts";
import * as S from "../../packages/core/ar_settlement.ts";
import { PostingError } from "../../packages/core/posting.ts";
import { PricingError } from "../../packages/core/pricing.ts";
import { CatalogError } from "../../packages/core/catalog.ts";
import { ReconcileError } from "../../packages/core/reconcile.ts";

const ID = "([0-9a-fA-F-]{36})";
const LABEL = "([A-Za-z0-9-]{1,40})";

const safe = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
  try { return await fn(...a); } catch (e) {
    if (e instanceof inv.InventoryError || e instanceof L.LabelError || e instanceof S.SettlementError || e instanceof PostingError
      || e instanceof PricingError || e instanceof CatalogError || e instanceof ReconcileError) throw new ModuleError(e.message);
    throw e;
  }
};

const WAREHOUSE = ["warehouse", "store_manager"];
const LOTS_SETUP = ["store_manager", "controller"];          // strict lots on or off
const PRODUCT = ["buyer", "store_manager"];                  // how a product is matched (dye lot, finish batch)
const RESERVE = ["warehouse", "store_manager", "sales"];     // putting pieces on an order
const PRINT = ["warehouse", "store_manager", "dispatcher", "buyer"];
const TAGS = ["store_manager", "buyer", "sales", "warehouse"];
const TEMPLATES = ["store_manager"];
const CLERK = ["ar_clerk", "controller"];                    // importing settlements, exceptions
const CONTROL = ["controller"];                              // lender setup, charge-offs

const sc = (co: Company, a: Actor) => scopeOf(co, a);
const list = (v: unknown, max = 500): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : []).map((x) => String(x).trim()).filter(Boolean).slice(0, max);
const ids = (v: unknown): string[] => list(v).map(uuid).filter(Boolean) as string[];

// ---------------------------------------------------------------- labels --

type Src = { source: string; id?: string | null; locationId?: string | null; labels?: string[]; productIds?: string[]; skus?: string[]; binIds?: string[]; priceList?: string | null; templateId?: string | null };

function srcOf(b: Record<string, unknown> | URLSearchParams): Src {
  const g = (k: string) => (b instanceof URLSearchParams ? b.get(k) : (b as Record<string, unknown>)[k]);
  return { source: str(g("source"), 20), id: uuid(g("id")), locationId: uuid(g("locationId")), labels: list(g("labels")), productIds: ids(g("productIds")),
    skus: list(g("skus"), 300).map((x) => x.slice(0, 40)), binIds: ids(g("binIds")), priceList: str(g("priceList"), 24) || null, templateId: uuid(g("templateId")) };
}

async function rolesFor(c: Client, co: Company, a: Actor, s: Src) {
  await requireRole(c, co, a, s.source === "tags" ? TAGS : PRINT, s.source === "tags" ? "printing price tags" : "printing labels");
}

async function setFor(c: Client, co: Company, s: Src): Promise<L.LabelSet> {
  switch (s.source) {
    case "receipt": need(s.id, "pick the receipt"); return L.forReceipt(c, co.id, s.id!);
    case "prep": return L.forPrep(c, co.id, s.locationId ?? null);
    case "manifest": need(s.id, "pick the route"); return L.forManifest(c, co.id, s.id!);
    case "pieces": return L.forPieces(c, co.id, s.labels ?? []);
    case "bins": return L.forBins(c, co.id, { locationId: s.locationId, binIds: s.binIds });
    case "tags": {
      const pids = [...(s.productIds ?? [])];
      if (s.skus?.length) {
        const r = await q<{ id: string; sku: string }>(c, `select id, sku from product where entity_id = $1 and upper(sku) = any($2)`, [co.id, s.skus.map((x) => x.toUpperCase())]);
        const missing = s.skus.filter((x) => !r.some((p) => p.sku.toUpperCase() === x.toUpperCase()));
        need(!missing.length, `no product has SKU ${missing.slice(0, 3).join(", ")}`);
        pids.push(...r.map((x) => x.id));
      }
      return L.forPriceTags(c, co.id, { productIds: pids, priceList: s.priceList });
    }
    default: need(false, "say what to print: a receipt, the prep queue, a manifest, pieces, bins or price tags"); throw new Error("unreachable");
  }
}

async function zplFor(c: Client, co: Company, s: Src) {
  const set = await setFor(c, co, s);
  need(set.labels.length, "nothing to print from that");
  const t = await L.templateFor(c, co.id, set.kind, s.templateId);
  return { set, t, zpl: L.zplFor(t, set) };
}

async function labelOptions(c: Client, co: Company) {
  const [tpl, printers, jobs, locations, receipts, routes, prepCount] = await Promise.all([
    L.templates(c, co.id), L.printers(c, co.id), L.recentJobs(c, co.id),
    q(c, `select id, name, kind from location where entity_id = $1 and status = 'active' and kind in ('warehouse','store','outlet') order by kind <> 'warehouse', name`, [co.id]),
    q(c, `select gr.id, po.number, gr.received_on::text received_on, count(gl.id)::int lines from goods_receipt gr join purchase_order po on po.id = gr.purchase_order_id
           join goods_receipt_line gl on gl.goods_receipt_id = gr.id where po.entity_id = $1 group by gr.id, po.number order by gr.received_on desc, po.number desc limit 20`, [co.id]),
    q(c, `select r.id, r.number, r.route_on::text route_on, (select count(*) from route_load_item i where i.entity_id = r.entity_id and i.route_id = r.id and i.status <> 'removed')::int pieces
           from delivery_route r where r.entity_id = $1 and r.status <> 'cancelled' and r.route_on >= current_date - 1 order by r.route_on, r.number limit 30`, [co.id]),
    q<{ n: number }>(c, `select count(*)::int n from wms_prep_job where entity_id = $1 and status in ('queued','in_progress','problem')`, [co.id]),
  ]);
  return { ...tpl, printers, jobs, locations, receipts, routes, prepOpen: prepCount[0]?.n ?? 0, kinds: L.KINDS };
}

// ------------------------------------------------------------ settlements --

async function settlementView(c: Client, co: Company) {
  const [lenders, imports, exceptions, variances, aging, setAside] = await Promise.all([
    S.lenders(c, co.id), S.imports(c, co.id), S.exceptions(c, co.id), S.feeVariances(c, co.id), S.lenderAging(c, co.id), S.setAside(c, co.id)]);
  return { ...lenders, imports, exceptions, variances, aging, setAside };
}

export const module: ErpModule = {
  id: "lots",
  register({ coGet, coPost }) {
    // ================================================= serials and lots
    coGet("/lots/search", safe((c, co, url) => inv.searchSerials(c, co.id, str(url.searchParams.get("q"), 60))));
    coGet("/lots/settings", safe(async (c, co) => ({
      strict: await inv.lotStrict(c, co.id),
      products: await q(c, `select id, sku, name, lot_class, lot_group, collection, color, serialized from product
        where entity_id = $1 and kind in ('stock','configurable','special_order') and status <> 'discontinued' order by lot_class nulls last, name limit 500`, [co.id]),
    })));
    coGet("/lots/find-order", safe(async (c, co, url) => {
      const no = str(url.searchParams.get("no"), 40);
      need(no, "type the order number");
      const r = await q<{ id: string; number: string }>(c, `select id, number from sales_order where entity_id = $1 and upper(number) = upper($2)`, [co.id, no]);
      need(r.length, `no order is numbered ${no}`);
      return r[0];
    }));
    coGet(`/lots/orders/${ID}`, safe(async (c, co, _u, m) => {
      const lines = await q<{ id: string; sku: string; description: string; qty: string; line_status: string }>(c, `select l.id, l.sku, l.description, l.qty::text, l.line_status
        from sales_order_line l where l.entity_id = $1 and l.sales_order_id = $2 order by l.seq`, [co.id, m[2]]);
      const by = await inv.lotsForLines(c, co.id, lines.map((l) => l.id));
      return { lines: lines.map((l) => ({ ...l, pieces: by.get(l.id) ?? [] })), mixed: await inv.lotMix(c, co.id, m[2]), strict: await inv.lotStrict(c, co.id) };
    }));
    coPost("/lots/settings", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, LOTS_SETUP, "changing how strictly lots are kept");
      need(typeof b.strict === "boolean", "say whether lots are strict (true) or warn only (false)");
      return inv.setLotStrict(c, sc(co, a), b.strict as boolean);
    }));
    coPost(`/lots/products/${ID}`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, PRODUCT, "setting how a product's lots are matched");
      const cls = str(b.lotClass, 20) || null;
      return inv.setLotClass(c, sc(co, a), m[2], { lotClass: cls, lotGroup: b.lotGroup === undefined ? null : str(b.lotGroup, 80) || null });
    }));
    coPost(`/lots/pieces/${LABEL}`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, WAREHOUSE, "recording a serial number or lot");
      return inv.setUnitIds(c, sc(co, a), m[2], { serial: b.serial === undefined ? undefined : str(b.serial, 60) || null, lot: b.lot === undefined ? undefined : str(b.lot, 40) || null });
    }));
    coPost(`/lots/orders/${ID}/reserve`, safe(async (c, co, a, _b, m) => {
      await requireRole(c, co, a, RESERVE, "reserving pieces for an order");
      return inv.reservePieces(c, sc(co, a), m[2]);
    }));

    // ============================================================ labels
    coGet("/labels/options", safe((c, co) => labelOptions(c, co)));
    // The browser print page: HTML with SVG barcodes at the label's size, no script.
    // A link opened in a new tab carries no headers, so the acting person may ride in ?as=; either way they must hold the printing roles.
    coGet("/labels/print", safe(async (c, co, url, _m, personId) => {
      const who = personId ?? uuid(url.searchParams.get("as"));
      need(who, "pick who you are acting as before printing");
      const s = srcOf(url.searchParams);
      const a: Actor = { personId: who!, personName: "", label: "" };
      await rolesFor(c, co, a, s);
      const set = await setFor(c, co, s);
      const t = await L.templateFor(c, co.id, set.kind, s.templateId);
      const html = L.printPage(t, set, `${set.kind === "price_tag" ? "Price tags" : "Labels"} · ${co.name}`);
      // a preview (an owner seeing someone's view) or a demo prospect looks only: nothing is logged
      if (!lookOnly(c)) await L.logMade(c, sc(co, a), "browser", set.source, set.labels.length, html.length);
      return new PublicPage(html);
    }));
    coPost("/labels/zpl", safe(async (c, co, a, b) => {
      const s = srcOf(b);
      await rolesFor(c, co, a, s);
      const { set, t, zpl } = await zplFor(c, co, s);
      await L.logMade(c, sc(co, a), "download", set.source, set.labels.length, zpl.length);
      return { filename: `${set.kind}-labels-${new Date().toISOString().slice(0, 10)}.zpl`, zpl, labels: set.labels.length, template: t.name, source: set.source };
    }));
    coPost("/labels/send", safe(async (c, co, a, b) => {
      // Only a printer the owner set up: the request names it, never an address.
      need(!["host", "ip", "address", "port", "url"].some((k) => k in b), "a print request names one of the printers set up in Labels, not an address");
      const s = srcOf(b);
      await rolesFor(c, co, a, s);
      const pid = uuid(b.printerId);
      need(pid, "pick the printer");
      const { set, zpl } = await zplFor(c, co, s);
      return L.sendToPrinter(c, sc(co, a), pid!, zpl, set.source, set.labels.length);
    }));
    coPost("/labels/templates", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, TEMPLATES, "changing label templates");
      return L.saveTemplate(c, sc(co, a), { id: uuid(b.id), kind: str(b.kind, 20), name: str(b.name, 60), widthIn: Number(b.widthIn), heightIn: Number(b.heightIn),
        dpi: b.dpi === undefined ? undefined : Number(b.dpi), fields: list(b.fields, 20), isDefault: b.isDefault === true, active: b.active === false ? false : true });
    }));
    coPost("/labels/printers", safe(async (c, co, a, b) => {
      const held = await rolesOf(c, co, a.personId);
      need(held.has("owner"), "only the owner sets up label printers, because the server sends to them");
      return L.savePrinter(c, sc(co, a), { id: uuid(b.id), name: str(b.name, 60), host: str(b.host, 60), port: b.port === undefined || b.port === "" ? undefined : Number(b.port),
        locationId: uuid(b.locationId), active: b.active === false ? false : true });
    }));

    // ======================================================= settlements
    coGet("/settlements", safe((c, co) => settlementView(c, co)));
    coGet(`/settlements/imports/${ID}`, safe((c, co, _u, m) => S.importLines(c, co.id, m[2])));
    coGet("/settlements/aging", safe((c, co, url) => S.lenderAging(c, co.id, /^\d{4}-\d{2}-\d{2}$/.test(String(url.searchParams.get("asOf"))) ? String(url.searchParams.get("asOf")) : undefined)));
    coPost(`/settlements/lenders/${ID}`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, CONTROL, "setting up a finance company's settlement file");
      return S.setLender(c, sc(co, a), m[2], { mapping: b.mapping, bankAccountId: b.bankAccountId === undefined ? undefined : uuid(b.bankAccountId),
        feeToleranceMinor: b.feeTolerance === undefined || b.feeTolerance === "" ? undefined : minor(b.feeTolerance),
        chargebackMode: b.chargebackMode === undefined ? undefined : str(b.chargebackMode, 10) });
    }));
    coPost("/settlements/import", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, CLERK, "importing a finance company's settlement");
      const cid = uuid(b.companyId); need(cid, "pick the finance company");
      need(typeof b.text === "string", "attach the settlement file");
      return S.importRemittance(c, sc(co, a), { companyId: cid!, filename: str(b.filename, 200) || null, text: b.text as string, depositOn: str(b.depositOn, 10) || null });
    }));
    coPost(`/settlements/lines/${ID}/resolve`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, CLERK, "settling a settlement exception");
      return S.resolveException(c, sc(co, a), m[2], { financedSaleId: uuid(b.financedSaleId), dismissReason: b.dismissReason === undefined ? null : str(b.dismissReason, 300) });
    }));
    coPost(`/settlements/imports/${ID}/link`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, CLERK, "linking a settlement to the bank");
      return S.linkDeposit(c, sc(co, a), m[2], uuid(b.statementLineId));
    }));
    coPost(`/settlements/sales/${ID}/charge-off`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, CONTROL, "writing off a chargeback");
      return S.chargeOff(c, sc(co, a), m[2], str(b.reason, 300));
    }));
  },
};
