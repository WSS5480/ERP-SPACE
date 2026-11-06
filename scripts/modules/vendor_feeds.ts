// Vendor API setup checks, against a fake network served from fixtures by an
// injected fetch: Ashley's products API (paged, OAuth or key header), its
// prices API (effective dates, promo cost), its ATP SOAP inquiry (batches,
// pauses), freight per ship-to, a cursor-paged photo API, an XML
// acknowledgment feed, a CSV quantities feed; a 401, a timeout, mapping
// refusal, SSRF refusals, test mode changing nothing, per-feed keys kept
// apart and masked, encrypted secrets, ETL steps, stop runs, the scheduler,
// migration of old connections, the hand-over from CATALOG-APP, and sending
// a PO through the order feed. Run last from purchasing.ts, so the products
// it touches cannot move another check's numbers.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { type T, ENTITY, RIO_ENTITY, LOC } from "./harness.ts";
import { q, type Client } from "../../packages/core/db.ts";
import * as feeds from "../../packages/core/vendor_feeds.ts";
import * as pur from "../../packages/core/purchasing.ts";
import { module as catalogModule, useFeedEnv, useImageFetch } from "../../server/modules/catalog.ts";
import type { ImageFetch } from "../../packages/core/catalog.ts";
import { runDueVendorFeeds } from "../run-due.ts";
import { module as purchasingModule } from "../../server/modules/purchasing.ts";
import { routes, rio, asPerson, V, BUYER, DC } from "./catalog.ts";
import { scopeOf } from "../../server/actions.ts";

const API = "https://api.ashley.example";
const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const KEY = randomBytes(32);

// ------------------------------------------------------------- fixtures
const CATALOG = [
  { itemNumber: "B600-31", description: "Brinxton Dresser", brand: "Ashley", category: "Bedroom", dealerCost: 300, images: [{ url: "https://img.ashley.example/b600-31.jpg" }, { url: "https://img.ashley.example/b600-31b.jpg" }], cartons: 1, cube: 24, weight: 180 },
  { itemNumber: "B600-46", description: "Brinxton Chest", brand: "Ashley", category: "Bedroom", dealerCost: 250, images: [{ url: "https://img.ashley.example/b600-46.jpg" }], cartons: 2, cube: 20, weight: 150 },
  { itemNumber: "B600-92", description: "Brinxton Nightstand", brand: "Ashley", category: "Bedroom", dealerCost: 99, images: [], cartons: 1, cube: 5, weight: 40 },
  { itemNumber: "B192-92", description: "Willowton Nightstand", brand: "Ashley", category: "Bedroom", dealerCost: 95, images: [{ url: "https://images.example.com/catalog/ash-b192-92.jpg" }], cartons: 1, cube: 6, weight: 45 },
  { itemNumber: "B600-36", description: "Brinxton Mirror", brand: "Ashley", category: "Bedroom", dealerCost: 61, images: [], cartons: 1, cube: 3, weight: 20 },
];
const PRICES = [   // the prices API: netPriceBeforeFreight is our cost
  { sku: "B600-31", netPriceBeforeFreight: 289.5, msrp: 799, map: 699, promoCost: 270, effectiveDate: "2020-01-01" },
  { sku: "B600-46", netPriceBeforeFreight: 241, msrp: 699 },
  { sku: "B600-92", netPriceBeforeFreight: 96.25 },
  { sku: "B192-92", netPriceBeforeFreight: 95 },
  { sku: "B600-36", netPriceBeforeFreight: 61, effectiveDate: "2099-01-01" },   // future: history only
  { sku: "ZZ-NOT-YET", netPriceBeforeFreight: 10 },
];
const ATP: Record<string, [number, number | null, string | null]> = {   // sku -> qty, load lead time, exception
  "2930338": [52, 3, null], "B192-QBED": [0, 35, null], "B192-92": [0, 18, null], "B600-31": [12, 4, null], "B600-46": [0, 28, "Discontinued after current stock"],
};

type Req = { url: string; method: string; headers: Record<string, string>; body: string };
function fakeNet(state: { atpFails?: boolean; poFails?: boolean; hang?: boolean } = {}) {
  const log: Req[] = [];
  const sleeps: number[] = [];
  const res = (status: number, body: string, type = "application/json", extra: Record<string, string> = {}) =>
    ({ status, headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? type : extra[k.toLowerCase()] ?? null) }, text: async () => body });
  const fetch: feeds.FetchLike = async (url, init = {}) => {
    const r: Req = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? "" };
    log.push(r);
    const u = new URL(url);
    const key = (r.headers["Ocp-Apim-Subscription-Key"] ?? "");
    if (state.hang || u.pathname === "/slow") {
      return new Promise((_ok, fail) => init.signal?.addEventListener("abort", () => fail(new Error("aborted"))));
    }
    if (u.pathname === "/oauth/token") {
      if (!r.body.includes("client_id=demo-client") || !r.body.includes("client_secret=s3cret-oauth")) return res(401, '{"error":"invalid_client"}');
      return res(200, '{"access_token":"tok-123456","expires_in":3600}');
    }
    if (u.pathname === "/products") {
      if (r.headers.authorization !== "Bearer tok-123456" || key !== "K-PRODUCTS-1111") return res(401, "");
      const limit = Number(u.searchParams.get("Limit")), page = Number(u.searchParams.get("Page"));
      return res(200, JSON.stringify({ metadata: { page }, data: CATALOG.slice((page - 1) * limit, page * limit) }));
    }
    if (u.pathname === "/prices") {
      if (key !== "K-PRICES-2222") return res(401, "");
      const store = u.searchParams.get("ShipTo");
      if (store === "7003") return res(401, "");
      const page = Number(u.searchParams.get("Page") || 1), limit = Number(u.searchParams.get("Limit") || 250);
      const ents = PRICES.map((p, i) => ({ price: { sku: p.sku, netPriceBeforeFreight: p.netPriceBeforeFreight, msrp: p.msrp, map: p.map, promoCost: p.promoCost,
        effectiveDate: p.effectiveDate, freight: store === "7001" ? 12.5 + i : 20 + i } }));
      return res(200, JSON.stringify({ metadata: { totalRecords: ents.length }, entities: ents.slice((page - 1) * limit, page * limit) }));
    }
    if (u.pathname === "/atp") {
      if (state.atpFails) return res(500, "Server Error", "text/html");
      const inner = r.body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      if (!inner.includes("<sPassword>p&lt;&amp;&gt;</sPassword>") && !r.body.includes("<sPassword>p&lt;&amp;&gt;</sPassword>")) return res(200, "<soap:Envelope><soap:Body><ATPRequestResult></ATPRequestResult></soap:Body></soap:Envelope>", "text/xml");
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
    if (u.pathname === "/photos") {   // cursor paging
      const cur = u.searchParams.get("cursor") ?? "";
      const pages: Record<string, { items: unknown[]; next: string | null }> = {
        "": { items: [{ sku: "B600-92", imageUrl: "https://img.ashley.example/b600-92.jpg" }], next: "c2" },
        c2: { items: [{ sku: "B600-36", imageUrl: "https://img.ashley.example/b600-36.jpg" }, { sku: "NOPE-1", imageUrl: "https://img.ashley.example/x.jpg" }], next: null },
      };
      const p = pages[cur] ?? { items: [], next: null };
      return res(200, JSON.stringify({ items: p.items, paging: { next_cursor: p.next } }));
    }
    if (u.pathname === "/acks.xml") {   // an XML feed
      return res(200, `<acks>${(state as { acks?: string }).acks ?? ""}</acks>`, "application/xml");
    }
    if (u.pathname === "/stock.csv") {  // a CSV feed (another vendor)
      return res(200, "Item,On Hand,Lead Time\n121221,14,5\n121222,0,21\n", "text/csv");
    }
    if (u.pathname === "/orders") {
      if (state.poFails) return res(503, "Order service down for maintenance");
      if (key !== "K-ORDERS-3333") return res(401, "");
      const b = JSON.parse(r.body) as { purchaseOrderNumber: string };
      return res(201, JSON.stringify({ result: { orderNumber: `ASH-${b.purchaseOrderNumber}` } }));
    }
    if (u.pathname === "/hop") return res(302, "", "text/plain", { location: "https://evil.example/inside" });
    return res(404, "");
  };
  const mails: feeds.Mail[] = [];
  const env = (o: { mail?: boolean; key?: Buffer | null; secrets?: Record<string, string> } = {}): feeds.FeedEnv => ({
    fetch, secret: (ref) => (o.secrets ?? {})[ref] ?? "", sleep: async (ms) => { sleeps.push(ms); },
    resolve: async (h) => (h.startsWith("evil") ? ["10.0.0.7"] : ["93.184.216.34"]),
    secretKey: o.key === undefined ? KEY : o.key,
    mailer: o.mail ? { send: async (m) => { mails.push(m); return { id: "m-1" }; } } : undefined,
  });
  return { env, log, sleeps, mails, state };
}

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = await t.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};

export async function runFeeds(t: T) {
  const cr = routes(t, catalogModule), pr = routes(t, purchasingModule);

  // ------------------------------------------------------ pure parsing
  const rendered = feeds.render(feeds.ASHLEY_ATP_TEMPLATE, { cred: { atpPassword: "p<&>" }, customer: "3989100", shipTo: "01", duns: feeds.ATP_DUNS,
    date: "2026-11-06", time: "09:05:07", stamp: "x", skus: ["B192-92", 'A&"B'] }, "xml");
  t.ok("templates: the Ashley ATP envelope carries the FIDX document escaped inside it, one itemInquiry per model",
    rendered.includes("<sPassword>p&lt;&amp;&gt;</sPassword>") && rendered.includes("&lt;itemInquiry lineItemNumber=&quot;2&quot;")
    && rendered.includes("itemNumber=&quot;A&amp;amp;&amp;quot;B&quot;") && rendered.includes("partyIdentifierCode=&quot;3989100&quot;"));
  t.ok("templates: JSON bodies escape values, query values stay plain", feeds.render('{"q":"{{a}}","p":{{page}}}', { a: 'x"y', page: 2 }, "json") === '{"q":"x\\"y","p":2}');
  const xrow = feeds.flattenXml('<a:itemAdvice><itemIdentifier itemNumber="Z1"/><itemAvailability availability="future"><availQty value="9"/></itemAvailability>' +
    '<itemAvailability availability="current"><availQty value="4"/><systemReferenceDescription>LoadLeadTime</systemReferenceDescription><systemReferenceValue>12</systemReferenceValue>' +
    '<systemReferenceDescription>EXCEPTION</systemReferenceDescription><systemReferenceValue>Limited</systemReferenceValue></itemAvailability></a:itemAdvice>',
    { pick: { element: "itemAvailability", attr: "availability", equals: "current" }, pairs: [{ name: "systemReferenceDescription", value: "systemReferenceValue" }] });
  t.ok("XML: a record flattens to element@attr and pairs, keeping only the current availability", xrow["itemIdentifier@itemNumber"] === "Z1" && xrow["availQty@value"] === "4"
    && xrow.LoadLeadTime === "12" && xrow.EXCEPTION === "Limited");
  const flat = feeds.flatten({ sku: "X", price: { net: 5, tiers: { a: 1 } }, images: [{ url: "u1" }, { url: "u2" }] });
  t.ok("JSON: CATALOG-APP's flatten rule (dicts unpacked, first of a list unpacked, the list kept compact)",
    flat["price.net"] === "5" && flat["images.url"] === "u1" && flat["price.tiers.a"] === "1" && flat.images.startsWith("[{"));
  t.ok("JSON: records are found under the usual wrappers or as the largest list", feeds.unwrapRecords({ meta: {}, payload: { list: [{ a: 1 }, { a: 2 }] } })?.length === 2);
  const etl = feeds.applyEtl([{ Regular: "300", Discount: "30" }, { Regular: "100", Discount: "" }, { Regular: "", Discount: "5", Alt: "9" }], [
    { out: "Promo Cost", a: "Regular", op: "subtract", b: "Discount" }, { out: "R2", a: "Regular", op: "fill_blank", b: "Alt" }, { out: "Half", a: "Regular", op: "percent_off", b: "50" }]);
  t.ok("ETL: promo = regular − discount; no discount means no promo; fill-blank and percent-off as CATALOG-APP does them",
    etl[0]["Promo Cost"] === "270.00" && etl[1]["Promo Cost"] === "" && etl[2].R2 === "9" && etl[0].Half === "150.00");

  // ------------------------------------------------------ templates and setup
  const net = fakeNet();
  useFeedEnv(() => net.env({ mail: true }));
  const tpl = await cr.get<{ drafts: (feeds.FeedDraft & { vendor_id: string })[] }>("/catalog/vendors/:id/feed-templates", "?template=ashley", V.ASHLEY);
  t.ok("templates: Ashley starts five feeds — products, prices, ATP quantities, freight, orders — each with its own key reference",
    tpl.drafts.map((d) => d.purpose).join(",") === "products,pricing,quantities,freight,orders"
    && new Set(tpl.drafts.map((d) => d.credential_ref)).size === 4 && tpl.drafts[2].body_template === feeds.ASHLEY_ATP_TEMPLATE);
  const draft = (p: string) => ({ ...tpl.drafts.find((d) => d.purpose === p)!, credential_ref: null });
  const products = { ...draft("products"), url: `${API}/products`, paging: { mode: "page", size: 2, pageParam: "Page", sizeParam: "Limit" },
    auth: { mode: "oauth2", authUrl: `${API}/oauth/token`, clientId: "demo-client", headerName: "Ocp-Apim-Subscription-Key" }, options: { customer: "3989100", alertEmail: "steve@example.com" } };
  await t.throws("secrets: a header that carries a key is refused as a plain header", () => cr.post("/catalog/feeds", BUYER,
    { feed: { ...products, headers: { "Ocp-Apim-Subscription-Key": "abc" } } }), /carries a secret/);
  await t.throws("secrets: the database refuses a key in settings too", () => asPerson(t, BUYER, (c) => c.query(
    `insert into vendor_feed (entity_id, vendor_id, purpose, name, url, auth) values ($1,$2,'products','x','https://a.example','{"apiKey":"abc"}')`, [ENTITY, V.COASTER])), /may not hold apiKey/);
  await t.throws("secrets: a literal password in a SOAP template is refused", () => cr.post("/catalog/feeds", BUYER,
    { feed: { ...draft("quantities"), body_template: "<sPassword>hunter2</sPassword>" } }), /literal secret/);
  await t.throws("secrets: with no ERP_SECRET_KEY, a typed key is not stored, and the screen says which variable to add", async () => {
    useFeedEnv(() => net.env({ key: null }));
    try { await cr.post("/catalog/feeds", BUYER, { feed: products, secrets: { apiKey: "K-PRODUCTS-1111" } }); } finally { useFeedEnv(() => net.env({ mail: true })); }
  }, /add ERP_SECRET_KEY/);
  const pf = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: products, secrets: { apiKey: "K-PRODUCTS-1111", clientSecret: "s3cret-oauth" } });
  const pricing = { ...draft("pricing"), url: `${API}/prices`, query_params: { Customer: "{{customer}}", IncludeTentative: "False" }, options: { customer: "3989100" },
    paging: { mode: "page", size: 4, pageParam: "Page", sizeParam: "Limit", totalPath: "metadata.totalRecords" },
    mapping: { vendor_sku: "price.sku", cost: "price.netPriceBeforeFreight", map: "price.map", msrp: "price.msrp", promo_cost: "price.promoCost", effective_from: "price.effectiveDate" } };
  const ppf = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: pricing, secrets: { apiKey: "K-PRICES-2222" } });
  const stored = await read(t, (c) => q<{ name: string; ct: string; last2: string }>(c, `select name, encode(ciphertext,'hex') ct, last2 from vendor_feed_secret where entity_id = $1 and feed_id = $2`, [ENTITY, pf.id]));
  t.ok("secrets: typed keys are stored encrypted (no plaintext in the table), only their last two characters readable",
    stored.length === 2 && stored.every((x) => !Buffer.from(x.ct, "hex").toString("utf8").includes("K-PRODUCTS") && !x.ct.includes(Buffer.from("s3cret").toString("hex"))) && stored.some((x) => x.last2 === "11"));
  const view = await cr.get<{ feeds: { id: string; secrets: { name: string; masked: string }[]; auth: Record<string, unknown> }[]; secretKeySet: boolean }>("/catalog/vendors/:id/feeds", "", V.ASHLEY);
  const pv = view.feeds.find((f) => f.id === pf.id)!;
  t.ok("secrets: the screen gets ••••last2 only, never the value", JSON.stringify(view).indexOf("K-PRODUCTS-1111") < 0 && JSON.stringify(view).indexOf("s3cret-oauth") < 0
    && pv.secrets.some((x) => x.name === "apiKey" && x.masked === "••••11") && view.secretKeySet);

  // ------------------------------------------------------ test mode
  const before = await read(t, async (c) => (await q<{ n: string }>(c, `select count(*) n from product where entity_id = $1`, [ENTITY]))[0].n);
  const test1 = await cr.post<feeds.TestResult>("/catalog/feeds/test", BUYER, { feed: { id: pf.id } });
  const after = await read(t, async (c) => (await q<{ n: string }>(c, `select count(*) n from product where entity_id = $1`, [ENTITY]))[0].n);
  t.ok("test: one call (first page), status, records found and the first rows mapped", test1.ok && test1.status === 200 && test1.calls === 1 && test1.recordsFound === 2
    && test1.rows[0].vendor_sku === "B600-31" && test1.rows[0].name === "Brinxton Dresser" && test1.columns.includes("images.url"), JSON.stringify(test1).slice(0, 300));
  t.ok("test: changes nothing in the catalog", before === after);
  t.ok("test: no secret comes back — the key header and token are masked", !JSON.stringify(test1).includes("K-PRODUCTS-1111") && !JSON.stringify(test1).includes("tok-123456")
    && test1.requestHeaders["Ocp-Apim-Subscription-Key"] === "••••" && test1.requestHeaders.authorization === "••••");
  const nokey = await cr.post<feeds.TestResult>("/catalog/feeds/test", BUYER, { feed: { ...pricing, name: "" } });
  t.ok("test: a feed not yet saved can be tested; with no key typed it says so before calling", !nokey.ok && /header needs its key/.test(nokey.problem ?? ""), nokey.problem ?? "");
  const unsaved = await cr.post<feeds.TestResult>("/catalog/feeds/test", BUYER, { feed: { ...pricing, name: "" }, secrets: { apiKey: "WRONG-KEY-0000" } });
  t.ok("test: a key typed but not saved is used for the test only, and a wrong one fails in words", !unsaved.ok && /refused the credentials \(401\)/.test(unsaved.problem ?? "")
    && !JSON.stringify(unsaved).includes("WRONG-KEY-0000"), unsaved.problem ?? "");
  const notStored = await read(t, async (c) => (await q<{ n: string }>(c, `select count(*) n from vendor_feed_secret where entity_id = $1 and last2 = '00'`, [ENTITY]))[0].n);
  t.ok("test: a key typed for a test is never stored", notStored === "0");
  // ------------------------------------------------------ products, then prices
  const mark = net.log.length;
  const run1 = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, pf.id);
  const prodCalls = net.log.slice(mark).filter((r) => new URL(r.url).pathname === "/products");
  t.ok("products: paged until a short page (2, 2, 1), OAuth token traded once, own key header on each call",
    run1.ok && run1.rows === 5 && prodCalls.length === 3 && net.log.slice(mark).filter((r) => r.url.endsWith("/oauth/token")).length === 1, `${run1.note} · ${prodCalls.length} calls`);
  t.ok("products: built through the import; with a pricing feed active, cost/MAP/MSRP are left to it", /cost, MAP and MSRP left to the pricing feed/.test(run1.note) && run1.added === 4, run1.note);
  const run2 = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, ppf.id);
  t.ok("prices: their own key, paged by total records, history recorded, products repriced", run2.ok && /6 prices: 6 new in the history/.test(run2.note)
    && /1 for models not in the catalog yet/.test(run2.note), run2.note);
  const priced = await read(t, (c) => q<{ sku: string; cost_minor: string; map_minor: string | null; msrp_minor: string | null; status: string }>(c,
    `select sku, cost_minor, map_minor, msrp_minor, status from product where entity_id = $1 and sku like 'ASH-B600-%' order by sku`, [ENTITY]));
  const of = (s: string) => priced.find((x) => x.sku === s);
  t.ok("prices: the lesser of regular and promo cost, MAP and MSRP land on the product", of("ASH-B600-31")?.cost_minor === "27000" && of("ASH-B600-31")?.map_minor === "69900"
    && of("ASH-B600-31")?.msrp_minor === "79900" && of("ASH-B600-46")?.cost_minor === "24100", JSON.stringify(priced));
  t.ok("prices: a future-dated price waits in the history and does not apply yet", of("ASH-B600-36")?.cost_minor === "6100");   // from the products feed at creation
  t.ok("prices: retail is untouched without a price rule; new products wait as drafts", priced.every((x) => x.status === "draft"));
  CATALOG[0].dealerCost = 500;
  const run3 = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, pf.id);
  t.ok("precedence: a later products run does not overwrite the pricing feed's cost", run3.ok && (await read(t, async (c) =>
    (await q<{ cost_minor: string }>(c, `select cost_minor from product where entity_id = $1 and sku = 'ASH-B600-31'`, [ENTITY]))[0].cost_minor)) === "27000");
  CATALOG[0].dealerCost = 300;
  await cr.post("/catalog/feeds", BUYER, { feed: { ...pricing, id: ppf.id, options: { customer: "3989100", priceRule: { mode: "markup", markupBps: 20000, ending99: true } } } });
  await cr.post("/catalog/feeds/:id/run", BUYER, {}, ppf.id);
  t.ok("price rule: with a markup rule the pricing feed sets retail too (2× cost, .99, never under MAP)", (await read(t, async (c) =>
    (await q<{ price_minor: string }>(c, `select price_minor from product where entity_id = $1 and sku = 'ASH-B600-46'`, [ENTITY]))[0].price_minor)) === "48199");

  // ------------------------------------------------------ ATP quantities
  const qf = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { ...draft("quantities"), url: `${API}/atp`, batching: { size: 4, delayMs: 250 },
    auth: { mode: "none", atpExternalId: "EXT", atpUser: "u" }, options: { ...draft("quantities").options, customer: "3989100", shipTo: "01" } },
    secrets: { atpKeyCode: "KEY-9", atpPassword: "p<&>" } });
  const qTest = await cr.post<feeds.TestResult>("/catalog/feeds/test", BUYER, { feed: { id: qf.id } });
  t.ok("test quantities: one SOAP call for the first batch (at most 5 models), the raw answer shown and the rows mapped", qTest.ok && qTest.calls === 1 && qTest.recordsFound === 4
    && qTest.sample.includes("ATPRequestResult") && qTest.rows.every((r) => r.vendor_sku && r.qty !== undefined) && !qTest.sample.includes("p&lt;&amp;&gt;"), JSON.stringify({ c: qTest.calls, n: qTest.recordsFound, rows: qTest.rows, m: qTest.missing }));
  net.sleeps.length = 0;
  const mark4 = net.log.length;
  const run4 = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, qf.id);
  const atpCalls = net.log.slice(mark4).filter((r) => new URL(r.url).pathname === "/atp");
  const models = await read(t, async (c) => Number((await q<{ n: string }>(c, `select count(distinct vendor_sku) n from product where entity_id = $1 and vendor_id = $2
    and vendor_sku is not null and status <> 'discontinued' and kind <> 'kit'`, [ENTITY, V.ASHLEY]))[0].n));
  t.ok("ATP: the SOAP inquiry in batches of 4 with a pause between, stored per model", run4.ok && atpCalls.length === Math.ceil(models / 4)
    && net.sleeps.filter((x) => x === 250).length === atpCalls.length - 1 && atpCalls.every((r) => r.headers.SOAPAction?.includes("ATPRequest")), `${run4.note} · ${atpCalls.length} calls for ${models} · sleeps ${net.sleeps.join(",")}`);
  const av = await read(t, (c) => q<{ vendor_sku: string; qty_available: string; lead_days: number | null; exception: string | null; product_id: string | null }>(c,
    `select vendor_sku, qty_available, lead_days, exception, product_id from vendor_availability where entity_id = $1 and vendor_id = $2`, [ENTITY, V.ASHLEY]));
  const avOf = (s: string) => av.find((x) => x.vendor_sku === s);
  t.ok("ATP: quantity, load lead time and exception per model, tied to our product", Number(avOf("2930338")?.qty_available) === 52 && avOf("B192-QBED")?.lead_days === 35
    && avOf("B600-46")?.exception === "Discontinued after current stock" && !!avOf("2930338")?.product_id);

  // ------------------------------------------------------ freight by store
  const ff = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { ...draft("freight"), url: `${API}/prices`, secrets_from_feed_id: ppf.id,
    paging: { mode: "page", size: 4, pageParam: "Page", sizeParam: "Limit", totalPath: "metadata.totalRecords" },
    options: { customer: "3989100", shipTos: { [DC]: "7001", [LOC.ENOLA]: "7002", [LOC.PALESTINE]: "7003" }, parallel: 4 } } });
  const run5 = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, ff.id);
  const fr = await read(t, (c) => q<{ vendor_sku: string; location_id: string; freight_minor: string }>(c,
    `select vendor_sku, location_id, freight_minor from vendor_sku_freight where entity_id = $1 and vendor_id = $2`, [ENTITY, V.ASHLEY]));
  t.ok("freight: the prices API asked once per ship-to (borrowing the prices key), a refused store skipped and named",
    run5.ok && fr.length === 12 && fr.find((x) => x.vendor_sku === "B192-92" && x.location_id === DC)?.freight_minor === "1550" && /1 skipped: 7003/.test(run5.note), run5.note);

  // ------------------------------------------------------ cursor-paged photos
  const imf = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { vendor_id: V.ASHLEY, purpose: "images", name: "Ashley photos", url: `${API}/photos`,
    response_format: "json", records_path: "items", paging: { mode: "cursor", cursorPath: "paging.next_cursor", cursorParam: "cursor" } } });
  const run6 = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, imf.id);
  t.ok("cursor paging: follows next_cursor until it ends; photos land on matched products", run6.ok && run6.rows === 3 && run6.changed === 2 && /1 models not in the catalog/.test(run6.note), run6.note);

  // ------------------------------------------------------ CSV feed (another vendor)
  const csvf = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { vendor_id: V.COASTER, purpose: "quantities", name: "Coaster stock file", template: "csv_https",
    url: "https://files.coaster.example/stock.csv", response_format: "csv", mapping: { vendor_sku: "Item", qty: "On Hand", lead_days: "Lead Time" } } });
  const run7 = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, csvf.id);
  t.ok("CSV: a stock file over https maps by its headings", run7.ok && run7.added === 2 && (await read(t, async (c) =>
    (await q<{ lead_days: number }>(c, `select lead_days from vendor_availability where entity_id = $1 and vendor_id = $2 and vendor_sku = '121222'`, [ENTITY, V.COASTER]))[0]?.lead_days)) === 21);

  // ------------------------------------------------------ failures, plainly
  const bad = { ...pricing, name: "Ashley prices (wrong mapping)", mapping: { vendor_sku: "price.nope", cost: "price.alsoNope" }, url: `${API}/prices` };
  const badF = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { ...bad, records_path: "metadata", paging: { mode: "none" } }, secrets: { apiKey: "K-PRICES-2222" } });
  const histBefore = await read(t, async (c) => (await q<{ n: string }>(c, `select count(*) n from vendor_price_history where entity_id = $1`, [ENTITY]))[0].n);
  const run8 = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, badF.id);
  t.ok("mapping refusal: no column for a required field fails in words and changes nothing", !run8.ok && /no column covers vendor_sku, cost/.test(run8.note)
    && (await read(t, async (c) => (await q<{ n: string }>(c, `select count(*) n from vendor_price_history where entity_id = $1`, [ENTITY]))[0].n)) === histBefore, run8.note);
  const k401 = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { ...pricing, name: "Ashley prices (old key)" }, secrets: { apiKey: "K-EXPIRED-0000" } });
  const run9 = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, k401.id);
  t.ok("401: refused credentials are named, per feed", !run9.ok && /refused the credentials \(401\); check this feed's keys/.test(run9.note));
  t.ok("separation: each feed sent only its own key", net.log.filter((r) => r.url.includes("/products")).every((r) => r.headers["Ocp-Apim-Subscription-Key"] === "K-PRODUCTS-1111")
    && net.log.filter((r) => r.url.includes("/prices")).every((r) => ["K-PRICES-2222", "K-EXPIRED-0000", "WRONG-KEY-0000"].includes(r.headers["Ocp-Apim-Subscription-Key"])));
  const slow = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { vendor_id: V.ASHLEY, purpose: "quantities", name: "Slow API", url: `${API}/slow`, timeout_ms: 100 } });
  const run10 = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, slow.id);
  t.ok("timeout: a vendor that never answers fails in words after its timeout", !run10.ok && /took longer than 1 s to answer/.test(run10.note), run10.note);
  const failing = fakeNet({ atpFails: true });
  useFeedEnv(() => failing.env({ mail: true }));
  await cr.post("/catalog/feeds", BUYER, { feed: { ...products, id: pf.id, url: `${API}/atp`, request_format: "query", method: "GET", paging: { mode: "none" } } });
  const runA = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, pf.id);
  const runB = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, pf.id);
  t.ok("alerts: a feed that starts failing emails once, not on every retry", !runA.ok && !runB.ok && failing.mails.length === 1 && failing.mails[0].to === "steve@example.com"
    && !failing.mails[0].text.includes("K-PRODUCTS"), `${failing.mails.length}`);
  t.ok("a failing feed does not block the vendor's other feeds", (await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, ppf.id)).ok);
  useFeedEnv(() => net.env({ mail: true }));
  await cr.post("/catalog/feeds", BUYER, { feed: { ...products, id: pf.id } });

  // ------------------------------------------------------ network safety
  const ssrf = async (url: string) => (await cr.post<feeds.TestResult>("/catalog/feeds/test", BUYER, { feed: { vendor_id: V.ASHLEY, purpose: "products", name: "x", url } })).problem ?? "";
  t.ok("SSRF: plain http is refused", /https addresses only/.test(await ssrf("http://api.ashley.example/products")));
  t.ok("SSRF: a host resolving to a private address is refused before any call", /private networks/.test(await ssrf("https://evil.example/products"))
    && !net.log.some((r) => r.url.includes("evil.example")));
  t.ok("SSRF: a redirect into a private network is refused at the hop", /private networks/.test(await ssrf(`${API}/hop`)));
  t.ok("SSRF: a literal private address is refused", /private networks/.test(await ssrf("https://10.1.2.3/x")));

  // ------------------------------------------------------ XML acknowledgments
  const enola = (await pr.get<{ pos: { id: string; number: string; vendor: string; status: string }[] }>("/purchasing/pos", "?status=open")).pos.find((p) => p.vendor.startsWith("Ashley"));
  if (enola) {
    (net.state as { acks?: string }).acks = `<ack><po>${enola.number}</po><line>1</line><code>IA</code><shipDate>2026-12-15</shipDate><ref>ASN-77</ref></ack><ack><po>PO-NOPE</po><line>1</line><code>IA</code></ack>`;
    const af = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { vendor_id: V.ASHLEY, purpose: "acknowledgments", name: "Ashley 855", url: `${API}/acks.xml`,
      response_format: "xml", records_path: "ack", mapping: { po_number: "po", line: "line", status: "code", ship_date: "shipDate", vendor_ref: "ref" } } });
    const runX = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, af.id);
    t.ok("XML: acknowledgments pulled as XML flow through the 855 import; an unknown PO is named", runX.ok && /2 acknowledgment rows: 1 applied, 1 not \(no purchase order PO-NOPE\)/.test(runX.note), runX.note);
  } else t.ok("XML: acknowledgments pulled as XML flow through the 855 import", false, "no open Ashley PO to acknowledge");

  // ------------------------------------------------------ the order form and POs
  const form = await pr.get<{ products: { id: string; sku: string; image: string | null; vendor_atp: { qty: number; leadDays: number } | null; sku_freight: { location: string; freight: number }[] }[] }>(
    "/purchasing/order-form", `?vendor=${V.ASHLEY}`);
  const darcy = form.products.find((p) => p.sku === "ASH-2930338");
  t.ok("order form: live vendor quantity and ETA, photo, freight per store", Number(darcy?.vendor_atp?.qty) === 52 && darcy?.vendor_atp?.leadDays === 3 && !!darcy?.image
    && form.products.find((p) => p.sku === "ASH-B192-92")?.sku_freight.some((f) => f.location === DC && Number(f.freight) === 1550));
  const of_ = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { ...draft("orders"), url: `${API}/orders`, mapping: { vendor_ref: "result.orderNumber" },
    options: { customer: "3989100", shipTos: { [DC]: "7001" } } }, secrets: { apiKey: "K-ORDERS-3333" } });
  void of_;
  await asPerson(t, BUYER, async (c, co, a) => {
    const s = scopeOf(co, a);
    const bed = await pur.createPO(c, s, { vendorId: V.ASHLEY, shipToId: DC, lines: [{ productId: "77777777-0000-0000-0000-000000000003", qty: 1 }] }, false);
    t.ok("lead time: a model the vendor is out of ships on the vendor's ATP lead time (35 days, not 21)", bed.expectedOn === day(35), bed.expectedOn);
    const sofa = await pur.createPO(c, s, { vendorId: V.ASHLEY, shipToId: DC, lines: [{ productId: "77777777-0000-0000-0000-000000000001", qty: 1 }] }, false);
    t.ok("lead time: a model the vendor has plenty of ships on the usual lead time", sofa.expectedOn === day(21));
    await pur.cancelPO(c, s, bed.poId, "check finished");
    const api = await pur.sendPO(c, s, sofa.poId, "api", net.env());
    const posted = JSON.parse(net.log.filter((r) => r.url.endsWith("/orders")).at(-1)!.body) as { shipTo: string; lines: { sku: string; unitCost: number }[] };
    t.ok("send: the order feed posts with its own key and keeps the vendor's order number from the mapped path",
      api.status === "sent" && api.vendorRef === `ASH-${sofa.number}` && posted.shipTo === "7001" && posted.lines[0].sku === "2930338");
    const down = fakeNet({ poFails: true });
    const failed = await pur.sendPO(c, s, sofa.poId, "api", down.env());
    t.ok("send: a vendor that is down is logged as failed, in words", failed.status === "failed" && /answered 503|kept failing: answered 503/.test(failed.detail), failed.detail);
    const mailed = await pur.sendPO(c, s, sofa.poId, "email", net.env({ mail: true }));
    t.ok("send: by email with the 850-style file attached", mailed.status === "sent" && net.mails.at(-1)?.to === "orders@ashley.example");
    await pur.cancelPO(c, s, sofa.poId, "check finished");
  });
  const noApi = await pr.post<{ status: string; detail: string }>("/purchasing/pos/:id/send", BUYER, { method: "api" },
    (await pr.get<{ pos: { id: string; vendor: string }[] }>("/purchasing/pos", "?status=open")).pos.find((p) => p.vendor.startsWith("Coaster"))!.id);
  t.ok("send: a vendor with no order feed is told where to add one", noApi.status === "failed" && /no order feed/.test(noApi.detail));

  // ------------------------------------------------------ stop runs
  const stopF = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { vendor_id: V.ASHLEY, purpose: "images", name: "Ashley photos (stoppable)", url: `${API}/photos`,
    response_format: "json", records_path: "items", paging: { mode: "cursor", cursorPath: "paging.next_cursor", cursorParam: "cursor" } } });
  const stopped = await asPerson(t, BUYER, (c, co, a) => feeds.runFeed(c, scopeOf(co, a), stopF.id, net.env(), "manual", async () => true));
  t.ok("stop: a run asked to stop ends between calls, keeps nothing and says so", !stopped.ok && /stopped by a person/.test(stopped.note));
  const st = await cr.post<{ closed: number }>("/catalog/feeds/:id/stop", BUYER, {}, stopF.id);
  t.ok("stop: the stop button records the request (a stuck run is closed after two minutes)", st.closed === 0);

  // ------------------------------------------------------ scheduler, per feed
  await read(t, (c) => c.query(`update vendor_feed set last_run_at = now() - interval '2 days', every_hours = 24, schedule_cron = null where id = $1 and entity_id = $2`, [ppf.id, ENTITY]));
  await read(t, (c) => c.query(`update vendor_feed set every_hours = null, schedule_cron = null where entity_id = $1 and id <> $2`, [ENTITY, ppf.id]));
  const due = await runDueVendorFeeds(new Date(), net.env(), { entityId: ENTITY });
  const again = await runDueVendorFeeds(new Date(), net.env(), { entityId: ENTITY });
  const schedRun = await read(t, async (c) => (await q<{ trigger: string; outcome: string }>(c,
    `select trigger, outcome from vendor_feed_run where entity_id = $1 and feed_id = $2 order by started_at desc limit 1`, [ENTITY, ppf.id]))[0]);
  t.ok("scheduler: a feed due by 'every 24 hours' runs once as the scheduler, then is not due again",
    due.due === 1 && due.runs[0].ok && again.due === 0 && schedRun.trigger === "schedule" && schedRun.outcome === "ok", JSON.stringify(due.runs));

  // ------------------------------------------------------ photos: hosted here
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  const fakeImg: ImageFetch = async (url) => ({ status: 200, url, headers: { get: (k: string) => (k === "content-type" ? "image/jpeg" : k === "content-length" ? String(JPEG.length) : null) },
    arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length) as ArrayBuffer });
  useImageFetch(fakeImg);
  const hp = await cr.post<{ total: number; hosted: number; tried: number }>("/catalog/vendors/:id/host-photos", BUYER, {}, V.ASHLEY);
  const tally = await cr.get<{ photos: { total: string; hosted: string } }>("/catalog/vendors/:id/feeds", "", V.ASHLEY);
  t.ok("photos: Host photos now copies the vendor's photos here and the card says N of M hosted", hp.hosted === hp.total && hp.total > 0
    && tally.photos.hosted === tally.photos.total, JSON.stringify(hp));
  useImageFetch(undefined);

  // ------------------------------------------------------ migration of old connections
  const migrated = await asPerson(t, BUYER, async (c) => {
    await c.query("savepoint mig");
    await c.query(`insert into vendor_connection (entity_id, vendor_id, kind, adapter, name, config, credential_ref, schedule_cron, mapping)
      values ($1,$2,'api','ashley','Old Global API',$3,'secret://vendor/global','15 5 * * *','{"vendor_sku":"sku"}')`,
      [ENTITY, V.GLOBAL, JSON.stringify({ url: "https://api.global.example/items", pageSize: 50, authUrl: "https://api.global.example/oauth", atpOn: true,
        atpCustomer: "77", atpShipTo: "01", atpBatch: 20, freightOn: true, freightUrl: "https://api.global.example/prices", shipTos: { [DC]: "9" }, poUrl: "https://api.global.example/orders" })]);
    const sql = readFileSync(new URL("../../db/migrations/0028_vendor_feeds.sql", import.meta.url), "utf8");
    const part = sql.slice(sql.indexOf("-- ------------------------------------------------ migrate old connections --"));
    await c.query(part.replace(/where k\.kind = 'api'/g, `where k.kind = 'api' and k.name = 'Old Global API'`));
    const rows = await q<{ purpose: string; url: string; schedule_cron: string | null; credential_ref: string; auth: { mode: string }; paging: { size: number }; batching: { size: number }; options: Record<string, unknown> }>(c,
      `select purpose, url, schedule_cron, credential_ref, auth, paging, batching, options from vendor_feed where entity_id = $1 and vendor_id = $2 and name like 'Old Global API%' order by purpose`, [ENTITY, V.GLOBAL]);
    const conn = (await q<{ active: boolean }>(c, `select active from vendor_connection where entity_id = $1 and name = 'Old Global API'`, [ENTITY]))[0];
    await c.query("rollback to savepoint mig");
    return { rows, conn };
  });
  const mp = (p: string) => migrated.rows.find((r) => r.purpose === p);
  t.ok("migration: an old connection becomes one feed per thing it did, same key reference and schedule, and is switched off",
    migrated.rows.map((r) => r.purpose).join(",") === "freight,orders,products,quantities" && mp("products")?.auth.mode === "oauth2" && mp("products")?.paging.size === 50
    && mp("quantities")?.batching.size === 20 && mp("quantities")?.options.customer === "77" && mp("products")?.schedule_cron === "15 5 * * *"
    && migrated.rows.every((r) => r.credential_ref === "secret://vendor/global") && mp("orders")?.schedule_cron === null && migrated.conn.active === false, JSON.stringify(migrated.rows.map((r) => r.purpose)));

  // ------------------------------------------------------ from CATALOG-APP
  const caSource = {
    name: "Ashley API", vendor_label: "Ashley Furniture Industries",
    mapping: { ModelNum: "sku", ItemName: "description", RegularCost: "price.netPriceBeforeFreight", Price: "Promo Cost", Brand: "brand", ItemImage2: "images.url", DisplayOrder: "sortOrder" },
    feed: {
      type: "api", url: "https://api.ashleyfurniture.example/products/v1/ProductsAndPrices", urls: ["https://api.ashleyfurniture.example/pricing/v1/Prices"],
      header: "Ocp-Apim-Subscription-Key: CA-SUB-KEY-9876", qparams: [["Customer", "3989100"], ["Limit", "250"]], every_hours: 24,
      atp_on: true, atp_external_id: "Company3989100", atp_keycode: "CA-KEYCODE", atp_user: "AD_TEST_VP", atp_password: "CA-ATP-PASS", atp_customer: "", atp_shipto: "01",
      frt_on: true, frt_stores: "DC1, 104", etl: [{ out: "Promo Cost", a: "price.netPriceBeforeFreight", op: "subtract", b: "price.discount" }], photos_on: true,
    },
  };
  await t.throws("catalog app: without ERP_SECRET_KEY nothing is stored, and the sentence names the variable", async () => {
    useFeedEnv(() => net.env({ key: null }));
    try { await cr.post("/vendor-api/import/catalog-app", BUYER, { source: caSource }); } finally { useFeedEnv(() => net.env({ mail: true })); }
  }, /add ERP_SECRET_KEY/);
  const ca = await cr.post<{ vendor: string; feeds: { id: string; name: string; purpose: string; action: string; secrets: Record<string, string> }[]; unplaced: string[]; unmatchedShipTos: string[] }>(
    "/vendor-api/import/catalog-app", BUYER, { vendorName: "ashley furniture industries", source: caSource });
  const caOf = (p: string) => ca.feeds.find((f) => f.purpose === p);
  t.ok("catalog app: products, prices, freight by store and ATP quantities become separate feeds", ca.feeds.map((f) => f.purpose).sort().join(",") === "freight,pricing,products,quantities"
    && ca.feeds.every((f) => f.action === "created"), JSON.stringify(ca.feeds.map((f) => [f.purpose, f.action])));
  t.ok("catalog app: nothing secret comes back; keys show as ••••last2", !JSON.stringify(ca).includes("CA-SUB-KEY-9876") && !JSON.stringify(ca).includes("CA-ATP-PASS")
    && caOf("products")?.secrets.apiKey === "••••76" && caOf("quantities")?.secrets.atpPassword === "••••SS" && caOf("pricing")?.secrets.apiKey === "••••76");
  const caFeeds = await read(t, (c) => q<{ purpose: string; auth: Record<string, unknown>; query_params: Record<string, string>; every_hours: number | null; mapping: Record<string, string>;
    etl: unknown[]; options: Record<string, unknown>; secrets_from_feed_id: string | null; paging: { size: number } }>(c,
    `select purpose, auth, query_params, every_hours, mapping, etl, options, secrets_from_feed_id, paging from vendor_feed where entity_id = $1 and vendor_id = $2 and template in ('catalog_app','ashley') and name like '%(from catalog app)'`, [ENTITY, V.ASHLEY]));
  const cf = (p: string) => caFeeds.find((f) => f.purpose === p)!;
  t.ok("catalog app: the header line becomes key-header auth, Customer a parameter, Limit the page size, every_hours the schedule",
    cf("products").auth.headerName === "Ocp-Apim-Subscription-Key" && cf("products").query_params.Customer === "3989100" && !("Limit" in cf("products").query_params)
    && cf("products").paging.size === 250 && cf("products").every_hours === 24);
  t.ok("catalog app: its mapping lands per feed (ModelNum, ItemName, cost; promo to prices), ETL steps and photo hosting kept",
    cf("products").mapping.vendor_sku === "sku" && cf("products").mapping.name === "description" && cf("pricing").mapping.promo_cost === "Promo Cost"
    && cf("products").etl.length === 1 && cf("products").options.hostPhotos === true && !!cf("pricing").secrets_from_feed_id);
  t.ok("catalog app: ATP keeps its identifiers plainly and its keycode/password encrypted; ship-to numbers matched to stores, the rest listed",
    cf("quantities").auth.atpExternalId === "Company3989100" && cf("quantities").options.customer === "3989100" && cf("quantities").options.shipTo === "01"
    && (cf("freight").options.shipTos as Record<string, string>)[DC] === "DC1" && ca.unmatchedShipTos.join() === "104"
    && ca.unplaced.some((u) => /DisplayOrder/.test(u)), JSON.stringify(ca.unplaced));
  const ca2 = await cr.post<{ feeds: { action: string }[] }>("/vendor-api/import/catalog-app", BUYER, { vendorId: V.ASHLEY, source: caSource });
  t.ok("catalog app: sending it again updates the same feeds", ca2.feeds.length === 4 && ca2.feeds.every((f) => f.action === "updated"));
  const ca3 = await cr.post<{ vendorId: string; feeds: { action: string }[] }>("/vendor-api/import/catalog-app", BUYER, { vendorName: "ASHLEY CATALOG W/ QTY", source: caSource });
  t.ok("catalog app: a loose source label (ASHLEY CATALOG W/ QTY) still finds Ashley Furniture Industries", ca3.vendorId === V.ASHLEY && ca3.feeds.every((f) => f.action === "updated"));
  await t.throws("catalog app: a label naming no vendor is refused in words", () => cr.post("/vendor-api/import/catalog-app", BUYER, { vendorName: "Nobody Imports", source: caSource }), /no vendor called Nobody Imports/);
  const audits = await read(t, (c) => q<{ after: unknown }>(c, `select after from audit_event where entity_id = $1 and table_name in ('vendor_feed','vendor_feed_secret')`, [ENTITY]));
  t.ok("catalog app and secrets: audited by name, never by value", audits.length > 0 && !JSON.stringify(audits).includes("CA-SUB-KEY-9876") && !JSON.stringify(audits).includes("K-PRODUCTS-1111"));
  await t.throws("catalog app: a buyer of another company cannot reach this vendor", () => rio(t, (c, s) =>
    feeds.importCatalogAppSource(c, s, net.env(), { vendorId: V.ASHLEY, source: caSource })), /not set up for this company/);
  await t.throws("catalog app: only owners and buyers bring settings over", () => cr.post("/vendor-api/import/catalog-app", "55555555-0000-0000-0000-000000000003", { source: caSource }), /needs one of: buyer/);

  // ------------------------------------------------------ the feed screen data
  const sftp = await cr.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { vendor_id: V.GLOBAL, purpose: "products", name: "Global SFTP drop", kind: "sftp", url: "",
    options: { host: "sftp.global.example", port: 22, user: "buddys", path: "/outbound/", pattern: "*.csv" } } });
  const gview = await cr.get<{ feeds: { id: string; transport_note: string | null }[] }>("/catalog/vendors/:id/feeds", "", V.GLOBAL);
  const sr = await cr.post<feeds.RunResult>("/catalog/feeds/:id/run", BUYER, {}, sftp.id).catch((e: Error) => ({ ok: false, note: e.message }) as feeds.RunResult);
  t.ok("SFTP: the setting is kept, and the card and a run say plainly it is not built yet", /not built in this version yet/.test(gview.feeds.find((f) => f.id === sftp.id)?.transport_note ?? "")
    && /not built in this version yet/.test(sr.note));

  // ------------------------------------------------------------ isolation
  await rio(t, (c, s) => t.throws("isolation: another company cannot run this company's feed", () => feeds.runFeed(c, s, pf.id, net.env()), /no such feed/));
  await rio(t, (c, s) => t.throws("isolation: another company cannot set this company's feed keys", () => feeds.setFeedSecrets(c, s, net.env(), pf.id, { apiKey: "x" }), /no such feed/));
  await rio(t, (c, s) => t.throws("isolation: another company cannot add a feed for this company's vendor", () => feeds.saveFeed(c, s, { ...products, vendor_id: V.ASHLEY }, net.env()), /not set up for this company/));
  const rioView = await cr.get("/catalog/vendors/:id/feeds", "", V.ASHLEY, RIO_ENTITY);
  t.ok("isolation: another company sees none of this company's feeds", rioView === null);
  useFeedEnv(feeds.liveEnv);
}
