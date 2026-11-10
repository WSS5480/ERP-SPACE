// Sales tax by jurisdiction. Setup owns the jurisdictions, their rates and
// where they apply; POS asks for a line's stack and writes the line's tax per
// jurisdiction; A/R marks those rows posted when the sale reaches GL 2100;
// POS returns reverse the same rows; reports read them for the filing.
//
// How a line's tax is found:
//   1. The place: the store for take-with and pickup; the ship-to address for
//      delivery and direct ship when the company sources by destination
//      (tax_setting.sourcing), the store when it sources by origin. An
//      address in a state with no jurisdiction set up falls back to the store.
//   2. The stack at that place, on that day: every active jurisdiction with a
//      rate in force whose area covers it -- a whole state, one postal code,
//      or a named location. A store with none keeps its single location rate,
//      as one 'combined' jurisdiction made on first use.
//   3. Which of them tax this line: goods always; delivery fees, labor and
//      protection plans only where the jurisdiction says so; nothing when the
//      product is not taxable; nothing in the certificate's state when the
//      sale carries a current exemption certificate.
//   4. The line's tax is the combined rate of those (half-up, exactly as a
//      single rate would give), split over them by rate. So one jurisdiction
//      always gives what the old single store rate gave.

import { q, one, audit, type Client, type Scope } from "./db.ts";

export class TaxError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new TaxError(msg); };
const today = () => new Date().toISOString().slice(0, 10);
const isDay = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const bps = (m: bigint, rate: number): bigint => { const neg = m < 0n; const a = neg ? -m : m; const r = (a * BigInt(rate) + 5000n) / 10000n; return neg ? -r : r; };

export const LEVELS = ["state", "county", "city", "special", "combined"] as const;
export const CERT_REASONS = ["resale", "government", "nonprofit", "agricultural", "manufacturing", "other"] as const;
export const EXEMPT_REASONS = ["resale", "government", "nonprofit", "agricultural", "manufacturing", "other_certificate",
  "item_not_taxable", "delivery_exempt", "labor_exempt", "warranty_exempt", "not_taxed"] as const;
export const EXEMPT_LABEL: Record<string, string> = {
  resale: "Resale certificate", government: "Government", nonprofit: "Nonprofit", agricultural: "Agricultural", manufacturing: "Manufacturing",
  other_certificate: "Other certificate", item_not_taxable: "Item not taxable", delivery_exempt: "Delivery exempt here",
  labor_exempt: "Labor exempt here", warranty_exempt: "Protection plan exempt here", not_taxed: "Not taxed (other)",
};

export type ItemClass = "goods" | "delivery" | "labor" | "warranty" | "other";
/** What a product kind is for tax: a fee is a delivery charge, a service is labor, a warranty a protection plan. */
export const classOf = (kind: string | null | undefined): ItemClass =>
  kind === "fee" ? "delivery" : kind === "service" ? "labor" : kind === "warranty" ? "warranty" : kind === "gift_card" ? "other" : "goods";

export type Juris = { id: string; code: string; name: string; level: string; state: string; rateBps: number;
  taxesDelivery: boolean; taxesLabor: boolean; taxesWarranty: boolean };
export type Cert = { id: string; number: string; state: string; reason: string; expiresOn: string | null };
export type Sourced = "origin" | "destination";
export type TaxRow = { jurisdictionId: string; rateBps: number; taxableMinor: bigint; exemptMinor: bigint; exemptReason: string | null; taxMinor: bigint;
  /** what the jurisdiction is owed; equals taxMinor unless another door charged a different amount */
  owedMinor?: bigint };

// ================================================================= settings

export async function sourcing(c: Client, entityId: string): Promise<Sourced> {
  const r = await q<{ sourcing: Sourced }>(c, `select sourcing from tax_setting where entity_id = $1`, [entityId]);
  return r[0]?.sourcing ?? "destination";
}

export async function setSourcing(c: Client, scope: Scope, value: string) {
  need(value === "origin" || value === "destination", "tax is sourced by origin (the store) or by destination (where the goods go)");
  await c.query(`insert into tax_setting (entity_id, sourcing, set_by) values ($1,$2,$3)
    on conflict (entity_id) do update set sourcing = excluded.sourcing, set_by = excluded.set_by, set_at = now()`, [scope.entityId, value, scope.actor.label]);
  await audit(c, scope, { table: "tax_setting", rowId: scope.entityId, action: "update", after: { sourcing: value } });
  return { sourcing: value };
}

// ===================================================================== stacks

async function jurisdictionsIn(c: Client, entityId: string, ids: string[], on: string): Promise<Juris[]> {
  if (!ids.length) return [];
  const r = await q<{ id: string; code: string; name: string; level: string; state: string; rate_bps: number; taxes_delivery: boolean; taxes_labor: boolean; taxes_warranty: boolean }>(c, `
    select j.id, j.code, j.name, j.level, j.state, r.rate_bps, j.taxes_delivery, j.taxes_labor, j.taxes_warranty
      from tax_jurisdiction j
      join tax_rate r on r.jurisdiction_id = j.id and r.entity_id = j.entity_id
                     and r.effective_from <= $3::date and (r.effective_to is null or r.effective_to >= $3::date)
     where j.entity_id = $1 and j.active and j.id = any($2)
     order by array_position(array['state','county','city','special','combined'], j.level), j.code`, [entityId, ids, on]);
  return r.map((x) => ({ id: x.id, code: x.code, name: x.name, level: x.level, state: x.state, rateBps: x.rate_bps,
    taxesDelivery: x.taxes_delivery, taxesLabor: x.taxes_labor, taxesWarranty: x.taxes_warranty }));
}

/** These jurisdictions as a stack, at the rates in force on the day (re-taxing a draft at the same places). */
export async function stackJurisdictions(c: Client, entityId: string, ids: string[], on = today()): Promise<Juris[]> {
  const s = await jurisdictionsIn(c, entityId, ids, on);
  return ids.map((id) => s.find((j) => j.id === id)).filter(Boolean) as Juris[];
}

/** The stack at a state and postal code: statewide jurisdictions plus those of that postal code. */
export async function stackForPlace(c: Client, entityId: string, state: string | null, postal: string | null, on = today()): Promise<Juris[]> {
  return (await placeStack(c, entityId, state, postal, on)).stack;
}

/**
 * The stack at a place, and whether its ZIP is a gap: the state has local
 * jurisdictions set up by ZIP but none for this one.
 */
export async function placeStack(c: Client, entityId: string, state: string | null, postal: string | null, on = today()): Promise<{ stack: Juris[]; uncovered: boolean; postal: string }> {
  const st = String(state ?? "").trim().toUpperCase();
  const zip = String(postal ?? "").trim().slice(0, 5);
  if (!/^[A-Z]{2}$/.test(st)) return { stack: [], uncovered: false, postal: zip };
  const ids = await q<{ id: string; local: boolean }>(c, `select distinct a.jurisdiction_id id, a.postal is not null local from tax_area a
     where a.entity_id = $1 and a.active and a.location_id is null and a.state = $2 and (a.postal is null or a.postal = $3)`, [entityId, st, zip]);
  const stack = await jurisdictionsIn(c, entityId, ids.map((x) => x.id), on);
  let uncovered = false;
  if (stack.length && !ids.some((x) => x.local)) {
    const locals = await q(c, `select 1 from tax_area a where a.entity_id = $1 and a.active and a.location_id is null and a.state = $2 and a.postal is not null limit 1`, [entityId, st]);
    uncovered = locals.length > 0;
  }
  return { stack, uncovered, postal: zip };
}

/** The stack at a customer's address, or empty when its state has nothing set up. */
export async function stackForAddress(c: Client, entityId: string, addressId: string, on = today()): Promise<Juris[]> {
  const a = await q<{ state: string; postal: string }>(c, `select state, postal from customer_address where id = $1 and entity_id = $2`, [addressId, entityId]);
  if (!a.length) return [];
  return stackForPlace(c, entityId, a[0].state, a[0].postal, on);
}

type LocRow = { code: string; name: string; state: string | null; addr_state: string | null; postal: string | null; tax_rate_bps: number };
async function locationRow(c: Client, entityId: string, locationId: string): Promise<LocRow> {
  const loc = await q<LocRow>(c, `
    select code, name, state, address->>'state' addr_state, address->>'postal' postal, tax_rate_bps from location where id = $1 and entity_id = $2`, [locationId, entityId]);
  need(loc.length, "no such store");
  return loc[0];
}
const stateOf = (l: LocRow) => { const s = String(l.state || l.addr_state || "").trim().toUpperCase(); return /^[A-Z]{2}$/.test(s) ? s : null; };

/**
 * The stack at a store: jurisdictions named for the location, else those of
 * its own address, else its single location rate as a stand-in jurisdiction
 * (made now when `write`, else shown as it would be). A store with no state
 * cannot be taxed until it has one.
 */
export async function stackForLocation(c: Client, entityId: string, locationId: string, on = today(), write = true): Promise<Juris[]> {
  const named = await q<{ id: string }>(c, `select distinct jurisdiction_id id from tax_area where entity_id = $1 and active and location_id = $2`, [entityId, locationId]);
  if (named.length) {
    const s = await jurisdictionsIn(c, entityId, named.map((x) => x.id), on);
    if (s.length) return s;
  }
  const l = await locationRow(c, entityId, locationId);
  const placed = await stackForPlace(c, entityId, l.addr_state || l.state, l.postal, on);
  if (placed.length) return placed;
  const state = stateOf(l);
  const standIn: Juris = { id: "", code: `LOC-${l.code}`.slice(0, 40), name: `${l.name} (single store rate)`, level: "combined", state: state ?? "",
    rateBps: l.tax_rate_bps, taxesDelivery: true, taxesLabor: true, taxesWarranty: true };
  if (!write) return state ? [standIn] : [];
  need(state, `${l.name} has no state set, so its sales tax cannot be worked out; add the state to the location in Business setup first`);
  standIn.id = await ensureStandIn(c, entityId, locationId, standIn, l.tax_rate_bps);
  return jurisdictionsIn(c, entityId, [standIn.id], on).then((s) => s.length ? s : [standIn]);
}

/** A store with no jurisdictions keeps its single rate as one 'combined' jurisdiction. */
async function ensureStandIn(c: Client, entityId: string, locationId: string, j: Juris, rate: number): Promise<string> {
  const have = await q<{ id: string }>(c, `select id from tax_jurisdiction where entity_id = $1 and for_location_id = $2`, [entityId, locationId]);
  if (have.length) {
    await c.query(`update tax_jurisdiction set active = true where id = $1 and entity_id = $2 and not active`, [have[0].id, entityId]);
    await c.query(`insert into tax_area (entity_id, jurisdiction_id, location_id)
      select $1, $2, $3 where not exists (select 1 from tax_area where entity_id = $1 and jurisdiction_id = $2 and location_id = $3 and active)`, [entityId, have[0].id, locationId]);
    return have[0].id;
  }
  let code = j.code;
  const clash = await q(c, `select 1 from tax_jurisdiction where entity_id = $1 and code = $2`, [entityId, code]);
  if (clash.length) code = `${code}-${locationId.slice(0, 4).toUpperCase()}`;
  const row = await one<{ id: string }>(c, `insert into tax_jurisdiction (entity_id, code, name, level, state, taxes_delivery, taxes_labor, taxes_warranty, for_location_id, note, created_by)
    values ($1,$2,$3,'combined',$4,true,true,true,$5,'The store''s single sales tax rate, kept as one jurisdiction until local ones are set up.','system') returning id`,
    [entityId, code.replace(/[^A-Z0-9_-]/g, "-"), j.name.slice(0, 120), j.state, locationId]);
  await c.query(`insert into tax_rate (entity_id, jurisdiction_id, rate_bps, effective_from, note, created_by) values ($1,$2,$3,'2000-01-01','from the store''s rate','system')`,
    [entityId, row.id, rate]);
  await c.query(`insert into tax_area (entity_id, jurisdiction_id, location_id) values ($1,$2,$3)`, [entityId, row.id, locationId]);
  return row.id;
}

/**
 * A store saved with a single rate that its address's jurisdictions do not
 * give keeps that rate as its own stand-in, so a later statewide
 * jurisdiction cannot quietly lower it. Same rule as the migration.
 */
export async function keepStoreRate(c: Client, entityId: string, locationId: string) {
  const named = await q(c, `select 1 from tax_area where entity_id = $1 and active and location_id = $2`, [entityId, locationId]);
  if (named.length) return false;
  const l = await locationRow(c, entityId, locationId);
  if (!l.tax_rate_bps || !stateOf(l)) return false;
  const placed = await stackForPlace(c, entityId, l.addr_state || l.state, l.postal);
  if (placed.length && goodsRate(placed) === l.tax_rate_bps) return false;
  await ensureStandIn(c, entityId, locationId, { id: "", code: `LOC-${l.code}`.slice(0, 40), name: `${l.name} (single store rate)`, level: "combined", state: stateOf(l)!,
    rateBps: l.tax_rate_bps, taxesDelivery: true, taxesLabor: true, taxesWarranty: true }, l.tax_rate_bps);
  return true;
}

export type Place = { stack: Juris[]; sourced: Sourced; note: string | null; uncoveredPostal: string | null };

/**
 * Where a line is taxed: the store, or the ship-to address when sourcing by
 * destination and its state is set up. A ZIP the state's local jurisdictions
 * do not cover is taxed at the selling store's stack when the store is in
 * that state, else at the state alone; either way the line says so.
 */
export async function stackForLine(c: Client, entityId: string, e: { storeId: string; fulfillment: string; shipAddressId?: string | null;
  shipTo?: { state: string | null; postal: string | null } | null; on?: string; sourcing?: Sourced; write?: boolean }): Promise<Place> {
  const on = e.on ?? today();
  const src = e.sourcing ?? await sourcing(c, entityId);
  const away = e.fulfillment === "delivery" || e.fulfillment === "ship";
  if (away && src === "destination" && (e.shipAddressId || e.shipTo)) {
    let to = e.shipTo ?? null;
    if (!to && e.shipAddressId) to = (await q<{ state: string; postal: string }>(c, `select state, postal from customer_address where id = $1 and entity_id = $2`,
      [e.shipAddressId, entityId]))[0] ?? null;
    if (to) {
      const p = await placeStack(c, entityId, to.state, to.postal, on);
      if (p.stack.length && !p.uncovered) return { stack: p.stack, sourced: "destination", note: null, uncoveredPostal: null };
      if (p.stack.length && p.uncovered) {
        const store = await locationRow(c, entityId, e.storeId);
        const st = String(to.state ?? "").toUpperCase();
        if (stateOf(store) === st)
          return { stack: await stackForLocation(c, entityId, e.storeId, on, e.write ?? true), sourced: "origin", uncoveredPostal: p.postal,
            note: `ZIP ${p.postal} has no local tax set up; taxed at the ${store.name} store's rates` };
        return { stack: p.stack, sourced: "destination", uncoveredPostal: p.postal, note: `ZIP ${p.postal} has no local tax set up; state tax only` };
      }
    }
  }
  return { stack: await stackForLocation(c, entityId, e.storeId, on, e.write ?? true), sourced: "origin", note: null, uncoveredPostal: null };
}

/** The combined rate a place charges on taxable goods today (what location.tax_rate_bps shows). */
export const goodsRate = (s: Juris[]) => s.reduce((a, j) => a + j.rateBps, 0);

// ============================================================= computing

/** Split an amount over weights, largest remainder; the parts always add up to the whole. */
export function split(total: bigint, weights: bigint[]): bigint[] {
  const neg = total < 0n;
  const t = neg ? -total : total;
  const w = weights.map((x) => (x < 0n ? -x : x));
  const sum = w.reduce((a, b) => a + b, 0n);
  if (!w.length) return [];
  if (sum === 0n) return w.map((_x, i) => (i === 0 ? total : 0n));
  const base = w.map((x) => (t * x) / sum);
  let left = t - base.reduce((a, b) => a + b, 0n);
  const order = w.map((x, i) => ({ i, r: (t * x) % sum })).sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const o of order) { if (left <= 0n) break; base[o.i] += 1n; left -= 1n; }
  return base.map((x) => (neg ? -x : x));
}

const certReason = (r: string) => (r === "other" ? "other_certificate" : r);

/** Why a jurisdiction does not tax this line, or null when it does. */
export function exemptionFor(j: Juris, cls: ItemClass, taxable: boolean, cert: Cert | null): string | null {
  if (!taxable || cls === "other") return "item_not_taxable";
  if (cls === "delivery" && !j.taxesDelivery) return "delivery_exempt";
  if (cls === "labor" && !j.taxesLabor) return "labor_exempt";
  if (cls === "warranty" && !j.taxesWarranty) return "warranty_exempt";
  if (cert && cert.state === j.state) return certReason(cert.reason);
  return null;
}

/** A line's tax over its stack: the combined rate of the jurisdictions that tax it, split over them by rate. */
export function computeLine(stack: Juris[], e: { netMinor: bigint; itemClass: ItemClass; taxable: boolean; cert: Cert | null }): { rows: TaxRow[]; taxMinor: bigint } {
  const why = stack.map((j) => exemptionFor(j, e.itemClass, e.taxable, e.cert));
  const rate = stack.reduce((a, j, i) => a + (why[i] ? 0 : j.rateBps), 0);
  const total = bps(e.netMinor, rate);
  const parts = split(total, stack.map((j, i) => (why[i] ? 0n : BigInt(j.rateBps))));
  // Nothing applies (every jurisdiction exempt): no tax at all, not a split of zero onto the first one.
  const rows = stack.map((j, i) => ({ jurisdictionId: j.id, rateBps: j.rateBps, taxableMinor: why[i] ? 0n : e.netMinor,
    exemptMinor: why[i] ? e.netMinor : 0n, exemptReason: why[i], taxMinor: why[i] ? 0n : (parts[i] ?? 0n) }));
  return { rows, taxMinor: rows.reduce((a, r) => a + r.taxMinor, 0n) };
}

export async function writeLineTax(c: Client, entityId: string, orderId: string, lineId: string, rows: TaxRow[],
  place: Sourced | { sourced: Sourced; note?: string | null; uncoveredPostal?: string | null }, cls: ItemClass) {
  const p = typeof place === "string" ? { sourced: place, note: null, uncoveredPostal: null } : place;
  for (const r of rows) {
    if (!r.jurisdictionId) continue;
    await c.query(`insert into sales_order_line_tax (entity_id, sales_order_id, sales_order_line_id, jurisdiction_id, kind, sourced, item_class, rate_bps,
        taxable_minor, exempt_minor, exempt_reason, tax_minor, owed_minor, note, uncovered_postal) values ($1,$2,$3,$4,'sale',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [entityId, orderId, lineId, r.jurisdictionId, p.sourced, cls, r.rateBps, r.taxableMinor.toString(), r.exemptMinor.toString(), r.exemptReason,
       r.taxMinor.toString(), (r.owedMinor ?? r.taxMinor).toString(), p.note ?? null, p.uncoveredPostal ?? null]);
  }
}

// ========================================================== certificates

export async function certificates(c: Client, entityId: string, customerId: string) {
  return q(c, `select id, number, state, reason, expires_on::text, status, void_reason, created_by, created_at,
      (status = 'active' and (expires_on is null or expires_on >= current_date)) current
    from tax_exemption_certificate where entity_id = $1 and customer_id = $2 order by status, expires_on desc nulls first, number`, [entityId, customerId]);
}

export async function saveCertificate(c: Client, scope: Scope, e: { customerId: string; number: string; state: string; reason: string; expiresOn?: string | null }) {
  const number = String(e.number ?? "").trim();
  need(number.length >= 3 && number.length <= 60, "enter the certificate number as printed");
  const st = String(e.state ?? "").trim().toUpperCase();
  need(/^[A-Z]{2}$/.test(st), "the state on the certificate is two letters");
  need((CERT_REASONS as readonly string[]).includes(e.reason), "pick why the customer is exempt: resale, government, nonprofit, agricultural, manufacturing or other");
  const exp = e.expiresOn ? String(e.expiresOn) : null;
  if (exp) { need(isDay(exp), "the expiry is a date"); need(exp >= today(), "that certificate has already expired; ask the customer for a current one"); }
  const cu = await q<{ name: string }>(c, `select name from customer where id = $1 and entity_id = $2`, [e.customerId, scope.entityId]);
  need(cu.length, "no such customer");
  const dup = await q(c, `select 1 from tax_exemption_certificate where entity_id = $1 and customer_id = $2 and number = $3`, [scope.entityId, e.customerId, number]);
  need(!dup.length, `${cu[0].name} already has certificate ${number} on file`);
  const r = await one<{ id: string }>(c, `insert into tax_exemption_certificate (entity_id, customer_id, number, state, reason, expires_on, created_by)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`, [scope.entityId, e.customerId, number, st, e.reason, exp, scope.actor.label]);
  // The customer card shows the newest certificate on file.
  await c.query(`update customer set tax_exempt_ref = $3 where id = $1 and entity_id = $2`, [e.customerId, scope.entityId, number]);
  await audit(c, scope, { table: "tax_exemption_certificate", rowId: r.id, action: "insert", after: { number, state: st, reason: e.reason, expiresOn: exp } });
  return { id: r.id };
}

export async function voidCertificate(c: Client, scope: Scope, id: string, reason: string) {
  need(String(reason ?? "").trim(), "say why the certificate is no longer good");
  const r = await q<{ customer_id: string; number: string }>(c, `update tax_exemption_certificate set status = 'void', void_reason = $3
     where id = $1 and entity_id = $2 and status = 'active' returning customer_id, number`, [id, scope.entityId, String(reason).trim()]);
  need(r.length, "no such certificate in use");
  await c.query(`update customer set tax_exempt_ref = null where id = $1 and entity_id = $2 and tax_exempt_ref = $3`, [r[0].customer_id, scope.entityId, r[0].number]);
  await audit(c, scope, { table: "tax_exemption_certificate", rowId: id, action: "transition", after: { status: "void" }, reason });
  return { ok: true };
}

/**
 * The certificate a sale is exempt under. It must be the customer's, not
 * void, and current on the day. A customer reference with no certificate
 * row (from before certificates were kept) is accepted as it always was,
 * for the store's state, with no expiry.
 */
export async function certificateFor(c: Client, entityId: string, customerId: string, number: string, on = today(), storeState: string | null = null): Promise<Cert> {
  const r = await q<{ id: string; number: string; state: string; reason: string; expires_on: string | null; status: string }>(c, `
    select id, number, state, reason, expires_on::text, status from tax_exemption_certificate where entity_id = $1 and customer_id = $2 and number = $3`,
    [entityId, customerId, number.trim()]);
  if (!r.length) {
    const cu = await q<{ tax_exempt_ref: string | null }>(c, `select tax_exempt_ref from customer where id = $1 and entity_id = $2`, [customerId, entityId]);
    const any = await q(c, `select 1 from tax_exemption_certificate where entity_id = $1 and customer_id = $2`, [entityId, customerId]);
    need(cu[0]?.tax_exempt_ref && cu[0].tax_exempt_ref.trim() === number.trim() && !any.length,
      `certificate ${number} is not on file for this customer; add it to the customer first`);
    return { id: "", number: number.trim(), state: (storeState ?? "ZZ").toUpperCase(), reason: "other", expiresOn: null };
  }
  const x = r[0];
  need(x.status === "active", `certificate ${x.number} has been voided; the sale is taxed unless a current certificate is given`);
  need(!x.expires_on || x.expires_on >= on, `certificate ${x.number} expired on ${x.expires_on}; the sale is taxed until the customer gives a current one`);
  return { id: x.id, number: x.number, state: x.state, reason: x.reason, expiresOn: x.expires_on };
}

// ===================================================== posting and returns

type LineFacts = { id: string; sales_order_id: string; qty: string; unit_price_minor: string; discount_minor: string; tax_minor: string; kind: string | null;
  taxable: boolean | null; location_id: string; fulfillment: string; ship_address_id: string | null; exempt_ref: string | null };

async function lineFacts(c: Client, entityId: string, lineIds: string[]): Promise<LineFacts[]> {
  return q<LineFacts>(c, `
    select l.id, l.sales_order_id, l.qty, l.unit_price_minor, l.discount_minor, l.tax_minor, p.kind, p.taxable, so.location_id,
           coalesce(pl.fulfillment, so.fulfillment) fulfillment, coalesce(pl.ship_address_id, so.ship_address_id) ship_address_id, po.tax_exempt_ref exempt_ref
      from sales_order_line l join sales_order so on so.id = l.sales_order_id and so.entity_id = l.entity_id
      left join product p on p.id = l.product_id left join pos_line pl on pl.sales_order_line_id = l.id
      left join pos_order po on po.sales_order_id = so.id
     where l.entity_id = $1 and l.id = any($2)`, [entityId, lineIds]);
}

/**
 * A line written by another door (an import, a hand-made order) carries its
 * tax as one amount. Its rows say what each jurisdiction is owed (the stack
 * where it was handed over) and what was actually charged. When the two
 * differ, the charge is spread by what each is owed, so 2100 still ties,
 * and the difference stays on the rows for the filing to flag as tax
 * under- or over-collected. Nothing is spread silently.
 */
async function allocate(c: Client, entityId: string, l: LineFacts) {
  const net = BigInt(Math.round(Number(l.qty) * Number(l.unit_price_minor))) - BigInt(l.discount_minor);
  const charged = BigInt(l.tax_minor);
  const place = await stackForLine(c, entityId, { storeId: l.location_id, fulfillment: l.fulfillment, shipAddressId: l.ship_address_id });
  const cls = classOf(l.kind);
  const taxable = l.taxable !== false && !!l.kind;
  let cert: Cert | null = null;
  if (l.exempt_ref) {
    const r = await q<{ id: string; number: string; state: string; reason: string; expires_on: string | null }>(c, `select id, number, state, reason, expires_on::text
       from tax_exemption_certificate where entity_id = $1 and number = $2 order by created_at desc limit 1`, [entityId, l.exempt_ref]);
    cert = r[0] ? { id: r[0].id, number: r[0].number, state: r[0].state, reason: r[0].reason, expiresOn: r[0].expires_on }
      : { id: "", number: l.exempt_ref, state: place.stack[0]?.state ?? "", reason: "other", expiresOn: null };
  }
  const owed = computeLine(place.stack, { netMinor: net, itemClass: cls, taxable, cert });
  let rows: TaxRow[] = owed.rows.map((r) => ({ ...r, owedMinor: r.taxMinor }));
  if (charged !== owed.taxMinor) {
    let w = owed.rows.map((r) => (r.taxMinor < 0n ? -r.taxMinor : r.taxMinor));
    if (w.every((x) => x === 0n)) w = place.stack.map((j) => (exemptionFor(j, cls, true, null) ? 0n : BigInt(j.rateBps)));
    if (w.every((x) => x === 0n)) w = place.stack.map((j) => BigInt(j.rateBps));
    const parts = split(charged, w);
    rows = owed.rows.map((r, i) => {
      const taxed = parts[i] !== 0n || r.taxMinor !== 0n;
      return { ...r, taxMinor: parts[i], owedMinor: r.taxMinor, taxableMinor: taxed ? net : 0n, exemptMinor: taxed ? 0n : net,
        exemptReason: taxed ? null : (r.exemptReason ?? "not_taxed") };
    });
  }
  await writeLineTax(c, entityId, l.sales_order_id, l.id, rows, place, cls);
}

/** Make sure each line has its per-jurisdiction rows. */
export async function ensureRows(c: Client, entityId: string, lineIds: string[]) {
  if (!lineIds.length) return;
  const have = await q<{ id: string }>(c, `select distinct sales_order_line_id id from sales_order_line_tax where entity_id = $1 and sales_order_line_id = any($2)`, [entityId, lineIds]);
  const done = new Set(have.map((x) => x.id));
  const missing = lineIds.filter((x) => !done.has(x));
  if (!missing.length) return;
  for (const l of await lineFacts(c, entityId, missing)) await allocate(c, entityId, l);
}

/** The sale reached 2100 (A/R's invoiceFulfilment): its lines' tax rows are posted on that day under that entry. */
export async function postLines(c: Client, entityId: string, lineIds: string[], journalEntryId: string, date: string) {
  await ensureRows(c, entityId, lineIds);
  await c.query(`update sales_order_line_tax set posted_on = $3, journal_entry_id = $4
     where entity_id = $1 and sales_order_line_id = any($2) and kind = 'sale' and posted_on is null`, [entityId, lineIds, date, journalEntryId]);
}

/**
 * A return reverses the original line's jurisdictions, in proportion to the
 * quantity back. Each jurisdiction gives back at most what it still holds
 * from that line (earlier returns counted), and the last unit back takes
 * whatever is left, so a line's tax never comes back more than once.
 */
export async function reverseLine(c: Client, entityId: string, e: { originalLineId: string; returnOrderId: string; returnLineId: string; qty: number; originalQty: number;
  netMinor: bigint; qtyLeft?: number }) {
  await ensureRows(c, entityId, [e.originalLineId]);
  const rows = await q<{ id: string; jurisdiction_id: string; sourced: string; item_class: string; rate_bps: number; taxable_minor: string; tax_minor: string; owed_minor: string;
    exempt_reason: string | null; back_tax: string; back_owed: string }>(c, `
    select t.id, t.jurisdiction_id, t.sourced, t.item_class, t.rate_bps, t.taxable_minor, t.tax_minor, t.owed_minor, t.exempt_reason,
           coalesce((select -sum(r.tax_minor) from sales_order_line_tax r where r.entity_id = t.entity_id and r.original_id = t.id), 0)::text back_tax,
           coalesce((select -sum(r.owed_minor) from sales_order_line_tax r where r.entity_id = t.entity_id and r.original_id = t.id), 0)::text back_owed
      from sales_order_line_tax t
     where t.entity_id = $1 and t.sales_order_line_id = $2 and t.kind = 'sale' order by t.created_at, t.id`, [entityId, e.originalLineId]);
  const last = e.qtyLeft !== undefined && e.qty >= e.qtyLeft;
  const share = (col: "tax_minor" | "owed_minor", back: "back_tax" | "back_owed") => {
    const left = rows.map((r) => BigInt(r[col]) - BigInt(r[back]));
    if (last) return left;
    const lineTotal = rows.reduce((a, r) => a + BigInt(r[col]), 0n);
    const parts = split(BigInt(Math.round(Number(lineTotal) * e.qty / e.originalQty)), rows.map((r) => BigInt(r[col])));
    return parts.map((x, i) => (left[i] >= 0n ? (x > left[i] ? left[i] : x < 0n ? 0n : x) : (x < left[i] ? left[i] : x > 0n ? 0n : x)));
  };
  const tx = share("tax_minor", "back_tax"), ow = share("owed_minor", "back_owed");
  for (const [i, r] of rows.entries()) {
    const taxed = BigInt(r.taxable_minor) !== 0n || tx[i] !== 0n;
    await c.query(`insert into sales_order_line_tax (entity_id, sales_order_id, sales_order_line_id, jurisdiction_id, kind, sourced, item_class, rate_bps,
        taxable_minor, exempt_minor, exempt_reason, tax_minor, owed_minor, original_id) values ($1,$2,$3,$4,'return',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [entityId, e.returnOrderId, e.returnLineId, r.jurisdiction_id, r.sourced, r.item_class, r.rate_bps, (taxed ? -e.netMinor : 0n).toString(),
       (taxed ? 0n : -e.netMinor).toString(), taxed ? null : (r.exempt_reason ?? "not_taxed"), (-tx[i]).toString(), (-ow[i]).toString(), r.id]);
  }
  return tx.reduce((a, b) => a + b, 0n);
}

/** The return reached 2100: its rows are posted on that day under that entry. */
export async function postReturn(c: Client, entityId: string, returnOrderId: string, journalEntryId: string, date: string) {
  await c.query(`update sales_order_line_tax set posted_on = $3, journal_entry_id = $4
     where entity_id = $1 and sales_order_id = $2 and kind = 'return' and posted_on is null`, [entityId, returnOrderId, date, journalEntryId]);
}

/** Per jurisdiction, what an order's lines carry (for the order view and the receipt). */
export async function orderTax(c: Client, entityId: string, orderId: string) {
  return q(c, `
    select j.code, j.name, j.level, j.state, t.rate_bps, t.sourced, sum(t.taxable_minor)::text taxable_minor, sum(t.exempt_minor)::text exempt_minor,
           sum(t.tax_minor)::text tax_minor, string_agg(distinct t.exempt_reason, ', ') exempt_reasons, string_agg(distinct t.note, '; ') notes
      from sales_order_line_tax t join tax_jurisdiction j on j.id = t.jurisdiction_id and j.entity_id = t.entity_id
      join sales_order_line l on l.id = t.sales_order_line_id and l.entity_id = t.entity_id
     where t.entity_id = $1 and t.sales_order_id = $2 and l.line_status <> 'cancelled'
     group by j.code, j.name, j.level, j.state, t.rate_bps, t.sourced
     order by array_position(array['state','county','city','special','combined'], j.level), j.code`, [entityId, orderId]);
}

// ================================================================ setup

export async function taxSetup(c: Client, entityId: string) {
  const jur = await q(c, `select j.id, j.code, j.name, j.level, j.state, j.taxes_delivery, j.taxes_labor, j.taxes_warranty, j.filing_ref, j.note, j.active,
      j.for_location_id, (select r.rate_bps from tax_rate r where r.entity_id = j.entity_id and r.jurisdiction_id = j.id
        and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date)) rate_bps
    from tax_jurisdiction j where j.entity_id = $1
    order by j.state, array_position(array['state','county','city','special','combined'], j.level), j.code`, [entityId]);
  const rates = await q(c, `select id, jurisdiction_id, rate_bps, effective_from::text, effective_to::text, note from tax_rate where entity_id = $1 order by effective_from desc`, [entityId]);
  const areas = await q(c, `select a.id, a.jurisdiction_id, a.location_id, l.name location, a.state, a.postal from tax_area a left join location l on l.id = a.location_id
     where a.entity_id = $1 and a.active order by a.state nulls first, a.postal nulls first`, [entityId]);
  const locs = await q<{ id: string; name: string; kind: string; tax_rate_bps: number }>(c,
    `select id, name, kind, tax_rate_bps from location where entity_id = $1 and status = 'active' and kind in ('store','outlet') order by name`, [entityId]);
  const stores = [];
  for (const l of locs) {
    const s = await stackForLocation(c, entityId, l.id, today(), false);
    stores.push({ id: l.id, name: l.name, rateBps: goodsRate(s), stack: s.map((j) => ({ code: j.code, name: j.name, level: j.level, rateBps: j.rateBps })) });
  }
  return { sourcing: await sourcing(c, entityId), jurisdictions: jur.map((j) => ({ ...j, rates: rates.filter((r) => r.jurisdiction_id === j.id),
    areas: areas.filter((a) => a.jurisdiction_id === j.id) })), stores, levels: LEVELS };
}

export async function saveJurisdiction(c: Client, scope: Scope, e: { id?: string | null; code: string; name: string; level: string; state: string;
  taxesDelivery: boolean; taxesLabor: boolean; taxesWarranty: boolean; filingRef?: string | null; note?: string | null; active?: boolean;
  rateBps?: number; effectiveFrom?: string }) {
  const before = await storeRates(c, scope.entityId);
  const code = String(e.code ?? "").trim().toUpperCase();
  need(/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code), "a jurisdiction code is 2 to 40 letters, digits or dashes, like TX-PALESTINE");
  need(String(e.name ?? "").trim().length >= 2, "name the jurisdiction as it appears on the return");
  need((LEVELS as readonly string[]).includes(e.level) && e.level !== "combined", "a jurisdiction is a state, a county, a city or a special district");
  const st = String(e.state ?? "").trim().toUpperCase();
  need(/^[A-Z]{2}$/.test(st), "the state is two letters");
  let id = e.id ?? null;
  if (id) {
    const r = await c.query(`update tax_jurisdiction set code = $3, name = $4, level = $5, state = $6, taxes_delivery = $7, taxes_labor = $8, taxes_warranty = $9,
        filing_ref = $10, note = $11, active = $12 where id = $1 and entity_id = $2 and for_location_id is null`,
      [id, scope.entityId, code, e.name.trim(), e.level, st, !!e.taxesDelivery, !!e.taxesLabor, !!e.taxesWarranty, e.filingRef ?? null, e.note ?? null, e.active !== false]);
    need(r.rowCount, "no such jurisdiction (a store's single rate is changed on the store)");
  } else {
    const dup = await q(c, `select 1 from tax_jurisdiction where entity_id = $1 and code = $2`, [scope.entityId, code]);
    need(!dup.length, `there is already a jurisdiction ${code}`);
    need(Number.isInteger(e.rateBps) && e.rateBps! >= 0 && e.rateBps! <= 2000, "give the rate, between 0% and 20%");
    id = (await one<{ id: string }>(c, `insert into tax_jurisdiction (entity_id, code, name, level, state, taxes_delivery, taxes_labor, taxes_warranty, filing_ref, note, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, [scope.entityId, code, e.name.trim(), e.level, st, !!e.taxesDelivery, !!e.taxesLabor, !!e.taxesWarranty,
      e.filingRef ?? null, e.note ?? null, scope.actor.label])).id;
    await c.query(`insert into tax_rate (entity_id, jurisdiction_id, rate_bps, effective_from, created_by) values ($1,$2,$3,$4,$5)`,
      [scope.entityId, id, e.rateBps, isDay(e.effectiveFrom) ? e.effectiveFrom : today(), scope.actor.label]);
  }
  await audit(c, scope, { table: "tax_jurisdiction", rowId: id!, action: e.id ? "update" : "insert", after: { code, level: e.level, state: st,
    delivery: !!e.taxesDelivery, labor: !!e.taxesLabor, warranty: !!e.taxesWarranty, rateBps: e.rateBps } });
  await refreshLocationRates(c, scope.entityId, before);
  return { id };
}

/** A new rate from a day on: the rate in force before it ends the day before. */
export async function addRate(c: Client, scope: Scope, jurisdictionId: string, e: { rateBps: number; effectiveFrom: string; note?: string | null }) {
  const before = await storeRates(c, scope.entityId);
  need(Number.isInteger(e.rateBps) && e.rateBps >= 0 && e.rateBps <= 2000, "the rate must be between 0% and 20%");
  need(isDay(e.effectiveFrom), "say from which day the rate applies");
  const j = await q(c, `select id from tax_jurisdiction where id = $1 and entity_id = $2`, [jurisdictionId, scope.entityId]);
  need(j.length, "no such jurisdiction");
  const later = await q(c, `select 1 from tax_rate where entity_id = $1 and jurisdiction_id = $2 and effective_from >= $3::date`, [scope.entityId, jurisdictionId, e.effectiveFrom]);
  need(!later.length, "a rate already starts on or after that day; rates are added in date order");
  await c.query(`update tax_rate set effective_to = $3::date - 1 where entity_id = $1 and jurisdiction_id = $2 and effective_from < $3::date
      and (effective_to is null or effective_to >= $3::date)`, [scope.entityId, jurisdictionId, e.effectiveFrom]);
  const r = await one<{ id: string }>(c, `insert into tax_rate (entity_id, jurisdiction_id, rate_bps, effective_from, note, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [scope.entityId, jurisdictionId, e.rateBps, e.effectiveFrom, e.note ?? null, scope.actor.label]);
  await audit(c, scope, { table: "tax_rate", rowId: r.id, action: "insert", after: { jurisdictionId, rateBps: e.rateBps, from: e.effectiveFrom } });
  await refreshLocationRates(c, scope.entityId, before);
  return { id: r.id };
}

/** Where a jurisdiction applies: a whole state, one postal code, or one store. Taking an area off keeps its row (inactive). */
export async function saveArea(c: Client, scope: Scope, e: { jurisdictionId: string; locationId?: string | null; state?: string | null; postal?: string | null; remove?: boolean; id?: string | null }) {
  const before = await storeRates(c, scope.entityId);
  if (e.remove) {
    const r = await c.query(`update tax_area set active = false where id = $1 and entity_id = $2 and active`, [e.id, scope.entityId]);
    need(r.rowCount, "no such area");
    await audit(c, scope, { table: "tax_area", rowId: e.id!, action: "update", after: { active: false } });
    await refreshLocationRates(c, scope.entityId, before);
    return { ok: true };
  }
  const j = await q<{ state: string }>(c, `select state from tax_jurisdiction where id = $1 and entity_id = $2`, [e.jurisdictionId, scope.entityId]);
  need(j.length, "no such jurisdiction");
  let st: string | null = null, zip: string | null = null, loc: string | null = null;
  if (e.locationId) {
    const l = await q(c, `select id from location where id = $1 and entity_id = $2`, [e.locationId, scope.entityId]);
    need(l.length, "no such store");
    loc = e.locationId;
  } else {
    st = String(e.state ?? j[0].state).trim().toUpperCase();
    need(/^[A-Z]{2}$/.test(st), "the state is two letters");
    zip = String(e.postal ?? "").trim() || null;
    need(!zip || /^\d{5}$/.test(zip), "a postal code is five digits");
  }
  const dup = await q(c, `select 1 from tax_area where entity_id = $1 and jurisdiction_id = $2 and active and location_id is not distinct from $3
     and state is not distinct from $4 and postal is not distinct from $5`, [scope.entityId, e.jurisdictionId, loc, st, zip]);
  need(!dup.length, "that jurisdiction already covers that place");
  const r = await one<{ id: string }>(c, `insert into tax_area (entity_id, jurisdiction_id, location_id, state, postal) values ($1,$2,$3,$4,$5) returning id`,
    [scope.entityId, e.jurisdictionId, loc, st, zip]);
  await audit(c, scope, { table: "tax_area", rowId: r.id, action: "insert", after: { jurisdictionId: e.jurisdictionId, locationId: loc, state: st, postal: zip } });
  await refreshLocationRates(c, scope.entityId, before);
  return { id: r.id };
}

/** What each store's stack charges on goods today, before a change (null: it is on its own single rate). */
export async function storeRates(c: Client, entityId: string): Promise<Map<string, number | null>> {
  const locs = await q<{ id: string }>(c, `select id from location where entity_id = $1 and status = 'active' and kind in ('store','outlet')`, [entityId]);
  const out = new Map<string, number | null>();
  for (const l of locs) {
    const s = await stackForLocation(c, entityId, l.id, today(), false);
    out.set(l.id, s.length === 1 && s[0].level === "combined" ? null : s.length ? goodsRate(s) : null);
  }
  return out;
}

/**
 * Keep each store's single rate column showing what its stack charges on
 * goods today (the web store's preview and the receipts read it). A store
 * follows its stack only if it already did before the change; one that was
 * on its own rate (no stand-in yet, as on a database from before this
 * module) keeps that rate as a stand-in instead of being lowered or raised.
 */
export async function refreshLocationRates(c: Client, entityId: string, before?: Map<string, number | null>) {
  const locs = await q<{ id: string; tax_rate_bps: number }>(c, `select id, tax_rate_bps from location where entity_id = $1 and status = 'active' and kind in ('store','outlet')`, [entityId]);
  for (const l of locs) {
    const s = await stackForLocation(c, entityId, l.id, today(), false);
    if (!s.length || (s.length === 1 && s[0].level === "combined")) continue;
    const now = goodsRate(s);
    if (now === l.tax_rate_bps) continue;
    const was = before?.get(l.id);
    const following = before ? was === l.tax_rate_bps : false;
    if (!following && l.tax_rate_bps > 0) { await keepStoreRate(c, entityId, l.id); continue; }
    await c.query(`update location set tax_rate_bps = $3 where id = $1 and entity_id = $2`, [l.id, entityId, now]);
  }
}

/** A store's single rate changed in setup: if it is kept as a stand-in jurisdiction, the new rate applies from today. */
export async function locationRateChanged(c: Client, scope: Scope, locationId: string, rateBps: number) {
  const j = await q<{ id: string }>(c, `select id from tax_jurisdiction where entity_id = $1 and for_location_id = $2`, [scope.entityId, locationId]);
  if (!j.length) return;
  const cur = await q<{ id: string; rate_bps: number; effective_from: string }>(c, `select id, rate_bps, effective_from::text from tax_rate
     where entity_id = $1 and jurisdiction_id = $2 and effective_to is null order by effective_from desc limit 1`, [scope.entityId, j[0].id]);
  if (cur[0]?.rate_bps === rateBps) return;
  if (cur[0]?.effective_from === today()) {
    await c.query(`update tax_rate set rate_bps = $3 where id = $1 and entity_id = $2`, [cur[0].id, scope.entityId, rateBps]);
    return;
  }
  await addRate(c, scope, j[0].id, { rateBps, effectiveFrom: today(), note: "the store's rate changed in setup" });
}

/** The rate a stacked store charges, or null when its single rate column is the source. */
export async function derivedRate(c: Client, entityId: string, locationId: string): Promise<number | null> {
  const s = await stackForLocation(c, entityId, locationId, today(), false);
  if (s.length === 1 && s[0].level === "combined") return null;
  return goodsRate(s);
}

// ================================================================ filing

export type FilingRow = { jurisdictionId: string; code: string; name: string; level: string; state: string; filingRef: string | null;
  grossMinor: bigint; exemptMinor: bigint; exemptBy: Record<string, bigint>; taxableMinor: bigint; taxMinor: bigint;
  returnsMinor: bigint; returnsTaxableMinor: bigint; returnsTaxMinor: bigint; netTaxMinor: bigint;
  /** what the jurisdiction is owed, net of returns; more than netTaxMinor means tax was under-collected */
  owedMinor: bigint; underCollectedMinor: bigint };

/**
 * The filing for a period: per jurisdiction, gross sales, exempt sales by
 * reason, taxable sales, tax collected and returns, on the day each reached
 * the ledger, with any tax under- or over-collected against what was owed
 * and the ZIPs no local jurisdiction covered. It ties to everything in GL
 * 2100 for those days except payments of the tax to the state (vendor bills
 * and payments debiting 2100), which are shown on their own line; any
 * difference is reported, never hidden.
 */
export async function filing(c: Client, entityId: string, from: string, to: string) {
  need(isDay(from) && isDay(to), "pick the period: a first and a last day");
  need(from <= to, "the period ends before it starts");
  const rows = await q<{ jurisdiction_id: string; kind: string; exempt_reason: string | null; taxable: string; exempt: string; tax: string; owed: string }>(c, `
    select t.jurisdiction_id, t.kind, t.exempt_reason, sum(t.taxable_minor)::text taxable, sum(t.exempt_minor)::text exempt, sum(t.tax_minor)::text tax,
           sum(t.owed_minor)::text owed
      from sales_order_line_tax t where t.entity_id = $1 and t.posted_on between $2::date and $3::date
     group by t.jurisdiction_id, t.kind, t.exempt_reason`, [entityId, from, to]);
  const jur = await q<{ id: string; code: string; name: string; level: string; state: string; filing_ref: string | null }>(c, `
    select id, code, name, level, state, filing_ref from tax_jurisdiction where entity_id = $1
     order by state, array_position(array['state','county','city','special','combined'], level), code`, [entityId]);
  const out: FilingRow[] = [];
  for (const j of jur) {
    const mine = rows.filter((r) => r.jurisdiction_id === j.id);
    if (!mine.length) continue;
    const f: FilingRow = { jurisdictionId: j.id, code: j.code, name: j.name, level: j.level, state: j.state, filingRef: j.filing_ref,
      grossMinor: 0n, exemptMinor: 0n, exemptBy: {}, taxableMinor: 0n, taxMinor: 0n, returnsMinor: 0n, returnsTaxableMinor: 0n, returnsTaxMinor: 0n, netTaxMinor: 0n,
      owedMinor: 0n, underCollectedMinor: 0n };
    for (const r of mine) {
      const tx = BigInt(r.taxable), ex = BigInt(r.exempt), tax = BigInt(r.tax);
      f.owedMinor += BigInt(r.owed);
      if (r.kind === "sale") {
        f.grossMinor += tx + ex; f.taxableMinor += tx; f.exemptMinor += ex; f.taxMinor += tax;
        if (ex !== 0n) f.exemptBy[r.exempt_reason ?? "not_taxed"] = (f.exemptBy[r.exempt_reason ?? "not_taxed"] ?? 0n) + ex;
      } else {
        f.returnsMinor += tx + ex; f.returnsTaxableMinor += tx; f.returnsTaxMinor += tax;
      }
    }
    f.netTaxMinor = f.taxMinor + f.returnsTaxMinor;
    f.underCollectedMinor = f.owedMinor - f.netTaxMinor;
    out.push(f);
  }
  const gl = await one<{ sales: string; other: string; remitted: string }>(c, `
    select coalesce(sum(jl.credit_minor - jl.debit_minor) filter (where je.source_type in ('sale','refund')), 0)::text sales,
           coalesce(sum(jl.credit_minor - jl.debit_minor) filter (where je.source_type not in ('sale','refund')
             and not (je.source_type in ('invoice','payment') and jl.debit_minor > 0)), 0)::text other,
           coalesce(sum(jl.debit_minor) filter (where je.source_type in ('invoice','payment') and jl.debit_minor > 0), 0)::text remitted
      from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
      join gl_account g on g.id = jl.gl_account_id and g.code = '2100'
     where je.entity_id = $1 and je.posting_date between $2::date and $3::date`, [entityId, from, to]);
  const gaps = await q<{ state: string; postal: string; lines: number; tax: string }>(c, `
    select j.state, t.uncovered_postal postal, count(distinct t.sales_order_line_id)::int lines, sum(t.tax_minor)::text tax
      from sales_order_line_tax t join tax_jurisdiction j on j.id = t.jurisdiction_id and j.entity_id = t.entity_id
     where t.entity_id = $1 and t.posted_on between $2::date and $3::date and t.uncovered_postal is not null
     group by j.state, t.uncovered_postal order by j.state, t.uncovered_postal`, [entityId, from, to]);
  const off = await q<{ order_number: string; sku: string; code: string; tax: string; owed: string }>(c, `
    select so.number order_number, l.sku, j.code, t.tax_minor::text tax, t.owed_minor::text owed
      from sales_order_line_tax t join tax_jurisdiction j on j.id = t.jurisdiction_id and j.entity_id = t.entity_id
      join sales_order_line l on l.id = t.sales_order_line_id and l.entity_id = t.entity_id
      join sales_order so on so.id = t.sales_order_id and so.entity_id = t.entity_id
     where t.entity_id = $1 and t.posted_on between $2::date and $3::date and t.owed_minor <> t.tax_minor
     order by so.number, l.sku, j.code limit 200`, [entityId, from, to]);
  const collected = out.reduce((a, r) => a + r.netTaxMinor, 0n);
  const glSales = BigInt(gl.sales), glOther = BigInt(gl.other);
  const totals = out.reduce((a, r) => ({ grossMinor: a.grossMinor + r.grossMinor, exemptMinor: a.exemptMinor + r.exemptMinor, taxableMinor: a.taxableMinor + r.taxableMinor,
    taxMinor: a.taxMinor + r.taxMinor, returnsMinor: a.returnsMinor + r.returnsMinor, returnsTaxMinor: a.returnsTaxMinor + r.returnsTaxMinor, netTaxMinor: a.netTaxMinor + r.netTaxMinor,
    owedMinor: a.owedMinor + r.owedMinor, underCollectedMinor: a.underCollectedMinor + r.underCollectedMinor }),
    { grossMinor: 0n, exemptMinor: 0n, taxableMinor: 0n, taxMinor: 0n, returnsMinor: 0n, returnsTaxMinor: 0n, netTaxMinor: 0n, owedMinor: 0n, underCollectedMinor: 0n });
  const diff = glSales + glOther - collected;
  const under = totals.underCollectedMinor;
  return { from, to, rows: out, totals,
    collection: { underCollectedMinor: under, ok: under === 0n, lines: off.map((x) => ({ ...x, differenceMinor: (BigInt(x.owed) - BigInt(x.tax)).toString() })),
      note: under === 0n ? null : `Tax ${under > 0n ? "under" : "over"}-collected: ${fmt(under < 0n ? -under : under)} ${under > 0n ? "less" : "more"} was charged than the jurisdictions are owed. `
        + `The return is filed on what was owed; the lines are listed.` },
    uncoveredZips: gaps.map((g) => ({ ...g, note: `ZIP ${g.postal} in ${g.state} has no local jurisdiction set up` })),
    tie: { glSalesMinor: glSales, glOtherMinor: glOther, glRemittedMinor: BigInt(gl.remitted), collectedMinor: collected, differenceMinor: diff, ties: diff === 0n,
      note: diff === 0n ? `Tax by jurisdiction ties to GL 2100 for the period${glOther ? ` (including ${fmt(glOther)} of other 2100 entries)` : ""}; payments to the state are left out.`
        : `GL 2100 shows ${fmt(glSales)} from sales and returns${glOther ? ` and ${fmt(glOther)} from other entries (manual or bills)` : ""} for the period, but the jurisdictions add up to ${fmt(collected)}: a difference of ${fmt(diff)} to look into before filing.` } };
}

const fmt = (m: bigint) => { const neg = m < 0n; const a = neg ? -m : m; return `${neg ? "-" : ""}$${(a / 100n).toLocaleString("en-US")}.${String(a % 100n).padStart(2, "0")}`; };
const money = (m: bigint) => { const neg = m < 0n; const a = neg ? -m : m; return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`; };

/** The filing as CSV, one row per jurisdiction, with each exemption reason a column, and the 2100 tie at the foot. */
export function filingCsv(f: Awaited<ReturnType<typeof filing>>): string {
  const reasons = EXEMPT_REASONS.filter((r) => f.rows.some((x) => x.exemptBy[r]));
  const esc = (s: string) => { const v = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const head = ["Jurisdiction code", "Jurisdiction", "Level", "State", "Filing account", "Gross sales", "Exempt sales", ...reasons.map((r) => `Exempt: ${EXEMPT_LABEL[r]}`),
    "Taxable sales", "Tax collected", "Returns", "Returns taxable", "Tax refunded", "Net tax collected", "Tax owed", "Under-collected (+) / over-collected (-)"];
  const lines = [head.map(esc).join(",")];
  for (const r of f.rows) lines.push([esc(r.code), esc(r.name), r.level, r.state, esc(r.filingRef ?? ""), money(r.grossMinor), money(r.exemptMinor),
    ...reasons.map((x) => money(r.exemptBy[x] ?? 0n)), money(r.taxableMinor), money(r.taxMinor), money(r.returnsMinor), money(r.returnsTaxableMinor),
    money(r.returnsTaxMinor), money(r.netTaxMinor), money(r.owedMinor), money(r.underCollectedMinor)].join(","));
  lines.push("");
  lines.push(["Period", f.from, f.to].join(","));
  lines.push(["GL 2100 sales and returns", money(f.tie.glSalesMinor)].join(","));
  lines.push(["GL 2100 other entries (manual, bills)", money(f.tie.glOtherMinor)].join(","));
  lines.push(["GL 2100 paid to the state (not in the tie)", money(f.tie.glRemittedMinor)].join(","));
  lines.push(["Jurisdictions total", money(f.tie.collectedMinor)].join(","));
  lines.push(["Difference", money(f.tie.differenceMinor), f.tie.ties ? "ties" : "DOES NOT TIE"].join(","));
  if (!f.collection.ok) lines.push(["Tax under/over-collected", money(f.collection.underCollectedMinor), esc(f.collection.note ?? "")].join(","));
  for (const z of f.uncoveredZips) lines.push(["ZIP not covered by local tax", z.state, z.postal, String(z.lines)].join(","));
  return lines.join("\r\n") + "\r\n";
}
