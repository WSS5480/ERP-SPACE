// Vendor connection checks, against a fake network: Ashley's paginated
// catalog API, its ATP SOAP inquiry and its per-store freight, served from
// fixtures by an injected fetch. Parsing, batching, upsert, failure in plain
// words with nothing changed, the no-secrets rule, and sending POs (API,
// email, file) with the transmission log. Run from purchasing.ts, last, so
// the products it touches cannot move another check's numbers.
import { type T, ENTITY, RIO_ENTITY, LOC } from "./harness.ts";
import { q, type Client } from "../../packages/core/db.ts";
import * as feeds from "../../packages/core/vendor_feeds.ts";
import * as pur from "../../packages/core/purchasing.ts";
import { module as catalogModule, useFeedEnv, useImageFetch } from "../../server/modules/catalog.ts";
import type { ImageFetch } from "../../packages/core/catalog.ts";
import { runDueVendorConnections } from "../run-due.ts";
import { module as purchasingModule } from "../../server/modules/purchasing.ts";
import { routes, rio, asPerson, V, BUYER, DC } from "./catalog.ts";
import { scopeOf } from "../../server/actions.ts";

const API = "https://api.ashley.example";
const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// ------------------------------------------------------------- fixtures
const CATALOG = [
  { itemNumber: "B600-31", description: "Brinxton Dresser", brand: "Ashley", category: "Bedroom", price: { netPriceBeforeFreight: 289.5, msrp: 799 }, images: [{ url: "https://img.ashley.example/b600-31.jpg" }], cartons: 1, cube: 24, weight: 180 },
  { itemNumber: "B600-46", description: "Brinxton Chest", brand: "Ashley", category: "Bedroom", price: { netPriceBeforeFreight: 241, msrp: 699 }, images: [{ url: "https://img.ashley.example/b600-46.jpg" }], cartons: 2, cube: 20, weight: 150 },
  { itemNumber: "B600-92", description: "Brinxton Nightstand", brand: "Ashley", category: "Bedroom", price: { netPriceBeforeFreight: 96.25 }, images: [], cartons: 1, cube: 5, weight: 40 },
  { itemNumber: "B192-92", description: "Willowton Nightstand", brand: "Ashley", category: "Bedroom", price: { netPriceBeforeFreight: 95 }, images: [{ url: "https://images.example.com/catalog/ash-b192-92.jpg" }], cartons: 1, cube: 6, weight: 45 },
  { itemNumber: "B600-36", description: "Brinxton Mirror", brand: "Ashley", category: "Bedroom", price: { netPriceBeforeFreight: 61 }, images: [], cartons: 1, cube: 3, weight: 20 },
];
const ATP: Record<string, [number, number | null, string | null]> = {   // sku -> qty, load lead time, exception
  "2930338": [52, 3, null], "B192-QBED": [0, 35, null], "B192-92": [0, 18, null], "B600-31": [12, 4, null], "B600-46": [0, 28, "Discontinued after current stock"],
};

type Req = { url: string; method: string; headers: Record<string, string>; body: string };
function fakeNet(state: { atpFails?: boolean; poFails?: boolean; tokenFails?: boolean }) {
  const log: Req[] = [];
  const sleeps: number[] = [];
  const res = (status: number, body: string, type = "application/json") => ({ status, headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? type : null) }, text: async () => body });
  const fetch: feeds.FetchLike = async (url, init = {}) => {
    const r: Req = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? "" };
    log.push(r);
    const u = new URL(url);
    if (u.pathname === "/oauth/token") {
      if (state.tokenFails || !r.body.includes("client_id=demo-client")) return res(401, '{"error":"invalid_client"}');
      return res(200, '{"access_token":"tok-123","expires_in":3600}');
    }
    if (u.pathname === "/products") {
      if (r.headers.authorization !== "Bearer tok-123") return res(401, "");
      const limit = Number(u.searchParams.get("limit")), page = Number(u.searchParams.get("page"));
      return res(200, JSON.stringify({ metadata: { page }, data: CATALOG.slice((page - 1) * limit, page * limit) }));
    }
    if (u.pathname === "/atp") {
      if (state.atpFails) return res(500, "Server Error", "text/html");
      const inner = r.body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      const skus = [...inner.matchAll(/itemNumber="([^"]*)"/g)].map((m) => m[1]);
      const adv = '<?xml version="1.0"?><fniia:inventoryInqAdv xmlns:fniia="x"><advice><items>' + skus.map((s, i) => {
        const [qty, lead, exc] = ATP[s] ?? [0, null, "Item not found"];
        return `<fniia:itemAdvice lineItemNumber="${i + 1}"><itemId><itemIdentifier itemNumber="${s}" itemNumberQualifier="SellerAssigned"/></itemId>` +
          `<itemAvailability availability="future"><availQty value="999"/></itemAvailability>` +
          `<itemAvailability availability="current"><availQty unitOfMeasure="Each" value="${qty}"/>` +
          (lead != null ? `<systemReference><systemReferenceDescription>LoadLeadTime</systemReferenceDescription><systemReferenceValue>${lead}</systemReferenceValue></systemReference>` : "") +
          (exc ? `<systemReference><systemReferenceDescription>EXCEPTION</systemReferenceDescription><systemReferenceValue>${exc}</systemReferenceValue></systemReference>` : "") +
          `</itemAvailability></fniia:itemAdvice>`;
      }).join("") + "</items></advice></fniia:inventoryInqAdv>";
      const esc = adv.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return res(200, `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ATPRequestResponse xmlns="ns"><ATPRequestResult>${esc}</ATPRequestResult></ATPRequestResponse></soap:Body></soap:Envelope>`, "text/xml");
    }
    if (u.pathname === "/prices") {
      const store = u.searchParams.get("ShipTo"), page = Number(u.searchParams.get("Page")), limit = Number(u.searchParams.get("Limit"));
      if (store === "7003") return res(401, "");
      const ents = CATALOG.map((c, i) => ({ price: { sku: c.itemNumber, freight: store === "7001" ? 12.5 + i : 20 + i, netPriceBeforeFreight: c.price.netPriceBeforeFreight } }));
      return res(200, JSON.stringify({ metadata: { totalRecords: ents.length }, entities: ents.slice((page - 1) * limit, page * limit) }));
    }
    if (u.pathname === "/orders") {
      if (state.poFails) return res(503, "Order service down for maintenance");
      const b = JSON.parse(r.body) as { purchaseOrderNumber: string };
      return res(201, JSON.stringify({ orderNumber: `ASH-${b.purchaseOrderNumber}` }));
    }
    return res(404, "");
  };
  const secrets: Record<string, string> = {
    "secret://vendor/ashley": JSON.stringify({ clientId: "demo-client", clientSecret: "demo-secret", atpExternalId: "EXT", atpKeyCode: "KEY", atpUser: "u", atpPassword: "p<&>" }),
  };
  const mails: feeds.Mail[] = [];
  const env = (withMail = false): feeds.FeedEnv => ({
    fetch, secret: (ref) => secrets[ref] ?? "", sleep: async (ms) => { sleeps.push(ms); },
    mailer: withMail ? { send: async (m) => { mails.push(m); return { id: "m-1" }; } } : undefined,
  });
  return { env, log, sleeps, mails };
}

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = await t.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};

export async function runFeeds(t: T) {
  // ------------------------------------------------------ pure parsing
  const fidx = feeds.buildFidx("1234500", "01", feeds.ATP_DUNS, ["B192-92", 'A&"B'], new Date(2026, 10, 6, 9, 5, 7));
  t.ok("ATP: the FIDX inquiry names buyer, ship-to, Ashley's DUNS and each model, escaped",
    fidx.includes('partyIdentifierCode="1234500"') && fidx.includes('partyIdentifierCode="052738531" partyIdentifierQualifierCode="DUNS"')
    && fidx.includes('lineItemNumber="2"') && fidx.includes('itemNumber="A&amp;&quot;B"') && fidx.includes("<creationDate>2026-11-06</creationDate>"));
  const env0 = feeds.soapEnvelope({ atpExternalId: "E", atpKeyCode: "K", atpUser: "U", atpPassword: "p<&>" }, fidx);
  t.ok("ATP: the SOAP envelope carries the credentials and the FIDX document escaped", env0.includes("<sPassword>p&lt;&amp;&gt;</sPassword>") && env0.includes("&lt;fniia:inventoryInqAdv"));
  const adv = feeds.parseAdvice('<a:x><a:itemAdvice><itemIdentifier itemNumber="Z1"/><itemAvailability availability="future"><availQty value="9"/></itemAvailability>' +
    '<itemAvailability availability="current"><availQty value="4"/><systemReferenceDescription>LoadLeadTime</systemReferenceDescription><systemReferenceValue>12</systemReferenceValue>' +
    '<systemReferenceDescription>EXCEPTION</systemReferenceDescription><systemReferenceValue>Limited</systemReferenceValue></itemAvailability></a:itemAdvice></a:x>');
  t.ok("ATP: the advice reads current quantity, load lead time and exception, not the future line", adv.length === 1 && adv[0].sku === "Z1" && adv[0].qty === 4 && adv[0].leadDays === 12 && adv[0].exception === "Limited");
  t.ok("feeds: records are found wherever the API nested them", feeds.unwrapRecords({ meta: {}, payload: { list: [{ a: 1 }, { a: 2 }] } })?.length === 2 && feeds.unwrapRecords({ data: [] })?.length === 0);
  const flat = feeds.flatten({ sku: "X", price: { net: 5, tiers: { a: 1 } }, images: [{ url: "u1" }, { url: "u2" }] });
  t.ok("feeds: a record flattens to columns (price.net, images.url)", flat["price.net"] === "5" && flat["images.url"] === "u1" && flat["price.tiers.a"] === "1");
  t.ok("feeds: the secret's environment name follows the server's rule", feeds.secretEnvName("secret://vendor/ashley") === "ERP_SECRET_VENDOR_ASHLEY");

  // ------------------------------------------------ the connection itself
  const cr = routes(t, catalogModule), pr = routes(t, purchasingModule);
  const net = fakeNet({});
  useFeedEnv(() => net.env(true));
  const config = {
    url: `${API}/products`, pageSize: 2, authUrl: `${API}/oauth/token`, customer: "1234500",
    atpOn: true, atpUrl: `${API}/atp`, atpCustomer: "1234500", atpShipTo: "01", atpBatch: 4, atpSleepMs: 250,
    freightOn: true, freightUrl: `${API}/prices`, freightPageSize: 3, shipTos: { [DC]: "7001", [LOC.ENOLA]: "7002", [LOC.PALESTINE]: "7003" },
    poUrl: `${API}/orders`,
  };
  await t.throws("connections: a password in the config is refused; it belongs in the secret", () => cr.post("/catalog/connections", BUYER,
    { vendorId: V.ASHLEY, kind: "api", adapter: "ashley", config: { ...config, apiPassword: "hunter2" } }), /may not hold apiPassword/);
  await t.throws("connections: the database refuses a secret-looking key too", () => asPerson(t, BUYER, (c) => c.query(
    `insert into vendor_connection (entity_id, vendor_id, kind, name, config) values ($1,$2,'email','x','{"token":"abc"}')`, [ENTITY, V.COASTER])), /may not hold token/);
  await t.throws("connections: a credential reference is a name, not the secret", () => cr.post("/catalog/connections", BUYER,
    { vendorId: V.ASHLEY, kind: "api", config, credentialRef: "Bearer abc123" }), /secret:\/\/vendor/);
  await t.throws("connections: a manual connection has no schedule", () => cr.post("/catalog/connections", BUYER,
    { vendorId: V.ASHLEY, kind: "manual", scheduleCron: "0 5 * * *" }), /only api and sftp/);
  const conn = await cr.post<{ id: string }>("/catalog/connections", BUYER, { vendorId: V.ASHLEY, kind: "api", adapter: "ashley", name: "Ashley API", config,
    credentialRef: "secret://vendor/ashley", scheduleCron: "15 5 * * *" });
  const run = await cr.post<feeds.RunResult>("/catalog/connections/:id/run", BUYER, {}, conn.id);
  t.ok("Ashley: the run succeeds and says what it did (the existing nightstand gains its photo)", run.ok && run.rows === 5 && run.added === 4 && run.changed === 1 && /5 products: 4 added, 1 changed, 0 unchanged/.test(run.note), run.note);
  const pages = net.log.filter((r) => new URL(r.url).pathname === "/products");
  t.ok("Ashley: the catalog is pulled page by page until a short page (2, 2, 1)", pages.length === 3 && pages.every((r) => r.headers.authorization === "Bearer tok-123")
    && new URL(pages[2].url).searchParams.get("page") === "3");
  t.ok("Ashley: the OAuth token is traded with the client id from the secret, never from the database",
    net.log[0].url.endsWith("/oauth/token") && net.log[0].body.includes("client_secret=demo-secret"));
  const added = await read(t, (c) => q<{ sku: string; status: string; cost_minor: string; msrp_minor: string; pieces: string; image: string | null }>(c, `
    select p.sku, p.status, p.cost_minor, p.msrp_minor, (select count(*) from product_piece x where x.product_id = p.id and x.entity_id = p.entity_id) pieces,
           (select url from product_image i where i.product_id = p.id and i.entity_id = p.entity_id order by seq limit 1) image
      from product p where p.entity_id = $1 and p.sku like 'ASH-B600-%' order by p.sku`, [ENTITY]));
  const b31 = added.find((x) => x.sku === "ASH-B600-31"), b46 = added.find((x) => x.sku === "ASH-B600-46");
  t.ok("Ashley: pulled products are built through the import: SKU prefix, cost, MSRP, image, cartons; unpriced ones wait as drafts",
    added.length === 4 && b31?.cost_minor === "28950" && b31?.msrp_minor === "79900" && b31?.image === "https://img.ashley.example/b600-31.jpg"
    && b46?.pieces === "2" && added.every((x) => x.status === "draft"), JSON.stringify(added.map((x) => [x.sku, x.cost_minor, x.status])));
  const atpCalls = net.log.filter((r) => new URL(r.url).pathname === "/atp");
  const ashleyModels = await read(t, async (c) => Number((await q<{ n: string }>(c, `select count(distinct vendor_sku) n from product where entity_id = $1 and vendor_id = $2
    and vendor_sku is not null and status <> 'discontinued' and kind <> 'kit'`, [ENTITY, V.ASHLEY]))[0].n));
  t.ok("ATP: models are asked in batches of the configured size, with a pause between calls",
    atpCalls.length === Math.ceil(ashleyModels / 4) && net.sleeps.filter((x) => x === 250).length === atpCalls.length - 1
    && atpCalls.every((r) => r.method === "POST" && r.headers.soapaction?.includes("ATPRequest")), `${atpCalls.length} calls for ${ashleyModels}`);
  const av = await read(t, (c) => q<{ vendor_sku: string; product_id: string | null; qty_available: string; lead_days: number | null; exception: string | null }>(c,
    `select vendor_sku, product_id, qty_available, lead_days, exception from vendor_availability where entity_id = $1 and vendor_id = $2`, [ENTITY, V.ASHLEY]));
  const avOf = (s: string) => av.find((x) => x.vendor_sku === s);
  t.ok("ATP: availability is stored per model and tied to our product", av.length === ashleyModels && Number(avOf("2930338")?.qty_available) === 52
    && avOf("B192-QBED")?.lead_days === 35 && !!avOf("2930338")?.product_id && avOf("B600-46")?.exception === "Discontinued after current stock");
  const fr = await read(t, (c) => q<{ vendor_sku: string; location_id: string; freight_minor: string }>(c,
    `select vendor_sku, location_id, freight_minor from vendor_sku_freight where entity_id = $1 and vendor_id = $2`, [ENTITY, V.ASHLEY]));
  t.ok("freight: per model per store, paged, and a store the vendor refuses is skipped and named",
    fr.length === 10 && fr.find((x) => x.vendor_sku === "B600-31" && x.location_id === DC)?.freight_minor === "1250" && /1 skipped: 7003/.test(run.note), run.note);

  // ------------------------------------------------ the owner's order form
  const form = await pr.get<{ products: { id: string; sku: string; image: string | null; vendor_atp: { qty: number; leadDays: number } | null; sku_freight: { location: string; freight: number }[] }[] }>(
    "/purchasing/order-form", `?vendor=${V.ASHLEY}`);
  const darcy = form.products.find((p) => p.sku === "ASH-2930338");
  t.ok("order form: each item shows the vendor's live quantity and ETA, its photo, and freight per store",
    Number(darcy?.vendor_atp?.qty) === 52 && darcy?.vendor_atp?.leadDays === 3 && !!darcy?.image
    && form.products.find((p) => p.sku === "ASH-B192-92")?.sku_freight.some((f) => f.location === DC && Number(f.freight) === 1550));
  await asPerson(t, BUYER, async (c, co, a) => {
    const s = scopeOf(co, a);
    const bed = await pur.createPO(c, s, { vendorId: V.ASHLEY, shipToId: DC, lines: [{ productId: "77777777-0000-0000-0000-000000000003", qty: 1 }] }, false);
    t.ok("lead time: a model the vendor is out of ships on the vendor's ATP lead time (35 days, not 21)", bed.expectedOn === day(35), bed.expectedOn);
    const sofa = await pur.createPO(c, s, { vendorId: V.ASHLEY, shipToId: DC, lines: [{ productId: "77777777-0000-0000-0000-000000000001", qty: 1 }] }, false);
    t.ok("lead time: a model the vendor has plenty of ships on the usual lead time", sofa.expectedOn === day(21));
    await pur.cancelPO(c, s, bed.poId, "check finished");
    // ------------------------------------------------- sending the PO
    const api = await pur.sendPO(c, s, sofa.poId, "api", net.env());
    const posted = JSON.parse(net.log.filter((r) => r.url.endsWith("/orders")).at(-1)!.body) as { purchaseOrderNumber: string; shipTo: string; lines: { sku: string; quantity: number; unitCost: number }[] };
    t.ok("send: the API posts the order with Ashley's ship-to and model numbers and keeps their order number",
      api.status === "sent" && api.vendorRef === `ASH-${sofa.number}` && posted.shipTo === "7001" && posted.lines[0].sku === "2930338" && posted.lines[0].unitCost === 385);
    const down = fakeNet({ poFails: true });
    const failed = await pur.sendPO(c, s, sofa.poId, "api", down.env());
    t.ok("send: a vendor that is down is logged as failed, in words", failed.status === "failed" && /answered 503: Order service down/.test(failed.detail));
    const prepared = await pur.sendPO(c, s, sofa.poId, "email", net.env(false));
    t.ok("send: with no mail service the email is prepared for a person to send", prepared.status === "prepared" && prepared.destination === "orders@ashley.example");
    const mailed = await pur.sendPO(c, s, sofa.poId, "email", net.env(true));
    t.ok("send: by email to the vendor's order address with the 850-style file attached",
      mailed.status === "sent" && net.mails.at(-1)?.to === "orders@ashley.example" && net.mails.at(-1)!.attachments[0].content.includes(sofa.number));
    const log = await q<{ method: string; status: string }>(c, `select method, status from po_transmission where entity_id = $1 and purchase_order_id = $2 order by sent_at, id`, [ENTITY, sofa.poId]);
    t.ok("send: every attempt is in the transmission log", log.length === 4 && log.filter((x) => x.status === "failed").length === 1);
    await pur.cancelPO(c, s, sofa.poId, "check finished");
    await t.throws("send: a cancelled order is not sent", () => pur.sendPO(c, s, sofa.poId, "file", net.env()), /only an open order/);
  });
  const noApi = await pr.post<{ status: string; detail: string }>("/purchasing/pos/:id/send", BUYER, { method: "api" },
    (await pr.get<{ pos: { id: string; vendor: string }[] }>("/purchasing/pos", "?status=open")).pos.find((p) => p.vendor.startsWith("Coaster"))!.id);
  t.ok("send: a vendor with no API connection is told to use email or file", noApi.status === "failed" && /no API connection/.test(noApi.detail));

  // ---------------------------------------------------- failure, plainly
  const bad = fakeNet({ atpFails: true });
  useFeedEnv(() => bad.env());
  CATALOG[0].price.netPriceBeforeFreight = 310;     // a cost change that must not land
  const fail = await cr.post<feeds.RunResult>("/catalog/connections/:id/run", BUYER, {}, conn.id);
  const after = await read(t, async (c) => (await q<{ cost_minor: string }>(c, `select cost_minor from product where entity_id = $1 and sku = 'ASH-B600-31'`, [ENTITY]))[0].cost_minor);
  t.ok("failure: a dead availability service fails the run with a sentence, and nothing it pulled is kept",
    !fail.ok && /availability service \(batch 1 of \d+\) kept failing: answered 500/.test(fail.note) && after === "28950", `${fail.note} / ${after}`);
  const conns = await cr.get<{ connections: { id: string; last_ok: boolean; last_note: string; consecutive_failures: number; credential_set: boolean; credential_env: string }[] }>("/catalog/connections");
  const k = conns.connections.find((x) => x.id === conn.id)!;
  t.ok("failure: the connection shows it failed, why, and how many times running", k.last_ok === false && k.consecutive_failures === 1 && /kept failing/.test(k.last_note)
    && k.credential_set && k.credential_env === "ERP_SECRET_VENDOR_ASHLEY");
  const runs = await cr.get<{ runs: { outcome: string }[] }>("/catalog/connections/:id/runs", "", conn.id);
  t.ok("failure: both runs are on the run log", runs.runs.length === 2 && runs.runs[0].outcome === "failed" && runs.runs[1].outcome === "ok");
  useFeedEnv(() => ({ ...net.env(), secret: () => "" }));
  const nosecret = await cr.post<feeds.RunResult>("/catalog/connections/:id/run", BUYER, {}, conn.id);
  t.ok("failure: a missing secret names the environment variable to set", !nosecret.ok && /ERP_SECRET_VENDOR_ASHLEY is not set/.test(nosecret.note));
  CATALOG[0].price.netPriceBeforeFreight = 289.5;
  useFeedEnv(feeds.liveEnv);

  // ------------------------------------------------------------ scheduler
  await read(t, (c) => c.query(`update vendor_connection set last_run_at = now() - interval '2 days' where id = $1 and entity_id = $2`, [conn.id, ENTITY]));
  const due = await runDueVendorConnections(new Date(), net.env(), { entityId: ENTITY });
  const again = await runDueVendorConnections(new Date(), net.env(), { entityId: ENTITY });
  const schedRun = await read(t, async (c) => (await q<{ trigger: string; outcome: string }>(c,
    `select trigger, outcome from vendor_feed_run where entity_id = $1 and connection_id = $2 order by started_at desc limit 1`, [ENTITY, conn.id]))[0]);
  t.ok("scheduler: a connection whose time has come runs once as the scheduler, then is not due again",
    due.due === 1 && due.runs[0].ok && again.due === 0 && schedRun.trigger === "schedule" && schedRun.outcome === "ok", JSON.stringify(due.runs));

  // ---------------------------------------------------------- photo proxy
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  const asked: string[] = [];
  const fakeImg: ImageFetch = async (url) => {
    asked.push(url);
    const big = url.includes("huge"), html = url.includes("page");
    return { status: 200, url, headers: { get: (k: string) => (k === "content-type" ? (html ? "text/html" : "image/jpeg") : k === "content-length" ? (big ? String(6 * 1024 * 1024) : String(JPEG.length)) : null) },
      arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length) as ArrayBuffer };
  };
  useImageFetch(fakeImg);
  const b31Id = await read(t, async (c) => (await q<{ id: string }>(c, `select id from product where entity_id = $1 and sku = 'ASH-B600-31'`, [ENTITY]))[0].id);
  await read(t, (c) => c.query(`insert into product_image (entity_id, product_id, seq, url) values
    ($1,$2,2,'http://img.ashley.example/plain.jpg'), ($1,$2,3,'https://img.ashley.example/page.html'), ($1,$2,4,'https://img.ashley.example/huge.jpg'),
    ($1,$2,5,'https://10.0.0.5/inside.jpg')`, [ENTITY, b31Id]));
  const viaRoute = async (seq: number) => {
    try { return { ok: true, r: await cr.get<{ dataUrl: string; cached: boolean; bytes: number } | null>("/catalog/image/:id/([0-9]{1,2})", "", [b31Id, String(seq)] as never) }; }
    catch (e) { return { ok: false, r: null, msg: (e as Error).message }; }
  };
  const p1 = await viaRoute(1), p1b = await viaRoute(1);
  t.ok("photos: the stored https photo comes back from our own origin as a data URL", p1.ok && !!p1.r?.dataUrl.startsWith("data:image/jpeg;base64,") && p1.r?.bytes === JPEG.length && p1.r?.cached === false);
  t.ok("photos: the second ask is served from the cache, not the vendor", p1b.r?.cached === true && asked.filter((u) => u.endsWith("b600-31.jpg")).length === 1);
  const [p2, p3, p4, p5, p9] = [await viaRoute(2), await viaRoute(3), await viaRoute(4), await viaRoute(5), await viaRoute(9)];
  t.ok("photos: a plain-http address is not fetched", !p2.ok && /only https/.test(p2.msg ?? ""));
  t.ok("photos: a page that is not an image is refused", !p3.ok && /not a photo \(text\/html\)/.test(p3.msg ?? ""));
  t.ok("photos: anything over 5 MB is refused", !p4.ok && /larger than 5 MB/.test(p4.msg ?? ""));
  t.ok("photos: an address on a private network is never fetched", !p5.ok && /private networks/.test(p5.msg ?? "") && !asked.some((u) => u.includes("10.0.0.5")));
  t.ok("photos: only addresses stored on that product are fetched (no such photo is not found)", p9.ok && p9.r === null);
  const rioImg = await cr.get("/catalog/image/:id/([0-9]{1,2})", "", [b31Id, "1"] as never, RIO_ENTITY);
  t.ok("photos: another company cannot fetch this company's photos", rioImg === null);
  useImageFetch(undefined);

  // ------------------------------------------------------------ isolation
  await rio(t, (c, s) => t.throws("isolation: another company cannot run this company's vendor connection", () => feeds.runConnection(c, s, conn.id, net.env()), /no such vendor connection/));
  await rio(t, (c, s) => t.throws("isolation: another company cannot connect this company's vendor", () => feeds.saveConnection(c, s, { vendorId: V.ASHLEY, kind: "manual" }), /not set up for this company/));
  const rioConns = await cr.get<{ connections: unknown[] }>("/catalog/connections", "", undefined, RIO_ENTITY);
  t.ok("isolation: another company sees no vendor connections of this one", rioConns.connections.length === 0);
}
