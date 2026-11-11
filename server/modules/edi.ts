// edi module -- see docs/MODULES.md for the contract.
// Vendor EDI and API ordering, as an extension of purchasing: trading
// partners (Setup, Vendor EDI), the EDI inbox and outbox, manual upload,
// a test 850, polling, the PO's EDI/API trail, and store orders (cart per
// vendor against freight minimums, submit, approve, PO, send).
import { TransportError } from "../../packages/core/transports.ts";
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, need, requireRole, str, uuid, int, minor } from "./kit.ts";
import { q, tx } from "../../packages/core/db.ts";
import { scopeOf } from "../actions.ts";
import * as edi from "../../packages/core/edi.ts";
import * as so from "../../packages/core/store_orders.ts";
import * as x12 from "../../packages/core/x12.ts";
import * as pur from "../../packages/core/purchasing.ts";
const { PurchasingError } = pur;
import { FeedError } from "../../packages/core/vendor_feeds.ts";
import { CatalogError } from "../../packages/core/catalog.ts";
import { BillError } from "../../packages/core/invoice.ts";
import { currentFeedEnv } from "./catalog.ts";

const ID = "([0-9a-fA-F-]{36})";
const BUY = ["buyer"];
const INTAKE = ["buyer", "ap_clerk"];
const STORE = ["store_manager", "buyer"];
const DECIDE = ["approver", "buyer"];

/** How EDI reaches the network and the drop folder: the server's own, unless checks hand in a fake. */
let ediEnv: () => edi.EdiEnv = () => ({ ...currentFeedEnv(), dropDir: process.env.ERP_EDI_DROP_DIR?.trim() || null });
export const useEdiEnv = (fn: () => edi.EdiEnv) => { ediEnv = fn; };
export const currentEdiEnv = () => ediEnv();

const KNOWN = [edi.EdiError, so.StoreOrderError, PurchasingError, FeedError, CatalogError, BillError, x12.X12Error, TransportError];
const isRefusal = (e: unknown) => KNOWN.some((K) => e instanceof K);
async function refuse<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (isRefusal(e)) throw new ModuleError((e as Error).message); throw e; }
}

/** A partner as a screen may see it: settings and which secrets are set (masked), never a secret's value. */
const partnerOut = (p: Record<string, unknown>) => {
  const o = { ...p };
  delete o.next_isa_control; delete o.next_gs_control; delete o.next_st_control;
  return o;
};

const strMap = (v: unknown): Record<string, string> => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [String(k).slice(0, 40), String(x ?? "").slice(0, 300)])) : {});

async function vendorsForSetup(c: Client, co: Company) {
  return q(c, `
    select v.id, coalesce(v.dba, v.legal_name) as name, (p.id is not null) has_partner, p.id partner_id
      from vendor_entity ve join vendor v on v.id = ve.vendor_id
      left join edi_partner p on p.entity_id = ve.entity_id and p.vendor_id = v.id
     where ve.entity_id = $1 and ve.status = 'active'
       and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise)
     order by 2`, [co.id]);
}

async function storeForm(c: Client, co: Company, url: URL) {
  const vendors = await q<{ id: string; name: string }>(c, `
    select v.id, coalesce(v.dba, v.legal_name) as name from vendor_entity ve join vendor v on v.id = ve.vendor_id
     where ve.entity_id = $1 and ve.status = 'active'
       and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise)
       and exists (select 1 from product p where p.entity_id = ve.entity_id and p.vendor_id = v.id and p.kind = 'stock' and p.status = 'active')
     order by 2`, [co.id]);
  const locations = await q(c, `select id, code, name, kind from location where entity_id = $1 and status = 'active' and kind in ('store','outlet','warehouse') order by kind <> 'store', name`, [co.id]);
  const vendorId = uuid(url.searchParams.get("vendor")) ?? vendors[0]?.id ?? null;
  if (!vendorId) return { vendors, locations, vendor: null, products: [], freight: [] };
  need(vendors.some((v) => v.id === vendorId), "that vendor has nothing to order");
  const products = await q(c, `
    select p.id, p.sku, p.name, p.vendor_sku, p.category, p.brand, p.collection, p.cost_minor, p.price_minor,
           (select json_build_object('qty', va.qty_available, 'leadDays', va.lead_days) from vendor_availability va
             where va.entity_id = p.entity_id and va.vendor_id = p.vendor_id and upper(va.vendor_sku) = upper(p.vendor_sku)) vendor_atp
      from product p where p.entity_id = $1 and p.vendor_id = $2 and p.kind = 'stock' and p.status = 'active'
     order by p.category nulls last, p.name limit 500`, [co.id, vendorId]);
  return { vendors, locations, vendor: vendors.find((v) => v.id === vendorId), products, freight: await so.freightMins(c, co.id, vendorId) };
}

const linesIn = (b: Record<string, unknown>) => (Array.isArray(b.lines) ? b.lines as Record<string, unknown>[] : []).map((l) => {
  const p = uuid(l.productId);
  need(p, "each line names a product");
  return { productId: p!, qty: Number(l.qty), note: str(l.note, 200) || null };
});

export const module: ErpModule = {
  id: "edi",
  register(kit) {
    const { coGet, coPost } = kit;
    const sc = (co: Company, a: Actor) => scopeOf(co, a);

    // ------------------------------------------------------------ reads
    coGet("/edi/home", async (c, co) => ({ home: await edi.ediHome(c, co.id) }));
    coGet("/edi/partners", async (c, co) => ({
      partners: (await edi.listPartners(c, co.id)).map(partnerOut), vendors: await vendorsForSetup(c, co),
      channels: edi.DOC_CHANNELS, docNames: x12.DOC_NAMES, feedFor: edi.FEED_FOR_DOC, transports: edi.TRANSPORTS, secretNames: edi.PARTNER_SECRETS, dropDirSet: !!process.env.ERP_EDI_DROP_DIR,
    }));
    coGet("/edi/partners/defaults", async (c, co, url) => {
      const v = uuid(url.searchParams.get("vendor"));
      need(v, "pick a vendor");
      return { documents: await edi.defaultDocuments(c, co.id, v!), feedFor: edi.FEED_FOR_DOC };
    });
    coGet(`/edi/partners/${ID}`, async (c, co, _u, m) => {
      const p = (await edi.listPartners(c, co.id)).find((x) => x.id === m[2]);
      if (!p) return null;
      return { partner: partnerOut(p), secrets: await edi.partnerSecretStatus(c, co.id, m[2]), items: await edi.itemMap(c, co.id, m[2]), pin: await edi.partnerPin(c, co.id, m[2]) };
    });
    coGet("/edi/documents", async (c, co, url) => ({
      documents: await edi.documents(c, co.id, { direction: ["in", "out"].includes(str(url.searchParams.get("direction"), 3)) ? str(url.searchParams.get("direction"), 3) : null,
        status: str(url.searchParams.get("status"), 20) || null, partnerId: uuid(url.searchParams.get("partner")), type: str(url.searchParams.get("type"), 7) || null,
        limit: int(url.searchParams.get("limit"), 100) }),
    }));
    coGet(`/edi/documents/${ID}`, async (c, co, _u, m) => edi.documentDetail(c, co.id, m[2]));
    coGet(`/edi/pos/${ID}/trail`, async (c, co, _u, m) => {
      const po = (await q(c, `select id from purchase_order where id = $1 and entity_id = $2`, [m[2], co.id]))[0];
      if (!po) return null;
      return edi.poTrail(c, co.id, m[2]);
    });
    coGet("/edi/store-orders", async (c, co, url) => ({
      orders: await so.listStoreOrders(c, co.id, { status: str(url.searchParams.get("status"), 20) || null, locationId: uuid(url.searchParams.get("location")) }),
    }));
    coGet("/edi/store-orders/form", (c, co, url) => refuse(() => storeForm(c, co, url)));
    coGet(`/edi/store-orders/${ID}`, async (c, co, _u, m) => so.storeOrderDetail(c, co.id, m[2]));
    coGet("/edi/freight-mins", async (c, co, url) => {
      const v = uuid(url.searchParams.get("vendor"));
      need(v, "pick a vendor");
      return { rules: await so.freightMins(c, co.id, v!) };
    });

    // ----------------------------------------------------------- partners
    coPost("/edi/partners", async (c, co, a, b) => {
      await requireRole(c, co, a, BUY, "setting up a vendor's EDI");
      const d = (b.partner && typeof b.partner === "object" ? b.partner : {}) as Record<string, unknown>;
      const vendorId = uuid(d.vendor_id);
      need(vendorId, "pick the vendor");
      const secrets = Object.fromEntries(Object.entries((b.secrets && typeof b.secrets === "object" ? b.secrets : {}) as Record<string, unknown>)
        .map(([k, v]) => [k, v === null ? null : String(v ?? "")]));
      const draft: edi.PartnerDraft = { vendor_id: vendorId!, secrets };
      for (const k of ["our_isa_qual", "our_isa_id", "their_isa_qual", "their_isa_id", "our_gs_id", "their_gs_id", "version", "usage", "element_sep", "segment_term", "subelement_sep", "repetition_sep", "transport"] as const) {
        if (d[k] !== undefined) (draft as Record<string, unknown>)[k] = str(d[k], 20);
      }
      if (d.edi_enabled !== undefined) draft.edi_enabled = d.edi_enabled === true;
      if (d.send_on_approval !== undefined) draft.send_on_approval = d.send_on_approval !== false;
      if (d.documents !== undefined) draft.documents = strMap(d.documents);
      if (d.transport_config !== undefined) draft.transport_config = strMap(d.transport_config);
      if (d.options !== undefined) draft.options = d.options;
      const id = await refuse(() => edi.savePartner(c, sc(co, a), ediEnv(), draft));
      return { id, secrets: await edi.partnerSecretStatus(c, co.id, id) };
    });
    coPost(`/edi/partners/${ID}/test-850`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, BUY, "sending a test 850");
      const r = await refuse(() => edi.sendTest850(c, sc(co, a), ediEnv(), m[2]));
      return { documentId: r.documentId, status: r.status, detail: r.detail, text: r.text };
    });
    coPost(`/edi/partners/${ID}/poll`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, BUY, "checking a vendor's EDI mailbox");
      // Each file and each send commits on its own transaction, not the request's, so one failure cannot undo the files already taken in.
      const s = sc(co, a);
      return refuse(() => edi.pollPartner((fn) => tx(s.actor, fn), s, ediEnv(), m[2]));
    });
    coPost(`/edi/partners/${ID}/test-sftp`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, BUY, "testing a vendor's SFTP");
      return refuse(() => edi.testPartnerSftp(c, sc(co, a), ediEnv(), m[2], a.personName));
    });
    coPost(`/edi/partners/${ID}/trust-key`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, ["owner"], "trusting a changed SFTP server key");
      return refuse(() => edi.trustPartnerKey(c, sc(co, a), m[2], str(b.fingerprint, 80), a.personName));
    });
    coPost(`/edi/partners/${ID}/poll-status`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, BUY, "asking a vendor's API for order status");
      return { runs: await refuse(() => edi.pollOrderStatus(c, sc(co, a), ediEnv(), m[2])) };
    });
    coPost(`/edi/partners/${ID}/items`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BUY, "mapping a vendor's item numbers");
      const rows = (Array.isArray(b.items) ? b.items as Record<string, unknown>[] : []).map((r) => ({ vendorItem: str(r.vendorItem, 60), productId: uuid(r.productId),
        sku: str(r.sku, 60) || null, upc: str(r.upc, 40) || null, active: r.active !== false }));
      return { saved: await refuse(() => edi.saveItemMap(c, sc(co, a), m[2], rows)) };
    });

    // ---------------------------------------------------------- documents
    coPost("/edi/upload", async (c, co, a, b) => {
      await requireRole(c, co, a, [...INTAKE, "store_manager"], "taking in a vendor's EDI file");
      need(typeof b.text === "string" && b.text.trim(), "choose the EDI file first");
      // Each document type has its own people: an A/P clerk takes bills (810), not acknowledgments or catalogs.
      for (const ty of edi.typesIn(b.text as string)) {
        await requireRole(c, co, a, edi.UPLOAD_ROLES[ty] ?? BUY, `taking in ${x12.DOC_NAMES[ty] ? `a ${ty} (${x12.DOC_NAMES[ty].toLowerCase()})` : `a ${ty || "blank"} document`}`);
      }
      return refuse(() => edi.receiveFile(c, sc(co, a), ediEnv(), { text: b.text as string, filename: str(b.filename, 200) || null, partnerId: uuid(b.partnerId) }));
    });
    coPost(`/edi/documents/${ID}/retry`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, INTAKE, "applying or sending an EDI document again");
      return refuse(() => edi.retryDocument(c, sc(co, a), ediEnv(), m[2]));
    });
    coPost(`/edi/documents/${ID}/download`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, BUY, "downloading an EDI document to send");
      return refuse(() => edi.takeDownload(c, sc(co, a), m[2]));
    });
    coPost(`/edi/pos/${ID}/send`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, BUY, "sending a purchase order");
      return refuse(() => edi.sendOrder(c, sc(co, a), ediEnv(), m[2]));
    });
    coPost(`/edi/po-lines/${ID}/price-reviewed`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, BUY, "reviewing a vendor's price change");
      await refuse(() => pur.clearPriceReview(c, sc(co, a), m[2]));
      return { ok: true };
    });
    coPost(`/edi/pos/${ID}/send-850`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, BUY, "sending a purchase order by EDI");
      return refuse(() => edi.queue850(c, sc(co, a), ediEnv(), m[2]));
    });

    // ------------------------------------------------------- store orders
    coPost("/edi/store-orders", async (c, co, a, b) => {
      await requireRole(c, co, a, STORE, "starting a store order");
      const loc = uuid(b.locationId), v = uuid(b.vendorId);
      need(loc && v, "pick the store and the vendor");
      return refuse(() => so.createStoreOrder(c, sc(co, a), { locationId: loc!, vendorId: v!, note: str(b.note, 500) || null, lines: linesIn(b) }));
    });
    coPost(`/edi/store-orders/${ID}/lines`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, STORE, "changing a store order");
      return refuse(() => so.setStoreOrderLines(c, sc(co, a), m[2], linesIn(b)));
    });
    coPost(`/edi/store-orders/${ID}/submit`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, STORE, "submitting a store order");
      return refuse(() => so.submitStoreOrder(c, sc(co, a), m[2]));
    });
    coPost(`/edi/store-orders/${ID}/back`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, [...STORE, ...DECIDE], "sending a store order back to draft");
      const decider = held.has("owner") || DECIDE.some((r) => held.has(r));
      return refuse(() => so.returnToDraft(c, sc(co, a), m[2], str(b.reason, 300), decider));
    });
    coPost(`/edi/store-orders/${ID}/approve`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, DECIDE, "approving a store order");
      const s = sc(co, a);
      return refuse(() => so.approveStoreOrder(c, s, m[2], { note: str(b.note, 300) || null, overBudgetReason: str(b.overBudgetReason, 300) || null,
        expectedOn: str(b.expectedOn, 10) || null }, held.has("owner"), async (poId) => {
        const p = (await q<{ send_on_approval: boolean }>(c, `select p.send_on_approval from edi_partner p join purchase_order po on po.vendor_id = p.vendor_id and po.entity_id = p.entity_id
                                                                where po.id = $1 and po.entity_id = $2`, [poId, co.id]))[0];
        if (!p || !p.send_on_approval) return null;
        const r = await edi.sendOrder(c, s, ediEnv(), poId);
        return { channel: r.channel, status: r.status, detail: r.detail };
      }, isRefusal));
    });
    coPost(`/edi/store-orders/${ID}/reject`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DECIDE, "turning down a store order");
      return refuse(() => so.rejectStoreOrder(c, sc(co, a), m[2], str(b.reason, 300)));
    });
    coPost(`/edi/store-orders/${ID}/cancel`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, STORE, "cancelling a store order");
      return refuse(() => so.cancelStoreOrder(c, sc(co, a), m[2], str(b.reason, 300)));
    });
    coPost("/edi/freight-mins", async (c, co, a, b) => {
      await requireRole(c, co, a, BUY, "setting a vendor's freight minimums");
      const v = uuid(b.vendorId);
      need(v, "pick the vendor");
      const measure = str(b.measure, 4) as "qty" | "cost";
      const minimum = measure === "cost" ? minor(b.minimum) : BigInt(Math.max(0, int(b.minimum)));
      return { id: await refuse(() => so.saveFreightMin(c, sc(co, a), { id: uuid(b.id), vendorId: v!, scope: (str(b.scope, 10) || "all") as so.FreightMin["scope"],
        scopeValue: str(b.scopeValue, 80) || null, measure, minimum, active: b.active !== false })) };
    });
  },
};
