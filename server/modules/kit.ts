// What a module gets from the server. Every retail module (catalog, POS,
// warehouse, A/R, fleet, web store, ...) registers its routes through this
// and nothing else, so the security rules in index.ts -- token or signed-in
// session, the page header on browser writes, the acting person being one of
// the company's own, one transaction per change -- apply to all of them
// without each module re-implementing them.

import type http from "node:http";
import type { Client } from "../../packages/core/db.ts";
import type { Company } from "../views.ts";
import type { Actor } from "../actions.ts";
import { rolesOf } from "../actions.ts";

export type { Client, Company, Actor };

export type CoGet = (
  tail: string,
  fn: (c: Client, co: Company, url: URL, m: RegExpMatchArray, personId: string | null) => Promise<unknown>,
) => void;

export type CoPost = (
  tail: string,
  fn: (c: Client, co: Company, a: Actor, body: Record<string, unknown>, m: RegExpMatchArray) => Promise<unknown>,
) => void;

/** A public route (the web store). No token, no session; it must never return back-office data. */
export type PublicRoute = (
  method: "GET" | "POST",
  path: RegExp,
  fn: (req: http.IncomingMessage, url: URL, m: RegExpMatchArray, body: Record<string, unknown>) => Promise<[number, unknown]>,
) => void;

/**
 * What a public handler returns instead of JSON when the store needs a page or
 * a script. index.ts turns these into its own Html / Asset responses, so the
 * same security headers and Content-Security-Policy apply (script-src 'self',
 * a per-response style nonce that replaces __NONCE__ in the page).
 */
export class PublicPage {
  text: string;
  constructor(text: string) { this.text = text; }
}
/** A script or stylesheet for a public page. Only JavaScript and CSS are allowed. */
export class PublicAsset {
  text: string;
  type: "text/javascript; charset=utf-8" | "text/css; charset=utf-8";
  constructor(text: string, type: PublicAsset["type"]) { this.text = text; this.type = type; }
}

export type ModuleKit = {
  coGet: CoGet;
  coPost: CoPost;
  publicRoute: PublicRoute;
};

export type ErpModule = {
  /** short id, also the UI screen group: 'catalog', 'pos', ... */
  id: string;
  register: (kit: ModuleKit) => void;
};

/** A refusal written for a person. The server returns it as a 409 with the message as-is. */
export class ModuleError extends Error {}

export function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ModuleError(message);
}

/** The acting person must hold one of these roles (owner always passes). */
export async function requireRole(c: Client, co: Company, a: Actor, roles: string[], doing: string) {
  const held = await rolesOf(c, co, a.personId);
  need(held.has("owner") || roles.some((r) => held.has(r)),
    `${doing} needs one of: ${roles.map((r) => r.replace(/_/g, " ")).join(", ")}`);
  return held;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const uuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);
export const int = (v: unknown, dflt = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
};

/** Money in from a request: "12.50", 12.5 or {minor: 1250}. Always bigint minor units out. */
export function minor(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (v && typeof v === "object" && "minor" in (v as object)) return BigInt(String((v as { minor: unknown }).minor));
  const s = String(v ?? "0").replace(/[$,\s]/g, "");
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new ModuleError(`not a money amount: ${v}`);
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

/** Half-up basis points: bps(10000n, 825) = 825n (8.25% of $100). */
export function bps(m: bigint, rate: number): bigint {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const r = (a * BigInt(rate) + 5000n) / 10000n;
  return neg ? -r : r;
}
