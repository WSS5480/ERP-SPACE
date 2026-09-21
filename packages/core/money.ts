// Money is integer minor units, held as bigint. Never a float, never a
// JavaScript number for a total. A rounding bug found at year end costs more
// than the discipline of these twenty lines.

export type Minor = bigint;

const SCALE = 100n; // USD cents. A currency table would set this per currency.

export function fromDecimal(input: string | number): Minor {
  const s = typeof input === "number" ? input.toFixed(2) : input.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.replace(/[$,\s]/g, ""));
  if (!m) throw new Error(`not a money amount: ${input}`);
  const [, sign, whole, frac = ""] = m;
  const cents = BigInt(whole) * SCALE + BigInt(frac.padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
}

export function toDecimal(m: Minor): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function format(m: Minor, currency = "USD"): string {
  const sym = currency === "USD" ? "$" : "";
  const [w, f] = toDecimal(m < 0n ? -m : m).split(".");
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${m < 0n ? "-" : ""}${sym}${grouped}.${f}`;
}

export const add = (a: Minor, b: Minor): Minor => a + b;
export const sub = (a: Minor, b: Minor): Minor => a - b;
export const sum = (xs: Minor[]): Minor => xs.reduce((a, b) => a + b, 0n);

/** Half-up multiplication by basis points, so 1500 bps = 15%. */
export function mulBps(m: Minor, bps: number): Minor {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const scaled = abs * BigInt(Math.round(bps)) + 5000n;
  const out = scaled / 10000n;
  return neg ? -out : out;
}

/** Is `actual` within `toleranceBps` of `expected`? The template gate. */
export function withinTolerance(actual: Minor, expected: Minor, toleranceBps: number): boolean {
  if (expected === 0n) return actual === 0n;
  const band = mulBps(expected < 0n ? -expected : expected, toleranceBps);
  const diff = actual > expected ? actual - expected : expected - actual;
  return diff <= band;
}

/**
 * Annualised return on taking an early-payment discount:
 *   r = d/(1-d) x 365/(N-D)
 * Returned in basis points. 2/10 net 30 comes to about 3,700 bps -- 37%.
 */
export function discountAnnualisedBps(discountBps: number, netDays: number, discountDays: number): number {
  if (discountBps <= 0 || netDays <= discountDays) return 0;
  const d = discountBps / 10000;
  return Math.round((d / (1 - d)) * (365 / (netDays - discountDays)) * 10000);
}

/** Split an amount across n buckets without losing or inventing a cent. */
export function allocate(total: Minor, weights: number[]): Minor[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) throw new Error("weights must be positive");
  const out = weights.map((w) => (total * BigInt(Math.round(w * 1e6))) / BigInt(Math.round(totalWeight * 1e6)));
  let remainder = total - out.reduce((a, b) => a + b, 0n);
  for (let i = 0; remainder !== 0n; i = (i + 1) % out.length) {
    const step = remainder > 0n ? 1n : -1n;
    out[i] += step;
    remainder -= step;
  }
  return out;
}
