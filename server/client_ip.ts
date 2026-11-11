// The client's address, for sign-in brakes and public-page rate limits.
//
// Behind Render (and Cloudflare in front of it) the socket address is a
// proxy's, shared by everyone, and each proxy appends the address it saw to
// x-forwarded-for. Only the entries the trusted proxies added can be believed;
// anything to their left was written by the client. So:
//
//   ERP_TRUSTED_PROXY_HOPS  how many proxies append to x-forwarded-for
//                           (default 2 on Render -- Cloudflare's edge, then
//                           Render's proxy -- and 0 elsewhere: the socket).
//                           The client is the entry that many from the right.
//                           A shorter list than that was written entirely by
//                           trusted proxies, so its first entry is the client.
//   ERP_CLIENT_IP_HEADER    "cf-connecting-ip": use Cloudflare's header when it
//                           is there (only safe when every request reaches the
//                           service through Cloudflare).

import type http from "node:http";

export function proxyHops(): number {
  const raw = process.env.ERP_TRUSTED_PROXY_HOPS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 5) return n;
  }
  return process.env.RENDER ? 2 : 0;
}

const cfHeader = () => (process.env.ERP_CLIENT_IP_HEADER ?? "").trim().toLowerCase() === "cf-connecting-ip";

export function clientIp(req: http.IncomingMessage, hops = proxyHops()): string {
  const sock = req.socket?.remoteAddress ?? "?";
  if (cfHeader()) {
    const cf = String(req.headers["cf-connecting-ip"] ?? "").trim();
    if (cf && cf.length <= 45 && /^[0-9a-fA-F:.]+$/.test(cf)) return cf;
  }
  if (hops === 0) return sock;
  const xf = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!xf.length) return sock;
  return xf.length >= hops ? xf[xf.length - hops] : xf[0];
}

/** One line for the start-up log: which method is in use. */
export function describeClientIp(): string {
  const hops = proxyHops();
  const how = hops === 0 ? "the socket address" : `the x-forwarded-for entry ${hops} from the right`;
  return `client address: ${cfHeader() ? `cf-connecting-ip when present, else ${how}` : how}` +
    ` (ERP_TRUSTED_PROXY_HOPS=${process.env.ERP_TRUSTED_PROXY_HOPS ?? `unset, default ${hops}`})`;
}

/** What a request's forwarding looks like, with no addresses in it: for a one-time check on live. */
export function forwardingShape(req: http.IncomingMessage): string {
  const xf = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return `x-forwarded-for has ${xf.length} hop(s); cf-connecting-ip ${req.headers["cf-connecting-ip"] ? "present" : "absent"}; using ${proxyHops()} trusted hop(s)`;
}
