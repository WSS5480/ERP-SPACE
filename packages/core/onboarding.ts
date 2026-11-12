// First-run setup: the per-company setup checklist, opening stock from a CSV
// and a bank account's opening balance.
//
// The checklist never stores a tick. Every step's status is worked out from
// the company's real data each time it is read: a step is done when its data
// exists. The one thing a person can say is "skip this, because ...", and
// that reason is kept (onboarding_skip, never deleted; taking it back stamps
// withdrawn_at). Steps that belong to a service show only while that service
// is on. The last step, the go-live check, runs the system's own tie-outs.
//
// This module writes only its own tables. Opening stock goes in through
// inventory.adjust (reason 'opening_balance': Dr 1300 / Cr 3000), and the bank
// opening balance through posting.post, like every other posting.

import { today as bizToday } from "./clock.ts";
import { periodFor, PeriodError } from "./periods.ts";
import { validTimeZone } from "./clock.ts";
import { q, one, audit, inSupport, type Client, type Scope } from "./db.ts";
import { post, PostingError } from "./posting.ts";
import { effectiveServices } from "./services.ts";
import { parseCsv, type ModuleId } from "./setup.ts";
import * as tax from "./tax.ts";
import * as inventory from "./inventory.ts";
import { lenderAging } from "./ar_settlement.ts";
import { netCheck } from "./group.ts";

export class OnboardingError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new OnboardingError(msg); };
const isDay = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmt = (m: bigint) => { const neg = m < 0n; const a = neg ? -m : m; return `${neg ? "-" : ""}$${(a / 100n).toLocaleString("en-US")}.${String(a % 100n).padStart(2, "0")}`; };

// ============================================================ account codes

/**
 * The GL codes each service posts to, by code, through posting.post (and the
 * inventory and A/R helpers it calls). Built from the post() calls in
 * packages/core: scripts/modules/onboarding.ts greps every `code: "NNNN"`
 * there and fails if one is missing from this list, so it stays complete.
 * "books" is what the finance core needs whatever is switched on.
 */
export const POSTS_TO: Partial<Record<ModuleId | "books", string[]>> = {
  books: ["1010", "2010", "3000", "3900"],
  ar: ["1050", "1100", "1190", "2100", "2300", "4000", "4020", "6900"],
  settlements: ["1050", "1110", "1115", "2195", "6910", "6915"],
  pos: ["1050", "1100", "1110", "1300", "2100", "2300", "2310", "2320", "4000", "4030", "4040", "4900", "5000", "6800", "6910"],
  shop: ["1050", "1100", "1300", "2100", "2300", "4000", "4030", "5000", "6910"],
  inventory: ["1300", "3000", "5000", "5040"],
  wms: ["1300", "1310", "2050", "5000"],
  purchasing: ["1300", "2050"],
  memos: ["1150", "2010", "5000", "6150"],
  service: ["1150", "2050", "4030", "4050", "5000", "6150", "6155"],
  workforce: ["2160", "6130"],
  trade: ["2160", "6130"],
  payroll: ["2150", "2200", "6100", "6110", "6120"],
  group: ["1195", "2190", "4090", "5090", "6800"],
  haulaway: ["4095"],
  fleet: ["4030"],
  salestax: ["2100"],
};

const SERVICE_NAME: Record<string, string> = {
  books: "the books", ar: "Receivables", settlements: "Finance settlements", pos: "Point of sale", shop: "Web store", inventory: "Warehouse",
  wms: "Containers and prep", purchasing: "Buying", memos: "Debit memos", service: "Service and repair", workforce: "Time and commissions",
  trade: "Trade accounts", payroll: "Payroll", group: "Group accounting", haulaway: "Haul-away", fleet: "Delivery", salestax: "Sales tax",
};

/** Codes the services that are on post to, with who needs each, and which of them the chart lacks (or has turned off). */
export async function missingAccounts(c: Client, tenantId: string, entityId: string, on: readonly string[]) {
  const needs = new Map<string, string[]>();
  const add = (svc: string, code: string) => { const l = needs.get(code) ?? []; if (!l.includes(svc)) l.push(svc); needs.set(code, l); };
  for (const code of POSTS_TO.books!) add("books", code);
  for (const svc of on) for (const code of POSTS_TO[svc as ModuleId] ?? []) add(svc, code);
  // two-step transfers through 1310 need it even without containers
  if (on.includes("inventory")) {
    const gl = await q<{ value: unknown }>(c, `select value from entity_setting where entity_id = $1 and key = 'inventory.in_transit_gl'`, [entityId]);
    if (gl[0]?.value === "1310") add("inventory", "1310");
  }
  const codes = [...needs.keys()].sort();
  const have = await q<{ code: string; active: boolean }>(c, `select code, active from gl_account where tenant_id = $1 and code = any($2)
     /* unscoped: the chart is shared across the client's companies */`, [tenantId, codes]);
  const missing = codes.filter((x) => !have.some((h) => h.code === x && h.active)).map((code) => ({
    code, inactive: have.some((h) => h.code === code && !h.active), services: (needs.get(code) ?? []).map((s) => SERVICE_NAME[s] ?? s) }));
  return { needed: codes, missing };
}

// =================================================================== steps

export type StepId = "company" | "locations" | "services" | "chart" | "tax" | "users" | "connections" | "vendors" | "products"
  | "opening" | "delivery" | "web" | "golive";

type StepDef = { id: StepId; title: string; why: string; what: string; skipped: string; screen: string; sub?: string; label: string; skippable: boolean };

/** What each step is, in plain words: the checklist line, and the help panel (what it is, and what happens if it is skipped). */
export const STEPS: StepDef[] = [
  { id: "company", title: "Company details", screen: "checklist", sub: "company", label: "Enter the details", skippable: true,
    why: "Your legal name, tax id and address go on invoices, statements, purchase orders and tax filings.",
    what: "The company's legal name as registered, its federal tax id (only the last four digits are kept here), its mailing address and state, and the month its fiscal year starts. These print on what you send out and decide how the year is grouped in the books.",
    skipped: "Documents go out without your legal name or address, and year-end reports may group the months wrongly." },
  { id: "locations", title: "Stores and warehouses", screen: "business", label: "Open Business setup", skippable: true,
    why: "Stock, sales, sales tax and the profit and loss are all kept per location.",
    what: "Every place you sell from or keep stock: stores, outlets, warehouses. A selling location needs its street address and state, because sales tax is worked out from where the goods are handed over.",
    skipped: "Nothing can be received, stocked or sold, and a store with no state cannot charge sales tax." },
  { id: "services", title: "Business type and services", screen: "services", label: "Open Services", skippable: true,
    why: "Picking what kind of business this is turns on the right screens and adds the accounts and defaults they need.",
    what: "Choose a setup pack or a preset (single store, several stores, furniture, delivery, back office). It switches services on and off and adds the accounts, reason lists and settings they use. Whether you run one store or several is counted for you from your locations and companies.",
    skipped: "Every service stays on, so people see screens you do not use, and the accounts those services need may be missing." },
  { id: "chart", title: "Chart of accounts", screen: "chart", label: "Open Chart of accounts", skippable: true,
    why: "Every sale, receipt, bill and stock movement posts to an account by its number; a missing account stops that posting.",
    what: "Either the chart that comes with a setup pack, or your own chart imported from a CSV. Each service that is on posts to certain account numbers; the list below names any your chart does not have yet.",
    skipped: "Postings to a missing account are refused, so a sale, receipt or bill that needs it cannot be saved until the account is added." },
  { id: "tax", title: "Sales tax", screen: "salestax", label: "Open Sales tax", skippable: true,
    why: "Every sale is taxed from these rates; wrong or unchecked rates mean charging customers the wrong amount.",
    what: "Each selling location needs at least one tax jurisdiction with a rate, and you choose whether deliveries are taxed where the goods go or at the store. Rates that came with the system, or were entered before anyone checked them, stay marked unchecked until a person confirms they match what the state publishes.",
    skipped: "Sales may be taxed at a rate nobody has checked, which you owe the state whether or not you collected it." },
  { id: "users", title: "Users and roles", screen: "setup", label: "Open Setup, People", skippable: true,
    why: "With more than one person, each one acts under their own name and roles, and nobody approves their own work.",
    what: "Add the people who enter and approve things, each with the roles they need (store manager, cashier, buyer, controller...). Required when the business has more than one store; optional for a single store.",
    skipped: "The owner has to do and approve everything, and nothing the owner enters can be approved by anyone else." },
  { id: "connections", title: "Connections", screen: "connections", label: "Open Connections", skippable: true,
    why: "Email sends purchase orders, sign-in codes, statements and reports; texts and card payments only matter if you use them.",
    what: "Connect outgoing email and send a test. If Delivery is on, connect a text provider for delivery texts. If the web store or the register takes cards, set up the card processor.",
    skipped: "Messages are logged but not sent, so customers and vendors never receive them." },
  { id: "vendors", title: "Vendors", screen: "payables", sub: "vendors", label: "Open Vendors", skippable: true,
    why: "Bills, purchase orders and product costs all belong to a vendor.",
    what: "Add at least one vendor. If Buying or Vendor EDI is on, also set up a vendor feed or an EDI trading partner so catalogs, prices and orders flow without typing.",
    skipped: "Bills and purchase orders cannot be entered, and catalogs and prices have to be typed by hand." },
  { id: "products", title: "Products", screen: "catalog", label: "Open Catalog", skippable: true,
    why: "Nothing can be sold, ordered or counted until it is in the catalog.",
    what: "Import your products from a CSV or a vendor feed. If Labels is on, set up a price-tag label so tags can be printed.",
    skipped: "The register, web store and purchasing have nothing to sell or order." },
  { id: "opening", title: "Opening balances", screen: "checklist", sub: "opening", label: "Bring balances over", skippable: true,
    why: "Starting from your old system's balances makes the first statements, aging and stock value right.",
    what: "What customers owed on the day you switch (open receivables), the stock you had on hand with what it cost, and each bank account's balance. Each posts against opening equity (3000), so the books start where the old ones ended.",
    skipped: "Customer balances, stock value and cash start at zero, so aging, statements and the balance sheet are wrong until corrected." },
  { id: "delivery", title: "Delivery", screen: "fleet", label: "Open Delivery", skippable: true,
    why: "Deliveries are booked into zones and time windows and loaded onto trucks.",
    what: "Set up the delivery zones (by ZIP), the time windows customers can pick, and the trucks with what they carry.",
    skipped: "Deliveries cannot be booked or routed." },
  { id: "web", title: "Web store and trade portal", screen: "shop", label: "Open Web store", skippable: true,
    why: "The online store and the trade portal both run on the site's own settings.",
    what: "Name the site, choose its address, pickup locations, delivery and shipping fees, and policies. The trade portal lives on the same site.",
    skipped: "The web store and trade portal have no site to show." },
  { id: "golive", title: "Go-live check", screen: "checklist", label: "Run the check", skippable: false,
    why: "Before real trading starts, the system's own tie-outs must agree.",
    what: "Runs the checks the books depend on: stock at cost against inventory account 1300, sales tax by jurisdiction against 2100, financing receivables against 1110, and inter-company balances netting to zero. It also needs every other step finished or skipped. Then the owner presses Go live: first they look over everything ERP setup approved for them during setup (new vendors and new hires) and tick that they reviewed it. Only the owner, signed in as themselves, can press it. From go-live on, ERP setup approves nothing for this company.",
    skipped: "This step cannot be skipped: it is how you know the opening balances and setup agree." },
];

export type Check = { label: string; ok: boolean; detail?: string | null };
export type Step = StepDef & {
  status: "done" | "todo" | "skipped" | "optional";
  checks: Check[];
  detail: string | null;
  missingAccounts?: { code: string; services: string[]; inactive: boolean }[];
  tieOuts?: { id: string; label: string; ok: boolean; detail: string }[];
  setupApprovals?: SetupApproval[];
  skip: { reason: string; by: string; at: string } | null;
};

const n = async (c: Client, sql: string, params: unknown[]) => Number((await one<{ n: string }>(c, sql, params)).n);

/** Is a connection of this kind live for the company (its own row wins, else the client's)? tested: worked on a test. */
async function connection(c: Client, tenantId: string, entityId: string, kind: string) {
  const r = await q<{ status: string; last_ok_at: string | null; entity_id: string | null }>(c, `
    select status, last_ok_at, entity_id from admin_connection where tenant_id = $1 and kind = $3 and active and (entity_id = $2 or entity_id is null)
     order by entity_id nulls last limit 1 /* unscoped: a client-wide connection serves every company */`, [tenantId, entityId, kind]);
  return r[0] ? { saved: true, tested: r[0].status === "connected" && !!r[0].last_ok_at, status: r[0].status } : { saved: false, tested: false, status: "not_set_up" };
}

/** The tie-outs the go-live check runs. Each one that cannot run counts as failing, with why. */
export async function tieOuts(c: Client, tenantId: string, entityId: string, multiCompany: boolean) {
  const out: { id: string; label: string; ok: boolean; detail: string }[] = [];
  const run = async (id: string, label: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    // read-only checks, run from a GET (no transaction): one that fails to run is reported, never thrown
    try { const r = await fn(); out.push({ id, label, ...r }); }
    catch (e) { out.push({ id, label, ok: false, detail: `could not be checked: ${(e as Error).message}` }); }
  };
  await run("stock", "Stock at cost ties to 1300", async () => {
    const t = await inventory.tieOut(c, entityId);
    return { ok: t.ties, detail: t.ties ? `Stock ${fmt(t.stockMinor + t.inTransitMinor)} agrees with the books.`
      : `The books show ${fmt(t.gl1300Minor + t.gl1310Minor)} in 1300/1310 but stock at cost is ${fmt(t.stockMinor + t.inTransitMinor)}: a difference of ${fmt(t.differenceMinor)}.` };
  });
  await run("tax", "Sales tax ties to 2100", async () => {
    const f = await tax.filing(c, entityId, "2000-01-01", (await bizToday(c, entityId)));
    return { ok: f.tie.ties, detail: f.tie.note };
  });
  await run("financing", "Financing receivables tie to 1110", async () => {
    const a = await lenderAging(c, entityId);
    const d = BigInt(a.differenceMinor);
    return { ok: d === 0n, detail: d === 0n ? "What finance companies owe agrees with 1110." : `1110 differs from the lenders' aging by ${fmt(d)}.` };
  });
  await run("intercompany", "Inter-company balances net to zero", async () => {
    if (!multiCompany) return { ok: true, detail: "Only one company here, so there is nothing between companies to net." };
    const r = await netCheck(c, tenantId);
    const mine = r.pairs.filter((p) => p.a.id === entityId || p.b.id === entityId);
    const off = mine.filter((p) => !p.balanced);
    const untracked = r.ties.find((x) => x.id === entityId && !x.ties);
    const ok = !off.length && !untracked;
    return { ok, detail: ok ? "Balances with the other companies net to zero."
      : [off.length ? `${off.length} pair${off.length === 1 ? "" : "s"} of companies do not net to zero` : null,
         untracked ? `${fmt(untracked.untrackedMinor)} posted to 1195/2190 outside Group` : null].filter(Boolean).join("; ") + "." };
  });
  return out;
}

/**
 * The checklist for one company, worked out from its data now. Steps for a
 * service that is off are left out. complete: every step shown is done,
 * skipped or optional.
 */
export async function checklist(c: Client, tenantId: string, entityId: string, opts: { tieOuts?: boolean } = {}) {
  const e = await one<{ name: string; legal_name: string; ein_last4: string | null; ein_ref: string | null; address: Record<string, string>; state: string | null; fy_end: number }>(c, `
    select name, legal_name, ein_last4, ein_ref, address, state, fiscal_year_end_month fy_end from entity where id = $1 and tenant_id = $2 /* unscoped: the company itself */`, [entityId, tenantId]);
  const svc = await effectiveServices(c, entityId);
  const on = svc.on as string[];
  const has = (m: string) => on.includes(m);
  const skips = await q<{ step: string; reason: string; skipped_by: string; skipped_at: string }>(c,
    `select step, reason, skipped_by, skipped_at::text from onboarding_skip where entity_id = $1 and withdrawn_at is null`, [entityId]);
  const dismissed = await q<{ dismissed_by: string; dismissed_at: string }>(c,
    `select dismissed_by, dismissed_at::text from onboarding_dismissal where entity_id = $1 and withdrawn_at is null`, [entityId]);
  const steps: Step[] = [];
  const add = (id: StepId, checks: Check[], o: { detail?: string | null; optional?: boolean; extra?: Partial<Step> } = {}) => {
    const def = STEPS.find((s) => s.id === id)!;
    const sk = skips.find((s) => s.step === id);
    const done = checks.every((x) => x.ok);
    steps.push({ ...def, checks, detail: o.detail ?? null, ...o.extra,
      status: done ? "done" : sk ? "skipped" : o.optional ? "optional" : "todo",
      skip: sk ? { reason: sk.reason, by: sk.skipped_by, at: sk.skipped_at } : null });
  };

  // ---- company details
  const a = e.address ?? {};
  const startMonth = MONTHS[e.fy_end % 12];
  add("company", [
    { label: "Legal name", ok: (e.legal_name ?? "").trim().length >= 2, detail: e.legal_name || null },
    { label: "Federal tax id (EIN)", ok: !!(e.ein_last4 || e.ein_ref), detail: e.ein_last4 ? `ends ${e.ein_last4}` : null },
    { label: "Mailing address", ok: !!(a.line1 && a.city && a.postal), detail: [a.line1, a.city, a.postal].filter(Boolean).join(", ") || null },
    { label: "State", ok: !!e.state, detail: e.state },
    { label: "Fiscal year", ok: true, detail: `starts in ${startMonth}` },
  ]);

  // ---- locations
  const locs = await q<{ id: string; code: string; name: string; kind: string; state: string | null; address: Record<string, string> }>(c,
    `select id, code, name, kind, coalesce(state, address->>'state') state, address from location where entity_id = $1 and status = 'active'
       and kind not in ('in_transit','dropship') order by code`, [entityId]);
  const selling = locs.filter((l) => l.kind === "store" || l.kind === "outlet");
  const noAddr = selling.filter((l) => !l.state || !(l.address?.line1 && l.address?.city && l.address?.postal));
  add("locations", [
    { label: "At least one store or warehouse", ok: locs.filter((l) => l.kind !== "web" && l.kind !== "office").length > 0,
      detail: locs.length ? `${locs.length} location${locs.length === 1 ? "" : "s"}` : null },
    { label: "Every selling location has a state and an address", ok: selling.length > 0 ? !noAddr.length : locs.length > 0,
      detail: noAddr.length ? `Missing on ${noAddr.map((l) => l.name).join(", ")}` : null },
  ]);

  // ---- business type and services
  const packs = await q<{ pack: string }>(c, `select pack from pack_application where entity_id = $1 order by applied_at desc limit 1`, [entityId]);
  const chose = await n(c, `select count(*)::text n from entity_module where entity_id = $1`, [entityId]);
  const L = svc.layout;
  const layoutWords = L.single ? "Single store" : `${L.multiStore ? `${L.locations} locations` : "One location"}${L.multiCompany ? `, ${L.companies} companies` : ""}`;
  add("services", [
    { label: "A setup pack or preset chosen", ok: packs.length > 0 || chose > 0, detail: packs[0] ? `set up as ${packs[0].pack}` : chose ? "services chosen by hand" : null },
  ], { detail: `${layoutWords} (counted)` });

  // ---- chart of accounts
  const imported = await n(c, `select count(*)::text n from chart_import_run where entity_id = $1 and status = 'applied'`, [entityId]);
  const acct = await missingAccounts(c, tenantId, entityId, on);
  add("chart", [
    { label: "A pack's chart applied or your chart imported", ok: packs.length > 0 || imported > 0, detail: imported ? "chart imported" : packs.length ? "from the setup pack" : null },
    { label: "Every account the services post to exists", ok: !acct.missing.length,
      detail: acct.missing.length ? `Missing: ${acct.missing.map((m) => m.code).join(", ")}` : `${acct.needed.length} accounts in use` },
  ], { extra: { missingAccounts: acct.missing } });

  // ---- sales tax
  if (has("salestax")) {
    const noTax: string[] = [];
    let standIns = 0;   // a store on its single rate whose stand-in is not made yet: a rate nobody has checked either
    for (const l of selling) {
      const s = l.state ? await tax.stackForLocation(c, entityId, l.id, (await bizToday(c, entityId)), false) : [];
      if (!s.length || !s.some((j) => j.rateBps > 0 || (j.id && j.level !== "combined"))) noTax.push(l.name);
      if (s.some((j) => !j.id && j.rateBps > 0)) standIns++;
    }
    const unchecked = await tax.uncheckedRates(c, entityId);
    const chosen = await n(c, `select count(*)::text n from tax_setting where entity_id = $1`, [entityId]);
    const nUnchecked = unchecked.length + standIns;
    add("tax", [
      { label: "Each selling location has a tax jurisdiction with a rate", ok: selling.length > 0 && !noTax.length,
        detail: !selling.length ? "No selling locations yet" : noTax.length ? `None for ${noTax.join(", ")}` : null },
      { label: "How deliveries are taxed is chosen", ok: chosen > 0, detail: chosen ? `by ${await tax.sourcing(c, entityId)}` : null },
      { label: "A person confirmed the rates were checked", ok: nUnchecked === 0,
        detail: nUnchecked ? `${nUnchecked} rate${nUnchecked === 1 ? "" : "s"} not checked yet` : null },
    ], { optional: !selling.length, detail: selling.length ? null : "No store or outlet sells here yet, so nothing is taxed; optional until one is added" });
  }

  // ---- users and roles
  const others = await n(c, `
    select count(distinct u.id)::text n from app_user u join role_grant g on g.app_user_id = u.id
     where u.tenant_id = $2 and (g.entity_id = $1 or g.entity_id is null)
       and not exists (select 1 from role_grant o where o.app_user_id = u.id and o.role = 'owner' and (o.entity_id = $1 or o.entity_id is null))
     /* unscoped: people belong to the client; grants name this company or every company */`, [entityId, tenantId]);
  add("users", [{ label: "Someone besides the owner has a role", ok: others > 0, detail: others ? `${others} other ${others === 1 ? "person" : "people"}` : null }],
    { optional: L.single, detail: L.single ? "Optional for a single store" : null });

  // ---- connections
  const email = await connection(c, tenantId, entityId, "email");
  const conn: Check[] = [{ label: "Email connected and tested", ok: email.tested, detail: email.saved && !email.tested ? (email.status === "failing" ? "the last test failed" : "saved, not tested yet") : null }];
  if (has("fleet")) { const s = await connection(c, tenantId, entityId, "sms"); conn.push({ label: "Text messages connected and tested (delivery texts)", ok: s.tested, detail: s.saved && !s.tested ? "saved, not tested yet" : null }); }
  if (has("shop") || has("pos")) { const p = await connection(c, tenantId, entityId, "card"); conn.push({ label: "Card payments set up (web store and register)", ok: p.saved }); }
  add("connections", conn);

  // ---- vendors
  const vendors = await n(c, `select count(*)::text n from vendor_entity where entity_id = $1 and status <> 'inactive'`, [entityId]);
  const vchecks: Check[] = [{ label: "At least one vendor", ok: vendors > 0, detail: vendors ? `${vendors} vendor${vendors === 1 ? "" : "s"}` : null }];
  if (has("purchasing") || has("edi")) {
    const feeds = await n(c, `select count(*)::text n from vendor_feed where entity_id = $1 and active`, [entityId]);
    const edi = await n(c, `select count(*)::text n from edi_partner where entity_id = $1`, [entityId]);
    vchecks.push({ label: "A vendor feed or EDI partner", ok: feeds + edi > 0, detail: feeds + edi ? `${feeds} feed${feeds === 1 ? "" : "s"}, ${edi} EDI partner${edi === 1 ? "" : "s"}` : null });
  }
  add("vendors", vchecks);

  // ---- products
  if (has("catalog")) {
    const products = await n(c, `select count(*)::text n from product where entity_id = $1 and status <> 'discontinued'`, [entityId]);
    const pchecks: Check[] = [{ label: "Products in the catalog", ok: products > 0, detail: products ? `${products} product${products === 1 ? "" : "s"}` : null }];
    if (has("labels")) {
      const tags = await n(c, `select count(*)::text n from label_template where entity_id = $1 and kind = 'price_tag' and active`, [entityId]);
      pchecks.push({ label: "A price-tag label set up", ok: tags > 0 });
    }
    add("products", pchecks);
  }

  // ---- opening balances
  const ochecks: Check[] = [];
  if (has("ar")) {
    const ar = await n(c, `select count(*)::text n from opening_receivable where entity_id = $1`, [entityId]);
    ochecks.push({ label: "Customers' open balances imported", ok: ar > 0, detail: ar ? `${ar} balance${ar === 1 ? "" : "s"}` : null });
  }
  if (has("inventory")) {
    const st = await n(c, `select count(*)::text n from inv_adjustment where entity_id = $1 and reason_code = 'opening_balance'`, [entityId]);
    ochecks.push({ label: "Opening stock entered", ok: st > 0, detail: st ? `${st} line${st === 1 ? "" : "s"}` : null });
  }
  const banks = await n(c, `select count(*)::text n from opening_bank_balance where entity_id = $1`, [entityId]);
  ochecks.push({ label: "Bank opening balance entered", ok: banks > 0, detail: banks ? `${banks} account${banks === 1 ? "" : "s"}` : null });
  add("opening", ochecks);

  // ---- delivery
  if (has("fleet")) {
    const zones = await n(c, `select count(*)::text n from delivery_zone where entity_id = $1 and active`, [entityId]);
    const windows = await n(c, `select count(*)::text n from delivery_window where entity_id = $1 and active`, [entityId]);
    const trucks = await n(c, `select count(*)::text n from vehicle where entity_id = $1 and status = 'active'`, [entityId]);
    add("delivery", [
      { label: "Delivery zones", ok: zones > 0, detail: zones ? String(zones) : null },
      { label: "Delivery windows", ok: windows > 0, detail: windows ? String(windows) : null },
      { label: "Trucks", ok: trucks > 0, detail: trucks ? String(trucks) : null },
    ]);
  }

  // ---- web store / trade portal
  if (has("shop") || has("trade")) {
    const site = await q<{ display_name: string; status: string }>(c, `select display_name, status from shop_site where entity_id = $1 order by created_at limit 1`, [entityId]);
    add("web", [{ label: "Site settings saved", ok: site.length > 0, detail: site[0] ? `${site[0].display_name} (${site[0].status})` : null }]);
  }

  // ---- go-live check (and what ERP setup approved, for the owner to review before going live)
  const setup = await setupApprovals(c, entityId);
  const live = await goneLive(c, entityId);
  const rest = steps.filter((s) => s.status === "todo");
  const ties = opts.tieOuts === false ? [] : await tieOuts(c, tenantId, entityId, L.multiCompany);
  if (opts.tieOuts === false) ties.push({ id: "skipped", label: "Tie-outs", ok: false, detail: "not run here; open the checklist to run them" });
  add("golive", [
    { label: "Every other step done, skipped or optional", ok: !rest.length, detail: rest.length ? `Still to do: ${rest.map((s) => s.title).join(", ")}` : null },
    ...ties.map((t) => ({ label: t.label, ok: t.ok, detail: t.detail })),
  ], { extra: { tieOuts: ties, setupApprovals: setup } });

  const shown = steps;
  const finished = shown.filter((s) => s.status !== "todo").length;
  return {
    company: e.name, layout: L, steps: shown, finished, total: shown.length, complete: finished === shown.length,
    dismissed: dismissed[0] ? { by: dismissed[0].dismissed_by, at: dismissed[0].dismissed_at } : null,
    wentLive: live, setupApprovals: setup,
  };
}

// ======================================================== go-live (0066)

export type SetupApproval = { requestId: string; subjectType: string; subjectId: string; kind: string; title: string; detail: string;
  decision: string; at: string; operator: string | null; session: string; reason: string | null; link: string | null; amountMinor: string | null; pay: string | null };

const SETUP_KIND: Record<string, string> = { vendor: "Vendors", employee: "Employees" };

/** "$18.50 an hour" / "$52,000.00 a year": a hire's pay as the go-live list and the digest show it. */
export const payWords = (minor: string | null, payType: string | null) =>
  minor == null ? null : `${fmt(BigInt(minor))} ${payType === "salary" ? "a year" : "an hour"}`;

/**
 * Everything ERP setup decided for the owner in support mode before go-live
 * (approval steps marked setup_session), one line per request, newest first,
 * each with the record it opens; a hire with their position and pay.
 */
export async function setupApprovals(c: Client, entityId: string): Promise<SetupApproval[]> {
  const rows = await q<{ id: string; subject_type: string; subject_id: string; decision: string; at: string; setup_by: string | null; setup_session: string;
                         setup_reason: string | null; vendor: string | null; person: string | null; position: string | null; rate: string | null; pay_type: string | null }>(c, `
    select distinct on (r.id) r.id, r.subject_type, r.subject_id, s.decision, s.decided_at::text at, s.setup_by, s.setup_session, s.setup_reason,
           (select coalesce(v.dba, v.legal_name) from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = r.entity_id where v.id = r.subject_id) vendor,
           (select e.first_name || ' ' || e.last_name from employee e where e.id = r.subject_id and e.entity_id = r.entity_id) person,
           (select e.position from employee e where e.id = r.subject_id and e.entity_id = r.entity_id) position,
           (select e.base_rate_minor::text from employee e where e.id = r.subject_id and e.entity_id = r.entity_id) rate,
           (select e.pay_type from employee e where e.id = r.subject_id and e.entity_id = r.entity_id) pay_type
      from approval_request r join approval_step s on s.request_id = r.id
     where r.entity_id = $1 and s.setup_session is not null
     order by r.id, s.decided_at desc`, [entityId]);
  return rows.map((r) => {
    const title = r.subject_type === "vendor" ? `New vendor · ${r.vendor ?? "vendor"}` : `New hire · ${r.person ?? "someone"}`;
    const link = r.subject_type === "vendor" ? `vendor:${r.subject_id}` : r.subject_type === "employee" ? `person:${r.subject_id}` : null;
    const who = r.setup_session === "install-token" ? "ERP setup (install-wide API token)" : `ERP setup (${r.setup_by ?? "operator"}), support session ${r.setup_session}`;
    const pay = r.subject_type === "employee" ? payWords(r.rate, r.pay_type) : null;
    return { requestId: r.id, subjectType: r.subject_type, subjectId: r.subject_id, kind: SETUP_KIND[r.subject_type] ?? r.subject_type, title,
      detail: [r.subject_type === "employee" ? r.position : null, pay ? `pay ${pay}` : null, `${r.decision === "rejected" ? "Rejected" : "Approved"} by ${who}`].filter(Boolean).join(" · "),
      decision: r.decision, at: r.at, operator: r.setup_by, session: r.setup_session, reason: r.setup_reason, link, amountMinor: null, pay };
  }).sort((a, b) => b.at.localeCompare(a.at));
}

/** The company's recorded go-live, or null. (A posted sale also counts as live for setup approvals: company_went_live() in SQL.) */
export async function goneLive(c: Client, entityId: string) {
  const r = await q<{ at: string; by: string; kind: string; setup_items: number; reviewed_setup: boolean }>(c, `
    select went_live_at::text at, by_label by, kind, setup_items, reviewed_setup from company_go_live where entity_id = $1`, [entityId]);
  if (r[0]) return { at: r[0].at, by: r[0].by, kind: r[0].kind, setupItems: r[0].setup_items, reviewed: r[0].reviewed_setup, bySale: false };
  const traded = await one<{ t: boolean }>(c, `select company_traded($1) t /* unscoped: the function reads entity_id = $1 */`, [entityId]);
  return traded.t ? { at: null, by: null, kind: "sale", setupItems: 0, reviewed: false, bySale: true } : null;
}

/**
 * The owner presses Go live: the go-live check passes (every step done,
 * skipped or optional, and the tie-outs agree), and, when ERP setup approved
 * anything, the owner ticks that they reviewed it. Recorded once
 * (company_go_live, never changed or removed); from then on ERP setup
 * approves nothing for this company. Never from support mode: the owner does
 * it signed in as themselves.
 */
export async function goLive(c: Client, scope: Scope, x: { reviewed: string[] | null }) {
  need(!(await inSupport(c)), "Go live is the owner's own step, signed in as themselves: ERP setup cannot press it in support mode");
  // One at a time with ERP setup's approvals: the approval-step guard takes this row for share, so an approval in
  // flight finishes first (and is listed below) or waits and then sees the go-live (review of 0066: no write skew).
  await q(c, `select 1 from entity where id = $1 for update /* unscoped: the company row itself */`, [scope.entityId]);
  const rec = await q(c, `select 1 from company_go_live where entity_id = $1`, [scope.entityId]);
  need(!rec.length, "this company has already gone live");
  const d = await checklist(c, scope.tenantId, scope.entityId);
  const g = d.steps.find((s) => s.id === "golive");
  need(d.complete && g && g.status === "done", `the go-live check has not passed yet: ${(g?.checks ?? []).filter((x) => !x.ok).map((x) => x.detail ? `${x.label} (${x.detail})` : x.label).join("; ") || "finish the steps above"}`);
  const items = d.setupApprovals;
  need(!items.length || Array.isArray(x.reviewed), `tick "I've reviewed what ERP setup approved" first: ${items.length} item${items.length === 1 ? "" : "s"} were approved during setup`);
  // The tick covers the list the owner was shown: ERP setup deciding something after it was opened sends them back to it.
  const seen = new Set((x.reviewed ?? []).map(String));
  const unseen = items.filter((i) => !seen.has(i.requestId));
  need(!unseen.length, `ERP setup approved ${unseen.length} more since you opened this list (${unseen.map((i) => i.title).join("; ")}); look over the list again, tick it, then go live`);
  const r = await one<{ id: string; at: string }>(c, `
    insert into company_go_live (tenant_id, entity_id, by_label, by_id, kind, setup_items, reviewed_setup)
    values ($1, $2, $3, $4, 'owner', $5, $6) returning id, went_live_at::text at`,
    [scope.tenantId, scope.entityId, scope.actor.label, scope.actor.id ?? null, items.length, items.length ? true : false]);
  await audit(c, scope, { table: "company_go_live", rowId: r.id, action: "insert",
    after: { setupItems: items.length, reviewed: items.length ? true : false, requests: items.map((i) => i.requestId) },
    reason: items.length ? `went live; the owner reviewed ${items.length} approval${items.length === 1 ? "" : "s"} made by ERP setup` : "went live" });
  return { wentLive: true, at: r.at, setupItems: items.length };
}

// ============================================================ skip, dismiss

export async function skipStep(c: Client, scope: Scope, step: string, reason: string) {
  const def = STEPS.find((s) => s.id === step);
  need(def, "there is no such step on the checklist");
  need(def!.skippable, `${def!.title} cannot be skipped`);
  const why = String(reason ?? "").trim();
  need(why.length >= 5, "say why this step is being skipped, in a few words");
  need(why.length <= 500, "keep the reason under 500 characters");
  const live = await q(c, `select 1 from onboarding_skip where entity_id = $1 and step = $2 and withdrawn_at is null`, [scope.entityId, step]);
  need(!live.length, `${def!.title} is already skipped`);
  const r = await one<{ id: string }>(c, `insert into onboarding_skip (entity_id, step, reason, skipped_by, skipped_by_id) values ($1,$2,$3,$4,$5) returning id`,
    [scope.entityId, step, why, scope.actor.label, scope.actor.id ?? null]);
  await audit(c, scope, { table: "onboarding_skip", rowId: r.id, action: "insert", after: { step }, reason: why });
  return { id: r.id, step };
}

export async function unskipStep(c: Client, scope: Scope, step: string) {
  const r = await q<{ id: string }>(c, `update onboarding_skip set withdrawn_at = now(), withdrawn_by = $3 where entity_id = $1 and step = $2 and withdrawn_at is null returning id`,
    [scope.entityId, step, scope.actor.label]);
  need(r.length, "that step is not skipped");
  await audit(c, scope, { table: "onboarding_skip", rowId: r[0].id, action: "update", after: { withdrawn: true } });
  return { step };
}

export async function dismiss(c: Client, scope: Scope, on: boolean) {
  if (on) {
    const live = await q(c, `select 1 from onboarding_dismissal where entity_id = $1 and withdrawn_at is null`, [scope.entityId]);
    if (live.length) return { dismissed: true };
    const r = await one<{ id: string }>(c, `insert into onboarding_dismissal (entity_id, dismissed_by, dismissed_by_id) values ($1,$2,$3) returning id`,
      [scope.entityId, scope.actor.label, scope.actor.id ?? null]);
    await audit(c, scope, { table: "onboarding_dismissal", rowId: r.id, action: "insert" });
    return { dismissed: true };
  }
  await c.query(`update onboarding_dismissal set withdrawn_at = now(), withdrawn_by = $2 where entity_id = $1 and withdrawn_at is null`, [scope.entityId, scope.actor.label]);
  return { dismissed: false };
}

// ========================================================= company details

export async function saveCompanyDetails(c: Client, scope: Scope, x: { legalName: string; einLast4?: string | null;
  address: { line1?: string; city?: string; postal?: string }; state?: string | null; fiscalYearStartMonth?: number | null; timeZone?: string | null }) {
  const legal = String(x.legalName ?? "").trim();
  need(legal.length >= 2 && legal.length <= 120, "enter the company's legal name, as on its tax filings");
  const ein = String(x.einLast4 ?? "").trim() || null;
  need(!ein || /^\d{4}$/.test(ein), "only the last four digits of the tax id are kept");
  const st = String(x.state ?? "").trim().toUpperCase() || null;
  need(!st || /^[A-Z]{2}$/.test(st), "the state is two letters, as on a postal address");
  const addr = { line1: String(x.address?.line1 ?? "").trim().slice(0, 120), city: String(x.address?.city ?? "").trim().slice(0, 60),
    postal: String(x.address?.postal ?? "").trim().slice(0, 10) };
  const cur = await one<{ fy_end: number }>(c, `select fiscal_year_end_month fy_end from entity where id = $1 and tenant_id = $2 /* unscoped: the company itself */`,
    [scope.entityId, scope.tenantId]);
  let fyEnd = cur.fy_end;
  if (x.fiscalYearStartMonth != null && x.fiscalYearStartMonth !== "" as unknown) {
    const start = Number(x.fiscalYearStartMonth);
    need(Number.isInteger(start) && start >= 1 && start <= 12, "pick the month the fiscal year starts");
    const want = start === 1 ? 12 : start - 1;
    if (want !== fyEnd) {
      const posted = await q(c, `select 1 from journal_entry where entity_id = $1 limit 1`, [scope.entityId]);
      need(!posted.length, "the fiscal year cannot move once entries are posted; ask your accountant about a change of year end");
      fyEnd = want;
    }
  }
  // The company's business time zone (stores without their own use it); empty leaves the fallbacks in clock.ts.
  const tz = x.timeZone === undefined ? undefined : String(x.timeZone ?? "").trim() || null;
  need(!tz || validTimeZone(tz), `${tz} is not a time zone; pick one from the list`);
  await c.query(`update entity set legal_name = $3, ein_last4 = coalesce($4, ein_last4), address = $5, state = $6, fiscal_year_end_month = $7
     where id = $1 and tenant_id = $2 /* unscoped: the company itself */`, [scope.entityId, scope.tenantId, legal, ein, JSON.stringify(addr), st, fyEnd]);
  if (tz !== undefined) await c.query(`update entity set time_zone = $3 where id = $1 and tenant_id = $2 /* unscoped: the company itself */`, [scope.entityId, scope.tenantId, tz]);
  await audit(c, scope, { table: "entity", rowId: scope.entityId, action: "update", after: { legalName: legal, einLast4: ein ? "set" : null, state: st, fiscalYearEndMonth: fyEnd, timeZone: tz } });
  return { ok: true };
}

// ============================================================ opening stock

const STOCKED = ["stock", "configurable", "special_order"];
const pick = (r: Record<string, string>, ...names: string[]) => { for (const x of names) if (r[x]) return r[x]; return ""; };
function cents(s: string): bigint | null {
  const m = /^\$?(\d+)(?:\.(\d{1,2}))?$/.exec(s.replace(/[,\s]/g, ""));
  if (!m) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}

/** The day must fall in one of the company's open periods (a near month opens on its own, see periods.ts). */
async function openDay(c: Client, entityId: string, day: unknown, what: string) {
  need(isDay(day), `give the day ${what} is as of`);
  try { await periodFor(c, { entityId }, day as string); }
  catch (e) { if (e instanceof PeriodError) need(false, e.message); throw e; }
}

/** Opening stock is for before trading starts: once sales are posted, stock comes in through receiving, counts or adjustments. */
async function refuseOnceTrading(c: Client, entityId: string) {
  const sold = await q(c, `select 1 from journal_entry where entity_id = $1 and source_type = 'sale' limit 1`, [entityId]);
  need(!sold.length, "this company has already posted sales, so stock can no longer come in as an opening balance; use a stock count or an adjustment instead");
}

type RowOut = { row: number; sku: string; location: string; bin: string; qty: number | null; unitCostMinor: string | null; serials: string[]; lot: string | null;
  action: "add" | "refuse"; message: string | null; valueMinor: string; addsToExisting: boolean };

/**
 * Read an opening stock CSV and keep it as a preview: nothing moves yet.
 * Columns (any case): sku, location (its code), bin (optional, its code),
 * qty, unit_cost, serial (optional; several separated by ; one per unit), lot (optional).
 */
export async function previewOpeningStock(c: Client, scope: Scope, csv: string, filename: string | null, asOf: string) {
  await refuseOnceTrading(c, scope.entityId);
  await openDay(c, scope.entityId, asOf, "the opening stock");
  const rows = parseCsv(csv);
  need(rows.length, "that file has no rows under its header");
  need(rows.length <= 5000, "that is more than 5,000 rows; split the file");
  const head = Object.keys(rows[0]);
  need(head.some((h) => ["sku", "item", "product"].includes(h)), "the file needs a sku column");
  need(head.some((h) => ["location", "location_code", "store", "warehouse"].includes(h)), "the file needs a location column (the location's code)");
  need(head.some((h) => ["qty", "quantity", "on_hand"].includes(h)), "the file needs a qty column");
  const locs = await q<{ id: string; code: string; kind: string }>(c, `select id, code, kind from location where entity_id = $1 and status = 'active'`, [scope.entityId]);
  const seenKey = new Set<string>(), seenSerial = new Set<string>();
  const out: RowOut[] = [];
  let units = 0, value = 0n;
  for (const [i, r] of rows.entries()) {
    const rowNo = i + 2;
    const sku = pick(r, "sku", "item", "product").toUpperCase(), locCode = pick(r, "location", "location_code", "store", "warehouse").toUpperCase();
    const binCode = pick(r, "bin", "bin_code").toUpperCase();
    const qtyS = pick(r, "qty", "quantity", "on_hand"), costS = pick(r, "unit_cost", "cost", "unit_cost_dollars");
    const serials = pick(r, "serial", "serials", "serial_no", "serial_number").split(/[;|]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    const lotS = pick(r, "lot", "lot_code", "dye_lot");
    const o: RowOut = { row: rowNo, sku, location: locCode, bin: binCode, qty: null, unitCostMinor: null, serials, lot: lotS ? lotS.toUpperCase() : null,
      action: "refuse", message: null, valueMinor: "0", addsToExisting: false };
    const ids: { productId: string | null; locationId: string | null; binId: string | null } = { productId: null, locationId: null, binId: null };
    const refuse = (m: string) => { o.message = m; };
    const p = sku ? await q<{ id: string; name: string; kind: string; serialized: boolean }>(c,
      `select id, name, kind, serialized from product where entity_id = $1 and upper(sku) = $2`, [scope.entityId, sku]) : [];
    const loc = locs.find((l) => l.code.toUpperCase() === locCode);
    const qty = Number(qtyS);
    const cost = costS ? cents(costS) : null;
    if (!sku) refuse("no SKU");
    else if (!p.length) refuse(`no product with SKU ${sku}; add it to the catalog first`);
    else if (!STOCKED.includes(p[0].kind)) refuse(`${p[0].name} is not a stocked product`);
    else if (!locCode) refuse("no location code");
    else if (!loc) refuse(`no location with the code ${locCode}`);
    else if (["web", "in_transit", "dropship", "office"].includes(loc.kind)) refuse(`${locCode} does not hold stock`);
    else if (!qtyS || !Number.isFinite(qty) || qty <= 0) refuse("the quantity must be a number above zero");
    else if (qty > 100000) refuse("the quantity is over 100,000");
    else if (p[0].serialized && !Number.isInteger(qty)) refuse(`${p[0].name} is counted in whole units`);
    else if (!costS) refuse("no unit cost");
    else if (cost === null) refuse(`"${costS}" is not an amount`);
    else if (serials.length && !p[0].serialized) refuse(`${p[0].name} is not tracked by serial number`);
    else if (serials.length && serials.length !== qty) refuse(`${serials.length} serial number${serials.length === 1 ? "" : "s"} for ${qty} unit${qty === 1 ? "" : "s"}; give one per unit`);
    else if (serials.some((s) => !/^[A-Z0-9][A-Z0-9._/#-]{0,59}$/.test(s))) refuse("a serial number is 1 to 60 letters, digits or marks, with no spaces");
    else if (o.lot && !/^[A-Z0-9][A-Z0-9 ._/#-]{0,39}$/.test(o.lot)) refuse("a lot code is 1 to 40 letters, digits or marks");
    else if (serials.some((s) => seenSerial.has(`${p[0].id}|${s}`))) refuse("a serial number appears twice in the file");
    else if (seenKey.has(`${p[0].id}|${loc.id}`)) refuse(`${sku} at ${locCode} appears twice in the file; put it on one row`);
    else {
      ids.productId = p[0].id; ids.locationId = loc.id;
      const done = await q(c, `select 1 from opening_stock_row where entity_id = $1 and product_id = $2 and location_id = $3 and adjustment_id is not null`, [scope.entityId, p[0].id, loc.id]);
      const dupSerial = serials.length ? await q<{ serial_no: string }>(c, `select serial_no from inv_piece where entity_id = $1 and product_id = $2 and serial_no = any($3) limit 1`,
        [scope.entityId, p[0].id, serials]) : [];
      let bin: { id: string }[] = [];
      if (binCode) bin = await q<{ id: string }>(c, `select id from inv_bin where entity_id = $1 and location_id = $2 and upper(code) = $3 and active`, [scope.entityId, loc.id, binCode]);
      if (done.length) refuse(`${sku} at ${locCode} already came in from an opening stock import`);
      else if (dupSerial.length) refuse(`serial ${dupSerial[0].serial_no} is already on a ${p[0].name}`);
      else if (binCode && !bin.length) refuse(`no bin ${binCode} at ${locCode}`);
      else {
        ids.binId = bin[0]?.id ?? null;
        o.action = "add"; o.qty = qty; o.unitCostMinor = cost!.toString();
        // stock or movements already here: bringing this in adds to them, so it is flagged and needs a confirm
        const have = await q<{ on_hand: string }>(c, `select coalesce(sum(on_hand), 0)::text on_hand from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`,
          [scope.entityId, p[0].id, loc.id]);
        const moved = await q(c, `select 1 from inv_move where entity_id = $1 and product_id = $2 and (from_location_id = $3 or to_location_id = $3) limit 1`, [scope.entityId, p[0].id, loc.id]);
        const onHand = Number(have[0]?.on_hand ?? 0);
        if (onHand !== 0 || moved.length) {
          o.addsToExisting = true;
          o.message = onHand !== 0 ? `already has ${onHand} on hand here; this adds to it` : "already has stock movements here; this adds to them";
        }
        const v = BigInt(Math.round(qty * Number(cost)));
        o.valueMinor = v.toString(); units += qty; value += v;
        seenKey.add(`${p[0].id}|${loc.id}`);
        for (const s of serials) seenSerial.add(`${p[0].id}|${s}`);
      }
    }
    if (o.qty === null && Number.isFinite(qty)) o.qty = qty;
    out.push(o);
    (o as RowOut & { ids?: typeof ids }).ids = ids;
  }
  const ok = out.filter((x) => x.action === "add").length;
  const run = await one<{ id: string }>(c, `insert into opening_stock_run (entity_id, filename, as_of, rows_seen, rows_ok, rows_refused, units, value_minor, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [scope.entityId, filename, asOf, out.length, ok, out.length - ok, units, value.toString(), scope.actor.label]);
  for (const o of out) {
    const ids = (o as RowOut & { ids: { productId: string | null; locationId: string | null; binId: string | null } }).ids;
    delete (o as Partial<RowOut & { ids: unknown }>).ids;
    await c.query(`insert into opening_stock_row (run_id, entity_id, row_no, sku, location_code, bin_code, qty, unit_cost_minor, serials, lot, product_id, location_id, bin_id, action, message, adds_to_existing)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [run.id, scope.entityId, o.row, o.sku || null, o.location || null, o.bin || null, o.qty, o.unitCostMinor, o.serials, o.lot,
       ids.productId, ids.locationId, ids.binId, o.action, o.message, o.addsToExisting]);
  }
  return { runId: run.id, asOf, seen: out.length, ok, refused: out.length - ok, addsToExisting: out.filter((x) => x.addsToExisting).length,
    units, valueMinor: value.toString(), rows: out };
}

/**
 * Bring a previewed opening stock file in. Each row is an opening-balance
 * stock adjustment at the row's unit cost (Dr 1300 / Cr 3000). A row that has
 * gone bad since the preview is refused on its own; the rest go in.
 */
export async function applyOpeningStock(c: Client, scope: Scope, runId: string, opts: { confirm?: boolean } = {}) {
  const run = await q<{ id: string; status: string; as_of: string }>(c, `select id, status, as_of::text from opening_stock_run where id = $1 and entity_id = $2 for update`, [runId, scope.entityId]);
  need(run.length, "no such opening stock import");
  need(run[0].status === "previewed", "that import was already brought in");
  await refuseOnceTrading(c, scope.entityId);
  await openDay(c, scope.entityId, run[0].as_of, "the opening stock");
  const flagged = await q<{ n: string }>(c, `select count(*)::text n from opening_stock_row where run_id = $1 and entity_id = $2 and action = 'add' and adds_to_existing`, [runId, scope.entityId]);
  const nf = Number(flagged[0].n);
  need(!nf || opts.confirm === true, `${nf} row${nf === 1 ? " adds" : "s add"} to stock already at ${nf === 1 ? "its location" : "their locations"}; confirm to bring ${nf === 1 ? "it" : "them"} in on top`);
  const rows = await q<{ id: string; row_no: number; sku: string; location_code: string; qty: string; unit_cost_minor: string; serials: string[]; lot: string | null;
    product_id: string; location_id: string; bin_id: string | null }>(c, `select id, row_no, sku, location_code, qty, unit_cost_minor, serials, lot, product_id, location_id, bin_id
      from opening_stock_row where run_id = $1 and entity_id = $2 and action = 'add' order by row_no`, [runId, scope.entityId]);
  let added = 0, value = 0n;
  const problems: { row: number; problem: string }[] = [];
  for (const r of rows) {
    await c.query("savepoint opening_stock_row");
    try {
      const done = await q(c, `select 1 from opening_stock_row where entity_id = $1 and product_id = $2 and location_id = $3 and adjustment_id is not null`, [scope.entityId, r.product_id, r.location_id]);
      need(!done.length, `${r.sku} at ${r.location_code} already came in from an opening stock import`);
      const adj = await inventory.adjust(c, scope, { locationId: r.location_id, productId: r.product_id, qty: Number(r.qty), reasonCode: "opening_balance",
        binId: r.bin_id, unitCostMinor: BigInt(r.unit_cost_minor), serials: r.serials, lot: r.lot, note: `Opening stock import, row ${r.row_no}`, postOn: run[0].as_of });
      await c.query(`update opening_stock_row set adjustment_id = $3 where id = $1 and entity_id = $2`, [r.id, scope.entityId, adj.id]);
      await c.query("release savepoint opening_stock_row");
      added++; value += adj.valueMinor;
    } catch (e) {
      await c.query("rollback to savepoint opening_stock_row");
      // another import brought this SKU in at this place at the same moment: say so plainly, not the constraint's name
      const msg = (e as { code?: string; constraint?: string }).code === "23505" && (e as { constraint?: string }).constraint === "opening_stock_row_once"
        ? `${r.sku} at ${r.location_code} already came in from an opening stock import` : (e as Error).message;
      problems.push({ row: r.row_no, problem: msg });
      await c.query(`update opening_stock_row set action = 'refuse', message = $3 where id = $1 and entity_id = $2`, [r.id, scope.entityId, msg]);
    }
  }
  await c.query(`update opening_stock_run set status = 'applied', applied_by = $3, applied_at = now(), rows_ok = $4, rows_refused = rows_seen - $4, value_minor = $5
    where id = $1 and entity_id = $2`, [runId, scope.entityId, scope.actor.label, added, value.toString()]);
  await audit(c, scope, { table: "opening_stock_run", rowId: runId, action: "transition", after: { status: "applied", added, value: value.toString() } });
  return { added, valueMinor: value.toString(), problems };
}

export async function openingStockRuns(c: Client, entityId: string) {
  return q(c, `select id, filename, as_of::text, status, rows_seen, rows_ok, rows_refused, units::text, value_minor::text, created_by, created_at, applied_by, applied_at
    from opening_stock_run where entity_id = $1 order by created_at desc limit 20`, [entityId]);
}

// ===================================================== opening bank balance

/** A bank account's balance on the day the books start: Dr its cash account / Cr 3000 (an overdraft the other way). Once per account. */
export async function openingBankBalance(c: Client, scope: Scope, x: { bankAccountId: string; asOf: string; amountMinor: bigint }) {
  await openDay(c, scope.entityId, x.asOf, "the balance");
  need(x.amountMinor !== 0n, "give the balance; a zero balance needs no entry");
  const b = await q<{ id: string; name: string; code: string; status: string }>(c, `select b.id, b.name, g.code, b.status from bank_account b join gl_account g on g.id = b.gl_account_id
     where b.id = $1 and b.entity_id = $2`, [x.bankAccountId, scope.entityId]);
  need(b.length, "no such bank account in this company");
  need(b[0].status === "active", `${b[0].name} is not active`);
  const have = await q(c, `select 1 from opening_bank_balance where entity_id = $1 and bank_account_id = $2`, [scope.entityId, x.bankAccountId]);
  need(!have.length, `${b[0].name} already has its opening balance; correct it with a journal entry in Books`);
  const abs = x.amountMinor < 0n ? -x.amountMinor : x.amountMinor;
  let je: string;
  try {
    je = await post(c, scope, { date: x.asOf, sourceType: "opening", sourceId: x.bankAccountId, description: `Opening balance, ${b[0].name}`,
      lines: x.amountMinor > 0n
        ? [{ code: b[0].code, debit: abs, bankAccountId: x.bankAccountId }, { code: "3000", credit: abs }]
        : [{ code: "3000", debit: abs }, { code: b[0].code, credit: abs, bankAccountId: x.bankAccountId }] });
  } catch (e) { if (e instanceof PostingError) throw new OnboardingError(e.message); throw e; }
  let r: { id: string };
  try {
    r = await one<{ id: string }>(c, `insert into opening_bank_balance (entity_id, bank_account_id, as_of, amount_minor, journal_entry_id, entered_by)
      values ($1,$2,$3,$4,$5,$6) returning id`, [scope.entityId, x.bankAccountId, x.asOf, x.amountMinor.toString(), je, scope.actor.label]);
  } catch (e) {
    // entered twice at the same moment: the unique key keeps one; the whole transaction (with its posting) rolls back
    if ((e as { code?: string }).code === "23505") throw new OnboardingError(`${b[0].name} already has its opening balance; correct it with a journal entry in Books`);
    throw e;
  }
  await audit(c, scope, { table: "opening_bank_balance", rowId: r.id, action: "insert", after: { bankAccountId: x.bankAccountId, asOf: x.asOf, amount: x.amountMinor.toString() } });
  return { id: r.id, journalEntryId: je };
}

export async function openingBanks(c: Client, entityId: string) {
  return q(c, `select b.id, b.name, b.purpose, b.account_last4, o.as_of::text, o.amount_minor::text, o.entered_by
    from bank_account b left join opening_bank_balance o on o.bank_account_id = b.id and o.entity_id = b.entity_id
   where b.entity_id = $1 and b.status = 'active' order by b.name`, [entityId]);
}
