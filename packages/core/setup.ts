// Industry packs: what makes the ERP work out of the box for a furniture
// store, a general retailer, a rent-to-own chain, an appliance dealer or a
// trucking company. A pack is data -- labels, modules, accounts, reasons and
// default settings -- applied to one company. It only ever adds.

import { adoptOpeningBalances } from "./ar.ts";
import { q, one, type Client, type Scope } from "./db.ts";
import { post } from "./posting.ts";
import { installStarters } from "./reports.ts";

export class SetupError extends Error {}

export const MODULE_IDS = ["catalog", "purchasing", "inventory", "pos", "ar", "workforce", "fleet", "shop", "crm", "service", "reports"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

type Account = [code: string, name: string, type: "asset" | "liability" | "equity" | "revenue" | "expense", normal: "D" | "C"];

/** Accounts any retail module may post to. Every retail pack carries them. */
const RETAIL_ACCOUNTS: Account[] = [
  ["1050", "Undeposited funds", "asset", "D"],
  ["1100", "Accounts receivable, customers", "asset", "D"],
  ["1110", "Receivable from finance companies", "asset", "D"],
  ["1190", "Allowance for doubtful accounts", "asset", "C"],
  ["1300", "Merchandise inventory", "asset", "D"],
  ["1150", "Vendor chargebacks receivable", "asset", "D"],
  ["1310", "Inventory in transit", "asset", "D"],
  ["2050", "Accrued liabilities / received not invoiced", "liability", "C"],
  ["2100", "Sales tax payable", "liability", "C"],
  ["2160", "Commissions payable", "liability", "C"],
  ["2300", "Customer deposits", "liability", "C"],
  ["2310", "Gift cards outstanding", "liability", "C"],
  ["2320", "Store credit outstanding", "liability", "C"],
  ["3000", "Owner equity", "equity", "C"],
  ["4000", "Merchandise sales", "revenue", "C"],
  ["4020", "Fees and other revenue", "revenue", "C"],
  ["4030", "Delivery and setup revenue", "revenue", "C"],
  ["4040", "Protection plan revenue", "revenue", "C"],
  ["4050", "Service revenue", "revenue", "C"],
  ["4900", "Sales returns and allowances", "revenue", "D"],
  ["4910", "Sales discounts", "revenue", "D"],
  ["5000", "Cost of goods sold", "expense", "D"],
  ["5030", "Freight in", "expense", "D"],
  ["5040", "Inventory shrink and damage", "expense", "D"],
  ["6130", "Sales commissions", "expense", "D"],
  ["6150", "Warranty and service expense", "expense", "D"],
  ["6155", "Service labor applied", "expense", "C"],
  ["6300", "Delivery and fleet", "expense", "D"],
  ["6310", "Fuel", "expense", "D"],
  ["6800", "Other operating", "expense", "D"],
  ["6900", "Bad debt expense", "expense", "D"],
  ["6910", "Card and finance fees", "expense", "D"],
];

type Reason = [kind: string, code: string, label: string, restock?: boolean];

const RETAIL_REASONS: Reason[] = [
  ["return", "changed_mind", "Changed their mind", true],
  ["return", "wrong_item", "Wrong item or color sent", true],
  ["return", "damaged_delivery", "Damaged in delivery", false],
  ["return", "defective", "Defective / manufacturer fault", false],
  ["return", "comfort", "Comfort exchange", true],
  ["adjustment", "found", "Found in count", undefined],
  ["adjustment", "missing", "Missing in count", undefined],
  ["adjustment", "correction", "Receiving correction", undefined],
  ["damage", "warehouse", "Damaged in warehouse", undefined],
  ["damage", "transit", "Damaged in transit from vendor", undefined],
  ["damage", "showroom", "Showroom wear", undefined],
  ["discount", "price_match", "Price match", undefined],
  ["discount", "floor_model", "Floor model / as-is", undefined],
  ["discount", "manager", "Manager discretion", undefined],
  ["discount", "bundle", "Package / bundle", undefined],
  ["write_off", "skip", "Customer skipped", undefined],
  ["write_off", "bankruptcy", "Bankruptcy", undefined],
  ["write_off", "small_balance", "Small balance", undefined],
  ["delivery_exception", "not_home", "Nobody home", undefined],
  ["delivery_exception", "refused", "Customer refused", undefined],
  ["delivery_exception", "damaged", "Item damaged", undefined],
  ["delivery_exception", "wont_fit", "Will not fit", undefined],
  ["void", "entry_error", "Entered in error", undefined],
];

export type Pack = {
  id: string;
  name: string;
  blurb: string;
  vertical: "furniture" | "retail" | "rto" | "trucking" | "services";
  labels: { location: string; profitObject: string; aging: string };
  modules: ModuleId[];
  accounts: Account[];
  reasons: Reason[];
  settings: Record<string, unknown>;
};

export const PACKS: Pack[] = [
  {
    id: "furniture",
    name: "Furniture and home furnishings",
    blurb: "Showrooms and a distribution center, special orders and customizable upholstery, deposits and financing, white-glove delivery with routing, commissioned sales staff.",
    vertical: "furniture",
    labels: { location: "Store", profitObject: "Store", aging: "Receivables" },
    modules: ["catalog", "purchasing", "inventory", "pos", "ar", "workforce", "fleet", "shop", "crm", "service", "reports"],
    accounts: RETAIL_ACCOUNTS,
    reasons: RETAIL_REASONS,
    settings: {
      "pos.discount_limit_bps": 1000,           // over 10% needs a manager
      "pos.deposit_min_bps": 3000,              // special orders need 30% down
      "pos.quote_days": 14,
      "pos.layaway_days": 90,
      "pos.tenders": ["cash", "card", "check", "financing", "gift_card", "store_credit"],
      "fleet.service_minutes": { base: 15, per_piece: 5, per_stair_flight: 10 },
      "fleet.windows": [["08:00", "12:00"], ["12:00", "16:00"], ["16:00", "20:00"]],
      "fleet.delivery_fee_minor": 9900,
      "workforce.commission": { basis: "margin", rate_bps: 800, earned_on: "delivered" },
      "ar.late_fee": { rate_bps: 500, min_minor: 1000, grace_days: 10 },
      "ar.aging_buckets": [0, 30, 60, 90],
      "catalog.special_order_lead_days": 42,
      "service.sla_hours": { urgent: 24, high: 48, normal: 120, low: 240 },
      "service.labor_rate_minor": 3000,
    },
  },
  {
    id: "appliance",
    name: "Appliances and electronics",
    blurb: "Serialized stock, manufacturer warranties and protection plans, install and haul-away on delivery, financing.",
    vertical: "retail",
    labels: { location: "Store", profitObject: "Store", aging: "Receivables" },
    modules: ["catalog", "purchasing", "inventory", "pos", "ar", "workforce", "fleet", "shop", "crm", "service", "reports"],
    accounts: RETAIL_ACCOUNTS,
    reasons: RETAIL_REASONS,
    settings: {
      "pos.discount_limit_bps": 500,
      "pos.deposit_min_bps": 0,
      "pos.quote_days": 7,
      "pos.tenders": ["cash", "card", "check", "financing", "gift_card", "store_credit"],
      "fleet.service_minutes": { base: 25, per_piece: 10, per_stair_flight: 10 },
      "fleet.windows": [["08:00", "12:00"], ["12:00", "17:00"]],
      "fleet.delivery_fee_minor": 7900,
      "workforce.commission": { basis: "sale", rate_bps: 300, earned_on: "delivered" },
      "ar.late_fee": { rate_bps: 500, min_minor: 1000, grace_days: 10 },
      "service.sla_hours": { urgent: 24, high: 48, normal: 72, low: 168 },
      "service.labor_rate_minor": 3500,
    },
  },
  {
    id: "retail",
    name: "General retail",
    blurb: "Cash-and-carry stores with a web store; no delivery fleet or installment contracts unless you turn them on.",
    vertical: "retail",
    labels: { location: "Store", profitObject: "Store", aging: "Receivables" },
    modules: ["catalog", "purchasing", "inventory", "pos", "ar", "workforce", "shop", "crm", "reports"],
    accounts: RETAIL_ACCOUNTS,
    reasons: RETAIL_REASONS.filter(([k]) => k !== "delivery_exception"),
    settings: {
      "pos.discount_limit_bps": 1500,
      "pos.deposit_min_bps": 0,
      "pos.quote_days": 7,
      "pos.tenders": ["cash", "card", "gift_card", "store_credit"],
      "workforce.commission": { basis: "none" },
      "ar.late_fee": { rate_bps: 0, min_minor: 0, grace_days: 0 },
    },
  },
  {
    id: "rto",
    name: "Rent-to-own",
    blurb: "Stores carrying back balances, delivery and pickup routes, a catalog and purchasing for rental merchandise. Agreements stay in your rental system; this pack reads it.",
    vertical: "rto",
    labels: { location: "Store", profitObject: "Store", aging: "Back balances" },
    modules: ["catalog", "purchasing", "inventory", "ar", "workforce", "fleet", "service", "reports"],
    accounts: RETAIL_ACCOUNTS,
    reasons: RETAIL_REASONS,
    settings: {
      "fleet.service_minutes": { base: 15, per_piece: 5, per_stair_flight: 10 },
      "fleet.windows": [["09:00", "13:00"], ["13:00", "18:00"]],
      "workforce.commission": { basis: "none" },
    },
  },
  {
    id: "trucking",
    name: "Trucking and hauling",
    blurb: "Trucks are the profit objects. Fleet, maintenance, inspections, payroll and A/R; no stores, catalog or POS.",
    vertical: "trucking",
    labels: { location: "Terminal", profitObject: "Truck", aging: "Settlements" },
    modules: ["ar", "workforce", "fleet", "reports"],
    accounts: [
      ["1050", "Undeposited funds", "asset", "D"],
      ["1100", "Accounts receivable, customers", "asset", "D"],
      ["1190", "Allowance for doubtful accounts", "asset", "C"],
      ["2100", "Sales tax payable", "liability", "C"],
      ["2300", "Customer deposits", "liability", "C"],
      ["3000", "Owner equity", "equity", "C"],
      ["4000", "Freight revenue", "revenue", "C"],
      ["4020", "Fees and other revenue", "revenue", "C"],
      ["6300", "Fleet repairs and maintenance", "expense", "D"],
      ["6310", "Fuel", "expense", "D"],
      ["6900", "Bad debt expense", "expense", "D"],
    ],
    reasons: RETAIL_REASONS.filter(([k]) => k === "write_off" || k === "void"),
    settings: {
      "ar.late_fee": { rate_bps: 150, min_minor: 0, grace_days: 30 },
      "fleet.service_minutes": { base: 30, per_piece: 0, per_stair_flight: 0 },
    },
  },
];

export function packById(id: string): Pack {
  const p = PACKS.find((x) => x.id === id);
  if (!p) throw new SetupError(`there is no setup pack called ${id}`);
  return p;
}

/**
 * Apply a pack to a company. Adds the accounts it needs (to the client's chart
 * and to this company), turns its modules on, adds its reason codes and any
 * default setting not already set, and sets the client's labels when the
 * client has only this one company. Returns what it changed.
 */
export async function applyPack(c: Client, scope: Scope, packId: string, appliedBy: string) {
  const pack = packById(packId);
  let accountsAdded = 0, modulesOn = 0, reasonsAdded = 0, settingsAdded = 0;

  for (const [code, name, type, nb] of pack.accounts) {
    const r = await c.query(
      `insert into gl_account (tenant_id, code, name, account_type, normal_balance) values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, code) do nothing`, [scope.tenantId, code, name, type, nb]);
    accountsAdded += r.rowCount ?? 0;
  }
  await c.query(
    `insert into entity_gl_account (entity_id, gl_account_id)
     select $1, id from gl_account where tenant_id = $2 and code = any($3)
     on conflict do nothing`, [scope.entityId, scope.tenantId, pack.accounts.map((a) => a[0])]);
  // Vendor categories take their usual accounts from the chart the pack just filled (merchandise → 2050, utilities → 6410, …).
  await c.query(`select vendor_category_defaults($1)`, [scope.tenantId]);

  for (const m of MODULE_IDS) {
    const on = pack.modules.includes(m);
    const r = await c.query(
      `insert into entity_module (entity_id, module, enabled, changed_by) values ($1,$2,$3,$4)
       on conflict (entity_id, module) do update set enabled = entity_module.enabled or excluded.enabled,
         changed_at = case when entity_module.enabled then entity_module.changed_at else now() end
       returning enabled`, [scope.entityId, m, on, `pack ${pack.id} (${appliedBy})`]);
    if (on && r.rows[0]?.enabled) modulesOn++;
  }

  // The starter reports the pack's modules call for (reports never removes one a person deleted).
  const startersAdded = await installStarters(c, scope.entityId, pack.modules);

  for (const [kind, code, label, restock] of pack.reasons) {
    const r = await c.query(
      `insert into reason_code (entity_id, kind, code, label, restock) values ($1,$2,$3,$4,$5)
       on conflict do nothing`, [scope.entityId, kind, code, label, restock ?? null]);
    reasonsAdded += r.rowCount ?? 0;
  }

  for (const [key, value] of Object.entries(pack.settings)) {
    const r = await c.query(
      `insert into entity_setting (entity_id, key, value, set_by, from_pack) values ($1,$2,$3,$4,true)
       on conflict do nothing`, [scope.entityId, key, JSON.stringify(value), `pack ${pack.id}`]);
    settingsAdded += r.rowCount ?? 0;
  }

  // Labels belong to the client. Change them only when this is its only company,
  // so a pack applied to one company never relabels a sister company's screens.
  const siblings = await one<{ n: string }>(c,
    `select count(*)::text n from entity where tenant_id = $1 /* unscoped: counting the client's companies */`, [scope.tenantId]);
  let relabelled = false;
  if (Number(siblings.n) === 1) {
    await c.query(
      `update tenant set vertical = $2, location_label = $3, profit_object_label = $4, aging_label = $5 where id = $1`,
      [scope.tenantId, pack.vertical, pack.labels.location, pack.labels.profitObject, pack.labels.aging]);
    relabelled = true;
  }

  const summary = { accountsAdded, modulesOn, reasonsAdded, settingsAdded, relabelled, startersAdded };
  await c.query(`insert into pack_application (entity_id, pack, applied_by, summary) values ($1,$2,$3,$4)`,
    [scope.entityId, pack.id, appliedBy, JSON.stringify(summary)]);
  return { pack: pack.id, ...summary };
}

/** Modules on for a company. A company that has never had a pack applied sees every module. */
export async function enabledModules(c: Client, entityId: string): Promise<ModuleId[]> {
  const rows = await q<{ module: ModuleId; enabled: boolean }>(c,
    `select module, enabled from entity_module where entity_id = $1`, [entityId]);
  if (!rows.length) return [...MODULE_IDS];
  return rows.filter((r) => r.enabled).map((r) => r.module);
}

export async function setModule(c: Client, entityId: string, module: string, enabled: boolean, by: string) {
  if (!(MODULE_IDS as readonly string[]).includes(module)) throw new SetupError(`there is no module called ${module}`);
  // First explicit choice on a company with no pack: record every module as on, then change this one.
  await c.query(
    `insert into entity_module (entity_id, module, enabled, changed_by)
     select $1, m, true, $2 from unnest($3::text[]) m on conflict do nothing`, [entityId, by, [...MODULE_IDS]]);
  await c.query(
    `update entity_module set enabled = $3, changed_at = now(), changed_by = $4 where entity_id = $1 and module = $2`,
    [entityId, module, enabled, by]);
}

/** A company setting, falling back to a default. */
export async function setting<T>(c: Client, entityId: string, key: string, dflt: T): Promise<T> {
  const r = await q<{ value: T }>(c, `select value from entity_setting where entity_id = $1 and key = $2`, [entityId, key]);
  return r.length ? r[0].value : dflt;
}

export async function putSetting(c: Client, entityId: string, key: string, value: unknown, by: string) {
  if (!/^[a-z_]+(\.[a-z_]+)*$/.test(key)) throw new SetupError("a setting name is lower-case words joined by dots");
  await c.query(
    `insert into entity_setting (entity_id, key, value, set_by, from_pack) values ($1,$2,$3,$4,false)
     on conflict (entity_id, key) do update set value = excluded.value, set_by = excluded.set_by, set_at = now(), from_pack = false`,
    [entityId, key, JSON.stringify(value), by]);
}

// ------------------------------------------------------------- CSV imports --

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. Header row required. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const pick = (r: Record<string, string>, ...names: string[]) => {
  for (const n of names) if (r[n]) return r[n];
  return "";
};

function cents(s: string): bigint | null {
  const m = /^(-?)\$?(\d+)(?:\.(\d{1,2}))?$/.exec(s.replace(/[,\s]/g, ""));
  if (!m) return null;
  const v = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -v : v;
}

type Problem = { row: number; problem: string };

/**
 * Customers from the old system. Matched by customer number, then email;
 * a match is updated, anything else added. Columns (any case): number,
 * name, email, phone, address, city, state, zip, credit_limit, terms_days.
 */
export async function importCustomers(c: Client, scope: Scope, csv: string, filename: string, by: string) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new SetupError("that file has no rows under its header");
  if (rows.length > 50000) throw new SetupError("that is more than 50,000 customers; split the file");
  let added = 0, updated = 0;
  const problems: Problem[] = [];
  for (const [i, r] of rows.entries()) {
    const n = i + 2;
    const name = pick(r, "name", "customer_name", "full_name", "customer");
    if (!name) { problems.push({ row: n, problem: "no name" }); continue; }
    const email = pick(r, "email", "e_mail", "email_address").toLowerCase() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { problems.push({ row: n, problem: `"${email}" is not an email address` }); continue; }
    const phone = pick(r, "phone", "phone_number", "cell", "mobile") || null;
    const limit = cents(pick(r, "credit_limit", "limit") || "0");
    if (limit === null || limit < 0n) { problems.push({ row: n, problem: "credit limit is not an amount" }); continue; }
    const terms = Number(pick(r, "terms_days", "terms") || 0);
    let number = pick(r, "number", "customer_number", "customer_no", "account", "id");
    const found = await q<{ id: string }>(c,
      `select id from customer where entity_id = $1 and (($2 <> '' and number = $2) or ($3::text is not null and lower(email) = $3)) limit 1`,
      [scope.entityId, number, email]);
    let id: string;
    if (found.length) {
      id = found[0].id;
      await c.query(
        `update customer set name = $3, email = coalesce($4, email), phone = coalesce($5, phone),
           credit_limit_minor = $6, terms_days = $7 where id = $1 and entity_id = $2`,
        [id, scope.entityId, name, email, phone, limit.toString(), Number.isFinite(terms) ? Math.max(0, Math.trunc(terms)) : 0]);
      updated++;
    } else {
      if (!number) number = (await one<{ n: string }>(c, `select next_doc_no($1, 'customer', 'C-') n`, [scope.entityId])).n;
      id = (await one<{ id: string }>(c,
        `insert into customer (entity_id, number, name, email, phone, credit_limit_minor, terms_days)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [scope.entityId, number, name, email, phone, limit.toString(), Number.isFinite(terms) ? Math.max(0, Math.trunc(terms)) : 0])).id;
      added++;
    }
    const line1 = pick(r, "address", "address1", "street", "line1");
    const city = pick(r, "city"), state = pick(r, "state", "st").toUpperCase(), postal = pick(r, "zip", "postal", "postal_code", "zipcode");
    if (line1 && city && /^[A-Z]{2}$/.test(state) && postal) {
      const has = await q(c, `select 1 from customer_address where entity_id = $1 and customer_id = $2 and lower(line1) = lower($3)`, [scope.entityId, id, line1]);
      if (!has.length) {
        const first = await q(c, `select 1 from customer_address where entity_id = $1 and customer_id = $2`, [scope.entityId, id]);
        await c.query(
          `insert into customer_address (entity_id, customer_id, line1, city, state, postal, is_default) values ($1,$2,$3,$4,$5,$6,$7)`,
          [scope.entityId, id, line1, city, state, postal, !first.length]);
      }
    } else if (line1) problems.push({ row: n, problem: "address kept off: needs street, city, 2-letter state and zip" });
  }
  await c.query(
    `insert into import_run (entity_id, kind, filename, rows_seen, rows_added, rows_updated, rows_refused, problems, run_by)
     values ($1,'customers',$2,$3,$4,$5,$6,$7,$8)`,
    [scope.entityId, filename, rows.length, added, updated, problems.filter((p) => !p.problem.startsWith("address")).length,
     JSON.stringify(problems.slice(0, 500)), by]);
  return { seen: rows.length, added, updated, problems };
}

/**
 * Open receivables from the old system: one balance per customer reference.
 * Each posts Dr 1100 / Cr 3000 (opening equity) on its as-of date, so the
 * trial balance carries the balances the old books did. A reference already
 * imported is refused, never doubled.
 * Columns: customer_number (or email), reference, as_of, due_on, balance.
 */
export async function importOpenAr(c: Client, scope: Scope, csv: string, filename: string, by: string) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new SetupError("that file has no rows under its header");
  let added = 0;
  let total = 0n;
  const problems: Problem[] = [];
  for (const [i, r] of rows.entries()) {
    const n = i + 2;
    const num = pick(r, "customer_number", "customer", "number", "account");
    const email = pick(r, "email").toLowerCase();
    const ref = pick(r, "reference", "invoice", "invoice_number", "ref", "agreement");
    const asOf = pick(r, "as_of", "date", "invoice_date");
    const due = pick(r, "due_on", "due_date", "due") || null;
    const amt = cents(pick(r, "balance", "amount", "open_balance"));
    if (!ref) { problems.push({ row: n, problem: "no reference" }); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { problems.push({ row: n, problem: "as-of date must be YYYY-MM-DD" }); continue; }
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) { problems.push({ row: n, problem: "due date must be YYYY-MM-DD" }); continue; }
    if (amt === null || amt === 0n) { problems.push({ row: n, problem: "balance is not a non-zero amount" }); continue; }
    const cust = await q<{ id: string; name: string }>(c,
      `select id, name from customer where entity_id = $1 and (($2 <> '' and number = $2) or ($3 <> '' and lower(email) = $3)) limit 1`,
      [scope.entityId, num, email]);
    if (!cust.length) { problems.push({ row: n, problem: `no customer ${num || email}; import customers first` }); continue; }
    const dupe = await q(c, `select 1 from opening_receivable where entity_id = $1 and reference = $2`, [scope.entityId, ref]);
    if (dupe.length) { problems.push({ row: n, problem: `${ref} was already imported` }); continue; }
    const abs = amt < 0n ? -amt : amt;
    const je = await post(c, scope, {
      date: asOf, sourceType: "opening", sourceId: null,
      description: `Opening balance ${ref}, ${cust[0].name}`,
      lines: amt > 0n
        ? [{ code: "1100", debit: abs }, { code: "3000", credit: abs }]
        : [{ code: "3000", debit: abs }, { code: "1100", credit: abs }],
    });
    await c.query(
      `insert into opening_receivable (entity_id, customer_id, reference, as_of, due_on, amount_minor, journal_entry_id)
       values ($1,$2,$3,$4,$5,$6,$7)`, [scope.entityId, cust[0].id, ref, asOf, due, amt.toString(), je]);
    added++; total += amt;
  }
  // Receivables picks them up as open invoices, so aging and collections carry them.
  await adoptOpeningBalances(c, scope);
  await c.query(
    `insert into import_run (entity_id, kind, filename, rows_seen, rows_added, rows_refused, problems, run_by)
     values ($1,'open_ar',$2,$3,$4,$5,$6,$7)`,
    [scope.entityId, filename, rows.length, added, problems.length, JSON.stringify(problems.slice(0, 500)), by]);
  return { seen: rows.length, added, totalMinor: total, problems };
}

// -------------------------------------------------------------- locations --

const KINDS = ["store", "warehouse", "outlet", "yard", "office", "web"];

export async function saveLocation(c: Client, scope: Scope, input: {
  id?: string | null; code: string; name: string; kind: string; state?: string | null; taxRateBps?: number;
  address?: { line1?: string; city?: string; state?: string; postal?: string }; lng?: number | null; lat?: number | null;
}) {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,10}$/.test(code)) throw new SetupError("a location code is 2 to 10 letters or digits");
  if (input.name.trim().length < 2) throw new SetupError("name the location");
  if (!KINDS.includes(input.kind)) throw new SetupError(`a location is one of: ${KINDS.join(", ")}`);
  const tax = Math.trunc(input.taxRateBps ?? 0);
  if (!(tax >= 0 && tax <= 2000)) throw new SetupError("the sales tax rate must be between 0% and 20%");
  const st = (input.state ?? input.address?.state ?? "").toUpperCase() || null;
  if (st && !/^[A-Z]{2}$/.test(st)) throw new SetupError("the state is two letters");
  const hasGeo = typeof input.lng === "number" && typeof input.lat === "number";
  if (hasGeo && (Math.abs(input.lat!) > 90 || Math.abs(input.lng!) > 180)) throw new SetupError("that map point is off the map");
  const addr = JSON.stringify(input.address ?? {});
  if (input.id) {
    const r = await c.query(
      `update location set code = $3, name = $4, kind = $5, state = $6, tax_rate_bps = $7, address = $8,
         geo = case when $9::float8 is null then geo else point($9, $10) end
       where id = $1 and entity_id = $2`,
      [input.id, scope.entityId, code, input.name.trim(), input.kind, st, tax, addr, hasGeo ? input.lng : null, hasGeo ? input.lat : null]);
    if (!r.rowCount) throw new SetupError("no such location");
    return input.id;
  }
  const id = (await one<{ id: string }>(c,
    `insert into location (entity_id, code, name, kind, state, tax_rate_bps, address, geo)
     values ($1,$2,$3,$4,$5,$6,$7, case when $8::float8 is null then null else point($8, $9) end) returning id`,
    [scope.entityId, code, input.name.trim(), input.kind, st, tax, addr, hasGeo ? input.lng : null, hasGeo ? input.lat : null])).id;
  // A selling location is a profit object too, so its sales land in its own P&L column.
  if (["store", "outlet", "web"].includes(input.kind)) {
    await c.query(
      `insert into profit_object (entity_id, kind, code, name, location_id) values ($1,'store',$2,$3,$4)
       on conflict (entity_id, code) do nothing`, [scope.entityId, code, input.name.trim(), id]);
  }
  return id;
}
