// Warehouse management: containers and freight from the vendor to the DC,
// goods in transit, and the prep queue (unbox, inspect, touch-up, steam,
// assemble). It extends inventory and purchasing and goes through them:
// receiving is inventory.receivePurchaseOrder, a container's freight and duty
// is purchasing's landed cost, an ETA moves PO lines and special orders by
// purchasing.setLineEta, and a prep problem is inventory.reportDamage.
//
// A container's stages, in order:
//   booked → departed → at port → customs cleared → on rail / drayage →
//   delivered to DC → unloaded
// each with an expected and an actual day. When it reaches the DC is the
// later of "delivered to DC" (actual, else expected) and, failing that,
// "unloaded"; that is the day its PO lines, and the customers waiting on
// them, are told.

import { today as bizToday } from "./clock.ts";
import { q, one, audit, tx, type Client, type Scope } from "./db.ts";
import * as inv from "./inventory.ts";
import * as pur from "./purchasing.ts";

export class WmsError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new WmsError(msg); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const words = (s: string) => s.replace(/_/g, " ");

export const STAGES = ["booked", "departed", "at_port", "customs_cleared", "on_rail", "delivered_dc", "unloaded"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  booked: "Booked", departed: "Departed", at_port: "At port", customs_cleared: "Customs cleared",
  on_rail: "On rail / drayage", delivered_dc: "Delivered to DC", unloaded: "Unloaded",
};
export const COST_KINDS = ["freight", "drayage", "duty", "tariff", "port_fees", "other"];
export const COST_BASES = ["cube", "value", "weight", "qty"];
export const PREP_TYPES = ["unbox", "inspect", "touch_up", "steam", "assemble"] as const;
export const PREP_GATES = ["off", "warn", "refuse"];

const CONTAINER_NO = /^[A-Z0-9-]{4,20}$/;
const cleanNo = (v: unknown) => String(v ?? "").toUpperCase().replace(/\s+/g, "");
const text = (v: unknown, max = 120) => String(v ?? "").trim().slice(0, max) || null;

// ================================================================ containers

type ContainerRow = { id: string; number: string; container_no: string | null; dest_location_id: string; vendor_id: string | null; stage: Stage };

async function containerOf(c: Client, entityId: string, id: string, lock = true): Promise<ContainerRow> {
  need(/^[0-9a-f-]{36}$/i.test(String(id ?? "")), "no such container");
  const r = await q<ContainerRow>(c, `select id, number, container_no, dest_location_id, vendor_id, stage from wms_container
     where id = $1 and entity_id = $2 ${lock ? "for update" : ""}`, [id, entityId]);
  need(r.length, "no such container");
  return r[0];
}

export type ContainerIn = { containerNo?: string | null; carrier?: string | null; vessel?: string | null; voyage?: string | null; bol?: string | null;
  portLoading?: string | null; portDischarge?: string | null; destLocationId: string; vendorId?: string | null; note?: string | null;
  etaDc?: string | null; bookedOn?: string | null };

/** Book a container (or a domestic trailer): where it is coming into, and what we know of it so far. */
export async function createContainer(c: Client, s: Scope, e: ContainerIn) {
  const no = e.containerNo ? cleanNo(e.containerNo) : null;
  if (no) {
    need(CONTAINER_NO.test(no), "a container number is 4 to 20 letters and digits, like MSCU1234567");
    const dup = await q<{ number: string }>(c, `select number from wms_container where entity_id = $1 and upper(container_no) = $2`, [s.entityId, no]);
    need(!dup.length, `container ${no} is already booked as ${dup[0]?.number}`);
  }
  const loc = await q<{ id: string; kind: string; name: string }>(c, `select id, kind, name from location where id = $1 and entity_id = $2 and status = 'active'`,
    [e.destLocationId, s.entityId]);
  need(loc.length, "pick the warehouse or store it is coming into");
  need(!inv.VIRTUAL_KINDS.includes(loc[0].kind), `${loc[0].name} is not a place a container is unloaded`);
  if (e.vendorId) {
    const v = await q(c, `select 1 from vendor_entity where entity_id = $1 and vendor_id = $2 and status = 'active'`, [s.entityId, e.vendorId]);
    need(v.length, "that vendor is not active for this company");
  }
  if (e.etaDc) need(DAY.test(e.etaDc), "the arrival day is a date, like 2026-12-01");
  const bookedOn = e.bookedOn && DAY.test(e.bookedOn) && e.bookedOn <= (await bizToday(c, s)) ? e.bookedOn : (await bizToday(c, s));
  const number = await inv.nextNo(c, s.entityId, "container", "CT-");
  const ct = await one<{ id: string }>(c, `insert into wms_container (entity_id, number, container_no, carrier, vessel, voyage, bol, port_loading, port_discharge,
      dest_location_id, vendor_id, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [s.entityId, number, no, text(e.carrier, 80), text(e.vessel, 80), text(e.voyage, 40), text(e.bol, 60), text(e.portLoading, 80), text(e.portDischarge, 80),
     e.destLocationId, e.vendorId ?? null, text(e.note, 500), s.actor.id || null]);
  for (const st of STAGES) {
    await c.query(`insert into wms_container_stage (entity_id, container_id, stage, expected_on, actual_on, updated_by) values ($1,$2,$3,$4,$5,$6)`,
      [s.entityId, ct.id, st, st === "delivered_dc" ? e.etaDc ?? null : null, st === "booked" ? bookedOn : null, s.actor.id || null]);
  }
  await audit(c, s, { table: "wms_container", rowId: ct.id, action: "insert", after: { number, containerNo: no, dest: loc[0].name } });
  return { id: ct.id, number };
}

/** Change what we know about a container: number, carrier, vessel, bill of lading, ports. */
export async function editContainer(c: Client, s: Scope, id: string, e: Partial<ContainerIn>) {
  const ct = await containerOf(c, s.entityId, id);
  const no = e.containerNo !== undefined ? (e.containerNo ? cleanNo(e.containerNo) : null) : ct.container_no;
  if (no && no !== ct.container_no) {
    need(CONTAINER_NO.test(no), "a container number is 4 to 20 letters and digits, like MSCU1234567");
    const dup = await q<{ number: string }>(c, `select number from wms_container where entity_id = $1 and upper(container_no) = $2 and id <> $3`, [s.entityId, no, id]);
    need(!dup.length, `container ${no} is already booked as ${dup[0]?.number}`);
  }
  const keep = (v: unknown, max: number) => (v === undefined ? undefined : text(v, max));
  const vals = { carrier: keep(e.carrier, 80), vessel: keep(e.vessel, 80), voyage: keep(e.voyage, 40), bol: keep(e.bol, 60),
    port_loading: keep(e.portLoading, 80), port_discharge: keep(e.portDischarge, 80), note: keep(e.note, 500) };
  await c.query(`update wms_container set container_no = $3,
      carrier = case when $4::boolean then $5 else carrier end, vessel = case when $6::boolean then $7 else vessel end,
      voyage = case when $8::boolean then $9 else voyage end, bol = case when $10::boolean then $11 else bol end,
      port_loading = case when $12::boolean then $13 else port_loading end, port_discharge = case when $14::boolean then $15 else port_discharge end,
      note = case when $16::boolean then $17 else note end
    where id = $1 and entity_id = $2`,
    [id, s.entityId, no, vals.carrier !== undefined, vals.carrier ?? null, vals.vessel !== undefined, vals.vessel ?? null, vals.voyage !== undefined, vals.voyage ?? null,
     vals.bol !== undefined, vals.bol ?? null, vals.port_loading !== undefined, vals.port_loading ?? null, vals.port_discharge !== undefined, vals.port_discharge ?? null,
     vals.note !== undefined, vals.note ?? null]);
  await audit(c, s, { table: "wms_container", rowId: id, action: "update", after: { containerNo: no, ...vals } });
  return { number: ct.number };
}

type OpenPoLine = { id: string; seq: number; po_id: string; po_number: string; po_status: string; ship_to: string | null; vendor_id: string;
  product_id: string | null; sku: string | null; open: string };

async function poLine(c: Client, entityId: string, id: string): Promise<OpenPoLine> {
  const r = await q<OpenPoLine>(c, `
    select pol.id, pol.seq, po.id po_id, po.number po_number, po.status po_status, po.ship_to_location_id ship_to, po.vendor_id, pol.product_id, p.sku,
           (pol.quantity - pol.cancelled_qty - coalesce((select sum(g.quantity) from goods_receipt_line g where g.purchase_order_line_id = pol.id), 0))::text open
      from purchase_order_line pol join purchase_order po on po.id = pol.purchase_order_id left join product p on p.id = pol.product_id
     where pol.id = $1 and pol.entity_id = $2 for update of pol`, [id, entityId]);
  need(r.length, "no such purchase order line");
  return r[0];
}

/**
 * Put PO lines on a container, with how many of each it carries. Setting a
 * line again changes its quantity (never below what was received from this
 * container). A container carries no more of a line than is left on order
 * once the other containers carrying it are counted.
 */
export async function setContainerLines(c: Client, s: Scope, containerId: string, lines: { poLineId: string; qty: number }[]) {
  const ct = await containerOf(c, s.entityId, containerId);
  need(ct.stage !== "unloaded", `${ct.number} is unloaded; its contents are settled`);
  need(Array.isArray(lines) && lines.length, "say which purchase order lines are on the container");
  const seen = new Set<string>();
  const touched: string[] = [];
  for (const l of lines) {
    need(!seen.has(l.poLineId), "each purchase order line once");
    seen.add(l.poLineId);
    const pl = await poLine(c, s.entityId, l.poLineId);
    need(pl.po_status === "open", `${pl.po_number} is ${pl.po_status}; only an open order's lines go on a container`);
    need(pl.product_id, `line ${pl.seq} of ${pl.po_number} names no product`);
    const qty = Number(l.qty);
    need(Number.isFinite(qty) && qty > 0, `say how many of line ${pl.seq} (${pl.sku}) are on the container`);
    const mine = (await q<{ qty: string; received_qty: string }>(c, `select qty, received_qty from wms_container_line
       where entity_id = $1 and container_id = $2 and purchase_order_line_id = $3 for update`, [s.entityId, containerId, pl.id]))[0];
    const elsewhere = Number((await q<{ n: string }>(c, `select coalesce(sum(qty - received_qty), 0)::text n from wms_container_line
       where entity_id = $1 and purchase_order_line_id = $2 and container_id <> $3`, [s.entityId, pl.id, containerId]))[0].n);
    const receivedHere = Number(mine?.received_qty ?? 0);
    need(qty >= receivedHere, `${receivedHere} of line ${pl.seq} (${pl.sku}) were already received from ${ct.number}`);
    const room = Number(pl.open) + receivedHere - elsewhere;
    need(qty <= room, `line ${pl.seq} of ${pl.po_number} (${pl.sku}) has ${Math.max(room, 0)} left to put on a container, not ${qty}`);
    if (mine) await c.query(`update wms_container_line set qty = $4 where entity_id = $1 and container_id = $2 and purchase_order_line_id = $3`, [s.entityId, containerId, pl.id, qty]);
    else await c.query(`insert into wms_container_line (entity_id, container_id, purchase_order_line_id, qty) values ($1,$2,$3,$4)`, [s.entityId, containerId, pl.id, qty]);
    touched.push(pl.id);
  }
  await audit(c, s, { table: "wms_container_line", rowId: containerId, action: "update", after: { lines: lines.map((x) => ({ poLineId: x.poLineId, qty: x.qty })) } });
  await spreadCosts(c, s, containerId);
  const moved = await flowEta(c, s, touched, `${ct.number} carries them`);
  return { number: ct.number, lines: touched.length, etaMoved: moved };
}

/** When a container reaches the DC: delivered to DC (actual, else expected), else unloaded (actual, else expected). */
async function arrivalOf(c: Client, entityId: string, containerId: string): Promise<string | null> {
  const r = await q<{ d: string | null }>(c, `
    select coalesce(max(actual_on) filter (where stage = 'delivered_dc'), max(expected_on) filter (where stage = 'delivered_dc'),
                    max(actual_on) filter (where stage = 'unloaded'), max(expected_on) filter (where stage = 'unloaded'))::text d
      from wms_container_stage where entity_id = $1 and container_id = $2`, [entityId, containerId]);
  return r[0]?.d ?? null;
}

/**
 * Move the PO lines (and the special orders on them) to the latest arrival
 * of the containers still carrying some of each. Lines with nothing left on
 * any container keep their date.
 */
async function flowEta(c: Client, s: Scope, poLineIds: string[], why: string): Promise<number> {
  if (!poLineIds.length) return 0;
  const rows = await q<{ purchase_order_line_id: string; eta: string | null }>(c, `
    select cl.purchase_order_line_id,
           max(coalesce(
             (select coalesce(st.actual_on, st.expected_on) from wms_container_stage st where st.entity_id = cl.entity_id and st.container_id = cl.container_id and st.stage = 'delivered_dc'),
             (select coalesce(st.actual_on, st.expected_on) from wms_container_stage st where st.entity_id = cl.entity_id and st.container_id = cl.container_id and st.stage = 'unloaded')))::text eta
      from wms_container_line cl
     where cl.entity_id = $1 and cl.purchase_order_line_id = any($2) and cl.qty > cl.received_qty
     group by cl.purchase_order_line_id`, [s.entityId, poLineIds]);
  const byDay = new Map<string, string[]>();
  for (const r of rows) if (r.eta) byDay.set(r.eta, [...(byDay.get(r.eta) ?? []), r.purchase_order_line_id]);
  let n = 0;
  for (const [day, ids] of byDay) n += await pur.setLineEta(c, s, ids, day, why);
  return n;
}

/**
 * Record a stage: when it is expected, and when it happened. An actual day
 * cannot be in the future or before an earlier stage's actual day. The
 * container's stage is the furthest one that has happened, and a new
 * arrival day reaches the PO lines and customers' orders it carries.
 */
export async function setStage(c: Client, s: Scope, containerId: string, stage: string, e: { expectedOn?: string | null; actualOn?: string | null }) {
  const ct = await containerOf(c, s.entityId, containerId);
  need((STAGES as readonly string[]).includes(stage), `a container stage is one of: ${STAGES.map((x) => STAGE_LABEL[x].toLowerCase()).join(", ")}`);
  for (const d of [e.expectedOn, e.actualOn]) if (d) need(DAY.test(d), "the stage dates are dates, like 2026-12-01");
  if (e.actualOn) need(e.actualOn <= (await bizToday(c, s)), `${STAGE_LABEL[stage as Stage]} cannot have happened on ${e.actualOn}; that is in the future. Put it as the expected day`);
  const all = await q<{ stage: Stage; expected_on: string | null; actual_on: string | null }>(c, `select stage, expected_on::text, actual_on::text from wms_container_stage
     where entity_id = $1 and container_id = $2`, [s.entityId, containerId]);
  const idx = STAGES.indexOf(stage as Stage);
  if (e.actualOn) {
    for (const x of all) {
      const j = STAGES.indexOf(x.stage);
      if (j < idx && x.actual_on && x.actual_on > e.actualOn) need(false, `${STAGE_LABEL[x.stage]} happened on ${x.actual_on}, so ${STAGE_LABEL[stage as Stage].toLowerCase()} cannot be earlier`);
      if (j > idx && x.actual_on && x.actual_on < e.actualOn) need(false, `${STAGE_LABEL[x.stage]} happened on ${x.actual_on}, so ${STAGE_LABEL[stage as Stage].toLowerCase()} cannot be later`);
    }
  }
  const before = await arrivalOf(c, s.entityId, containerId);
  await c.query(`update wms_container_stage set expected_on = case when $4::boolean then $5::date else expected_on end,
                        actual_on = case when $6::boolean then $7::date else actual_on end, updated_by = $8, updated_at = now()
                  where entity_id = $1 and container_id = $2 and stage = $3`,
    [s.entityId, containerId, stage, e.expectedOn !== undefined, e.expectedOn || null, e.actualOn !== undefined, e.actualOn || null, s.actor.id || null]);
  const furthest = (await q<{ stage: Stage }>(c, `select stage from wms_container_stage where entity_id = $1 and container_id = $2 and actual_on is not null`,
    [s.entityId, containerId])).map((x) => x.stage).sort((a, b) => STAGES.indexOf(b) - STAGES.indexOf(a))[0] ?? "booked";
  await c.query(`update wms_container set stage = $3 where id = $1 and entity_id = $2`, [containerId, s.entityId, furthest]);
  const after = await arrivalOf(c, s.entityId, containerId);
  let moved = 0;
  if (after && after !== before) {
    const lines = await q<{ id: string }>(c, `select purchase_order_line_id id from wms_container_line where entity_id = $1 and container_id = $2`, [s.entityId, containerId]);
    moved = await flowEta(c, s, lines.map((x) => x.id), `${ct.number} ${STAGE_LABEL[stage as Stage].toLowerCase()} ${e.actualOn ? "on" : "expected"} ${e.actualOn || e.expectedOn}`);
  }
  await audit(c, s, { table: "wms_container_stage", rowId: containerId, action: "update", after: { stage, ...e, containerStage: furthest, arrival: after } });
  return { number: ct.number, stage: furthest, arrivalOn: after, etaMoved: moved };
}

// --------------------------------------------------------------- costs --

/** Freight, drayage, duty, tariff or port fees on a container, spread over what it carries by cube, value, weight or quantity. */
export async function addContainerCost(c: Client, s: Scope, containerId: string, e: { kind: string; amountMinor: bigint; basis: string; note?: string | null }) {
  const ct = await containerOf(c, s.entityId, containerId);
  need(COST_KINDS.includes(e.kind), "a container cost is freight, drayage, duty, tariff, port fees or other");
  need(COST_BASES.includes(e.basis), "spread it by cube, value, weight or quantity");
  need(typeof e.amountMinor === "bigint" && e.amountMinor > 0n, "say the amount");
  const r = await one<{ id: string }>(c, `insert into wms_container_cost (entity_id, container_id, kind, amount_minor, basis, note, created_by)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`, [s.entityId, containerId, e.kind, e.amountMinor.toString(), e.basis, text(e.note, 300), s.actor.id || null]);
  await audit(c, s, { table: "wms_container_cost", rowId: r.id, action: "insert", after: { container: ct.number, kind: e.kind, amountMinor: e.amountMinor.toString(), basis: e.basis } });
  const spread = await spreadCosts(c, s, containerId);
  return { id: r.id, number: ct.number, shares: spread.shares };
}

/** How much of a line's share belongs to `received` of its `qty` units: in proportion, the last unit taking whatever is left. */
const shareFor = (landed: bigint, received: number, qty: number): bigint =>
  qty <= 0 || received >= qty ? (received > 0 || qty <= 0 ? landed : 0n) : received <= 0 ? 0n : (landed * BigInt(Math.round(received * 1000))) / BigInt(Math.round(qty * 1000));

/**
 * Spread every cost on a container over its lines again (the last line takes
 * the rounding; with nothing to weigh by, quantity decides). Each line's
 * share rides on that container's own units: the units still to come off
 * take it at receipt; for units already received the difference is put on
 * them now -- the ones still on hand are revalued (1300) and the ones already
 * sold go to cost of goods (5000), against 2050. The shares are also written
 * to purchasing's landed cost per PO line (old rows retired, never deleted)
 * so payables sees what a PO's freight and duty came to.
 */
export async function spreadCosts(c: Client, s: Scope, containerId: string) {
  const costs = await q<{ id: string; kind: string; amount_minor: string; basis: string }>(c, `select id, kind, amount_minor::text, basis from wms_container_cost
     where entity_id = $1 and container_id = $2 order by created_at`, [s.entityId, containerId]);
  await pur.retireContainerShares(c, s.entityId, costs.map((x) => x.id));
  const lines = await q<{ id: string; pol_id: string; qty: string; received_qty: string; landed_minor: string; applied: string; unit: string; cube: string | null;
    weight: string | null; sku: string | null; name: string | null; product_id: string; serialized: boolean; dest: string; po_number: string }>(c, `
    select cl.id, cl.purchase_order_line_id pol_id, cl.qty::text, cl.received_qty::text, cl.landed_minor::text, cl.landed_applied_minor::text applied,
           pol.unit_price_minor::text unit, p.cubic_ft::text cube, p.weight_lb::text weight, p.sku, p.name, p.id product_id, p.serialized,
           ct.dest_location_id dest, po.number po_number
      from wms_container_line cl join wms_container ct on ct.id = cl.container_id
      join purchase_order_line pol on pol.id = cl.purchase_order_line_id join purchase_order po on po.id = pol.purchase_order_id
      join product p on p.id = pol.product_id
     where cl.entity_id = $1 and cl.container_id = $2 order by po.number, pol.seq for update of cl`, [s.entityId, containerId]);
  const shares: { poLineId: string; kind: string; amountMinor: bigint }[] = [];
  if (!lines.length) return { shares, revalued: 0n };
  const total = new Map(lines.map((l) => [l.id, 0n]));
  for (const k of costs) {
    const weigh = (basis: string) => lines.map((l) => {
      const qn = Number(l.qty);
      if (basis === "cube") { need(l.cube != null, `${l.name ?? l.sku} has no cube in the catalog; add it, or spread the ${words(k.kind)} by value`); return qn * Number(l.cube); }
      if (basis === "weight") { need(l.weight != null, `${l.name ?? l.sku} has no weight in the catalog; add it, or spread the ${words(k.kind)} by value`); return qn * Number(l.weight); }
      if (basis === "qty") return qn;
      return qn * Number(l.unit);
    }).map((v) => BigInt(Math.round(v * 1000)));
    let w = weigh(k.basis);
    if (w.every((x) => x === 0n)) w = weigh("qty");                // everything weighs nothing: by quantity
    const live = w.map((x, i) => (x > 0n ? i : -1)).filter((i) => i >= 0);
    const lastIdx = live.length ? live[live.length - 1] : lines.length - 1;
    const tw = w.reduce((a, b) => a + b, 0n);
    const amount = BigInt(k.amount_minor);
    let left = amount;
    for (const [i, l] of lines.entries()) {
      const share = i === lastIdx ? left : tw > 0n ? (amount * w[i]) / tw : 0n;
      left -= share;
      total.set(l.id, total.get(l.id)! + share);
      shares.push({ poLineId: l.pol_id, kind: k.kind, amountMinor: share });
      await pur.addLineLandedCost(c, s, l.pol_id, { kind: k.kind, amountMinor: share, containerCostId: k.id, note: `container share (${k.basis})` });
    }
  }
  let revalued = 0n;
  for (const l of lines) {
    const landed = total.get(l.id)!;
    const received = Number(l.received_qty), qty = Number(l.qty);
    const delta = shareFor(landed, received, qty) - BigInt(l.applied);
    if (delta !== 0n) {
      // The units that came off this container for this line, and how many are still ours.
      let units: string[] = [];
      let onHand: number;
      if (l.serialized) {
        const u = await q<{ unit_id: string; here: boolean }>(c, `
          select pc.unit_id, bool_and(pc.status = any($4)) here from inv_piece pc
            join goods_receipt_line gl on gl.id = pc.goods_receipt_line_id
            join wms_container_receipt cr on cr.goods_receipt_id = gl.goods_receipt_id and cr.entity_id = pc.entity_id
           where pc.entity_id = $1 and cr.container_id = $2 and gl.purchase_order_line_id = $3 group by pc.unit_id`,
          [s.entityId, containerId, l.pol_id, inv.ON_HAND]);
        units = u.filter((x) => x.here).map((x) => x.unit_id);
        onHand = Math.min(units.length, received);
      } else {
        const oh = await q<{ n: string }>(c, `select coalesce(sum(on_hand), 0)::text n from stock_level where entity_id = $1 and product_id = $2`, [s.entityId, l.product_id]);
        onHand = Math.max(0, Math.min(received, Number(oh[0].n)));
      }
      const here = received > 0 ? (delta * BigInt(Math.round(onHand * 1000))) / BigInt(Math.round(received * 1000)) : 0n;
      await inv.revalue(c, s, { productId: l.product_id, locationId: l.dest, onHandMinor: here, goneMinor: delta - here, unitIds: units,
        sourceId: containerId, description: `Container freight and duty on ${received} of ${l.sku} already received (${l.po_number})` });
      revalued += delta;
    }
    await c.query(`update wms_container_line set landed_minor = $3, landed_applied_minor = landed_applied_minor + $4 where id = $1 and entity_id = $2`,
      [l.id, s.entityId, landed.toString(), delta.toString()]);
  }
  return { shares, revalued };
}

// ------------------------------------------------------------ receiving --

/**
 * Unload some or all of a container into its destination. Each PO it
 * carries is received through inventory (pieces, labels, special orders,
 * the prep queue), each unit carrying this container's freight and duty
 * share; what is not counted in stays on the container for a later receipt.
 * The first receipt marks it delivered to the DC; the last one, unloaded.
 */
export async function receiveContainer(c: Client, s: Scope, containerId: string, e: { binId?: string | null; note?: string | null;
  lines: { containerLineId: string; qty: number; damagedQty?: number; damageNote?: string }[] }) {
  const ct = await containerOf(c, s.entityId, containerId);
  need(ct.stage !== "unloaded", `${ct.number} is already unloaded`);
  need(Array.isArray(e.lines) && e.lines.filter((x) => Number(x.qty) > 0).length, "say what came off the container");
  const cls = await q<{ id: string; pol_id: string; po_id: string; po_number: string; po_kind: string; qty: string; received_qty: string; sku: string | null;
    landed_minor: string; applied: string }>(c, `
    select cl.id, cl.purchase_order_line_id pol_id, pol.purchase_order_id po_id, po.number po_number, po.kind po_kind, cl.qty::text, cl.received_qty::text, p.sku,
           cl.landed_minor::text, cl.landed_applied_minor::text applied
      from wms_container_line cl join purchase_order_line pol on pol.id = cl.purchase_order_line_id join purchase_order po on po.id = pol.purchase_order_id
      left join product p on p.id = pol.product_id
     where cl.entity_id = $1 and cl.container_id = $2 for update of cl`, [s.entityId, containerId]);
  const byPo = new Map<string, inv.ReceiveLine[]>();
  const counted: { id: string; qty: number; extra: bigint }[] = [];
  for (const l of e.lines) {
    const qty = Number(l.qty);
    if (!(qty > 0)) continue;
    const cl = cls.find((x) => x.id === l.containerLineId);
    need(cl, `that line is not on ${ct.number}`);
    need(!counted.some((x) => x.id === cl!.id), "each container line once per receipt");
    const left = Number(cl!.qty) - Number(cl!.received_qty);
    need(qty <= left, `${cl!.sku ?? "that line"} on ${ct.number}: ${left} left to unload, not ${qty}`);
    // This container's share for these units: what the received count reaches, less what is already on goods.
    const extra = shareFor(BigInt(cl!.landed_minor), Number(cl!.received_qty) + qty, Number(cl!.qty)) - BigInt(cl!.applied);
    byPo.set(cl!.po_id, [...(byPo.get(cl!.po_id) ?? []), { poLineId: cl!.pol_id, qty, damagedQty: l.damagedQty, damageNote: l.damageNote, extraMinor: extra > 0n ? extra : 0n }]);
    counted.push({ id: cl!.id, qty, extra: extra > 0n ? extra : 0n });
  }
  const receipts: { poNumber: string; receiptId: string; prepQueued: number; lines: number }[] = [];
  // Customers' special orders first, so their own goods off this container are the ones put on their orders.
  const order = [...byPo.keys()].sort((a, b) => Number(cls.find((x) => x.po_id === b)!.po_kind === "special") - Number(cls.find((x) => x.po_id === a)!.po_kind === "special"));
  for (const poId of order) {
    const lines = byPo.get(poId)!;
    const r = await inv.receivePurchaseOrder(c, s, { purchaseOrderId: poId, locationId: ct.dest_location_id, binId: e.binId ?? null, lines,
      note: [`from container ${ct.container_no ?? ct.number}`, text(e.note, 200)].filter(Boolean).join(". ") });
    await c.query(`insert into wms_container_receipt (entity_id, container_id, goods_receipt_id) values ($1,$2,$3)`, [s.entityId, containerId, r.receiptId]);
    receipts.push({ poNumber: r.poNumber, receiptId: r.receiptId, prepQueued: r.prepQueued, lines: r.lines.length });
  }
  for (const x of counted) await c.query(`update wms_container_line set received_qty = received_qty + $3, landed_applied_minor = landed_applied_minor + $4
      where id = $1 and entity_id = $2`, [x.id, s.entityId, x.qty, x.extra.toString()]);
  const at = await q<{ stage: Stage; actual_on: string | null }>(c, `select stage, actual_on::text from wms_container_stage where entity_id = $1 and container_id = $2`, [s.entityId, containerId]);
  if (!at.find((x) => x.stage === "delivered_dc")?.actual_on) await setStage(c, s, containerId, "delivered_dc", { actualOn: (await bizToday(c, s)) });
  const fin = await finishIfDone(c, s, containerId);
  return { number: ct.number, receipts, unloaded: fin.done, linesLeft: fin.left };
}

/** A container with nothing left outstanding on any line is finished (unloaded). */
async function finishIfDone(c: Client, s: Scope, containerId: string): Promise<{ done: boolean; left: number }> {
  const rest = await q<{ n: string }>(c, `select count(*)::text n from wms_container_line where entity_id = $1 and container_id = $2 and received_qty < qty`, [s.entityId, containerId]);
  const left = Number(rest[0].n);
  const st = await q<{ stage: string }>(c, `select stage from wms_container where entity_id = $1 and id = $2`, [s.entityId, containerId]);
  if (left === 0 && st[0]?.stage !== "unloaded") await setStage(c, s, containerId, "unloaded", { actualOn: (await bizToday(c, s)) });
  return { done: left === 0, left };
}

/**
 * The vendor cut a PO line back (an acknowledgment) or the PO was cancelled:
 * the containers carrying it are trimmed to what is still to come (latest
 * arrival first, never below what came off them), their costs re-spread, and
 * a container left with nothing outstanding is finished.
 */
export async function trimForPoLine(c: Client, s: Scope, poLineId: string) {
  const pl = (await q<{ open: string }>(c, `select (pol.quantity - pol.cancelled_qty - coalesce((select sum(g.quantity) from goods_receipt_line g
       where g.purchase_order_line_id = pol.id), 0))::text open from purchase_order_line pol where pol.id = $1 and pol.entity_id = $2`, [poLineId, s.entityId]))[0];
  if (!pl) return { trimmed: 0 };
  const cls = await q<{ id: string; container_id: string; qty: string; received_qty: string }>(c, `
    select cl.id, cl.container_id, cl.qty::text, cl.received_qty::text from wms_container_line cl join wms_container ct on ct.id = cl.container_id
     where cl.entity_id = $1 and cl.purchase_order_line_id = $2 and cl.qty > cl.received_qty
     order by (select coalesce(st.actual_on, st.expected_on) from wms_container_stage st where st.entity_id = cl.entity_id and st.container_id = cl.container_id and st.stage = 'delivered_dc') desc nulls first,
              ct.created_at desc for update of cl`, [s.entityId, poLineId]);
  let excess = cls.reduce((a, x) => a + Number(x.qty) - Number(x.received_qty), 0) - Math.max(0, Number(pl.open));
  const touched = new Set<string>();
  for (const x of cls) {
    if (excess <= 0) break;
    const cut = Math.min(excess, Number(x.qty) - Number(x.received_qty));
    await c.query(`update wms_container_line set qty = qty - $3 where id = $1 and entity_id = $2`, [x.id, s.entityId, cut]);
    excess -= cut;
    touched.add(x.container_id);
  }
  for (const id of touched) {
    await spreadCosts(c, s, id);
    await finishIfDone(c, s, id);
  }
  if (touched.size) await audit(c, s, { table: "wms_container_line", rowId: poLineId, action: "update", after: { trimmedOn: [...touched] }, reason: "the vendor cut the PO line" });
  return { trimmed: touched.size };
}

// ---------------------------------------------------------- ship notices --

/**
 * An 856 that names a container or trailer: the notice is attached to it, and
 * the shipped lines go on it. A container we had not booked yet is opened
 * from the notice, already departed. What cannot go on it (the container is
 * already unloaded, or the line is all on another container) is left off with
 * a note; the notice itself still stands.
 */
export async function attachShipment(c: Client, s: Scope, e: { equipment: string; vendorId: string; carrier?: string | null; bol?: string | null;
  shippedOn?: string | null; deliveryOn?: string | null; shipped: { shipmentId: string; poLineId: string; qty: number }[] }):
  Promise<{ id: string | null; number: string | null; containerNo: string; notes: string[] }> {
  const no = cleanNo(e.equipment);
  const notes: string[] = [];
  if (!CONTAINER_NO.test(no)) return { id: null, number: null, containerNo: no, notes: [`equipment ${e.equipment} is not a container or trailer number, so the notice is kept without one`] };
  if (!e.shipped.length) return { id: null, number: null, containerNo: no, notes };
  let ct = (await q<{ id: string; number: string; stage: string }>(c, `select id, number, stage from wms_container where entity_id = $1 and upper(container_no) = $2 for update`, [s.entityId, no]))[0];
  if (ct?.stage === "unloaded") return { id: ct.id, number: ct.number, containerNo: no, notes: [`container ${no} (${ct.number}) is already unloaded, so the notice is kept without it`] };
  // What fits: each shipped line up to what is left to put on a container.
  const want = new Map<string, number>();
  for (const x of e.shipped) want.set(x.poLineId, (want.get(x.poLineId) ?? 0) + x.qty);
  const set: { poLineId: string; qty: number }[] = [];
  for (const [polId, qty] of want) {
    const pl = await poLine(c, s.entityId, polId);
    const mine = ct ? (await q<{ qty: string; received_qty: string }>(c, `select qty::text, received_qty::text from wms_container_line where entity_id = $1 and container_id = $2
       and purchase_order_line_id = $3`, [s.entityId, ct.id, polId]))[0] : undefined;
    const have = Number(mine?.qty ?? 0);
    if (have >= qty) continue;
    const elsewhere = Number((await q<{ n: string }>(c, `select coalesce(sum(qty - received_qty), 0)::text n from wms_container_line
       where entity_id = $1 and purchase_order_line_id = $2 and ($3::uuid is null or container_id <> $3)`, [s.entityId, polId, ct?.id ?? null]))[0].n);
    const room = Number(pl.open) + Number(mine?.received_qty ?? 0) - elsewhere;
    const fit = Math.min(qty, room);
    if (fit > have) set.push({ poLineId: polId, qty: fit });
    if (fit < qty) notes.push(`${pl.po_number} line ${pl.seq} (${pl.sku}): ${qty - Math.max(fit, have, 0)} already sit on another container, so they were left off ${no}`);
  }
  if (!ct) {
    if (!set.length) return { id: null, number: null, containerNo: no, notes: [...notes, `nothing on the notice could go on ${no}, so no container was opened`] };
    const first = await poLine(c, s.entityId, set[0].poLineId);
    need(first.ship_to, `${first.po_number} has no ship-to`);
    const made = await createContainer(c, s, { containerNo: no, carrier: e.carrier ?? null, bol: e.bol ?? null, destLocationId: first.ship_to!, vendorId: e.vendorId,
      note: "opened from the vendor's ship notice", bookedOn: e.shippedOn ?? null });
    ct = { ...made, stage: "booked" };
  } else if (e.bol || e.carrier) {
    await c.query(`update wms_container set bol = coalesce(bol, $3), carrier = coalesce(carrier, $4) where id = $1 and entity_id = $2`, [ct.id, s.entityId, e.bol ?? null, e.carrier ?? null]);
  }
  if (set.length) await setContainerLines(c, s, ct.id, set);
  await pur.linkShipmentContainer(c, s.entityId, [...new Set(e.shipped.map((x) => x.shipmentId))], ct.id);
  const st = await q<{ stage: Stage; actual_on: string | null }>(c, `select stage, actual_on::text from wms_container_stage where entity_id = $1 and container_id = $2`, [s.entityId, ct.id]);
  if (!st.find((x) => x.stage === "departed")?.actual_on) {
    const booked = st.find((x) => x.stage === "booked")?.actual_on ?? null;
    let d = e.shippedOn && DAY.test(e.shippedOn) && e.shippedOn <= (await bizToday(c, s)) ? e.shippedOn : (await bizToday(c, s));
    if (booked && d < booked) d = booked;
    await setStage(c, s, ct.id, "departed", { actualOn: d });
  }
  if (e.deliveryOn && DAY.test(e.deliveryOn) && !st.find((x) => x.stage === "delivered_dc")?.actual_on) await setStage(c, s, ct.id, "delivered_dc", { expectedOn: e.deliveryOn });
  return { id: ct.id, number: ct.number, containerNo: no, notes };
}

// -------------------------------------------------------------- reading --

export async function containers(c: Client, entityId: string, f: { open?: boolean } = {}) {
  return q(c, `
    select ct.id, ct.number, ct.container_no, ct.carrier, ct.vessel, ct.bol, ct.port_loading, ct.port_discharge, ct.stage, ct.created_at,
           l.name dest, coalesce(v.dba, v.legal_name) vendor,
           (select coalesce(st.actual_on, st.expected_on)::text from wms_container_stage st where st.entity_id = ct.entity_id and st.container_id = ct.id and st.stage = 'delivered_dc') eta_dc,
           (select count(*) from wms_container_line cl where cl.entity_id = ct.entity_id and cl.container_id = ct.id)::int lines,
           (select coalesce(sum(cl.qty), 0)::text from wms_container_line cl where cl.entity_id = ct.entity_id and cl.container_id = ct.id) units,
           (select coalesce(sum(cl.received_qty), 0)::text from wms_container_line cl where cl.entity_id = ct.entity_id and cl.container_id = ct.id) received,
           (select coalesce(sum(k.amount_minor), 0)::text from wms_container_cost k where k.entity_id = ct.entity_id and k.container_id = ct.id) costs_minor
      from wms_container ct join location l on l.id = ct.dest_location_id left join vendor v on v.id = ct.vendor_id
     where ct.entity_id = $1 and (not $2 or ct.stage <> 'unloaded' or ct.created_at > now() - interval '30 days')
     order by case when ct.stage = 'unloaded' then 1 else 0 end, eta_dc nulls last, ct.number limit 100`, [entityId, f.open ?? true]);
}

export async function container(c: Client, entityId: string, id: string) {
  const ct = await containerOf(c, entityId, id, false);
  const head = (await containers(c, entityId, { open: false })).find((x) => (x as { id: string }).id === id)
    ?? (await q(c, `select id, number, container_no, stage from wms_container where id = $1 and entity_id = $2`, [id, entityId]))[0];
  const stages = await q<{ stage: Stage; expected_on: string | null; actual_on: string | null }>(c, `select stage, expected_on::text, actual_on::text
     from wms_container_stage where entity_id = $1 and container_id = $2`, [entityId, id]);
  const lines = await q(c, `
    select cl.id, cl.purchase_order_line_id po_line_id, cl.qty::text, cl.received_qty::text, po.number po_number, po.id po_id, pol.seq, p.sku, p.name, p.serialized,
           pol.unit_price_minor::text unit_minor, pol.landed_minor::text landed_minor, (pol.quantity - pol.cancelled_qty)::text ordered, pol.expected_on::text expected_on,
           cl.landed_minor::text container_landed_minor,
           (select coalesce(sum(k.amount_minor), 0)::text from po_landed_cost k join wms_container_cost cc on cc.id = k.container_cost_id
             where k.entity_id = cl.entity_id and k.purchase_order_line_id = cl.purchase_order_line_id and k.active and cc.container_id = cl.container_id) share_minor
      from wms_container_line cl join purchase_order_line pol on pol.id = cl.purchase_order_line_id join purchase_order po on po.id = pol.purchase_order_id
      left join product p on p.id = pol.product_id
     where cl.entity_id = $1 and cl.container_id = $2 order by po.number, pol.seq`, [entityId, id]);
  const costs = await q(c, `select k.id, k.kind, k.amount_minor::text, k.basis, k.note, k.created_at, u.name by_name from wms_container_cost k
      left join app_user u on u.id = k.created_by where k.entity_id = $1 and k.container_id = $2 order by k.created_at`, [entityId, id]);
  const notices = await q(c, `select sh.id, sh.asn_number, sh.shipped_on::text, sh.expected_on::text, sh.carrier, po.number po_number from po_shipment sh
      join purchase_order po on po.id = sh.purchase_order_id where sh.entity_id = $1 and sh.container_id = $2 order by sh.created_at`, [entityId, id]);
  return { ...head, id: ct.id, stages: STAGES.map((st) => ({ stage: st, label: STAGE_LABEL[st], ...(stages.find((x) => x.stage === st) ?? { expected_on: null, actual_on: null }) })),
    lines, costs, notices };
}

/** Open PO lines with what is left to put on a container (for the picker). */
export async function linesForContainer(c: Client, entityId: string, vendorId?: string | null) {
  return q(c, `
    select pol.id, pol.seq, po.number po_number, coalesce(v.dba, v.legal_name) vendor, p.sku, p.name,
           (pol.quantity - pol.cancelled_qty - coalesce((select sum(g.quantity) from goods_receipt_line g where g.purchase_order_line_id = pol.id), 0)
              - coalesce((select sum(cl.qty - cl.received_qty) from wms_container_line cl where cl.entity_id = pol.entity_id and cl.purchase_order_line_id = pol.id), 0))::text room
      from purchase_order_line pol join purchase_order po on po.id = pol.purchase_order_id join vendor v on v.id = po.vendor_id
      join product p on p.id = pol.product_id
     where pol.entity_id = $1 and po.status = 'open' and ($2::uuid is null or po.vendor_id = $2)
     order by po.number, pol.seq limit 300`, [entityId, vendorId ?? null]);
}

/** Everything on the road: shipped PO quantities and transfers, by product and destination. */
export async function inTransit(c: Client, entityId: string, f: { locationId?: string | null } = {}) {
  return q(c, `
    select t.source, t.ref_id, t.ref_no, t.product_id, p.sku, p.name, t.to_location_id, l.name to_name, t.qty::text, t.arriving_on::text
      from inv_in_transit t join product p on p.id = t.product_id join location l on l.id = t.to_location_id
     where t.entity_id = $1 and ($2::uuid is null or t.to_location_id = $2)
     order by t.arriving_on nulls last, p.name limit 300`, [entityId, f.locationId ?? null]);
}

// ================================================================ prep queue

export type PrepType = (typeof PREP_TYPES)[number];

/** Which prep a product or a whole category needs. A product's own rule wins over its category's. */
export async function setPrepRule(c: Client, s: Scope, e: { productId?: string | null; category?: string | null; prepTypes: string[]; stdMinutes?: number | null; active?: boolean }) {
  need(!!e.productId !== !!(e.category && e.category.trim()), "a prep rule is for one product or one category");
  const types = [...new Set((e.prepTypes ?? []).map(String))];
  need(types.length, "pick at least one kind of prep");
  for (const t of types) need((PREP_TYPES as readonly string[]).includes(t), `${t} is not a kind of prep (unbox, inspect, touch up, steam or assemble)`);
  const ordered = PREP_TYPES.filter((t) => types.includes(t));
  if (e.stdMinutes != null) need(Number.isInteger(e.stdMinutes) && e.stdMinutes > 0 && e.stdMinutes <= 600, "the standard time is whole minutes, 1 to 600");
  if (e.productId) {
    const p = await q(c, `select 1 from product where id = $1 and entity_id = $2`, [e.productId, s.entityId]);
    need(p.length, "no such product");
    const has = await q<{ id: string }>(c, `select id from wms_prep_rule where entity_id = $1 and product_id = $2`, [s.entityId, e.productId]);
    if (has.length) await c.query(`update wms_prep_rule set prep_types = $3, std_minutes = $4, active = $5, set_by = $6, set_at = now() where id = $1 and entity_id = $2`,
      [has[0].id, s.entityId, ordered, e.stdMinutes ?? null, e.active ?? true, s.actor.id || null]);
    else await c.query(`insert into wms_prep_rule (entity_id, product_id, prep_types, std_minutes, active, set_by) values ($1,$2,$3,$4,$5,$6)`,
      [s.entityId, e.productId, ordered, e.stdMinutes ?? null, e.active ?? true, s.actor.id || null]);
  } else {
    const cat = e.category!.trim().slice(0, 80);
    const has = await q<{ id: string }>(c, `select id from wms_prep_rule where entity_id = $1 and lower(category) = lower($2)`, [s.entityId, cat]);
    if (has.length) await c.query(`update wms_prep_rule set prep_types = $3, std_minutes = $4, active = $5, set_by = $6, set_at = now() where id = $1 and entity_id = $2`,
      [has[0].id, s.entityId, ordered, e.stdMinutes ?? null, e.active ?? true, s.actor.id || null]);
    else await c.query(`insert into wms_prep_rule (entity_id, category, prep_types, std_minutes, active, set_by) values ($1,$2,$3,$4,$5,$6)`,
      [s.entityId, cat, ordered, e.stdMinutes ?? null, e.active ?? true, s.actor.id || null]);
  }
  await audit(c, s, { table: "wms_prep_rule", rowId: e.productId ?? e.category!, action: "update", after: { prepTypes: ordered, stdMinutes: e.stdMinutes ?? null, active: e.active ?? true } });
  return { prepTypes: ordered };
}

export async function prepRules(c: Client, entityId: string) {
  return q(c, `select r.id, r.product_id, p.sku, p.name, r.category, r.prep_types, r.std_minutes, r.active from wms_prep_rule r
      left join product p on p.id = r.product_id where r.entity_id = $1 order by r.category nulls last, p.name`, [entityId]);
}

/** The prep a product needs (and the standard minutes), or none. */
export async function prepFor(c: Client, entityId: string, productId: string): Promise<{ types: PrepType[]; stdMinutes: number | null }> {
  const r = await q<{ prep_types: PrepType[]; std_minutes: number | null; own: boolean }>(c, `
    select r.prep_types, r.std_minutes, r.product_id is not null own from wms_prep_rule r join product p on p.id = $2 and p.entity_id = r.entity_id
     where r.entity_id = $1 and r.active and (r.product_id = p.id or (r.category is not null and lower(r.category) = lower(p.category)))
     order by own desc limit 1`, [entityId, productId]);
  return r.length ? { types: r[0].prep_types, stdMinutes: r[0].std_minutes } : { types: [], stdMinutes: null };
}

async function addJob(c: Client, s: Scope, j: { type: PrepType; productId: string; locationId: string; unitId: string | null; qty: number; source: string;
  goodsReceiptId?: string | null; salesOrderLineId?: string | null; stdMinutes: number | null; note?: string | null }): Promise<boolean> {
  if (j.unitId) {
    // One live job per unit and kind; a unit already prepped this way is not queued again.
    const has = await q(c, `select 1 from wms_prep_job where entity_id = $1 and unit_id = $2 and prep_type = $3 and status in ('queued','in_progress','problem','done')`,
      [s.entityId, j.unitId, j.type]);
    if (has.length) return false;
  }
  const number = await inv.nextNo(c, s.entityId, "prep", "PJ-");
  await c.query(`insert into wms_prep_job (entity_id, number, prep_type, product_id, location_id, unit_id, qty, source, goods_receipt_id, sales_order_line_id, std_minutes, note, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [s.entityId, number, j.type, j.productId, j.locationId, j.unitId, j.qty, j.source, j.goodsReceiptId ?? null, j.salesOrderLineId ?? null, j.stdMinutes, j.note ?? null, s.actor.id || null]);
  return true;
}

/** After a receipt: every good unit (or quantity) of a product that needs prep goes on the queue, one job per kind of prep. */
export async function queueForReceipt(c: Client, s: Scope, receiptId: string, locationId: string): Promise<{ queued: number }> {
  const lines = await q<{ id: string; product_id: string; quantity: string; serialized: boolean }>(c, `
    select gl.id, pol.product_id, gl.quantity::text, p.serialized
      from goods_receipt_line gl join purchase_order_line pol on pol.id = gl.purchase_order_line_id join product p on p.id = pol.product_id
     where pol.entity_id = $1 and gl.goods_receipt_id = $2`, [s.entityId, receiptId]);
  let queued = 0;
  for (const l of lines) {
    const need_ = await prepFor(c, s.entityId, l.product_id);
    if (!need_.types.length) continue;
    if (l.serialized) {
      // Units that arrived damaged are on damage hold already; the rest are prepped.
      const units = await q<{ unit_id: string; line_id: string | null }>(c, `select unit_id, min(sales_order_line_id::text)::uuid line_id from inv_piece
         where entity_id = $1 and goods_receipt_line_id = $2 group by unit_id having bool_and(status not in ('damaged','in_repair','vendor_claim'))`, [s.entityId, l.id]);
      for (const u of units) for (const t of need_.types)
        if (await addJob(c, s, { type: t, productId: l.product_id, locationId, unitId: u.unit_id, qty: 1, source: "receipt", goodsReceiptId: receiptId,
          salesOrderLineId: u.line_id, stdMinutes: need_.stdMinutes })) queued++;
    } else {
      for (const t of need_.types)
        if (await addJob(c, s, { type: t, productId: l.product_id, locationId, unitId: null, qty: Number(l.quantity), source: "receipt", goodsReceiptId: receiptId,
          stdMinutes: need_.stdMinutes })) queued++;
    }
  }
  return { queued };
}

/** Before a delivery is staged: units on these order lines that need prep and were never queued go on the queue now. */
export async function queueForLines(c: Client, s: Scope, lineIds: string[]): Promise<{ queued: number }> {
  if (!lineIds.length) return { queued: 0 };
  const units = await q<{ unit_id: string; product_id: string; location_id: string; line_id: string }>(c, `
    select unit_id, min(product_id::text)::uuid product_id, min(location_id::text)::uuid location_id, min(sales_order_line_id::text)::uuid line_id
      from inv_piece where entity_id = $1 and sales_order_line_id = any($2) and status in ('reserved','picked')
     group by unit_id`, [s.entityId, lineIds]);
  let queued = 0;
  for (const u of units) {
    const p = await prepFor(c, s.entityId, u.product_id);
    for (const t of p.types) if (await addJob(c, s, { type: t, productId: u.product_id, locationId: u.location_id, unitId: u.unit_id, qty: 1, source: "delivery",
      salesOrderLineId: u.line_id, stdMinutes: p.stdMinutes })) queued++;
  }
  return { queued };
}

export type OpenPrep = { number: string; type: string; status: string; label: string | null; unitId?: string | null; productId?: string; locationId?: string };

/** What a labelled unit still needs: every kind its product needs that is not done, and any other job still open on it. */
async function openForUnits(c: Client, entityId: string, units: { unit_id: string; product_id: string; label: string; location_id: string }[]): Promise<Map<string, OpenPrep[]>> {
  const out = new Map<string, OpenPrep[]>();
  if (!units.length) return out;
  const jobs = await q<{ unit_id: string; number: string; prep_type: string; status: string }>(c, `select unit_id, number, prep_type, status from wms_prep_job
     where entity_id = $1 and unit_id = any($2) and status <> 'cancelled' order by created_at`, [entityId, units.map((u) => u.unit_id)]);
  const rules = new Map<string, PrepType[]>();
  for (const u of units) {
    if (!rules.has(u.product_id)) rules.set(u.product_id, (await prepFor(c, entityId, u.product_id)).types);
    const mine = jobs.filter((j) => j.unit_id === u.unit_id);
    const done = new Set(mine.filter((j) => j.status === "done").map((j) => j.prep_type));
    const list: OpenPrep[] = [];
    const base = { label: u.label, unitId: u.unit_id, productId: u.product_id, locationId: u.location_id };
    for (const j of mine) if (j.status !== "done") list.push({ number: j.number, type: j.prep_type, status: j.status, ...base });
    for (const t of rules.get(u.product_id)!) if (!done.has(t) && !list.some((x) => x.type === t)) list.push({ number: "", type: t, status: "not_queued", ...base });
    if (list.length) out.set(u.unit_id, list);
  }
  return out;
}

/**
 * Prep not finished on what these order lines take. Labelled units allocated
 * to a line are checked one by one. A line of unlabelled stock is checked by
 * quantity: what is at its location, less what is held, less what is still
 * waiting on prep there, must cover it. Keyed by order line.
 */
export async function prepOpenForLines(c: Client, entityId: string, lineIds: string[]): Promise<Map<string, OpenPrep[]>> {
  const out = new Map<string, OpenPrep[]>();
  if (!lineIds.length) return out;
  const units = await q<{ unit_id: string; product_id: string; line_id: string; label: string; location_id: string }>(c, `
    select unit_id, min(product_id::text)::uuid product_id, min(sales_order_line_id::text)::uuid line_id, min(label) label, min(location_id::text)::uuid location_id
      from inv_piece where entity_id = $1 and sales_order_line_id = any($2) and status in ('reserved','picked','loaded')
     group by unit_id`, [entityId, lineIds]);
  const byUnit = await openForUnits(c, entityId, units);
  for (const u of units) { const l = byUnit.get(u.unit_id); if (l) out.set(u.line_id, [...(out.get(u.line_id) ?? []), ...l]); }
  // Unlabelled stock, by quantity.
  const plain = await q<{ id: string; product_id: string; sku: string; qty: string; loc: string }>(c, `
    select l.id, l.product_id, p.sku, l.qty::text, l.fulfil_from_id loc from sales_order_line l join product p on p.id = l.product_id
     where l.entity_id = $1 and l.id = any($2) and not p.serialized and l.fulfil_from_id is not null and l.qty > 0
       and p.kind in ('stock','configurable','special_order')`, [entityId, lineIds]);
  for (const l of plain) {
    const jobs = await q<{ number: string; prep_type: string; status: string; qty: string }>(c, `select number, prep_type, status, qty::text from wms_prep_job
       where entity_id = $1 and product_id = $2 and location_id = $3 and unit_id is null and status in ('queued','in_progress','problem') order by created_at`,
      [entityId, l.product_id, l.loc]);
    if (!jobs.length) continue;
    // A problem job's one unit is on hold already, so it counts once, in held.
    const waiting = jobs.reduce((a, j) => a + Number(j.qty) - (j.status === "problem" ? 1 : 0), 0);
    const lv = await q<{ on_hand: string; held: string }>(c, `select on_hand::text, held::text from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`,
      [entityId, l.product_id, l.loc]);
    const ready = Number(lv[0]?.on_hand ?? 0) - Number(lv[0]?.held ?? 0) - Math.max(0, waiting);
    if (ready >= Number(l.qty)) continue;
    out.set(l.id, [...(out.get(l.id) ?? []), ...[...new Set(jobs.map((j) => j.prep_type))].map((t) => {
      const j = jobs.find((x) => x.prep_type === t)!;
      return { number: j.number, type: t, status: j.status, label: `${Number(l.qty) - Math.max(0, ready)} of ${Number(l.qty)} ${l.sku}`, productId: l.product_id, locationId: l.loc };
    })]);
  }
  return out;
}

/** The company's choice for goods whose prep is not done: off, warn, or refuse to book or stage them. */
export async function prepGateMode(c: Client, entityId: string): Promise<"off" | "warn" | "refuse"> {
  const v = await inv.settingOf<unknown>(c, entityId, "wms.prep_gate", "warn");
  return v === "off" || v === "refuse" ? v : "warn";
}

function gateMessage(mode: string, open: OpenPrep[], doing: string, queued = 0) {
  const list = open.slice(0, 4).map((x) => `${x.label ?? "a piece"} needs ${words(x.type)}${x.status === "problem" ? " (a problem was found)" : ""}`).join("; ");
  const more = open.length > 4 ? ` and ${open.length - 4} more` : "";
  const q_ = queued ? ` ${queued === 1 ? "1 prep job was" : `${queued} prep jobs were`} put on the queue for it.` : "";
  return mode === "refuse"
    ? `prep is not done, so ${doing} is refused: ${list}${more}. Finish it in the prep queue first.${q_}`
    : `prep is not done yet: ${list}${more}`;
}

/**
 * The gate a delivery booking or a pick list goes through, without changing
 * anything. Returns the open prep and a sentence; refuse is true when the
 * company refuses such goods.
 */
export async function prepGate(c: Client, entityId: string, lineIds: string[], doing: string) {
  const mode = await prepGateMode(c, entityId);
  if (mode === "off") return { mode, open: [] as OpenPrep[], refuse: false, message: null as string | null };
  const open = [...(await prepOpenForLines(c, entityId, lineIds)).values()].flat();
  if (!open.length) return { mode, open, refuse: false, message: null };
  return { mode, open, refuse: mode === "refuse", message: gateMessage(mode, open, doing) };
}

/**
 * Put prep that was never queued on the queue in its own transaction, so it
 * is kept even when the caller is about to be refused (and roll back). The
 * jobs name the unit, not the order line: the line's own change may be the
 * one rolled back. Best effort: a lock wait gives up after a few seconds.
 */
async function queueKept(s: Scope, missing: OpenPrep[]): Promise<number> {
  const todo = missing.filter((x) => x.status === "not_queued" && x.unitId && x.productId && x.locationId);
  if (!todo.length) return 0;
  try {
    return await tx(s.actor, async (k) => {
      await k.query(`set local lock_timeout = '3s'`);
      let n = 0;
      for (const x of todo) {
        const p = await prepFor(k, s.entityId, x.productId!);
        if (await addJob(k, s, { type: x.type as PrepType, productId: x.productId!, locationId: x.locationId!, unitId: x.unitId!, qty: 1, source: "delivery",
          stdMinutes: p.stdMinutes })) n++;
      }
      return n;
    });
  } catch { return 0; }
}

/**
 * The gate, and the queue behind it: prep that was never queued goes on the
 * queue (kept even if this is refused), then the company's setting decides.
 * Booking, staging a pick list, loading, starting the route and completing
 * the stop all come through here.
 */
export async function gateOrQueue(c: Client, s: Scope, lineIds: string[], doing: string) {
  const mode = await prepGateMode(c, s.entityId);
  if (mode === "off" || !lineIds.length) return { mode, open: [] as OpenPrep[], refuse: false, message: null as string | null, queued: 0 };
  const open = [...(await prepOpenForLines(c, s.entityId, lineIds)).values()].flat();
  if (!open.length) return { mode, open, refuse: false, message: null, queued: 0 };
  const queued = mode === "refuse" ? await queueKept(s, open) : (await queueForLines(c, s, lineIds)).queued;
  return { mode, open, refuse: mode === "refuse", message: gateMessage(mode, open, doing, mode === "refuse" ? queued : 0), queued };
}

/** The gate for one labelled unit going on a truck. */
export async function gateForUnit(c: Client, s: Scope, unitId: string, doing: string) {
  const mode = await prepGateMode(c, s.entityId);
  if (mode === "off") return { mode, refuse: false, message: null as string | null };
  const u = await q<{ unit_id: string; product_id: string; label: string; location_id: string }>(c, `select unit_id, min(product_id::text)::uuid product_id, min(label) label,
      min(location_id::text)::uuid location_id from inv_piece where entity_id = $1 and unit_id = $2 group by unit_id`, [s.entityId, unitId]);
  const open = (await openForUnits(c, s.entityId, u)).get(unitId) ?? [];
  if (!open.length) return { mode, refuse: false, message: null };
  const queued = mode === "refuse" ? await queueKept(s, open) : 0;
  return { mode, refuse: mode === "refuse", message: gateMessage(mode, open, doing, queued) };
}

type JobRow = { id: string; number: string; prep_type: PrepType; status: string; product_id: string; location_id: string; unit_id: string | null; qty: string;
  started_at: string | null; std_minutes: number | null };

async function jobOf(c: Client, entityId: string, id: string): Promise<JobRow> {
  need(/^[0-9a-f-]{36}$/i.test(String(id ?? "")), "no such prep job");
  const r = await q<JobRow>(c, `select id, number, prep_type, status, product_id, location_id, unit_id, qty::text, started_at::text, std_minutes
     from wms_prep_job where id = $1 and entity_id = $2 for update`, [id, entityId]);
  need(r.length, "no such prep job");
  return r[0];
}

/** A unit any of whose cartons is on hold or gone: the status that stops it, else null. */
async function unitHeld(c: Client, entityId: string, unitId: string): Promise<string | null> {
  const r = await q<{ status: string }>(c, `select status from inv_piece where entity_id = $1 and unit_id = $2
     and status = any($3) order by carton_seq limit 1`, [entityId, unitId, ["damaged", "in_repair", "vendor_claim", "written_off", "returned_to_vendor", "delivered"]]);
  return r[0]?.status ?? null;
}

/** Start a job. A job with a problem starts again once its piece is off damage hold. */
export async function startJob(c: Client, s: Scope, id: string) {
  const j = await jobOf(c, s.entityId, id);
  need(["queued", "problem"].includes(j.status), `${j.number} is ${words(j.status)}; only a queued job (or one with a problem that is fixed) starts`);
  if (j.unit_id) {
    const held = await unitHeld(c, s.entityId, j.unit_id);
    need(!held, `the piece is ${words(held ?? "")}; ${j.number} starts once it is back in stock`);
  }
  await c.query(`update wms_prep_job set status = 'in_progress', started_by = $3, started_at = now() where id = $1 and entity_id = $2`, [id, s.entityId, s.actor.id || null]);
  return { number: j.number, status: "in_progress" };
}

/** Finish a job with the labor it took: minutes given, else the time since it started (at least one). */
export async function finishJob(c: Client, s: Scope, id: string, e: { laborMinutes?: number | null; note?: string | null } = {}) {
  const j = await jobOf(c, s.entityId, id);
  need(["queued", "in_progress"].includes(j.status), `${j.number} is ${words(j.status)}; it cannot be marked done`);
  if (j.unit_id) {
    const held = await unitHeld(c, s.entityId, j.unit_id);
    need(!held, `the piece is ${words(held ?? "")}; it cannot be prepped until it is back in stock`);
  }
  let minutes = e.laborMinutes;
  if (minutes != null) need(Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440, "labor is whole minutes, 0 to 1440");
  else {
    need(j.started_at, `say how many minutes ${j.number} took, or start it first so the time is kept`);
    const r = await one<{ m: number }>(c, `select greatest(1, ceil(extract(epoch from now() - started_at) / 60))::int m from wms_prep_job where id = $1 and entity_id = $2`, [id, s.entityId]);
    minutes = r.m;
  }
  await c.query(`update wms_prep_job set status = 'done', finished_by = $3, finished_at = now(), labor_minutes = $4,
      started_at = coalesce(started_at, now()), started_by = coalesce(started_by, $3), note = coalesce($5, note) where id = $1 and entity_id = $2`,
    [id, s.entityId, s.actor.id || null, minutes, text(e.note, 500)]);
  return { number: j.number, status: "done", laborMinutes: minutes };
}

function cleanPhotos(v: unknown, max = 6): string[] {
  const list = Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : [];
  need(list.length <= max, `${max} photos at most`);
  for (const u of list) {
    need(/^https:\/\/[^\s]{4,}$/.test(u) || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u), "a photo is a https link or a picture taken here");
    need(u.length <= 1_500_000, "a photo is too large; send a link to it, or a smaller picture");
  }
  return list;
}

/** Something is wrong with the piece: the job records it (with photos) and the piece goes on damage hold. */
export async function flagProblem(c: Client, s: Scope, id: string, e: { problem: string; photos?: unknown }) {
  const j = await jobOf(c, s.entityId, id);
  need(["queued", "in_progress"].includes(j.status), `${j.number} is ${words(j.status)}; a problem is flagged on a job still being worked`);
  const problem = String(e.problem ?? "").trim().slice(0, 500);
  need(problem, "say what is wrong with it");
  const photos = cleanPhotos(e.photos);
  const description = `Found during ${words(j.prep_type)} (${j.number}): ${problem}`;
  let dmg: { damageId: string; number: string };
  if (j.unit_id) {
    const label = (await q<{ label: string }>(c, `select label from inv_piece where entity_id = $1 and unit_id = $2 order by carton_seq limit 1`, [s.entityId, j.unit_id]))[0]?.label;
    need(label, "the piece for this job is gone");
    dmg = await inv.reportDamage(c, s, { label, source: "warehouse", description, photoUrls: photos });
  } else {
    dmg = await inv.reportDamage(c, s, { productId: j.product_id, locationId: j.location_id, qty: 1, source: "warehouse", description, photoUrls: photos });
  }
  await c.query(`update wms_prep_job set status = 'problem', problem = $3, photos = $4, damage_id = $5, finished_by = $6, finished_at = now(),
      labor_minutes = case when started_at is not null then greatest(1, ceil(extract(epoch from now() - started_at) / 60))::int else labor_minutes end
    where id = $1 and entity_id = $2`, [id, s.entityId, problem, photos, dmg.damageId, s.actor.id || null]);
  return { number: j.number, status: "problem", damage: dmg.number, damageId: dmg.damageId };
}

/** Take a job off the queue, with the reason (a manager's call). */
export async function cancelJob(c: Client, s: Scope, id: string, reason: string) {
  const j = await jobOf(c, s.entityId, id);
  need(["queued", "problem"].includes(j.status), `${j.number} is ${words(j.status)}; only a queued job or one with a problem is cancelled`);
  const note = String(reason ?? "").trim().slice(0, 500);
  need(note, "say why the job is cancelled");
  await c.query(`update wms_prep_job set status = 'cancelled', note = $3, finished_by = $4, finished_at = now() where id = $1 and entity_id = $2`, [id, s.entityId, note, s.actor.id || null]);
  return { number: j.number, status: "cancelled" };
}

/** Queue prep for a scanned piece by hand. */
export async function queueByLabel(c: Client, s: Scope, label: string, type: string, note?: string | null) {
  need((PREP_TYPES as readonly string[]).includes(type), `${type} is not a kind of prep (unbox, inspect, touch up, steam or assemble)`);
  const pc = (await q<{ unit_id: string; product_id: string; location_id: string; status: string; line_id: string | null }>(c,
    `select unit_id, product_id, location_id, status, sales_order_line_id line_id from inv_piece where entity_id = $1 and upper(label) = upper($2)`, [s.entityId, String(label ?? "").trim()]))[0];
  need(pc, `no piece is labelled ${label}`);
  need(["in_stock", "reserved", "picked", "as_is", "returned"].includes(pc.status), `${label} is ${words(pc.status)}; it cannot be prepped now`);
  const live = await q(c, `select 1 from wms_prep_job where entity_id = $1 and unit_id = $2 and prep_type = $3 and status in ('queued','in_progress','problem')`, [s.entityId, pc.unit_id, type]);
  need(!live.length, `${label} already has ${words(type)} on the queue`);
  const number = await inv.nextNo(c, s.entityId, "prep", "PJ-");
  await c.query(`insert into wms_prep_job (entity_id, number, prep_type, product_id, location_id, unit_id, qty, source, sales_order_line_id, note, created_by)
    values ($1,$2,$3,$4,$5,$6,1,'manual',$7,$8,$9)`, [s.entityId, number, type, pc.product_id, pc.location_id, pc.unit_id, pc.line_id, text(note, 500), s.actor.id || null]);
  return { number };
}

/** The work queue: open jobs (and today's finished ones), oldest first, with where the piece is. */
export async function prepQueue(c: Client, entityId: string, f: { locationId?: string | null; status?: string | null } = {}) {
  return q(c, `
    select j.id, j.number, j.prep_type, j.status, j.qty::text, j.source, j.created_at, j.started_at, j.finished_at, j.labor_minutes, j.std_minutes, j.problem,
           cardinality(j.photos) photos, p.sku, p.name, l.name location, j.location_id, su.name started_by, fu.name finished_by, d.number damage,
           (select string_agg(x.label, ' ' order by x.carton_seq) from inv_piece x where x.entity_id = j.entity_id and x.unit_id = j.unit_id) labels,
           (select b.code from inv_piece x join inv_bin b on b.id = x.bin_id where x.entity_id = j.entity_id and x.unit_id = j.unit_id limit 1) bin,
           (select so.number from sales_order_line sl join sales_order so on so.id = sl.sales_order_id where sl.entity_id = j.entity_id
               and sl.id = coalesce(j.sales_order_line_id, (select x.sales_order_line_id from inv_piece x where x.entity_id = j.entity_id and x.unit_id = j.unit_id limit 1))) order_number
      from wms_prep_job j join product p on p.id = j.product_id join location l on l.id = j.location_id
      left join app_user su on su.id = j.started_by left join app_user fu on fu.id = j.finished_by left join inv_damage d on d.id = j.damage_id
     where j.entity_id = $1 and ($2::uuid is null or j.location_id = $2)
       and (($3::text is null and (j.status in ('queued','in_progress','problem') or j.finished_at > now() - interval '1 day')) or j.status = $3)
     order by case j.status when 'in_progress' then 0 when 'queued' then 1 when 'problem' then 2 else 3 end, j.created_at limit 200`,
    [entityId, f.locationId ?? null, f.status ?? null]);
}

/** Labor by kind of prep over the last days: jobs done, minutes spent, against the standard. */
export async function prepLabor(c: Client, entityId: string, days = 30) {
  return q(c, `select prep_type, count(*)::int jobs, coalesce(sum(labor_minutes), 0)::int minutes, coalesce(sum(std_minutes), 0)::int std_minutes
      from wms_prep_job where entity_id = $1 and status = 'done' and finished_at > now() - make_interval(days => $2) group by prep_type order by prep_type`, [entityId, days]);
}

// ================================================================ settings

export type WmsSettings = { twoStepTransfers: boolean; inTransitGl: "1300" | "1310"; transferDays: number; prepGate: "off" | "warn" | "refuse" };

export async function settings(c: Client, entityId: string): Promise<WmsSettings> {
  const t = await inv.transferSettings(c, entityId);
  return { twoStepTransfers: t.twoStep, inTransitGl: t.transitGl, transferDays: t.transitDays, prepGate: await prepGateMode(c, entityId) };
}

/** Change the warehouse settings. Keeping 1310 needs the account in the chart. */
export async function saveSettings(c: Client, s: Scope, e: Partial<WmsSettings>) {
  const put = async (key: string, value: unknown) => c.query(`insert into entity_setting (entity_id, key, value, set_by, from_pack) values ($1,$2,$3,$4,false)
      on conflict (entity_id, key) do update set value = excluded.value, set_by = excluded.set_by, set_at = now(), from_pack = false`,
    [s.entityId, key, JSON.stringify(value), s.actor.label || "user"]);
  if (e.twoStepTransfers !== undefined) await put("inventory.transfers_two_step", e.twoStepTransfers === true);
  if (e.inTransitGl !== undefined) {
    need(e.inTransitGl === "1300" || e.inTransitGl === "1310", "goods on the road stay in 1300 or go to 1310");
    if (e.inTransitGl === "1310") {
      const a = await q(c, `select 1 from gl_account g join entity_gl_account eg on eg.gl_account_id = g.id where eg.entity_id = $1 and g.code = '1310'`, [s.entityId]);
      need(a.length, "the chart has no 1310 Inventory in transit for this company; add it in Setup (the retail packs carry it) first");
    }
    await put("inventory.in_transit_gl", e.inTransitGl);
  }
  if (e.transferDays !== undefined) {
    need(Number.isInteger(e.transferDays) && e.transferDays >= 0 && e.transferDays <= 60, "a transfer takes 0 to 60 days on the road");
    await put("inventory.transfer_days", e.transferDays);
  }
  if (e.prepGate !== undefined) {
    need(PREP_GATES.includes(e.prepGate), "unfinished prep is let through (off), warned about, or refused");
    await put("wms.prep_gate", e.prepGate);
  }
  await audit(c, s, { table: "entity_setting", rowId: "wms", action: "update", after: e });
  return settings(c, s.entityId);
}
