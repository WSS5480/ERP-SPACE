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

import { q, one, audit, type Client, type Scope } from "./db.ts";
import * as inv from "./inventory.ts";
import * as pur from "./purchasing.ts";

export class WmsError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new WmsError(msg); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
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
  const bookedOn = e.bookedOn && DAY.test(e.bookedOn) && e.bookedOn <= today() ? e.bookedOn : today();
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
  if (e.actualOn) need(e.actualOn <= today(), `${STAGE_LABEL[stage as Stage]} cannot have happened on ${e.actualOn}; that is in the future. Put it as the expected day`);
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

/**
 * Spread every cost on a container over its lines again. The old shares are
 * retired (not deleted) and new ones put on each PO line through
 * purchasing's landed cost, so the next receipt values the goods with them.
 * The last line takes the rounding.
 */
export async function spreadCosts(c: Client, s: Scope, containerId: string) {
  const costs = await q<{ id: string; kind: string; amount_minor: string; basis: string }>(c, `select id, kind, amount_minor::text, basis from wms_container_cost
     where entity_id = $1 and container_id = $2 order by created_at`, [s.entityId, containerId]);
  await pur.retireContainerShares(c, s.entityId, costs.map((x) => x.id));
  const lines = await q<{ id: string; pol_id: string; qty: string; unit: string; cube: string | null; weight: string | null; sku: string | null; name: string | null }>(c, `
    select cl.id, cl.purchase_order_line_id pol_id, cl.qty::text, pol.unit_price_minor::text unit, p.cubic_ft::text cube, p.weight_lb::text weight, p.sku, p.name
      from wms_container_line cl join purchase_order_line pol on pol.id = cl.purchase_order_line_id join purchase_order po on po.id = pol.purchase_order_id
      left join product p on p.id = pol.product_id
     where cl.entity_id = $1 and cl.container_id = $2 order by po.number, pol.seq`, [s.entityId, containerId]);
  const shares: { poLineId: string; kind: string; amountMinor: bigint }[] = [];
  if (!lines.length) return { shares };
  for (const k of costs) {
    const w = lines.map((l) => {
      const qn = Number(l.qty);
      if (k.basis === "cube") { need(l.cube != null, `${l.name ?? l.sku} has no cube in the catalog; add it, or spread the ${words(k.kind)} by value`); return qn * Number(l.cube); }
      if (k.basis === "weight") { need(l.weight != null, `${l.name ?? l.sku} has no weight in the catalog; add it, or spread the ${words(k.kind)} by value`); return qn * Number(l.weight); }
      if (k.basis === "qty") return qn;
      return qn * Number(l.unit);
    }).map((v) => BigInt(Math.round(v * 1000)));
    const tw = w.reduce((a, b) => a + b, 0n);
    const amount = BigInt(k.amount_minor);
    let left = amount;
    for (const [i, l] of lines.entries()) {
      const share = i === lines.length - 1 ? left : tw > 0n ? (amount * w[i]) / tw : 0n;
      left -= share;
      shares.push({ poLineId: l.pol_id, kind: k.kind, amountMinor: share });
      await pur.addLineLandedCost(c, s, l.pol_id, { kind: k.kind, amountMinor: share, containerCostId: k.id, note: `container share (${k.basis})` });
    }
  }
  return { shares };
}

// ------------------------------------------------------------ receiving --

/**
 * Unload some or all of a container into its destination. Each PO it
 * carries is received through inventory (pieces, labels, special orders,
 * the prep queue); what is not counted in stays on the container for a later
 * receipt. The first receipt marks it delivered to the DC; the last one,
 * unloaded.
 */
export async function receiveContainer(c: Client, s: Scope, containerId: string, e: { binId?: string | null; note?: string | null;
  lines: { containerLineId: string; qty: number; damagedQty?: number; damageNote?: string }[] }) {
  const ct = await containerOf(c, s.entityId, containerId);
  need(ct.stage !== "unloaded", `${ct.number} is already unloaded`);
  need(Array.isArray(e.lines) && e.lines.filter((x) => Number(x.qty) > 0).length, "say what came off the container");
  const cls = await q<{ id: string; pol_id: string; po_id: string; po_number: string; po_kind: string; qty: string; received_qty: string; sku: string | null }>(c, `
    select cl.id, cl.purchase_order_line_id pol_id, pol.purchase_order_id po_id, po.number po_number, po.kind po_kind, cl.qty::text, cl.received_qty::text, p.sku
      from wms_container_line cl join purchase_order_line pol on pol.id = cl.purchase_order_line_id join purchase_order po on po.id = pol.purchase_order_id
      left join product p on p.id = pol.product_id
     where cl.entity_id = $1 and cl.container_id = $2 for update of cl`, [s.entityId, containerId]);
  const byPo = new Map<string, inv.ReceiveLine[]>();
  const counted: { id: string; qty: number }[] = [];
  for (const l of e.lines) {
    const qty = Number(l.qty);
    if (!(qty > 0)) continue;
    const cl = cls.find((x) => x.id === l.containerLineId);
    need(cl, `that line is not on ${ct.number}`);
    const left = Number(cl!.qty) - Number(cl!.received_qty);
    need(qty <= left, `${cl!.sku ?? "that line"} on ${ct.number}: ${left} left to unload, not ${qty}`);
    byPo.set(cl!.po_id, [...(byPo.get(cl!.po_id) ?? []), { poLineId: cl!.pol_id, qty, damagedQty: l.damagedQty, damageNote: l.damageNote }]);
    counted.push({ id: cl!.id, qty });
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
  for (const x of counted) await c.query(`update wms_container_line set received_qty = received_qty + $3 where id = $1 and entity_id = $2`, [x.id, s.entityId, x.qty]);
  const rest = await q<{ n: string }>(c, `select count(*)::text n from wms_container_line where entity_id = $1 and container_id = $2 and received_qty < qty`, [s.entityId, containerId]);
  const at = await q<{ stage: Stage; actual_on: string | null }>(c, `select stage, actual_on::text from wms_container_stage where entity_id = $1 and container_id = $2`, [s.entityId, containerId]);
  if (!at.find((x) => x.stage === "delivered_dc")?.actual_on) await setStage(c, s, containerId, "delivered_dc", { actualOn: today() });
  const done = rest[0].n === "0";
  if (done) await setStage(c, s, containerId, "unloaded", { actualOn: today() });
  return { number: ct.number, receipts, unloaded: done, linesLeft: Number(rest[0].n) };
}

// ---------------------------------------------------------- ship notices --

/**
 * An 856 that names a container or trailer: the notice is attached to it, and
 * the shipped lines go on it. A container we had not booked yet is opened
 * from the notice, already departed.
 */
export async function attachShipment(c: Client, s: Scope, e: { equipment: string; vendorId: string; carrier?: string | null; bol?: string | null;
  shippedOn?: string | null; deliveryOn?: string | null; shipped: { shipmentId: string; poLineId: string; qty: number }[] }) {
  const no = cleanNo(e.equipment);
  need(CONTAINER_NO.test(no), `the ship notice names equipment ${e.equipment}, which is not a container or trailer number`);
  need(e.shipped.length, "the ship notice lists nothing shipped");
  let ct = (await q<{ id: string; number: string }>(c, `select id, number from wms_container where entity_id = $1 and upper(container_no) = $2 for update`, [s.entityId, no]))[0];
  if (!ct) {
    const first = await poLine(c, s.entityId, e.shipped[0].poLineId);
    need(first.ship_to, `${first.po_number} has no ship-to`);
    ct = await createContainer(c, s, { containerNo: no, carrier: e.carrier ?? null, bol: e.bol ?? null, destLocationId: first.ship_to!, vendorId: e.vendorId,
      note: "opened from the vendor's ship notice", bookedOn: e.shippedOn ?? null });
  } else if (e.bol || e.carrier) {
    await c.query(`update wms_container set bol = coalesce(bol, $3), carrier = coalesce(carrier, $4) where id = $1 and entity_id = $2`, [ct.id, s.entityId, e.bol ?? null, e.carrier ?? null]);
  }
  // What the notice ships goes on the container (a line already there keeps the larger of the two quantities).
  const want = new Map<string, number>();
  for (const x of e.shipped) want.set(x.poLineId, (want.get(x.poLineId) ?? 0) + x.qty);
  const have = new Map((await q<{ pol: string; qty: string }>(c, `select purchase_order_line_id pol, qty::text from wms_container_line where entity_id = $1 and container_id = $2`,
    [s.entityId, ct.id])).map((x) => [x.pol, Number(x.qty)]));
  const set = [...want].filter(([pol, qty]) => (have.get(pol) ?? 0) < qty).map(([poLineId, qty]) => ({ poLineId, qty }));
  if (set.length) await setContainerLines(c, s, ct.id, set);
  await pur.linkShipmentContainer(c, s.entityId, [...new Set(e.shipped.map((x) => x.shipmentId))], ct.id);
  const st = await q<{ stage: Stage; actual_on: string | null }>(c, `select stage, actual_on::text from wms_container_stage where entity_id = $1 and container_id = $2`, [s.entityId, ct.id]);
  if (!st.find((x) => x.stage === "departed")?.actual_on) {
    const d = e.shippedOn && DAY.test(e.shippedOn) && e.shippedOn <= today() ? e.shippedOn : today();
    await setStage(c, s, ct.id, "departed", { actualOn: d });
  }
  if (e.deliveryOn && DAY.test(e.deliveryOn) && !st.find((x) => x.stage === "delivered_dc")?.actual_on) await setStage(c, s, ct.id, "delivered_dc", { expectedOn: e.deliveryOn });
  return { id: ct.id, number: ct.number, containerNo: no };
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

export type OpenPrep = { number: string; type: string; status: string; label: string | null };

/**
 * Prep not finished on the labelled units allocated to these order lines:
 * every kind their product needs that is not done, and any other job still
 * open on them. Keyed by order line.
 */
export async function prepOpenForLines(c: Client, entityId: string, lineIds: string[]): Promise<Map<string, OpenPrep[]>> {
  const out = new Map<string, OpenPrep[]>();
  if (!lineIds.length) return out;
  const units = await q<{ unit_id: string; product_id: string; line_id: string; label: string }>(c, `
    select unit_id, min(product_id::text)::uuid product_id, min(sales_order_line_id::text)::uuid line_id, min(label) label
      from inv_piece where entity_id = $1 and sales_order_line_id = any($2) and status in ('reserved','picked','loaded')
     group by unit_id`, [entityId, lineIds]);
  if (!units.length) return out;
  const jobs = await q<{ unit_id: string; number: string; prep_type: string; status: string }>(c, `select unit_id, number, prep_type, status from wms_prep_job
     where entity_id = $1 and unit_id = any($2) and status <> 'cancelled' order by created_at`, [entityId, units.map((u) => u.unit_id)]);
  const rules = new Map<string, PrepType[]>();
  for (const u of units) {
    if (!rules.has(u.product_id)) rules.set(u.product_id, (await prepFor(c, entityId, u.product_id)).types);
    const mine = jobs.filter((j) => j.unit_id === u.unit_id);
    const done = new Set(mine.filter((j) => j.status === "done").map((j) => j.prep_type));
    const list: OpenPrep[] = [];
    for (const j of mine) if (j.status !== "done") list.push({ number: j.number, type: j.prep_type, status: j.status, label: u.label });
    for (const t of rules.get(u.product_id)!) if (!done.has(t) && !list.some((x) => x.type === t)) list.push({ number: "", type: t, status: "not_queued", label: u.label });
    if (list.length) out.set(u.line_id, [...(out.get(u.line_id) ?? []), ...list]);
  }
  return out;
}

/** The company's choice for goods whose prep is not done: off, warn, or refuse to book or stage them. */
export async function prepGateMode(c: Client, entityId: string): Promise<"off" | "warn" | "refuse"> {
  const v = await inv.settingOf<unknown>(c, entityId, "wms.prep_gate", "warn");
  return v === "off" || v === "refuse" ? v : "warn";
}

/**
 * The gate a delivery booking or a pick list goes through. Returns the open
 * prep and a sentence; refuse is true when the company refuses such goods.
 */
export async function prepGate(c: Client, entityId: string, lineIds: string[], doing: string) {
  const mode = await prepGateMode(c, entityId);
  if (mode === "off") return { mode, open: [] as OpenPrep[], refuse: false, message: null as string | null };
  const map = await prepOpenForLines(c, entityId, lineIds);
  const open = [...map.values()].flat();
  if (!open.length) return { mode, open, refuse: false, message: null };
  const list = open.slice(0, 4).map((x) => `${x.label ?? "a piece"} needs ${words(x.type)}${x.status === "problem" ? " (a problem was found)" : ""}`).join("; ");
  const more = open.length > 4 ? ` and ${open.length - 4} more` : "";
  const message = mode === "refuse"
    ? `prep is not done, so ${doing} is refused: ${list}${more}. Finish it in the prep queue first`
    : `prep is not done yet: ${list}${more}`;
  return { mode, open, refuse: mode === "refuse", message };
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

async function unitHeld(c: Client, entityId: string, unitId: string): Promise<string | null> {
  const r = await q<{ status: string }>(c, `select status from inv_piece where entity_id = $1 and unit_id = $2 limit 1`, [entityId, unitId]);
  return r[0] && ["damaged", "in_repair", "vendor_claim", "written_off", "returned_to_vendor", "delivered"].includes(r[0].status) ? r[0].status : null;
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
