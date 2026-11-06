// Delivery routing: pure functions, no database, no clock, no randomness.
// The same stops and trucks in always give the same routes out, so a
// dispatcher who presses "re-optimise" twice sees the same answer twice.
//
//   haversineMiles      great-circle distance, times a road factor
//   serviceMinutes      time at the door: base + per piece + stairs per piece
//   simulate            drive a sequence: arrival, wait, ETA, lateness per stop
//   construct           nearest neighbour, window group by window group
//   twoOpt              reverse segments while that shortens the loop and
//                       makes no stop later than it was -- never lengthens
//   optimise            construct + twoOpt
//   assign              capacity-constrained sweep clustering onto trucks
//                       (cube, weight, stop count, time windows, day length)
//
// Distances come from haversine unless the caller injects a matrix (a real
// road-distance service), through Cfg.distance.

export type Pt = { lng: number; lat: number };

export type RStop = {
  id: string;
  at: Pt;
  cube?: number;
  weight?: number;
  pieces?: number;
  stairs?: number;
  windowStart?: number;      // minutes after midnight
  windowEnd?: number;
  serviceMin?: number;       // overrides the formula when given
};

export type RVehicle = {
  id: string;
  cube: number;
  weight: number;
  maxStops: number;
  startMin?: number;          // leaves the DC
  endMin?: number;            // must be back by
};

export type Node = { id: string; at: Pt };

export type Cfg = {
  avgMph?: number;            // default 30
  roadFactor?: number;        // haversine * this; default 1.3
  baseMin?: number;           // default 10
  perPieceMin?: number;       // default 4
  perStairPieceMin?: number;  // default 3, per flight per piece
  startMin?: number;          // default 450 (7:30)
  endMin?: number;            // default 1110 (18:30)
  /** injectable distance in miles; the depot's node id is DEPOT */
  distance?: (a: Node, b: Node) => number;
};

export const DEPOT = "__depot";

export type StopPlan = {
  id: string;
  seq: number;
  arriveMin: number;
  startMin: number;           // service starts (after any wait for the window)
  departMin: number;
  waitMin: number;
  lateMin: number;            // service starts after the window closed by this much
  legMiles: number;
};

export type RoutePlan = {
  stops: StopPlan[];
  miles: number;
  minutes: number;            // depot out to depot back
  endMin: number;
  lateMin: number;
  waitMin: number;
};

const R_MILES = 3958.7613;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMiles(a: Pt, b: Pt): number {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

const c0 = (cfg: Cfg) => ({
  mph: cfg.avgMph ?? 30, road: cfg.roadFactor ?? 1.3, base: cfg.baseMin ?? 10, piece: cfg.perPieceMin ?? 4,
  stair: cfg.perStairPieceMin ?? 3, start: cfg.startMin ?? 450, end: cfg.endMin ?? 1110,
});

export function miles(a: Node, b: Node, cfg: Cfg = {}): number {
  if (a.id === b.id) return 0;
  if (cfg.distance) return cfg.distance(a, b);
  return haversineMiles(a.at, b.at) * c0(cfg).road;
}

export function serviceMinutes(s: RStop, cfg: Cfg = {}): number {
  if (s.serviceMin != null) return s.serviceMin;
  const k = c0(cfg);
  const pcs = Math.max(0, s.pieces ?? 0);
  return k.base + k.piece * pcs + k.stair * Math.max(0, s.stairs ?? 0) * Math.max(1, pcs);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Drive the stops in this order from the depot and back. */
export function simulate(depot: Pt, seq: RStop[], cfg: Cfg = {}, startMin?: number): RoutePlan {
  const k = c0(cfg);
  const dep: Node = { id: DEPOT, at: depot };
  let t = startMin ?? k.start, total = 0, late = 0, wait = 0;
  let prev: Node = dep;
  const out: StopPlan[] = [];
  seq.forEach((s, i) => {
    const d = miles(prev, s, cfg);
    total += d;
    const arrive = t + (d / k.mph) * 60;
    const ws = s.windowStart ?? -Infinity, we = s.windowEnd ?? Infinity;
    const start = Math.max(arrive, ws);
    const w = start - arrive;
    const l = Math.max(0, start - we);
    const depart = start + serviceMinutes(s, cfg);
    out.push({ id: s.id, seq: i + 1, arriveMin: Math.round(arrive), startMin: Math.round(start), departMin: Math.round(depart),
      waitMin: Math.round(w), lateMin: Math.round(l), legMiles: r1(d) });
    wait += w; late += l; t = depart; prev = s;
  });
  const back = miles(prev, dep, cfg);
  total += back;
  const end = t + (back / k.mph) * 60;
  const st = startMin ?? k.start;
  return { stops: out, miles: r1(total), minutes: Math.round(end - st), endMin: Math.round(end), lateMin: Math.round(late), waitMin: Math.round(wait) };
}

/** Loop length in miles, depot out and back. */
export function loopMiles(depot: Pt, seq: RStop[], cfg: Cfg = {}): number {
  const dep: Node = { id: DEPOT, at: depot };
  let prev: Node = dep, total = 0;
  for (const s of seq) { total += miles(prev, s, cfg); prev = s; }
  return total + miles(prev, dep, cfg);
}

const byId = (a: RStop, b: RStop) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Nearest neighbour, one window group at a time (8–12 before 12–4), so the
 * first draft already honours the order customers were promised. Stops with
 * no window travel with the first group.
 */
export function construct(depot: Pt, stops: RStop[], cfg: Cfg = {}): RStop[] {
  const groups = new Map<string, RStop[]>();
  for (const s of [...stops].sort(byId)) {
    const key = s.windowStart == null && s.windowEnd == null ? "" : `${String(s.windowStart ?? 0).padStart(5, "0")}-${String(s.windowEnd ?? 1440).padStart(5, "0")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const keys = [...groups.keys()].sort();
  // window-less stops ride with the earliest group
  if (keys[0] === "" && keys.length > 1) { groups.get(keys[1])!.push(...groups.get("")!); keys.shift(); }
  const out: RStop[] = [];
  let prev: Node = { id: DEPOT, at: depot };
  for (const key of keys) {
    const left = [...groups.get(key)!];
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((s, i) => { const d = miles(prev, s, cfg); if (d < bd - 1e-9) { bd = d; bi = i; } });
      const [s] = left.splice(bi, 1);
      out.push(s); prev = s;
    }
  }
  return out;
}

/**
 * 2-opt: reverse a run of stops when that makes the loop strictly shorter
 * and no later against the windows. A move that lengthens is never taken, so
 * the result is never longer than what came in.
 */
export function twoOpt(depot: Pt, seq: RStop[], cfg: Cfg = {}, maxPasses = 50): RStop[] {
  let best = [...seq];
  if (best.length < 3) return best;
  let bestLen = loopMiles(depot, best, cfg);
  let bestLate = simulate(depot, best, cfg).lateMin;
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const len = loopMiles(depot, cand, cfg);
        if (len < bestLen - 1e-6) {
          const late = simulate(depot, cand, cfg).lateMin;
          if (late <= bestLate) { best = cand; bestLen = len; bestLate = late; improved = true; }
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

export function optimise(depot: Pt, stops: RStop[], cfg: Cfg = {}): RStop[] {
  return twoOpt(depot, construct(depot, stops, cfg), cfg);
}

export type Assignment = {
  routes: { vehicleId: string; stops: RStop[]; plan: RoutePlan; cube: number; weight: number }[];
  unassigned: { id: string; reason: string }[];
};

/**
 * Put stops on trucks. Sweep: order the stops by bearing from the DC,
 * starting just after the widest empty arc, and fill one truck before
 * starting the next, so each truck works one slice of the map. A stop goes
 * on a truck only if the truck still has the cube, the weight and the stop
 * count for it, and the optimised route still makes every window and gets
 * back before the end of the day. A stop that fits nowhere is left over,
 * with the reason, for a person to decide.
 */
export function assign(depot: Pt, stops: RStop[], vehicles: RVehicle[], cfg: Cfg = {}): Assignment {
  const k = c0(cfg);
  const ang = (s: RStop) => {
    const a = Math.atan2(s.at.lat - depot.lat, (s.at.lng - depot.lng) * Math.cos(rad(depot.lat)));
    return a < 0 ? a + 2 * Math.PI : a;
  };
  const sorted = [...stops].sort((a, b) => ang(a) - ang(b) || byId(a, b));
  // start after the widest gap, so a cluster is not split across the 0° line
  if (sorted.length > 2) {
    let gi = 0, gap = -1;
    for (let i = 0; i < sorted.length; i++) {
      const a = ang(sorted[i]), b = i + 1 < sorted.length ? ang(sorted[i + 1]) : ang(sorted[0]) + 2 * Math.PI;
      if (b - a > gap + 1e-12) { gap = b - a; gi = i; }
    }
    sorted.push(...sorted.splice(0, gi + 1));
  }
  const load = vehicles.map(() => ({ stops: [] as RStop[], cube: 0, weight: 0 }));
  const unassigned: Assignment["unassigned"] = [];
  let cur = 0;
  for (const s of sorted) {
    const order = vehicles.length ? [...Array(vehicles.length).keys()].map((i) => (cur + i) % vehicles.length) : [];
    let roomSomewhere = false, placed = -1;
    for (const vi of order) {
      const v = vehicles[vi], L = load[vi];
      const cube = L.cube + (s.cube ?? 0), weight = L.weight + (s.weight ?? 0);
      if (cube > v.cube + 1e-9 || weight > v.weight + 1e-9 || L.stops.length + 1 > v.maxStops) continue;
      roomSomewhere = true;
      const vcfg = { ...cfg, startMin: v.startMin ?? k.start };
      const trial = optimise(depot, [...L.stops, s], vcfg);
      const p = simulate(depot, trial, vcfg);
      if (p.lateMin > 0 || p.endMin > (v.endMin ?? k.end)) continue;
      L.stops = trial; L.cube = cube; L.weight = weight; placed = vi;
      break;
    }
    if (placed >= 0) cur = placed;
    else unassigned.push({ id: s.id, reason: !vehicles.length ? "no truck is available that day"
      : roomSomewhere ? "no truck can reach it inside its window and be back by the end of the day"
      : "no truck has the room for it (cube, weight or stop count)" });
  }
  const routes = vehicles.map((v, i) => {
    const vcfg = { ...cfg, startMin: v.startMin ?? k.start };
    const seq = optimise(depot, load[i].stops, vcfg);
    return { vehicleId: v.id, stops: seq, plan: simulate(depot, seq, vcfg), cube: load[i].cube, weight: load[i].weight };
  }).filter((r) => r.stops.length);
  return { routes, unassigned };
}

/** "8:05 AM" from minutes after midnight. */
export function clock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
