// Haul-away and recycling: the old sofa or mattress the crew takes away.
//
// A stop carries haul-away lines (what, how many, the fee per piece from the
// company's rates, any trade-in value). On a stop with an order, the fee is a
// fee line on the order and a trade-in is a credit line on it, both left open
// so they are handed over and invoiced with the delivery (fleet.completeStop
// -> ar.invoiceFulfilment): the fee is revenue (4030), the trade-in comes off
// the sale. The driver records what was actually taken, with a photo, before
// the stop is completed; what was not taken comes off the order.
//
// The disposal log says where it went (recycler, landfill, donation), when,
// the weight and the certificate number, and feeds a report by state for the
// states that run a mattress recycling program (configurable per state).

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { FleetError } from "./fleet.ts";

function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new FleetError(message);
}
const UUIDRX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUIDRX.test(v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const n = (v: unknown) => Number(v ?? 0);
export const CATEGORIES = ["mattress", "box_spring", "sofa", "chair", "recliner", "table", "appliance", "other"];
export const METHODS = ["recycler", "landfill", "donation"];
const usd = (m: bigint) => `$${(Number(m) / 100).toFixed(2)}`;

// ------------------------------------------------------------ settings --

export async function rates(c: Client, entityId: string) {
  return q(c, `select r.id, r.category, r.label, r.fee_product_id, p.sku fee_sku, r.fee_minor::text fee_minor, r.est_weight_lb::float est_weight_lb, r.active
                 from haul_away_rate r left join product p on p.id = r.fee_product_id
                where r.entity_id = $1 order by r.category`, [entityId]);
}

export async function saveRate(c: Client, scope: Scope, b: { category: string; label?: string; feeProductId?: string | null; feeMinor: bigint; estWeightLb?: number; active?: boolean }) {
  need(CATEGORIES.includes(b.category), `a haul-away is one of: ${CATEGORIES.join(", ").replace(/_/g, " ")}`);
  need(b.feeMinor >= 0n, "a fee is not negative");
  if (b.feeProductId) {
    need(isId(b.feeProductId), "no such fee product");
    const p = await q<{ kind: string }>(c, `select kind from product where entity_id = $1 and id = $2`, [scope.entityId, b.feeProductId]);
    need(p.length, "no such fee product");
    need(["fee", "service"].includes(p[0].kind), "the haul-away fee is charged with a fee or service product");
  }
  need(b.feeMinor === 0n || b.feeProductId, "pick the fee product the charge is sold as");
  return one(c, `insert into haul_away_rate (entity_id, category, label, fee_product_id, fee_minor, est_weight_lb, active)
                 values ($1,$2,$3,$4,$5,$6,$7)
                 on conflict (entity_id, category) do update set label = excluded.label, fee_product_id = excluded.fee_product_id,
                   fee_minor = excluded.fee_minor, est_weight_lb = excluded.est_weight_lb, active = excluded.active returning id`,
    [scope.entityId, b.category, String(b.label ?? "").trim() || b.category.replace(/_/g, " "), b.feeProductId || null, b.feeMinor.toString(),
     Math.max(0, n(b.estWeightLb)), b.active !== false]);
}

export async function programs(c: Client, entityId: string) {
  return q(c, `select id, state, name, categories, program_fee_minor::text program_fee_minor, report_required, active
                 from recycling_program where entity_id = $1 order by state`, [entityId]);
}

export async function saveProgram(c: Client, scope: Scope, b: { state: string; name: string; categories?: string[]; programFeeMinor?: bigint; reportRequired?: boolean; active?: boolean }) {
  const state = String(b.state ?? "").trim().toUpperCase();
  need(/^[A-Z]{2}$/.test(state), "give the two-letter state");
  need(String(b.name ?? "").trim(), "name the program");
  const cats = (b.categories?.length ? b.categories : ["mattress", "box_spring"]).filter((x) => CATEGORIES.includes(x));
  need(cats.length, "pick what the program covers");
  return one(c, `insert into recycling_program (entity_id, state, name, categories, program_fee_minor, report_required, active)
                 values ($1,$2,$3,$4,$5,$6,$7)
                 on conflict (entity_id, state) do update set name = excluded.name, categories = excluded.categories,
                   program_fee_minor = excluded.program_fee_minor, report_required = excluded.report_required, active = excluded.active returning id`,
    [scope.entityId, state, String(b.name).trim().slice(0, 120), cats, (b.programFeeMinor ?? 0n).toString(), b.reportRequired === true, b.active !== false]);
}

// ------------------------------------------------------------ the stop --

async function stopOf(c: Client, entityId: string, stopId: string) {
  need(isId(stopId), "no such stop");
  const r = await q<{ id: string; number: string; kind: string; status: string; sales_order_id: string | null; state: string | null;
    route_id: string | null; route_status: string | null; order_status: string | null }>(c, `
    select s.id, s.number, s.kind, s.status, s.sales_order_id, a.state, s.route_id, r.status route_status, so.status order_status
      from delivery_stop s left join customer_address a on a.id = s.address_id left join delivery_route r on r.id = s.route_id
      left join sales_order so on so.id = s.sales_order_id
     where s.entity_id = $1 and s.id = $2 for update of s`, [entityId, stopId]);
  need(r.length, "no such stop");
  return r[0];
}

async function addOrderLine(c: Client, entityId: string, orderId: string, l: { productId: string | null; sku: string; description: string; qty: number; unitMinor: bigint; creditMinor?: bigint }) {
  const seq = await one<{ s: number }>(c, `select coalesce(max(seq),0)::int + 1 s from sales_order_line where entity_id = $1 and sales_order_id = $2`, [entityId, orderId]);
  const r = await one<{ id: string }>(c, `
    insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, discount_minor, tax_minor, line_status)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,'open') returning id`,
    [entityId, orderId, seq.s, l.productId, l.sku, l.description.slice(0, 200), l.qty, l.unitMinor.toString(), (l.creditMinor ?? 0n).toString()]);
  return r.id;
}
async function retotal(c: Client, orderId: string) {
  await c.query(`select sales_order_retotal($1) /* unscoped: an order of this entity */`, [orderId]);
}
/** A line still open comes off (cancelled), or down to a smaller quantity. Never one already handed over. */
async function trimLine(c: Client, entityId: string, lineId: string | null, qty: number) {
  if (!lineId) return;
  if (qty <= 0) await c.query(`update sales_order_line set line_status = 'cancelled' where entity_id = $1 and id = $2 and line_status = 'open'`, [entityId, lineId]);
  else await c.query(`update sales_order_line set qty = $3 where entity_id = $1 and id = $2 and line_status = 'open'`, [entityId, lineId, qty]);
}

export async function forStop(c: Client, entityId: string, stopId: string) {
  return q(c, `select h.id, h.category, h.description, h.qty::float qty, h.fee_minor::text fee_minor, h.trade_in_minor::text trade_in_minor,
                      h.state, h.status, h.taken_qty::float taken_qty, h.weight_lb::float weight_lb, h.photo is not null has_photo, h.taken_note,
                      h.taken_at::text taken_at, u.name taken_by, h.disposal_id, d.number disposal_number
                 from stop_haul_away h left join app_user u on u.id = h.taken_by left join haul_away_disposal d on d.id = h.disposal_id
                where h.entity_id = $1 and h.stop_id = $2 and h.status <> 'cancelled' order by h.created_at`, [entityId, stopId]);
}

/** Add a haul-away to a stop: the fee goes on the order, and any trade-in comes off it. */
export async function addHaulAway(c: Client, scope: Scope, stopId: string, b: { category: string; qty?: number; description?: string; tradeInMinor?: bigint; waiveFee?: boolean }) {
  const st = await stopOf(c, scope.entityId, stopId);
  need(st.status === "scheduled", `stop ${st.number} is ${st.status}; haul-away is added before the crew gets there`);
  need(["delivery", "pickup"].includes(st.kind), "haul-away rides on a delivery or a pickup");
  need(CATEGORIES.includes(b.category), `a haul-away is one of: ${CATEGORIES.join(", ").replace(/_/g, " ")}`);
  const qty = Math.round(n(b.qty ?? 1) * 100) / 100;
  need(qty > 0 && qty <= 20, "say how many pieces go (1 to 20)");
  const rate = await q<{ label: string; fee_product_id: string | null; fee_minor: string; sku: string | null; est: number }>(c, `
    select r.label, r.fee_product_id, r.fee_minor, p.sku, r.est_weight_lb::float est from haul_away_rate r left join product p on p.id = r.fee_product_id
     where r.entity_id = $1 and r.category = $2 and r.active`, [scope.entityId, b.category]);
  need(rate.length, `there is no haul-away rate for ${b.category.replace(/_/g, " ")}; add one in Delivery › Haul-away`);
  const fee = b.waiveFee ? 0n : BigInt(rate[0].fee_minor);
  const trade = b.tradeInMinor ?? 0n;
  need(trade >= 0n, "a trade-in value is not negative");
  need((fee === 0n && trade === 0n) || st.sales_order_id, `stop ${st.number} has no order to charge the fee or credit the trade-in to`);
  if (st.sales_order_id) need(["open", "fulfilling"].includes(st.order_status ?? ""), `the order on stop ${st.number} is ${st.order_status}`);
  const desc = String(b.description ?? "").trim().slice(0, 200) || rate[0].label;
  let feeLine: string | null = null, tradeLine: string | null = null;
  if (st.sales_order_id && fee > 0n) {
    feeLine = await addOrderLine(c, scope.entityId, st.sales_order_id, { productId: rate[0].fee_product_id, sku: rate[0].sku ?? "HAUL-AWAY",
      description: `Haul-away: ${desc}`, qty, unitMinor: fee });
  }
  if (st.sales_order_id && trade > 0n) {
    // a credit line: nothing sold, the trade-in's value off (it is handed over and invoiced with the delivery)
    tradeLine = await addOrderLine(c, scope.entityId, st.sales_order_id, { productId: null, sku: "TRADE-IN", description: `Trade-in credit: ${desc}`, qty: 1, unitMinor: 0n, creditMinor: trade });
  }
  if (st.sales_order_id) await retotal(c, st.sales_order_id);
  const r = await one<{ id: string }>(c, `
    insert into stop_haul_away (entity_id, stop_id, category, description, qty, fee_minor, fee_line_id, trade_in_minor, trade_in_line_id, state, weight_lb, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [scope.entityId, stopId, b.category, desc, qty, fee.toString(), feeLine, trade.toString(), tradeLine, (st.state ?? "PA").toUpperCase().slice(0, 2),
     Math.round(rate[0].est * qty * 10) / 10, scope.actor.id || null]);
  await audit(c, scope, { table: "stop_haul_away", rowId: r.id, action: "insert", after: { stop: st.number, category: b.category, qty, fee: fee.toString(), trade: trade.toString() } });
  return { id: r.id, feeMinor: fee * BigInt(Math.round(qty)), tradeInMinor: trade, feeLineId: feeLine, tradeInLineId: tradeLine };
}

/** Take a planned haul-away off before the crew goes: its order lines come off. */
export async function cancelHaulAway(c: Client, scope: Scope, id: string, reason: string) {
  const h = await haulRow(c, scope.entityId, id);
  need(h.status === "planned", `that haul-away is ${h.status.replace("_", " ")}`);
  need(String(reason ?? "").trim().length >= 3, "say why it comes off");
  const st = await stopOf(c, scope.entityId, h.stop_id);
  need(["scheduled", "arrived"].includes(st.status), `stop ${st.number} is ${st.status}`);
  await trimLine(c, scope.entityId, h.fee_line_id, 0);
  await trimLine(c, scope.entityId, h.trade_in_line_id, 0);
  if (st.sales_order_id) await retotal(c, st.sales_order_id);
  await c.query(`update stop_haul_away set status = 'cancelled', cancel_reason = $3 where entity_id = $1 and id = $2`, [scope.entityId, id, String(reason).trim().slice(0, 300)]);
  return { status: "cancelled" };
}

async function haulRow(c: Client, entityId: string, id: string) {
  need(isId(id), "no such haul-away");
  const r = await q<{ id: string; stop_id: string; status: string; qty: string; fee_line_id: string | null; trade_in_line_id: string | null; category: string;
    disposal_id: string | null; taken_qty: string | null }>(c,
    `select id, stop_id, status, qty, fee_line_id, trade_in_line_id, category, disposal_id, taken_qty from stop_haul_away where entity_id = $1 and id = $2 for update`, [entityId, id]);
  need(r.length, "no such haul-away");
  return r[0];
}

/**
 * The driver records what was actually taken. Taken needs a photo; the fee is
 * charged for what was taken. Nothing taken takes the fee and the trade-in off
 * the order. Recorded before the stop is completed, so it is invoiced with it.
 */
export async function recordHaulAway(c: Client, scope: Scope, id: string, b: { takenQty: number; photo?: string | null; note?: string; weightLb?: number | null }) {
  const h = await haulRow(c, scope.entityId, id);
  need(h.status !== "cancelled", "that haul-away was taken off the stop");
  const st = await stopOf(c, scope.entityId, h.stop_id);
  need(["scheduled", "arrived"].includes(st.status), `stop ${st.number} is already ${st.status}; haul-away is recorded before the stop is completed`);
  if (st.route_id) need(st.route_status === "in_progress", "start the route before recording at the door");
  const taken = Math.round(n(b.takenQty) * 100) / 100;
  need(taken >= 0 && taken <= n(h.qty), `between 0 and ${n(h.qty)} can be taken`);
  const photo = String(b.photo ?? "").trim();
  if (taken > 0) {
    need(/^(https:\/\/|data:image\/)/.test(photo), "take a photo of what goes on the truck");
    need(photo.length <= 2_000_000, "the photo is too large; send a link to it");
  }
  if (taken === 0) need(String(b.note ?? "").trim().length >= 3, "say why nothing was taken");
  await trimLine(c, scope.entityId, h.fee_line_id, taken);
  if (taken === 0) await trimLine(c, scope.entityId, h.trade_in_line_id, 0);
  if (st.sales_order_id) await retotal(c, st.sales_order_id);
  const weight = b.weightLb != null && Number.isFinite(Number(b.weightLb)) ? Math.max(0, Number(b.weightLb)) : null;
  await c.query(`update stop_haul_away set status = $3, taken_qty = $4, photo = nullif($5,''), taken_note = nullif($6,''), taken_at = now(), taken_by = $7,
                        weight_lb = coalesce($8, case when qty > 0 then weight_lb * $4 / qty end)
                  where entity_id = $1 and id = $2`,
    [scope.entityId, id, taken > 0 ? "taken" : "not_taken", taken, taken > 0 ? photo : "", String(b.note ?? "").trim().slice(0, 300), scope.actor.id || null, weight]);
  return { status: taken > 0 ? "taken" : "not_taken", takenQty: taken };
}

// ------------------------------------------------------------ disposal --

/** Taken away and back at the warehouse, not yet disposed of. */
export async function collected(c: Client, entityId: string, dcId: string | null) {
  return q(c, `
    select h.id, h.category, h.description, h.taken_qty::float qty, h.weight_lb::float weight_lb, h.state, h.taken_at::text taken_at,
           s.number stop_number, s.dc_location_id, lo.name dc_name, cu.name customer
      from stop_haul_away h join delivery_stop s on s.id = h.stop_id join location lo on lo.id = s.dc_location_id
      left join customer cu on cu.id = s.customer_id
     where h.entity_id = $1 and h.status = 'taken' and h.disposal_id is null and ($2::uuid is null or s.dc_location_id = $2)
     order by h.taken_at`, [entityId, dcId]);
}

export async function recordDisposal(c: Client, scope: Scope, b: { dcLocationId: string; disposedOn: string; method: string; facility: string;
  weightLb?: number | null; certificateNo?: string; state?: string; note?: string; haulIds: string[] }) {
  need(isId(b.dcLocationId), "pick the warehouse it left from");
  const dc = await q<{ state: string | null }>(c, `select state from location where entity_id = $1 and id = $2`, [scope.entityId, b.dcLocationId]);
  need(dc.length, "that warehouse is not one of this company's");
  need(DAY.test(String(b.disposedOn ?? "")), "give the day it went");
  need(METHODS.includes(b.method), "it went to a recycler, a landfill, or as a donation");
  need(String(b.facility ?? "").trim(), "name where it went");
  const cert = String(b.certificateNo ?? "").trim().slice(0, 60);
  if (b.method === "recycler") need(cert, "a recycler's drop needs its certificate number");
  const ids = (b.haulIds ?? []).filter(isId);
  need(ids.length, "pick what went");
  const rows = await q<{ id: string; status: string; disposal_id: string | null; weight_lb: string | null; state: string; dc_location_id: string }>(c, `
    select h.id, h.status, h.disposal_id, h.weight_lb, h.state, s.dc_location_id from stop_haul_away h join delivery_stop s on s.id = h.stop_id
     where h.entity_id = $1 and h.id = any($2) for update of h`, [scope.entityId, ids]);
  need(rows.length === ids.length, "some of those are not this company's haul-aways");
  need(rows.every((r) => r.status === "taken"), "only what was taken away is disposed of");
  need(rows.every((r) => !r.disposal_id), "some of those are already on a disposal");
  const weight = b.weightLb != null && String(b.weightLb) !== "" ? Number(b.weightLb) : rows.reduce((a, r) => a + n(r.weight_lb), 0);
  need(Number.isFinite(weight) && weight >= 0, "give the weight in pounds");
  const state = String(b.state ?? "").trim().toUpperCase() || rows[0].state || (dc[0]?.state ?? "PA");
  need(/^[A-Z]{2}$/.test(state), "give the two-letter state it was disposed in");
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'disposal', 'HD-') n /* unscoped: numbering takes the entity */`, [scope.entityId])).n;
  const d = await one<{ id: string }>(c, `
    insert into haul_away_disposal (entity_id, number, dc_location_id, disposed_on, method, facility, weight_lb, certificate_no, state, note, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,nullif($8,''),$9,nullif($10,''),$11) returning id`,
    [scope.entityId, number, b.dcLocationId, b.disposedOn, b.method, String(b.facility).trim().slice(0, 120), Math.round(weight * 10) / 10, cert, state,
     String(b.note ?? "").trim().slice(0, 300), scope.actor.id || null]);
  await c.query(`update stop_haul_away set disposal_id = $3 where entity_id = $1 and id = any($2)`, [scope.entityId, ids, d.id]);
  await audit(c, scope, { table: "haul_away_disposal", rowId: d.id, action: "insert", after: { number, method: b.method, pieces: ids.length, weight } });
  return { id: d.id, number, pieces: ids.length, weightLb: Math.round(weight * 10) / 10 };
}

export async function disposals(c: Client, entityId: string, from: string, to: string) {
  return q(c, `
    select d.id, d.number, d.disposed_on::text disposed_on, d.method, d.facility, d.weight_lb::float weight_lb, d.certificate_no, d.state, d.note,
           lo.name dc_name, count(h.id)::int lines, coalesce(sum(h.taken_qty),0)::float pieces
      from haul_away_disposal d join location lo on lo.id = d.dc_location_id
      left join stop_haul_away h on h.disposal_id = d.id and h.entity_id = d.entity_id
     where d.entity_id = $1 and d.disposed_on between $2::date and $3::date
     group by d.id, lo.name order by d.disposed_on desc, d.number`, [entityId, from, to]);
}

/**
 * For a state's recycling program: units collected by category, how they were
 * disposed of (recycled, landfilled, donated) with weights and certificates,
 * and whether the state wants the report at all.
 */
export async function programReport(c: Client, entityId: string, state: string, from: string, to: string) {
  const st = String(state ?? "").trim().toUpperCase();
  need(/^[A-Z]{2}$/.test(st), "pick the state");
  need(DAY.test(from) && DAY.test(to) && from <= to, "pick the period");
  const prog = await q<{ name: string; categories: string[]; program_fee_minor: string; report_required: boolean }>(c, `
    select name, categories, program_fee_minor, report_required from recycling_program where entity_id = $1 and state = $2 and active`, [entityId, st]);
  const cats = prog[0]?.categories ?? ["mattress", "box_spring"];
  const rows = await q<{ category: string; collected: number; recycled: number; landfilled: number; donated: number; undisposed: number;
    weight_recycled: number; weight_landfilled: number; weight_donated: number }>(c, `
    select h.category,
           coalesce(sum(h.taken_qty),0)::float collected,
           coalesce(sum(h.taken_qty) filter (where d.method = 'recycler'),0)::float recycled,
           coalesce(sum(h.taken_qty) filter (where d.method = 'landfill'),0)::float landfilled,
           coalesce(sum(h.taken_qty) filter (where d.method = 'donation'),0)::float donated,
           coalesce(sum(h.taken_qty) filter (where d.id is null),0)::float undisposed,
           coalesce(sum(h.weight_lb) filter (where d.method = 'recycler'),0)::float weight_recycled,
           coalesce(sum(h.weight_lb) filter (where d.method = 'landfill'),0)::float weight_landfilled,
           coalesce(sum(h.weight_lb) filter (where d.method = 'donation'),0)::float weight_donated
      from stop_haul_away h left join haul_away_disposal d on d.id = h.disposal_id
     where h.entity_id = $1 and h.status = 'taken' and h.state = $2 and h.category = any($3)
       and (h.taken_at at time zone 'UTC')::date between $4::date and $5::date
     group by h.category order by h.category`, [entityId, st, cats, from, to]);
  const certs = await q(c, `
    select distinct d.number, d.disposed_on::text disposed_on, d.facility, d.certificate_no, d.method, d.weight_lb::float weight_lb
      from haul_away_disposal d join stop_haul_away h on h.disposal_id = d.id
     where d.entity_id = $1 and h.state = $2 and h.category = any($3) and (h.taken_at at time zone 'UTC')::date between $4::date and $5::date
     order by 2, 1`, [entityId, st, cats, from, to]);
  const total = rows.reduce((a, r) => a + r.collected, 0);
  const recycled = rows.reduce((a, r) => a + r.recycled, 0);
  return {
    state: st, from, to, program: prog[0] ?? null,
    reportRequired: prog[0]?.report_required ?? false,
    note: prog[0]?.report_required ? `${prog[0].name} wants this report` : `${st} has no program set to want a report; the log is kept anyway`,
    categories: rows, certificates: certs,
    totals: { collected: total, recycled, recycledPct: total ? Math.round(recycled / total * 100) : null,
      programFeeMinor: (BigInt(prog[0]?.program_fee_minor ?? "0") * BigInt(Math.round(total))).toString() },
    programFeeWords: prog[0] && BigInt(prog[0].program_fee_minor) > 0n ? `${usd(BigInt(prog[0].program_fee_minor))} a unit` : null,
  };
}
