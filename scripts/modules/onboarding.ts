// Onboarding checks: the setup checklist on a brand-new company (every step
// not done, each one turning done as its data arrives), skipping with a
// reason, the account codes the services post to, unchecked tax rates, the
// opening stock import (preview, apply, the GL ties, bad rows refused), the
// bank opening balance, the go-live check catching a tie-out that fails, who
// may do what, and that a new company gets no sample data from a pack.
import { readFileSync, readdirSync } from "node:fs";
import { type T, ENTITY, PEOPLE } from "./harness.ts";
import { tx, q, type Client } from "../../packages/core/db.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";
import { createCompany } from "../../server/actions.ts";
import { applyPack, saveLocation, importCustomers, importOpenAr } from "../../packages/core/setup.ts";
import * as tax from "../../packages/core/tax.ts";
import * as inventory from "../../packages/core/inventory.ts";
import { post } from "../../packages/core/posting.ts";
import * as ob from "../../packages/core/onboarding.ts";
import { module as onboardingModule } from "../../server/modules/onboarding.ts";
import { module as setupModule } from "../../server/modules/setup.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const sys = { kind: "system" as const, label: "onboarding checks" };
const inTx = <R>(fn: (c: Client) => Promise<R>) => tx(sys, fn);

type Fn = (...a: unknown[]) => Promise<unknown>;
function routes(t: T, entityId: () => string, ...mods: { register: (k: never) => void }[]) {
  const gets = new Map<string, Fn>(), posts = new Map<string, Fn>();
  for (const mod of mods) mod.register({ coGet: (tail: string, fn: Fn) => gets.set(tail, fn), coPost: (tail: string, fn: Fn) => posts.set(tail, fn), publicRoute: () => {} } as never);
  const nameOf = async (id: string) => (await inTx((c) => q<{ name: string }>(c, `select name from app_user where id = $1 /* unscoped: lookup */`, [id])))[0]?.name ?? "?";
  return {
    get: async <R = any>(tail: string, personId: string | null): Promise<R> => {
      const c = await t.pool.connect();
      try { const co = await t.company(entityId()); return await gets.get(tail)!(c, co, new URL("http://x/"), ["", co.id], personId) as R; }
      finally { c.release(); }
    },
    post: async <R = any>(tail: string, personId: string, body: Record<string, unknown>): Promise<R> => {
      const co = await t.company(entityId());
      const name = await nameOf(personId);
      const a: Actor = { personId, personName: name, label: name };
      return tx({ kind: "user", id: personId, label: name }, (c) => posts.get(tail)!(c, co, a, body, ["", co.id]) as Promise<R>);
    },
  };
}

export async function run(t: T) {
  // ------------------------------------------------- a brand-new company
  console.log("  -- a new company from the screen");
  const made = await inTx((c) => createCompany(c, "onboarding checks", {
    clientId: null, clientName: `Onboarding Check ${Date.now()}`, vertical: "retail", chartFrom: null,
    name: "Onboard Co", legalName: "Onboard Co LLC", einLast4: "", fiscalYearEndMonth: 12, stores: [],
    banks: [{ purpose: "operating", name: "Operating", bankName: "A Bank", routingLast4: "1234", accountLast4: "5678" }],
    people: [{ name: "Olive Owner", email: "olive@onboard.test", roles: ["owner"] }],
  })) as { id: string; tenantId: string };
  const E1 = made.id, T1 = made.tenantId;
  const owner = (await inTx((c) => q<{ id: string }>(c, `select id from app_user where tenant_id = $1 and email = 'olive@onboard.test' /* unscoped: lookup */`, [T1])))[0].id;
  const r = routes(t, () => E1, onboardingModule, setupModule);
  const scope = (id = owner, label = "Olive Owner") => ({ tenantId: T1, entityId: E1, actor: { kind: "user" as const, id, label } });
  const asOwner = <R>(fn: (c: Client) => Promise<R>) => tx({ kind: "user", id: owner, label: "Olive Owner" }, fn);
  const list = () => r.get<Awaited<ReturnType<typeof ob.checklist>>>("/onboarding/checklist", owner);
  const step = async (id: string) => (await list()).steps.find((s) => s.id === id)!;

  const counts = async (entityId: string, tenantId: string) => (await inTx((c) => q<Record<string, string>>(c, `select
      (select count(*) from product where entity_id = $1)::text products, (select count(*) from customer where entity_id = $1)::text customers,
      (select count(*) from tax_jurisdiction where entity_id = $1)::text jurisdictions, (select count(*) from tax_rate where entity_id = $1)::text rates,
      (select count(*) from location where entity_id = $1)::text locations, (select count(*) from shop_site where entity_id = $1)::text sites,
      (select count(*) from delivery_zone where entity_id = $1)::text zones, (select count(*) from vehicle where entity_id = $1)::text trucks,
      (select count(*) from inv_piece where entity_id = $1)::text pieces, (select count(*) from journal_entry where entity_id = $1)::text entries,
      (select count(*) from sales_order where entity_id = $1)::text orders, (select count(*) from vendor where tenant_id = $2)::text vendors,
      (select count(*) from admin_connection where tenant_id = $2)::text connections, (select count(*) from label_template where entity_id = $1)::text labels
      /* unscoped: counting one new company and its client */`, [entityId, tenantId])))[0];
  const zero = (x: Record<string, string>) => Object.entries(x).filter(([, v]) => v !== "0").map(([k, v]) => `${k}=${v}`);
  const fresh = await counts(E1, T1);
  t.ok("new company: no products, customers, tax rates, locations, sites, trucks, entries or vendors", !zero(fresh).length, zero(fresh).join(", "));

  const d0 = await list();
  t.ok("new company: every step shows, none of them done", d0.steps.length === 13 && d0.steps.every((s) => s.status !== "done"),
    d0.steps.filter((s) => s.status === "done").map((s) => s.id).join(","));
  t.ok("new company: one store or none, so users and roles are optional", d0.steps.find((s) => s.id === "users")!.status === "optional");
  t.ok("new company: each step says why, has help and a screen to open", d0.steps.every((s) => s.why && s.what && s.skipped && s.screen && s.label));
  t.ok("new company: the chart lists the account codes the services need and lack",
    (d0.steps.find((s) => s.id === "chart")!.missingAccounts ?? []).some((m) => m.code === "1300" && m.services.includes("Warehouse"))
    && (d0.steps.find((s) => s.id === "chart")!.missingAccounts ?? []).some((m) => m.code === "2100"));
  const home0 = await r.get("/onboarding/home", owner);
  t.ok("home: the owner sees the card with the next steps", home0.show === true && home0.next.length === 3 && home0.total === 13);

  // packs add accounts, reasons, settings and services; never tax rates, locations or sample data
  await asOwner((c) => applyPack(c, scope(), "furniture", "Olive Owner"));
  const afterPack = await counts(E1, T1);
  t.ok("pack: applying a pack adds no tax rates, locations or sample data", !zero(afterPack).length, zero(afterPack).join(", "));
  t.ok("services: a pack applied turns the step done, single store counted", (await step("services")).status === "done" && /Single store|One location/.test((await step("services")).detail ?? ""));
  t.ok("chart: the pack's chart covers every code the services post to", (await step("chart")).status === "done", JSON.stringify((await step("chart")).missingAccounts));

  // the list of codes stays complete: every code: "NNNN" a core file posts to is on it
  const listed = new Set(Object.values(ob.POSTS_TO).flat());
  const used = new Set<string>();
  for (const f of readdirSync(ROOT + "packages/core").filter((x) => x.endsWith(".ts") && !["setup.ts", "onboarding.ts", "x12.ts"].includes(x))) {
    for (const m of readFileSync(ROOT + "packages/core/" + f, "utf8").matchAll(/\b(?:code|revenueCode): "(\d{4})"/g)) used.add(m[1]);
  }
  const unlisted = [...used].filter((x) => !listed.has(x));
  t.ok("chart: every code a core posting names is in the services' list", used.size > 20 && !unlisted.length, unlisted.join(","));

  // ------------------------------------------------------ company details
  console.log("  -- each step turns done when its data exists");
  await t.throws("company details: the state is two letters", () => r.post("/onboarding/company", owner, { legalName: "Onboard Co LLC", state: "Ohio" }), /two letters/);
  await r.post("/onboarding/company", owner, { legalName: "Onboard Co LLC", einLast4: "4321", address: { line1: "1 Main St", city: "Springfield", postal: "12345" }, state: "CO", fiscalYearStartMonth: 1 });
  t.ok("company details: done once the legal name, tax id, address and state are in", (await step("company")).status === "done");

  // ------------------------------------------------------------ locations
  const store = await asOwner((c) => saveLocation(c, scope(), { code: "ST1", name: "Main Street", kind: "store", address: { line1: "1 Main St", city: "Springfield", state: "CO", postal: "12345" } }));
  t.ok("locations: a store with its state and address is enough", (await step("locations")).status === "done");
  const wh = await asOwner((c) => saveLocation(c, scope(), { code: "DC1", name: "Warehouse", kind: "warehouse", address: { line1: "9 Dock Rd", city: "Springfield", state: "CO", postal: "12346" } }));
  const noAddr = await asOwner((c) => saveLocation(c, scope(), { code: "ST2", name: "Second Store", kind: "store", state: "CO" }));
  t.ok("locations: a selling location with no address turns it back to not done", (await step("locations")).status === "todo"
    && /Second Store/.test((await step("locations")).checks[1].detail ?? ""));
  await asOwner((c) => saveLocation(c, scope(), { id: noAddr, code: "ST2", name: "Second Store", kind: "store", address: { line1: "5 Elm St", city: "Springfield", state: "CO", postal: "12347" } }));
  t.ok("locations: done again once it has its address", (await step("locations")).status === "done");

  // -------------------------------------------------------------- users
  t.ok("users: several stores make a second person required", (await step("users")).status === "todo");
  const cashier = await inTx(async (c) => (await q<{ id: string }>(c, `insert into app_user (tenant_id, email, name) values ($1, 'cass@onboard.test', 'Cass Cashier') returning id /* unscoped: new person */`, [T1]))[0].id);
  await inTx((c) => c.query(`insert into role_grant (app_user_id, entity_id, role) values ($1, $2, 'cashier')`, [cashier, E1]));
  t.ok("users: done once someone besides the owner has a role", (await step("users")).status === "done");

  await t.throws("company details: a controller cannot change them", async () => {
    const ctl = await inTx(async (c) => (await q<{ id: string }>(c, `insert into app_user (tenant_id, email, name) values ($1, 'carl@onboard.test', 'Carl Controller') returning id /* unscoped: new person */`, [T1]))[0].id);
    await inTx((c) => c.query(`insert into role_grant (app_user_id, entity_id, role) values ($1, $2, 'controller')`, [ctl, E1]));
    await r.post("/onboarding/company", ctl, { legalName: "X Co" });
  }, /owner/);
  // ---------------------------------------------------------- sales tax
  const taxStep0 = await step("tax");
  t.ok("tax: a store with no jurisdiction is not done", taxStep0.status === "todo" && !taxStep0.checks[0].ok);
  await asOwner(async (c) => {
    const j = await tax.saveJurisdiction(c, scope(), { code: "CO-STATE", name: "State sales tax", level: "state", state: "CO", taxesDelivery: true, taxesLabor: false, taxesWarranty: true, rateBps: 290 });
    await tax.saveArea(c, scope(), { jurisdictionId: j.id!, state: "CO" });
    await tax.setSourcing(c, scope(), "destination");
  });
  const taxStep1 = await step("tax");
  t.ok("tax: a rate nobody has checked keeps the step not done", taxStep1.status === "todo" && taxStep1.checks[0].ok && taxStep1.checks[1].ok && !taxStep1.checks[2].ok,
    JSON.stringify(taxStep1.checks));
  const demoUnchecked = await inTx((c) => tax.uncheckedRates(c, ENTITY));
  t.ok("tax: seeded sample rates start unchecked", demoUnchecked.length > 0);
  await t.throws("tax: a cashier cannot confirm the rates", () => r.post("/setup/tax/confirm", cashier, {}), /owner, controller/);
  const conf = await r.post("/setup/tax/confirm", owner, {});
  t.ok("tax: confirmed by a person, the step is done", conf.checked >= 1 && (await step("tax")).status === "done");
  const checkedBy = await inTx((c) => q<{ checked_by: string }>(c, `select checked_by from tax_rate where entity_id = $1`, [E1]));
  t.ok("tax: the rate carries who checked it", checkedBy.every((x) => x.checked_by === "Olive Owner"));

  // --------------------------------------------------------- connections
  await inTx(async (c) => {
    for (const [kind, provider, status] of [["email", "smtp", "connected"], ["sms", "twilio", "connected"], ["card", "test", "saved"]]) {
      await c.query(`insert into admin_connection (tenant_id, entity_id, kind, provider, status, last_ok_at) values ($1, null, $2, $3, $4, $5)`,
        [T1, kind, provider, status, status === "connected" ? new Date() : null]);
    }
  });
  t.ok("connections: email and texts tested and card payments saved (client-wide) count", (await step("connections")).status === "done");

  // ------------------------------------------------------------- vendors
  await t.throws("skip: a skip needs a reason", () => r.post("/onboarding/skip", owner, { step: "vendors", reason: "" }), /say why/);
  await t.throws("skip: the go-live check cannot be skipped", () => r.post("/onboarding/skip", owner, { step: "golive", reason: "we are in a hurry" }), /cannot be skipped/);
  await t.throws("skip: a cashier cannot skip a step", () => r.post("/onboarding/skip", cashier, { step: "vendors", reason: "no vendors yet" }), /owner, controller/);
  await r.post("/onboarding/skip", owner, { step: "vendors", reason: "We buy from one vendor, added next week" });
  const sk = await step("vendors");
  t.ok("skip: with a reason the step shows skipped, with who and why", sk.status === "skipped" && sk.skip?.by === "Olive Owner" && /next week/.test(sk.skip?.reason ?? ""));
  await r.post("/onboarding/unskip", owner, { step: "vendors" });
  const kept = await inTx((c) => q(c, `select 1 from onboarding_skip where entity_id = $1 and withdrawn_at is not null`, [E1]));
  t.ok("skip: taking it back puts the step back on the list and keeps the old row", (await step("vendors")).status === "todo" && kept.length === 1);
  const vendorId = await inTx(async (c) => {
    const v = (await q<{ id: string }>(c, `insert into vendor (tenant_id, legal_name, status) values ($1, 'Maker Inc', 'active') returning id /* unscoped: new vendor */`, [T1]))[0].id;
    await c.query(`insert into vendor_entity (vendor_id, entity_id, status) values ($1, $2, 'active')`, [v, E1]);
    return v;
  });
  t.ok("vendors: a vendor alone is not enough while Buying is on", (await step("vendors")).status === "todo");
  await inTx((c) => c.query(`insert into vendor_feed (entity_id, vendor_id, purpose, name) values ($1, $2, 'products', 'Maker catalog')`, [E1, vendorId]));
  t.ok("vendors: done with a vendor feed", (await step("vendors")).status === "done");

  // ------------------------------------------------------------- products
  const prod = await inTx(async (c) => {
    const one = async (sku: string, serialized: boolean) => (await q<{ id: string }>(c, `insert into product (entity_id, sku, name, kind, price_minor, cost_minor, serialized, status)
      values ($1, $2, $3, 'stock', 50000, 20000, $4, 'active') returning id`, [E1, sku, `Item ${sku}`, serialized]))[0].id;
    return { chair: await one("CHAIR-1", false), tv: await one("TV-1", true), lamp: await one("LAMP-1", false) };
  });
  t.ok("products: products alone are not enough while Labels is on", (await step("products")).status === "todo");
  await inTx((c) => c.query(`insert into label_template (entity_id, kind, name, width_in, height_in, fields) values ($1, 'price_tag', 'Tag', 2, 1, '{sku,price}')`, [E1]));
  t.ok("products: done with a price-tag label", (await step("products")).status === "done");

  // ------------------------------------------------------- opening stock
  console.log("  -- opening stock and the bank opening balance");
  const zone = await inTx(async (c) => (await q<{ id: string }>(c, `insert into inv_zone (entity_id, location_id, code, name) values ($1, $2, 'A', 'Aisle A') returning id`, [E1, wh]))[0].id);
  await inTx((c) => c.query(`insert into inv_bin (entity_id, location_id, zone_id, code) values ($1, $2, $3, 'A-01')`, [E1, wh, zone]));
  const csv = [
    "sku,location,bin,qty,unit_cost,serial,lot",
    "CHAIR-1,DC1,A-01,4,120.50,,",            // goes in
    "TV-1,ST1,,2,300,SN-1;SN-2,",             // goes in, two serials
    "NOPE-9,DC1,,1,10,,",                     // no such SKU
    "LAMP-1,XX9,,1,10,,",                     // no such location
    "LAMP-1,DC1,,0,10,,",                     // zero quantity
    "LAMP-1,ST1,,1,,,",                       // no cost
    "CHAIR-1,DC1,,1,120.50,,",                // the same SKU and place twice
    "TV-1,DC1,,2,300,SN-3,",                  // one serial for two units
    "LAMP-1,DC1,Z-99,1,10,,",                 // no such bin
    "LAMP-1,ST2,,3,abc,,",                    // cost is not an amount
  ].join("\n");
  await t.throws("opening stock: a cashier cannot import it", () => r.post("/onboarding/opening-stock/preview", cashier, { csv, filename: "stock.csv" }), /owner, controller/);
  await t.throws("opening stock: a file without a qty column is refused", () => r.post("/onboarding/opening-stock/preview", owner, { csv: "sku,location\nCHAIR-1,DC1", filename: "x.csv" }), /qty column/);
  const gl = async (code: string) => BigInt((await inTx((c) => q<{ b: string }>(c, `select coalesce(sum(jl.debit_minor - jl.credit_minor), 0)::text b from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id where je.entity_id = $1 and g.code = $2`, [E1, code])))[0].b);
  const pv = await r.post("/onboarding/opening-stock/preview", owner, { csv, filename: "stock.csv" });
  const msg = (row: number) => pv.rows.find((x: any) => x.row === row)?.message ?? "";
  t.ok("opening stock preview: two rows go in, eight are refused", pv.ok === 2 && pv.refused === 8, `${pv.ok}/${pv.refused}`);
  t.ok("opening stock preview: each refusal says why", /no product with SKU NOPE-9/.test(msg(4)) && /no location with the code XX9/.test(msg(5)) && /above zero/.test(msg(6))
    && /no unit cost/.test(msg(7)) && /appears twice/.test(msg(8)) && /one per unit/.test(msg(9)) && /no bin Z-99/.test(msg(10)) && /not an amount/.test(msg(11)), pv.rows.map((x: any) => x.message).join(" | "));
  t.ok("opening stock preview: value at cost is worked out (4 x 120.50 + 2 x 300)", pv.valueMinor === "108200", pv.valueMinor);
  const lvl = await inTx((c) => q(c, `select 1 from stock_level where entity_id = $1 and on_hand <> 0`, [E1]));
  t.ok("opening stock preview: nothing moves and nothing posts", !lvl.length && (await gl("1300")) === 0n);
  const ap = await r.post("/onboarding/opening-stock/apply", owner, { runId: pv.runId });
  t.ok("opening stock apply: both rows in, $1,082.00", ap.added === 2 && ap.valueMinor === "108200" && !ap.problems.length, JSON.stringify(ap));
  t.ok("opening stock apply: Dr 1300 / Cr 3000 for the value", (await gl("1300")) === 108200n && (await gl("3000")) === -108200n);
  const tie = await inTx((c) => inventory.tieOut(c, E1));
  t.ok("opening stock apply: stock at cost ties to 1300", tie.ties, `${tie.differenceMinor}`);
  const pieces = await inTx((c) => q<{ serial_no: string; cost_minor: string }>(c, `select serial_no, cost_minor::text from inv_piece where entity_id = $1 and product_id = $2 order by serial_no`, [E1, prod.tv]));
  t.ok("opening stock apply: serials kept on the pieces at their cost", pieces.map((p) => p.serial_no).join(",") === "SN-1,SN-2" && pieces.every((p) => p.cost_minor === "30000"));
  const binQty = await inTx((c) => q<{ qty: string }>(c, `select sum(on_hand)::text qty from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`, [E1, prod.chair, wh]));
  t.ok("opening stock apply: the chairs are on hand at the warehouse", Number(binQty[0].qty) === 4);
  await t.throws("opening stock: the same import is never brought in twice", () => r.post("/onboarding/opening-stock/apply", owner, { runId: pv.runId }), /already brought in/);
  const again = await r.post("/onboarding/opening-stock/preview", owner, { csv: "sku,location,qty,unit_cost\nCHAIR-1,DC1,1,1.00", filename: "again.csv" });
  t.ok("opening stock: a SKU at a place already imported is refused next time", again.ok === 0 && /already came in/.test(again.rows[0].message));
  const adj = await inTx((c) => q(c, `select 1 from inv_adjustment where entity_id = $1 and reason_code = 'opening_balance'`, [E1]));
  t.ok("opening stock: each row is an opening-balance stock adjustment", adj.length === 2);

  // ---------------------------------------------------- opening balances
  await asOwner(async (c) => {
    await importCustomers(c, scope(), "number,name\nC-1,First Customer", "customers.csv", "Olive Owner");
    await importOpenAr(c, scope(), `customer_number,reference,as_of,balance\nC-1,OLD-1,${new Date().toISOString().slice(0, 10)},250.00`, "ar.csv", "Olive Owner");
  });
  t.ok("opening balances: receivables and stock in, still waiting on the bank", (await step("opening")).status === "todo"
    && (await step("opening")).checks.filter((x) => !x.ok).map((x) => x.label).join() === "Bank opening balance entered");
  const bank = await inTx(async (c) => (await q<{ id: string }>(c, `select id from bank_account where entity_id = $1 and purpose = 'operating'`, [E1]))[0].id);
  await t.throws("bank opening: a cashier cannot post it", () => r.post("/onboarding/opening-bank", cashier, { bankAccountId: bank, asOf: new Date().toISOString().slice(0, 10), amount: "1000" }), /owner, controller/);
  await t.throws("bank opening: a zero balance needs no entry", () => r.post("/onboarding/opening-bank", owner, { bankAccountId: bank, asOf: new Date().toISOString().slice(0, 10), amount: "0" }), /zero/);
  const before1010 = await gl("1010"), before3000 = await gl("3000");
  await r.post("/onboarding/opening-bank", owner, { bankAccountId: bank, asOf: new Date().toISOString().slice(0, 10), amount: "12,345.67" });
  t.ok("bank opening: Dr the bank's cash account / Cr 3000", (await gl("1010")) - before1010 === 1234567n && before3000 - (await gl("3000")) === 1234567n);
  await t.throws("bank opening: once per account", () => r.post("/onboarding/opening-bank", owner, { bankAccountId: bank, asOf: new Date().toISOString().slice(0, 10), amount: "5" }), /already has its opening balance/);
  t.ok("opening balances: done with receivables, stock and the bank", (await step("opening")).status === "done");

  // ------------------------------------------------------------ delivery
  t.ok("delivery: no zones, windows or trucks is not done", (await step("delivery")).status === "todo");
  await inTx(async (c) => {
    const z = (await q<{ id: string }>(c, `insert into delivery_zone (entity_id, code, name, dc_location_id, postal_codes) values ($1, 'Z1', 'Town', $2, '{12345}') returning id`, [E1, wh]))[0].id;
    await c.query(`insert into delivery_window (entity_id, zone_id, label, starts, ends) values ($1, $2, 'Morning', '08:00', '12:00')`, [E1, z]);
    await c.query(`insert into vehicle (entity_id, unit_no, vin_last6, kind, home_location_id, cube_ft, max_weight_lb) values ($1, 'T1', 'ABC123', 'box_truck', $2, 900, 6000)`, [E1, wh]);
  });
  t.ok("delivery: done with a zone, a window and a truck", (await step("delivery")).status === "done");

  // ------------------------------------------------------------ web store
  const web = await asOwner((c) => saveLocation(c, scope(), { code: "WEB", name: "Online", kind: "web" }));
  await inTx((c) => c.query(`insert into shop_site (entity_id, slug, display_name, web_location_id) values ($1, $3, 'Onboard Co', $2)`, [E1, web, `onboard-${Date.now().toString(36)}`]));
  t.ok("web store: done with the site's settings", (await step("web")).status === "done");

  // ------------------------------------------------------------- go-live
  console.log("  -- the go-live check");
  const done = await list();
  const g = done.steps.find((s) => s.id === "golive")!;
  t.ok("go-live: every step done and every tie-out passing", done.complete && g.status === "done" && (g.tieOuts ?? []).length === 4 && g.tieOuts!.every((x) => x.ok),
    JSON.stringify(done.steps.filter((s) => s.status !== "done").map((s) => [s.id, s.checks.filter((x) => !x.ok)])));
  t.ok("home: a finished checklist leaves Home", (await r.get("/onboarding/home", owner)).show === false);
  await asOwner((c) => post(c, scope(), { date: new Date().toISOString().slice(0, 10), sourceType: "manual", sourceId: null, description: "check: stock posted with no stock",
    lines: [{ code: "1300", debit: 5000n }, { code: "3000", credit: 5000n }] }));
  const g2 = (await list()).steps.find((s) => s.id === "golive")!;
  const stockTie = g2.tieOuts!.find((x) => x.id === "stock")!;
  t.ok("go-live: a failing tie-out is reported and the step is not done", g2.status === "todo" && !stockTie.ok && /\$50\.00/.test(stockTie.detail), stockTie.detail);
  t.ok("go-live: the other tie-outs still pass", g2.tieOuts!.filter((x) => x.id !== "stock").every((x) => x.ok));
  await asOwner((c) => post(c, scope(), { date: new Date().toISOString().slice(0, 10), sourceType: "manual", sourceId: null, description: "check: reversed",
    lines: [{ code: "3000", debit: 5000n }, { code: "1300", credit: 5000n }] }));

  // --------------------------------------------------------------- roles
  console.log("  -- who may see and change it");
  await t.throws("roles: a cashier cannot see the checklist", () => r.get("/onboarding/checklist", cashier), /owner or a controller/);
  await t.throws("roles: nobody acting cannot see it", () => r.get("/onboarding/checklist", null), /pick who you are acting as/);
  t.ok("roles: a cashier's Home has no checklist card", (await r.get("/onboarding/home", cashier)).show === false);
  await t.throws("roles: a cashier cannot hide it from Home", () => r.post("/onboarding/dismiss", cashier, { dismissed: true }), /owner, controller/);
  const ctlId = (await inTx((c) => q<{ id: string }>(c, `select id from app_user where tenant_id = $1 and email = 'carl@onboard.test' /* unscoped: lookup */`, [T1])))[0].id;
  t.ok("roles: a controller sees the checklist", (await r.get("/onboarding/checklist", ctlId)).steps.length === 13);

  // a controller hides the card; it stays under Setup, and comes back when asked
  const r2 = routes(t, () => ENTITY, onboardingModule);
  await r2.post("/onboarding/dismiss", PEOPLE.CONTROLLER, { dismissed: true });
  t.ok("dismiss: hidden from Home for the demo company", (await r2.get("/onboarding/home", PEOPLE.STEVE)).show === false
    && !!(await r2.get("/onboarding/checklist", PEOPLE.STEVE)).dismissed);
  await r2.post("/onboarding/dismiss", PEOPLE.STEVE, { dismissed: false });
  t.ok("dismiss: shown again when asked", (await r2.get("/onboarding/home", PEOPLE.STEVE)).show === true);

  // ------------------------------------------------- sample assumptions
  const uiFiles = readdirSync(ROOT + "server/ui").filter((f) => f.endsWith(".js")).map((f) => "server/ui/" + f).concat(["server/app.js", "server/shop/store.js"]);
  const sample = /Buddy|Enola|Palestine|Socorro|Camp Hill|Keystone|40\.2601|75801|17025|placeholder: '(PA|TX)'/;
  const hits = uiFiles.filter((f) => sample.test(readFileSync(ROOT + f, "utf8")));
  t.ok("sample names: no screen assumes a sample business, town or state", !hits.length, hits.join(", "));
  const core = ["packages/core/haulaway.ts", "packages/core/tax.ts", "packages/core/setup.ts", "server/actions.ts", "packages/core/geocode.ts"];
  const coreHits = core.filter((f) => /\?\? "PA"|like TX|like ENL|TX-PALESTINE|Enola|Palestine/.test(readFileSync(ROOT + f, "utf8")));
  t.ok("sample names: no core rule falls back to a sample state or names one", !coreHits.length, coreHits.join(", "));
  t.ok("new company: the add-a-company form starts as general retail", /select\(Object\.entries\(KIND\), 'retail'\)/.test(readFileSync(ROOT + "server/app.js", "utf8")));
  void store;
}
