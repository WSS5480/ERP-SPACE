// The service catalog: every user-facing service a company can switch on or
// off, in plain words, with what it belongs under and which screens it owns.
//
// A switch HIDES a service; it never stops it. Its screens, Home cards and
// menu entries go away for that company, but its data stays, its scheduled
// jobs and postings keep running, and its API answers the services that use
// it. Turning it back on loses nothing.
//
// What a company sees is computed here, in this order:
//   1. its own switch (setup.enabledModules: a company with no choices sees all)
//   2. every parent's switch: a parent off hides its children
//   3. the layout rule: Group needs a second company, store orders a second
//      location. Computed from the client's companies and the company's
//      locations; the owner may override it ('admin.layout': single | multi).

import { q, one, type Client } from "./db.ts";
import { MODULE_IDS, PACKS, enabledModules, setModule, setting, putSetting, type ModuleId } from "./setup.ts";

export class ServiceError extends Error {}
const need = (c: unknown, m: string): void => { if (!c) throw new ServiceError(m); };

export type ServiceGroup = "Back office" | "Retail" | "Operations" | "Setup";
export type Service = {
  id: ModuleId;
  name: string;
  description: string;
  group: ServiceGroup;
  parent: ModuleId | null;
  screens: string[];
  /** hidden unless the client has a second company / the company a second location */
  needs?: "multi_company" | "multi_store";
  /** services this one reads from or posts through (shown as "works with"; never enforced) */
  uses?: ModuleId[];
};

export const SERVICES: Service[] = [
  // ---------------------------------------------------------------- back office
  { id: "ar", name: "Receivables", group: "Back office", parent: null, screens: ["ar"],
    description: "House accounts, statements, aging, collections, financing and write-offs." },
  { id: "settlements", name: "Finance settlements", group: "Back office", parent: "ar", screens: ["settlements"],
    description: "Match finance companies' remittance files to financed sales: fees, holdbacks, chargebacks." },
  { id: "memos", name: "Debit memos", group: "Back office", parent: null, screens: ["memos"],
    description: "Credits on vendor accounts for returns, shortages and damage, applied to bills." },
  { id: "payroll", name: "Payroll", group: "Back office", parent: null, screens: ["payroll"],
    description: "Pay groups, timecards, the register, approval and release, posting to the books." },
  { id: "workforce", name: "Time and commissions", group: "Back office", parent: null, screens: ["workforce"], uses: ["payroll"],
    description: "Time clock, shifts and commission plans feeding payroll." },
  { id: "timeoff", name: "Time off", group: "Back office", parent: "workforce", screens: ["timeoff"],
    description: "Ask for time off, balances and accruals, holidays and store closures." },
  { id: "reports", name: "Reports", group: "Back office", parent: null, screens: ["reports"],
    description: "Report creator: curated datasets, saved and shared reports, schedules, CSV and Excel." },
  { id: "group", name: "Group accounting", group: "Back office", parent: null, screens: ["group"], needs: "multi_company",
    description: "The client's companies together: combined statements, inter-company billing, net-to-zero and settle." },
  // --------------------------------------------------------------------- retail
  { id: "catalog", name: "Catalog", group: "Retail", parent: null, screens: ["catalog"],
    description: "Products, options for customizing, vendor catalog imports, price lists and price tags." },
  { id: "sectionals", name: "Sectionals", group: "Retail", parent: "catalog", screens: ["sectionals"], uses: ["pos", "shop"],
    description: "Sectional builder, fabric and leather grades, swatches and option rules." },
  { id: "purchasing", name: "Buying", group: "Retail", parent: null, screens: ["purchasing"], uses: ["catalog", "inventory"],
    description: "Open-to-buy, order forms, special-order POs, reorder suggestions, sending POs to vendors." },
  { id: "storeorders", name: "Store orders", group: "Retail", parent: "purchasing", screens: ["storeorders"], needs: "multi_store",
    description: "Stores ask the warehouse or buyer for stock; someone else approves." },
  { id: "pos", name: "Point of sale", group: "Retail", parent: null, screens: ["pos"], uses: ["catalog", "inventory", "ar"],
    description: "Quotes, sales, deposits, layaway, split tenders, returns and the drawer close." },
  { id: "aisle", name: "Endless aisle", group: "Retail", parent: "pos", screens: ["aisle"], uses: ["shop"],
    description: "Price and build carts on the sales floor from everything a vendor makes." },
  { id: "shop", name: "Web store", group: "Retail", parent: null, screens: ["shop"], uses: ["catalog", "inventory"],
    description: "The online store with the product customizer, pickup and delivery." },
  { id: "crm", name: "Customers", group: "Retail", parent: null, screens: ["crm"],
    description: "Customer profiles, households, consent and history across every door." },
  { id: "leads", name: "Leads", group: "Retail", parent: "crm", screens: ["leads"],
    description: "The lead tracker and pipeline, with a rotation for walk-ins." },
  { id: "myday", name: "My day", group: "Retail", parent: "crm", screens: ["myday"],
    description: "A salesperson's calls, tasks and appointments for today." },
  { id: "marketing", name: "Marketing", group: "Retail", parent: "crm", screens: ["marketing"],
    description: "Campaigns, coupons and customer lists." },
  { id: "trade", name: "Trade accounts", group: "Retail", parent: "crm", screens: ["trade"], uses: ["shop", "ar"],
    description: "Designer and contractor accounts, trade pricing and the trade portal." },
  { id: "projects", name: "Room projects", group: "Retail", parent: "crm", screens: ["projects"],
    description: "Rooms, photos, budgets and the products considered, with follow-ups." },
  // ----------------------------------------------------------------- operations
  { id: "inventory", name: "Warehouse", group: "Operations", parent: null, screens: ["inventory"],
    description: "Bins, piece tracking, receiving, transfers, counts, damage and claims." },
  { id: "wms", name: "Containers and prep", group: "Operations", parent: "inventory", screens: ["wms"], uses: ["purchasing"],
    description: "Import containers and freight, goods in transit, the prep queue." },
  { id: "lots", name: "Serials and lots", group: "Operations", parent: "inventory", screens: ["lots"],
    description: "Serial numbers and dye lots, matched on orders and searchable for recalls." },
  { id: "labels", name: "Labels", group: "Operations", parent: "inventory", screens: ["labels"],
    description: "Carton, bin and price-tag labels, to a network printer or a print page." },
  { id: "asis", name: "As-is grades", group: "Operations", parent: "inventory", screens: ["asis"],
    description: "Condition grades and prices for floor models and returned pieces." },
  { id: "fleet", name: "Delivery", group: "Operations", parent: null, screens: ["fleet", "myroute"], uses: ["inventory"],
    description: "Trucks, delivery windows, route building, the driver's app and proof of delivery." },
  { id: "loading", name: "Loading dock", group: "Operations", parent: "fleet", screens: ["loading"],
    description: "Load trucks last stop first, piece by piece." },
  { id: "haulaway", name: "Haul-away", group: "Operations", parent: "fleet", screens: ["haulaway"],
    description: "What crews take away from customers, and where it went." },
  { id: "service", name: "Service and repair", group: "Operations", parent: null, screens: ["service"],
    description: "Service tickets from the first call to the fix: parts, visits, who pays." },
  // ---------------------------------------------------------------------- setup
  { id: "salestax", name: "Sales tax", group: "Setup", parent: null, screens: ["salestax"],
    description: "Jurisdictions, dated rates, where they apply, exemption certificates and filing." },
  { id: "edi", name: "Vendor EDI", group: "Setup", parent: "purchasing", screens: ["edi"],
    description: "X12 trading partners: 850 orders, 855, 856, 810 and 832 catalogs." },
];

/** Screens that are always there: the books themselves, and setting the company up. */
export const CORE_SCREENS = ["home", "approvals", "payables", "books", "chart", "cash", "recon", "feeds", "setup", "business", "services", "connections", "checklist"];

/** Screens that follow who signed in (an operator, a customer account), not a service switch or a role. */
export const PLATFORM_SCREENS = ["operator", "account"];

export const SCREEN_SERVICE: Record<string, ModuleId | null> = Object.fromEntries([
  ...CORE_SCREENS.map((s) => [s, null]),
  ...PLATFORM_SCREENS.map((s) => [s, null]),
  ...SERVICES.flatMap((s) => s.screens.map((x) => [x, s.id])),
]);

export const serviceById = (id: string) => SERVICES.find((s) => s.id === id);
export const childrenOf = (id: string) => SERVICES.filter((s) => s.parent === id);
function ancestors(id: string): ModuleId[] {
  const out: ModuleId[] = [];
  for (let p = serviceById(id)?.parent ?? null; p; p = serviceById(p)?.parent ?? null) out.push(p);
  return out;
}
function descendants(id: string): ModuleId[] {
  return childrenOf(id).flatMap((c) => [c.id, ...descendants(c.id)]);
}

// -------------------------------------------------------------- presets --

export type Preset = { id: string; name: string; blurb: string; pack: string | null; services: ModuleId[] };
const BASE: ModuleId[] = ["ar", "memos", "payroll", "workforce", "timeoff", "reports", "salestax"];
export const PRESETS: Preset[] = [
  { id: "single_store", name: "Single store retail", pack: "retail",
    blurb: "One store selling over the counter and online: catalog, buying, stock, the register, customers and receivables.",
    services: [...BASE, "catalog", "purchasing", "inventory", "labels", "pos", "shop", "crm", "leads", "myday", "marketing"] },
  { id: "multi_store", name: "Multi-store retail", pack: "retail",
    blurb: "Several stores and a warehouse: everything a single store has, plus store orders, vendor EDI, serials, the endless aisle and group accounting.",
    services: [...BASE, "catalog", "purchasing", "storeorders", "edi", "inventory", "labels", "lots", "pos", "aisle", "shop", "crm", "leads", "myday", "marketing", "group", "settlements"] },
  { id: "furniture", name: "Furniture full suite", pack: "furniture",
    blurb: "Every service: special orders and sectionals, containers and prep, white-glove delivery with loading and haul-away, trade accounts, service.",
    services: [...MODULE_IDS] },
  { id: "back_office", name: "Back office only", pack: null,
    blurb: "The books, payables, receivables, payroll and reports; no stores, stock or delivery.",
    services: [...BASE, "group"] },
  { id: "delivery", name: "Delivery company", pack: "trucking",
    blurb: "Trucks and routes, loading and haul-away, service visits, receivables and payroll; no stores or catalog.",
    services: [...BASE, "fleet", "loading", "haulaway", "service", "group"] },
];

// --------------------------------------------------------------- layout --

export type LayoutMode = "auto" | "single" | "multi";
export type Layout = { companies: number; locations: number; mode: LayoutMode; multiCompany: boolean; multiStore: boolean; single: boolean };

/** One company with one location is a single store. Counted, unless the owner set 'admin.layout'. */
export async function layoutOf(c: Client, entityId: string): Promise<Layout> {
  const n = await one<{ companies: string; locations: string }>(c, `
    select (select count(*) from entity e2 where e2.tenant_id = e.tenant_id and e2.status <> 'closed') companies,
           (select count(*) from location l where l.entity_id = e.id and l.status = 'active' and l.kind not in ('web','office')) locations
      from entity e where e.id = $1 /* unscoped: the company and its client's open companies */`, [entityId]);
  const companies = Number(n.companies), locations = Number(n.locations);
  const raw = await setting<string>(c, entityId, "admin.layout", "auto");
  const mode: LayoutMode = raw === "single" || raw === "multi" ? raw : "auto";
  const multiCompany = mode === "multi" ? true : mode === "single" ? false : companies > 1;
  const multiStore = mode === "multi" ? true : mode === "single" ? false : locations > 1;
  return { companies, locations, mode, multiCompany, multiStore, single: !multiCompany && !multiStore };
}

export async function setLayout(c: Client, entityId: string, mode: string, by: string) {
  need(["auto", "single", "multi"].includes(mode), "choose automatic, single store or several stores");
  await putSetting(c, entityId, "admin.layout", mode, by);
  return layoutOf(c, entityId);
}

// ------------------------------------------------------------ effective --

export type ServiceState = {
  switches: Record<ModuleId, boolean>;
  on: ModuleId[];
  /** why a service that is switched on is hidden anyway */
  hidden: Partial<Record<ModuleId, string>>;
  layout: Layout;
};

export function computeState(switchesOn: readonly string[], layout: Layout): ServiceState {
  const switches = Object.fromEntries(MODULE_IDS.map((m) => [m, switchesOn.includes(m)])) as Record<ModuleId, boolean>;
  const hidden: Partial<Record<ModuleId, string>> = {};
  const on: ModuleId[] = [];
  for (const m of MODULE_IDS) {
    if (!switches[m]) continue;
    const off = ancestors(m).find((p) => !switches[p]);
    const s = serviceById(m);
    if (off) hidden[m] = `${serviceById(off)?.name ?? off} is off`;
    else if (s?.needs === "multi_company" && !layout.multiCompany) hidden[m] = "only one company here";
    else if (s?.needs === "multi_store" && !layout.multiStore) hidden[m] = "only one store here";
    else on.push(m);
  }
  return { switches, on, hidden, layout };
}

/** What a company shows: its switches, less children of a parent that is off, less what its layout does not need. */
export async function effectiveServices(c: Client, entityId: string): Promise<ServiceState> {
  return computeState(await enabledModules(c, entityId), await layoutOf(c, entityId));
}

/**
 * The screens a person's menu offers: on for the company, and theirs by role.
 * roleScreens is the page's own map (server/app.js ROLE_SCREENS); the owner sees every screen that is on.
 */
export function navScreens(state: Pick<ServiceState, "on">, roles: readonly string[], roleScreens: Record<string, string[]>, screens: string[] = Object.keys(SCREEN_SERVICE).filter((s) => !PLATFORM_SCREENS.includes(s))): string[] {
  const owner = roles.includes("owner");
  const mine = new Set(["home", ...roles.flatMap((r) => roleScreens[r] ?? [])]);
  return screens.filter((s) => {
    const svc = SCREEN_SERVICE[s];
    if (svc && !state.on.includes(svc)) return false;
    return owner || mine.has(s);
  });
}

// -------------------------------------------------------------- changes --

/**
 * Switch a service in some companies. Turning one off leaves its children's
 * own switches alone (they hide with it and come back with it). Turning one on
 * also turns on the parents it needs, so the screen actually appears.
 */
export async function setService(c: Client, entityIds: string[], id: string, enabled: boolean, by: string) {
  const s = serviceById(id);
  need(s, `there is no service called ${id}`);
  const changed: string[] = [];
  for (const e of entityIds) {
    await setModule(c, e, id, enabled, by);
    if (enabled) for (const p of ancestors(id)) await setModule(c, e, p, true, by);
    changed.push(e);
  }
  return { service: id, enabled, companies: changed.length, alsoOn: enabled ? ancestors(id) : [] };
}

/** A preset sets every switch: on for the services it lists, off for the rest. Data is never touched. */
export async function applyPresetSwitches(c: Client, entityId: string, presetId: string, by: string) {
  const p = PRESETS.find((x) => x.id === presetId);
  need(p, "pick one of the presets");
  for (const m of MODULE_IDS) await setModule(c, entityId, m, p!.services.includes(m), `preset ${p!.id} (${by})`);
  return p!;
}

/** What still has open work, per service: switching it off would hide records someone has to finish. */
const OPEN: Partial<Record<ModuleId, [what: string, sql: string]>> = {
  fleet: ["open deliveries", `select count(*) n from delivery_stop where entity_id = $1 and status in ('scheduled','arrived')`],
  storeorders: ["store orders not yet decided", `select count(*) n from store_order where entity_id = $1 and status in ('draft','submitted')`],
  purchasing: ["open purchase orders", `select count(*) n from purchase_order where entity_id = $1 and status = 'open'`],
  edi: ["live trading partners", `select count(*) n from edi_partner where entity_id = $1 and edi_enabled`],
  ar: ["unpaid invoices", `select count(*) n from customer_invoice where entity_id = $1 and status = 'open'`],
  settlements: ["financed sales waiting on funding", `select count(*) n from financed_sale where entity_id = $1 and status = 'awaiting_funding'`],
  pos: ["open store orders", `select count(*) n from sales_order where entity_id = $1 and channel <> 'web' and status in ('open','fulfilling')`],
  shop: ["open web orders", `select count(*) n from sales_order where entity_id = $1 and channel = 'web' and status in ('open','fulfilling')`],
  service: ["open service tickets", `select count(*) n from service_ticket where entity_id = $1 and status not in ('resolved','closed','cancelled')`],
  trade: ["active trade accounts", `select count(*) n from trade_account where entity_id = $1 and status = 'active'`],
  timeoff: ["time-off requests waiting", `select count(*) n from leave_request where entity_id = $1 and status = 'requested'`],
};

export type OpenWork = { service: ModuleId; name: string; what: string; count: number };

/** Of these services, the ones with open records in this company. */
export async function openRecords(c: Client, entityId: string, ids: readonly string[]): Promise<OpenWork[]> {
  const out: OpenWork[] = [];
  for (const id of ids) {
    const o = OPEN[id as ModuleId];
    if (!o) continue;
    const n = Number((await one<{ n: string }>(c, o[1], [entityId])).n);
    if (n > 0) out.push({ service: id as ModuleId, name: serviceById(id)?.name ?? id, what: o[0], count: n });
  }
  return out;
}

/** What a preset would switch off that still has open records, in each of these companies. */
export async function presetCheck(c: Client, entityIds: { id: string; name: string }[], presetId: string) {
  const p = PRESETS.find((x) => x.id === presetId);
  need(p, "pick one of the presets");
  const out: (OpenWork & { company: string })[] = [];
  for (const e of entityIds) {
    const st = await effectiveServices(c, e.id);
    const goingOff = MODULE_IDS.filter((m) => st.switches[m] && !p!.services.includes(m));
    for (const w of await openRecords(c, e.id, goingOff)) out.push({ ...w, company: e.name });
  }
  return out;
}

export function presetPack(presetId: string) {
  const p = PRESETS.find((x) => x.id === presetId);
  return p?.pack ? PACKS.find((x) => x.id === p.pack) ?? null : null;
}

/** The Services screen: one card per service, grouped, with its switch, what it belongs to and what depends on it. */
export async function servicesView(c: Client, entityId: string, tenantId: string) {
  const st = await effectiveServices(c, entityId);
  const companies = await q<{ id: string; name: string }>(c,
    `select id, name from entity where tenant_id = $1 and status <> 'closed' order by name /* unscoped: the client's companies, for "apply to all" */`, [tenantId]);
  return {
    services: SERVICES.map((s) => ({
      id: s.id, name: s.name, description: s.description, group: s.group, parent: s.parent, needs: s.needs ?? null,
      parentName: s.parent ? serviceById(s.parent)?.name ?? s.parent : null,
      children: descendants(s.id).map((d) => serviceById(d)!.name),
      usedBy: SERVICES.filter((x) => x.uses?.includes(s.id)).map((x) => x.name),
      screens: s.screens,
      switchOn: st.switches[s.id], showing: st.on.includes(s.id), hiddenWhy: st.hidden[s.id] ?? null,
    })),
    core: CORE_SCREENS,
    presets: PRESETS.map((p) => ({ id: p.id, name: p.name, blurb: p.blurb, pack: p.pack, services: p.services })),
    layout: st.layout,
    companies,
  };
}
