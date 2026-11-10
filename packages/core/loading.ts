// Loading the truck: a piece-by-piece manifest for each route, loaded last
// stop first, at the route's staging lane on the dock.
//
// The manifest is built from the route's stops: every labelled carton of a
// serialized unit (inventory's pick list allocates the units and names their
// barcodes), and every piece of a stocked line (scanned by its SKU). It is
// re-synced whenever the route changes while it is still a draft; a piece
// that leaves the route is marked removed, never deleted.
//
// A route is locked (the truck is loaded) only when every piece is loaded or
// marked short with a reason. Loading a piece while pieces for a later stop
// are still on the dock is allowed, with a warning, and remembered.
//
// Pieces move through inventory's own scan actions (pick, load, unload); this
// module never writes inv_piece itself.

import { q, one, audit, type Client, type Scope } from "./db.ts";
import * as inventory from "./inventory.ts";
import { FleetError } from "./fleet.ts";

function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new FleetError(message);
}
const UUIDRX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUIDRX.test(v);
const n = (v: unknown) => Number(v ?? 0);

type RouteRow = { id: string; number: string; status: string; route_on: string; dc_location_id: string; vehicle_id: string | null };

async function routeRow(c: Client, entityId: string, routeId: string, forUpdate = false): Promise<RouteRow> {
  need(isId(routeId), "no such route");
  const r = await q<RouteRow>(c, `select id, number, status, route_on::text route_on, dc_location_id, vehicle_id from delivery_route
                                   where entity_id = $1 and id = $2 ${forUpdate ? "for update" : ""}`, [entityId, routeId]);
  need(r.length, "no such route");
  return r[0];
}

// ---------------------------------------------------------------- lanes --

export async function lanes(c: Client, entityId: string, dcId: string | null, day: string | null) {
  return q(c, `
    select l.id, l.dc_location_id, lo.name dc_name, l.code, l.name, l.active,
           rl.route_id, r.number route_number
      from dock_lane l join location lo on lo.id = l.dc_location_id
      left join route_lane rl on rl.lane_id = l.id and rl.entity_id = l.entity_id and rl.released_at is null and rl.day = $3::date
      left join delivery_route r on r.id = rl.route_id
     where l.entity_id = $1 and ($2::uuid is null or l.dc_location_id = $2)
     order by lo.name, l.code`, [entityId, dcId, day]);
}

export async function saveLane(c: Client, scope: Scope, b: { id?: string | null; dcLocationId?: string; code?: string; name?: string; active?: boolean }) {
  const code = String(b.code ?? "").trim().toUpperCase().slice(0, 12), name = String(b.name ?? "").trim().slice(0, 80);
  need(code && name, "a lane needs a short code and a name");
  if (b.id) {
    need(isId(b.id), "no such lane");
    const r = await q(c, `update dock_lane set code = $3, name = $4, active = $5 where entity_id = $1 and id = $2 returning id`,
      [scope.entityId, b.id, code, name, b.active !== false]);
    need(r.length, "no such lane");
    return r[0];
  }
  need(isId(b.dcLocationId), "pick the warehouse the lane is in");
  const dc = await q(c, `select 1 from location where entity_id = $1 and id = $2`, [scope.entityId, b.dcLocationId]);
  need(dc.length, "that location is not one of this company's");
  const dup = await q(c, `select 1 from dock_lane where entity_id = $1 and dc_location_id = $2 and code = $3`, [scope.entityId, b.dcLocationId, code]);
  need(!dup.length, `that warehouse already has a lane ${code}`);
  return one(c, `insert into dock_lane (entity_id, dc_location_id, code, name) values ($1,$2,$3,$4) returning id`, [scope.entityId, b.dcLocationId, code, name]);
}

/** Stage a route in a lane for its day (or take it out of its lane with null). */
export async function assignLane(c: Client, scope: Scope, routeId: string, laneId: string | null) {
  const rt = await routeRow(c, scope.entityId, routeId, true);
  need(!["completed", "cancelled"].includes(rt.status), `route ${rt.number} is ${rt.status}`);
  await c.query(`update route_lane set released_at = now() where entity_id = $1 and route_id = $2 and released_at is null`, [scope.entityId, routeId]);
  if (!laneId) return { laneId: null };
  need(isId(laneId), "no such lane");
  const l = await q<{ code: string; dc_location_id: string; active: boolean }>(c, `select code, dc_location_id, active from dock_lane where entity_id = $1 and id = $2`, [scope.entityId, laneId]);
  need(l.length, "no such lane");
  need(l[0].active, `lane ${l[0].code} is not in use`);
  need(l[0].dc_location_id === rt.dc_location_id, `lane ${l[0].code} is at another warehouse`);
  const taken = await q<{ number: string }>(c, `
    select r.number from route_lane rl join delivery_route r on r.id = rl.route_id
     where rl.entity_id = $1 and rl.lane_id = $2 and rl.day = $3 and rl.released_at is null`, [scope.entityId, laneId, rt.route_on]);
  need(!taken.length, `lane ${l[0].code} already holds route ${taken[0]?.number} that day`);
  await c.query(`insert into route_lane (entity_id, route_id, lane_id, day, assigned_by) values ($1,$2,$3,$4,$5)`,
    [scope.entityId, routeId, laneId, rt.route_on, scope.actor.id || null]);
  await audit(c, scope, { table: "route_lane", rowId: routeId, action: "update", after: { lane: l[0].code, day: rt.route_on } });
  return { laneId, code: l[0].code };
}

/** The first free active lane at the route's warehouse that day, if the route has none yet. */
async function autoLane(c: Client, scope: Scope, rt: RouteRow) {
  const has = await q(c, `select 1 from route_lane where entity_id = $1 and route_id = $2 and released_at is null`, [scope.entityId, rt.id]);
  if (has.length) return;
  const free = await q<{ id: string }>(c, `
    select l.id from dock_lane l
     where l.entity_id = $1 and l.dc_location_id = $2 and l.active
       and not exists (select 1 from route_lane rl where rl.lane_id = l.id and rl.day = $3 and rl.released_at is null)
     order by l.code limit 1`, [scope.entityId, rt.dc_location_id, rt.route_on]);
  if (free.length) {
    await c.query(`insert into route_lane (entity_id, route_id, lane_id, day, assigned_by) values ($1,$2,$3,$4,$5)`,
      [scope.entityId, rt.id, free[0].id, rt.route_on, scope.actor.id || null]);
  }
}

// ------------------------------------------------------------- manifest --

type Want = { stopId: string; stopLineId: string; pieceId: string | null; ordinal: number; label: string; description: string;
  carton: string | null; stopSeq: number; group: number };

/** What should be on the truck now, last stop first. Allocates serialized units through inventory's pick list. */
async function wanted(c: Client, entityId: string, routeId: string): Promise<Want[]> {
  const stops = await q<{ id: string; seq: number | null; number: string; order_id: string | null }>(c, `
    select s.id, s.seq, s.number, s.sales_order_id order_id from delivery_stop s
     where s.entity_id = $1 and s.route_id = $2 and s.status in ('scheduled','arrived') and s.kind <> 'pickup'
     order by s.seq nulls last, s.number`, [entityId, routeId]);
  if (!stops.length) return [];
  const lines = await q<{ id: string; stop_id: string; sales_order_line_id: string | null; description: string; pieces: number; sku: string | null; serialized: boolean | null }>(c, `
    select sl.id, sl.stop_id, sl.sales_order_line_id, sl.description, sl.pieces, ol.sku, p.serialized
      from delivery_stop_line sl
      left join sales_order_line ol on ol.id = sl.sales_order_line_id
      left join product p on p.id = ol.product_id
     where sl.entity_id = $1 and sl.stop_id = any($2) and sl.outcome = 'pending'
     order by ol.seq nulls last, sl.description`, [entityId, stops.map((s) => s.id)]);
  const orderIds = [...new Set(stops.map((s) => s.order_id).filter(isId))] as string[];
  const pick = orderIds.some((id) => lines.some((l) => l.serialized)) ? await inventory.pickListFor(c, entityId, orderIds) : { lines: [] };
  const byLine = new Map(pick.lines.map((l) => [l.lineId, l]));
  const out: Want[] = [];
  stops.forEach((s, i) => {
    const group = stops.length - i;
    for (const l of lines.filter((x) => x.stop_id === s.id)) {
      const base = { stopId: s.id, stopLineId: l.id, stopSeq: s.seq ?? i + 1, group, description: l.description };
      const pl = l.sales_order_line_id ? byLine.get(l.sales_order_line_id) : undefined;
      if (l.serialized && pl) {
        pl.pieces.forEach((pc) => out.push({ ...base, pieceId: pc.id, ordinal: 1, label: pc.label, carton: pc.carton }));
        for (let k = 1; k <= pl.short; k++) out.push({ ...base, pieceId: null, ordinal: k, label: l.sku ?? "NO-LABEL", carton: "no piece allocated" });
      } else {
        const count = Math.max(0, n(l.pieces));
        for (let k = 1; k <= count; k++) out.push({ ...base, pieceId: null, ordinal: k, label: l.sku ?? "NO-SKU", carton: count > 1 ? `${k} of ${count}` : null });
      }
    }
  });
  return out;
}

/** Bring the manifest in line with the route. Only while the route is a draft: a locked route's load is fixed. */
export async function syncLoad(c: Client, scope: Scope, routeId: string) {
  const rt = await routeRow(c, scope.entityId, routeId, true);
  if (rt.status !== "draft") return { synced: false };
  await autoLane(c, scope, rt);
  const want = await wanted(c, scope.entityId, routeId);
  const have = await q<{ id: string; stop_line_id: string; piece_id: string | null; ordinal: number; status: string }>(c, `
    select id, stop_line_id, piece_id, ordinal, status from route_load_item
     where entity_id = $1 and route_id = $2 and status <> 'removed' for update`, [scope.entityId, routeId]);
  const key = (x: { stopLineId?: string; stop_line_id?: string; pieceId?: string | null; piece_id?: string | null; ordinal: number }) =>
    `${x.stopLineId ?? x.stop_line_id}|${x.pieceId ?? x.piece_id ?? "-"}|${x.ordinal}`;
  const haveBy = new Map(have.map((h) => [key(h), h]));
  const wantKeys = new Set(want.map(key));
  let added = 0, removed = 0;
  for (const w of want) {
    const h = haveBy.get(key(w));
    if (h) {
      await c.query(`update route_load_item set stop_id = $3, stop_seq = $4, load_group = $5, label = $6, carton = $7 where entity_id = $1 and id = $2`,
        [scope.entityId, h.id, w.stopId, w.stopSeq, w.group, w.label, w.carton]);
    } else {
      await c.query(`insert into route_load_item (entity_id, route_id, stop_id, stop_line_id, piece_id, ordinal, label, description, carton, stop_seq, load_group)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [scope.entityId, routeId, w.stopId, w.stopLineId, w.pieceId, w.ordinal, w.label, w.description.slice(0, 200), w.carton, w.stopSeq, w.group]);
      added++;
    }
  }
  for (const h of have) if (!wantKeys.has(key(h))) {
    await c.query(`update route_load_item set status = 'removed' where entity_id = $1 and id = $2`, [scope.entityId, h.id]);
    // the stop moved to another truck: unload the piece only if that truck has not loaded it already
    if (h.piece_id && h.status === "loaded") {
      const elsewhere = await q(c, `select 1 from route_load_item where entity_id = $1 and piece_id = $2 and route_id <> $3 and status = 'loaded'`,
        [scope.entityId, h.piece_id, routeId]);
      if (!elsewhere.length) await pieceStep(c, scope, h.piece_id, ["unload"]);
    }
    removed++;
  }
  return { synced: true, added, removed };
}

/** The loading screen and the printable manifest: pieces in load order, the lane, the payload. */
export async function loading(c: Client, entityId: string, routeId: string) {
  const rt = await q<Record<string, unknown>>(c, `
    select r.id, r.number, r.status, r.route_on::text route_on, lo.name dc_name, v.unit_no, v.cube_ft::float cube_cap, v.max_weight_lb::float weight_cap,
           d.name driver, h.name helper, ln.id lane_id, ln.code lane_code, ln.name lane_name,
           coalesce((select sum(s.weight_lb) from delivery_stop s where s.entity_id = r.entity_id and s.route_id = r.id and s.status <> 'cancelled'),0)::float weight,
           coalesce((select sum(s.cube_ft) from delivery_stop s where s.entity_id = r.entity_id and s.route_id = r.id and s.status <> 'cancelled'),0)::float cube
      from delivery_route r join location lo on lo.id = r.dc_location_id
      left join vehicle v on v.id = r.vehicle_id left join app_user d on d.id = r.driver_id left join app_user h on h.id = r.helper_id
      left join route_lane rl on rl.route_id = r.id and rl.entity_id = r.entity_id and rl.released_at is null
      left join dock_lane ln on ln.id = rl.lane_id
     where r.entity_id = $1 and r.id = $2`, [entityId, routeId]);
  need(rt.length, "no such route");
  const items = await q<Record<string, unknown>>(c, `
    select i.id, i.stop_id, s.number stop_number, cu.name customer, a.line1, a.city, i.stop_seq, i.load_group, i.label, i.description, i.carton,
           i.piece_id, i.status, i.out_of_order, i.short_reason, i.loaded_at::text loaded_at, u.name loaded_by, b.code bin
      from route_load_item i join delivery_stop s on s.id = i.stop_id
      left join customer cu on cu.id = s.customer_id left join customer_address a on a.id = s.address_id
      left join app_user u on u.id = i.loaded_by
      left join inv_piece pc on pc.id = i.piece_id left join inv_bin b on b.id = pc.bin_id
     where i.entity_id = $1 and i.route_id = $2 and i.status <> 'removed'
     order by i.load_group, i.stop_seq, i.description, i.ordinal, i.label`, [entityId, routeId]);
  const count = (st: string) => items.filter((x) => x.status === st).length;
  const next = items.find((x) => x.status === "pending");
  const r = rt[0];
  return {
    route: { ...r, payloadPct: n(r.weight_cap) ? Math.round(n(r.weight) / n(r.weight_cap) * 100) : null,
      cubePct: n(r.cube_cap) ? Math.round(n(r.cube) / n(r.cube_cap) * 100) : null },
    prepared: items.length > 0,
    items,
    totals: { pieces: items.length, loaded: count("loaded"), short: count("short"), pending: count("pending"), outOfOrder: items.filter((x) => x.out_of_order).length },
    nextGroup: next ? n(next.load_group) : null,
    canLock: r.status === "draft" && items.length > 0 && !next,
  };
}

// ------------------------------------------------------------- scanning --

async function pieceStep(c: Client, scope: Scope, pieceId: string, actions: string[]) {
  const pc = await q<{ label: string; status: string }>(c, `select label, status from inv_piece where entity_id = $1 and id = $2`, [scope.entityId, pieceId]);
  if (!pc.length) return;
  let status = pc[0].status;
  for (const a of actions) {
    if (!(inventory.NEXT[status] ?? []).includes(a)) continue;
    await inventory.pieceAction(c, scope, pc[0].label, a, {});
    status = a === "pick" ? "picked" : a === "load" ? "loaded" : a === "unload" ? "picked" : a === "unpick" ? "reserved" : status;
  }
}

type ItemRow = { id: string; status: string; load_group: number; stop_seq: number; label: string; piece_id: string | null; description: string; stop_id: string };

async function itemFor(c: Client, entityId: string, routeId: string, by: { itemId?: string | null; code?: string | null }): Promise<ItemRow> {
  if (by.itemId) {
    need(isId(by.itemId), "no such piece on this route");
    const r = await q<ItemRow>(c, `select id, status, load_group, stop_seq, label, piece_id, description, stop_id from route_load_item
                                   where entity_id = $1 and route_id = $2 and id = $3 and status <> 'removed' for update`, [entityId, routeId, by.itemId]);
    need(r.length, "no such piece on this route");
    return r[0];
  }
  const code = String(by.code ?? "").trim();
  need(code, "scan a label, or tick a piece");
  // a labelled carton by its barcode; otherwise the next piece of that SKU still on the dock, in load order
  const exact = await q<ItemRow>(c, `select id, status, load_group, stop_seq, label, piece_id, description, stop_id from route_load_item
                                      where entity_id = $1 and route_id = $2 and status <> 'removed' and piece_id is not null and upper(label) = upper($3) for update`,
    [entityId, routeId, code]);
  if (exact.length) return exact[0];
  const bySku = await q<ItemRow>(c, `select id, status, load_group, stop_seq, label, piece_id, description, stop_id from route_load_item
                                      where entity_id = $1 and route_id = $2 and status = 'pending' and piece_id is null and upper(label) = upper($3)
                                      order by load_group, stop_seq, ordinal limit 1 for update`, [entityId, routeId, code]);
  if (bySku.length) return bySku[0];
  const elsewhere = await q<{ number: string }>(c, `select r.number from route_load_item i join delivery_route r on r.id = i.route_id
     where i.entity_id = $1 and i.route_id <> $2 and upper(i.label) = upper($3) and i.status <> 'removed' limit 1`, [entityId, routeId, code]);
  need(!elsewhere.length, `${code} belongs on route ${elsewhere[0]?.number}, not this truck`);
  // a barcode the warehouse knows, held back from this load (damage hold, repair, back in stock): say why
  const pc = await q<{ status: string }>(c, `select status from inv_piece where entity_id = $1 and upper(label) = upper($2)`, [entityId, code]);
  need(!pc.length || ["reserved", "picked", "loaded"].includes(pc[0].status),
    `${code} is ${pc[0]?.status.replace(/_/g, " ")} in the warehouse, so it cannot go on the truck; mark the piece it replaces short with the reason, or clear it in Warehouse first`);
  const done = await q(c, `select 1 from route_load_item where entity_id = $1 and route_id = $2 and upper(label) = upper($3) and status <> 'removed'`, [entityId, routeId, code]);
  need(!done.length, `every ${code} on this route is already loaded or marked short`);
  need(false, `${code} is not on this route's manifest`);
  throw new Error("unreachable");
}

/** A piece goes on the truck. Out of order (a later stop's pieces still on the dock) is allowed and flagged. */
export async function loadPiece(c: Client, scope: Scope, routeId: string, by: { itemId?: string | null; code?: string | null }) {
  const rt = await routeRow(c, scope.entityId, routeId, true);
  need(rt.status === "draft", `route ${rt.number} is ${rt.status === "locked" ? "already locked; unlock it to change the load" : rt.status.replace("_", " ")}`);
  await syncLoad(c, scope, routeId);
  const it = await itemFor(c, scope.entityId, routeId, by);
  need(it.status !== "loaded", `${it.label} (${it.description}) is already loaded`);
  if (it.piece_id) {
    // only goods held for this order go on: never a piece on damage hold, in repair, or back in stock
    const pc = await q<{ status: string; line: string | null }>(c, `
      select pc.status, pc.sales_order_line_id line from inv_piece pc where pc.entity_id = $1 and pc.id = $2`, [scope.entityId, it.piece_id]);
    const status = pc[0]?.status ?? "missing";
    need(["reserved", "picked", "loaded"].includes(status),
      `${it.label} is ${status.replace(/_/g, " ")} in the warehouse, so it cannot go on the truck; mark it short with the reason, or clear it in Warehouse first`);
  }
  const before = await q<{ n: number; stop_number: string; stop_seq: number }>(c, `
    select count(*)::int n, min(s.number) stop_number, min(i.stop_seq)::int stop_seq from route_load_item i join delivery_stop s on s.id = i.stop_id
     where i.entity_id = $1 and i.route_id = $2 and i.status = 'pending' and i.load_group < $3 and i.id <> $4`,
    [scope.entityId, routeId, it.load_group, it.id]);
  const out = before[0].n > 0;
  await c.query(`update route_load_item set status = 'loaded', loaded_at = now(), loaded_by = $3, out_of_order = out_of_order or $4, short_reason = null
                  where entity_id = $1 and id = $2`, [scope.entityId, it.id, scope.actor.id || null, out]);
  if (it.piece_id) await pieceStep(c, scope, it.piece_id, ["pick", "load"]);
  const left = await one<{ n: number }>(c, `select count(*)::int n from route_load_item where entity_id = $1 and route_id = $2 and status = 'pending'`, [scope.entityId, routeId]);
  return {
    itemId: it.id, label: it.label, description: it.description, stopSeq: it.stop_seq, left: left.n,
    warning: out ? `Out of order: ${before[0].n} piece${before[0].n === 1 ? "" : "s"} for a later stop (stop ${before[0].stop_seq}, ${before[0].stop_number}) ${before[0].n === 1 ? "is" : "are"} still on the dock and should go on first` : null,
  };
}

/** A piece that is not here: it rides as short, with the reason, so the route can still be locked. */
export async function markShort(c: Client, scope: Scope, routeId: string, itemId: string, reason: string) {
  const rt = await routeRow(c, scope.entityId, routeId, true);
  need(rt.status === "draft", `route ${rt.number} is locked; unlock it to change the load`);
  need(String(reason ?? "").trim().length >= 3, "say why the piece is short (not found, damaged, still at the store)");
  await syncLoad(c, scope, routeId);
  const it = await itemFor(c, scope.entityId, routeId, { itemId });
  if (it.status === "loaded" && it.piece_id) await pieceStep(c, scope, it.piece_id, ["unload"]);
  await c.query(`update route_load_item set status = 'short', short_reason = $3, marked_by = $4, loaded_at = null, loaded_by = null
                  where entity_id = $1 and id = $2`, [scope.entityId, it.id, String(reason).trim().slice(0, 300), scope.actor.id || null]);
  await audit(c, scope, { table: "route_load_item", rowId: it.id, action: "update", after: { short: true }, reason: String(reason).trim().slice(0, 300) });
  return { itemId: it.id, status: "short" };
}

/** Undo a mis-scan: the piece goes back to the dock. */
export async function unloadPiece(c: Client, scope: Scope, routeId: string, itemId: string) {
  const rt = await routeRow(c, scope.entityId, routeId, true);
  need(rt.status === "draft", `route ${rt.number} is locked; unlock it to change the load`);
  const it = await itemFor(c, scope.entityId, routeId, { itemId });
  need(it.status !== "pending", "that piece is still on the dock");
  if (it.status === "loaded" && it.piece_id) await pieceStep(c, scope, it.piece_id, ["unload"]);
  await c.query(`update route_load_item set status = 'pending', loaded_at = null, loaded_by = null, short_reason = null where entity_id = $1 and id = $2`,
    [scope.entityId, it.id]);
  return { itemId: it.id, status: "pending" };
}

/**
 * The route is finished: a piece still on the truck (refused, damaged at the
 * door, not delivered) comes off it, back to picked at the warehouse. Called by
 * fleet.finishRoute.
 */
export async function unloadLeftovers(c: Client, scope: Scope, routeId: string) {
  const left = await q<{ piece_id: string }>(c, `
    select distinct i.piece_id from route_load_item i join inv_piece pc on pc.id = i.piece_id and pc.entity_id = i.entity_id
     where i.entity_id = $1 and i.route_id = $2 and i.status = 'loaded' and pc.status = 'loaded'`, [scope.entityId, routeId]);
  for (const x of left) await pieceStep(c, scope, x.piece_id, ["unload"]);
  return left.length;
}

/** Before a route is locked: every piece is loaded or short. Called by fleet.lockRoute. */
export async function loadGate(c: Client, scope: Scope, routeId: string) {
  await syncLoad(c, scope, routeId);
  const r = await q<{ n: number; stops: string | null }>(c, `
    select count(*)::int n, string_agg(distinct s.number, ', ' order by s.number) stops
      from route_load_item i join delivery_stop s on s.id = i.stop_id
     where i.entity_id = $1 and i.route_id = $2 and i.status = 'pending'`, [scope.entityId, routeId]);
  need(!r[0].n, `${r[0].n} piece${r[0].n === 1 ? " is" : "s are"} not loaded yet (${r[0].stops}); load ${r[0].n === 1 ? "it" : "them"} or mark ${r[0].n === 1 ? "it" : "them"} short with a reason before locking`);
}

/** Before a route leaves: the same, without changing anything. Called by fleet.startRoute. */
export async function pendingPieces(c: Client, entityId: string, routeId: string): Promise<number> {
  return (await one<{ n: number }>(c, `select count(*)::int n from route_load_item where entity_id = $1 and route_id = $2 and status = 'pending'`, [entityId, routeId])).n;
}
