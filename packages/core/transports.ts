// The network clients behind the connection pipeline's pull channels.
//
// SFTP is the `ssh2` package (pure JavaScript; its native speed-ups are
// optional and not needed). Every session:
//
//   - is aimed at an address checked first: no private, loopback or link-local
//     address unless the host is on ERP_SFTP_ALLOW_HOSTS; the name is resolved
//     once and the checked address is the one dialled, so DNS cannot swap it
//   - talks to port 22, or the connection's own port when it is 1024 or above
//     (vendors use 2222, 10022 ...); a low port that is not SSH is refused
//   - checks the server's key against the one recorded on the first Test
//     (sha256, as OpenSSH prints it); a different key ends the session before
//     a password or key is sent, with a plain sentence
//   - has a deadline to connect and one per operation, and a size cap per file
//
// HTTP is the vendor feeds' own caller (vendor_feeds.call): https only, every
// hop's address checked, redirects followed by hand, a timeout, 10 MB a call.

import { createHash } from "node:crypto";
import net from "node:net";
import { isPrivateIp } from "./catalog.ts";
import { call, secretKeyFromEnv, type FeedEnv } from "./vendor_feeds.ts";
import { globTest } from "./filekit.ts";

export class TransportError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new TransportError(msg); };

/** Raised when the server's key is not the recorded one (or none is recorded yet). The run stops; nothing was sent to it. */
export class HostKeyError extends TransportError {
  kind: "unpinned" | "changed";
  seen: { type: string; fingerprint: string } | null;
  constructor(kind: "unpinned" | "changed", message: string, seen: { type: string; fingerprint: string } | null) {
    super(message);
    this.kind = kind;
    this.seen = seen;
  }
}

export type NetEnv = {
  resolve: (host: string) => Promise<string[]>;
  /** ERP_SFTP_ALLOW_HOSTS: servers that may sit on a private network (a VPN'd vendor, a test server) */
  sftpAllowHosts: string[];
  connectTimeoutMs: number;
  opTimeoutMs: number;
  secretKey: Buffer | null;
  /** the HTTP side: the vendor feeds' environment (fetch, DNS, allow-lists) */
  feeds: FeedEnv;
};

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export async function liveNetEnv(): Promise<NetEnv> {
  const { liveEnv } = await import("./vendor_feeds.ts");
  return {
    resolve: async (host) => {
      const { lookup } = await import("node:dns/promises");
      return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    },
    sftpAllowHosts: list(process.env.ERP_SFTP_ALLOW_HOSTS),
    connectTimeoutMs: Number(process.env.ERP_SFTP_CONNECT_TIMEOUT_MS ?? 20000) || 20000,
    opTimeoutMs: Number(process.env.ERP_SFTP_OP_TIMEOUT_MS ?? 60000) || 60000,
    secretKey: secretKeyFromEnv(),
    feeds: liveEnv(),
  };
}

// ------------------------------------------------------------------ SFTP --

export const DEFAULT_MAX_MB = 20;
export const MAX_MB = 50;

export type SftpTarget = {
  host: string;
  port?: number;
  user: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** the key recorded on the first Test; null means none yet */
  pinned: { fingerprint: string; type: string } | null;
};
export type RemoteFile = { name: string; size: number; modifiedAt: string };

export type SftpSession = {
  hostKey: { type: string; fingerprint: string };
  list(dir: string, globs?: string[]): Promise<RemoteFile[]>;
  get(dir: string, name: string, maxBytes: number): Promise<Buffer>;
  /** Write as name.part, then rename to name, so the vendor never picks up half a file. */
  put(dir: string, name: string, bytes: Buffer): Promise<string>;
  /** Move to another folder on the server; a name already there gets a time stamp. */
  move(dir: string, name: string, toDir: string): Promise<string>;
  remove(dir: string, name: string): Promise<void>;
  close(): void;
};

/** OpenSSH's form: SHA256: and the unpadded base64 of the key's sha256. */
export const fingerprintOf = (key: Buffer) => "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");

/** Glob with * and ? only, case-insensitive. */
export function globAny(name: string, globs?: string[]): boolean {
  const gs = (globs ?? []).map((g) => g.trim()).filter(Boolean);
  if (!gs.length) return true;
  return gs.some((g) => globTest(name, g));
}

export function sftpPort(port: unknown): number {
  if (port == null || port === "") return 22;
  const n = Number(port);
  need(Number.isInteger(n) && n > 0 && n < 65536, "the SFTP port is a number, usually 22");
  need(n === 22 || n >= 1024, `port ${n} is not an SFTP port; use 22 or the vendor's own port (1024 or above)`);
  return n;
}

/** The address to dial: checked, and fixed before connecting. */
export async function sftpAddress(env: NetEnv, host: string, port: number): Promise<string> {
  const h = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  need(h && /^[a-z0-9.:_-]+$/.test(h), "the SFTP host is a name like sftp.vendor.com or an address");
  const allowed = env.sftpAllowHosts.includes(h);
  const named = h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || isPrivateIp(h);
  need(!named || allowed, `${h} is on a private network; servers there are not called unless the host is on ERP_SFTP_ALLOW_HOSTS`);
  sftpPort(port);
  if (net.isIP(h)) return h;
  let addrs: string[];
  try { addrs = await env.resolve(h); } catch { throw new TransportError(`${h} could not be found; check the host name`); }
  need(addrs.length, `${h} could not be found; check the host name`);
  need(allowed || addrs.every((a) => !isPrivateIp(a)), `${h} points at a private network; servers there are not called unless the host is on ERP_SFTP_ALLOW_HOSTS`);
  return addrs[0];
}

const join = (dir: string, name: string) => `${(dir || ".").replace(/\/+$/, "") || "/"}/${name}`.replace(/^\/\//, "/");
const safeName = (n: string) => {
  need(n && !n.includes("/") && !n.includes("\\") && n !== "." && n !== "..", "a file name may not hold a folder");
  return n;
};

/** ssh2's own words, said for a person. */
function plain(e: unknown, what: string): TransportError {
  if (e instanceof TransportError) return e;
  const m = String((e as Error)?.message ?? e);
  const code = String((e as { code?: string | number })?.code ?? "");
  const level = (e as { level?: string })?.level ?? "";
  if (level === "client-authentication" || /authentication methods failed/i.test(m)) return new TransportError(`${what} refused the user name or password/key`);
  if (/Timed out while waiting for handshake/i.test(m)) return new TransportError(`${what} did not answer in time`);
  if (code === "ECONNREFUSED") return new TransportError(`${what} refused the connection; check the host and port`);
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return new TransportError(`${what} could not be reached`);
  if (code === "2" || /No such file/i.test(m)) return new TransportError(`${what}: no such file or folder`);
  if (code === "3" || /Permission denied/i.test(m)) return new TransportError(`${what}: permission denied`);
  return new TransportError(`${what}: ${m.slice(0, 160)}`);
}

/**
 * Open one SFTP session. With a pinned key, any other key is refused before
 * authentication. With none, `learn` takes whatever the server shows (the Test
 * path, which then records it); a run without a pin is refused.
 */
export async function openSftp(env: NetEnv, t: SftpTarget, mode: "require" | "learn"): Promise<SftpSession> {
  const port = sftpPort(t.port);
  const host = String(t.host ?? "").trim();
  const where = `the SFTP server ${host}${port === 22 ? "" : `:${port}`}`;
  if (mode === "require" && !t.pinned) {
    throw new HostKeyError("unpinned", `No server key is recorded for ${host}${port === 22 ? "" : `:${port}`} yet, so nothing was downloaded. Press Test to see the server's key and record it.`, null);
  }
  need(String(t.user ?? "").trim(), "SFTP needs the user name");
  need(t.password || t.privateKey, "SFTP needs a password or a private key; type one in");
  const addr = await sftpAddress(env, host, port);
  const ssh2 = (await import("ssh2")).default;
  const client = new ssh2.Client();
  let seen: { type: string; fingerprint: string } | null = null;
  let mismatch = false;
  const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) => {
    let done = false;
    const fail = (e: unknown) => { if (done) return; done = true; try { client.end(); } catch { /* closed */ } reject(e); };
    const hard = setTimeout(() => fail(new TransportError(`${where} did not answer in time`)), env.connectTimeoutMs + 2000);
    client.on("ready", () => {
      client.sftp((err, s) => {
        clearTimeout(hard);
        if (err) return fail(plain(err, where));
        done = true; resolve(s);
      });
    });
    client.on("error", (e) => {
      clearTimeout(hard);
      if (mismatch && seen) {
        return fail(new HostKeyError("changed", `${cap(where)} showed a different key (${seen.fingerprint}) from the one recorded (${t.pinned!.fingerprint}). Nothing was sent to it or downloaded. If the vendor says they changed their server key, the owner can trust the new key after a Test.`, seen));
      }
      fail(plain(e, where));
    });
    client.on("close", () => { clearTimeout(hard); fail(new TransportError(`${where} closed the connection`)); });
    try {
      client.connect({
        host: addr, port, username: t.user.trim(),
        password: t.password || undefined, privateKey: t.privateKey || undefined, passphrase: t.passphrase || undefined,
        readyTimeout: env.connectTimeoutMs, keepaliveInterval: 0, tryKeyboard: false,
        hostVerifier: (key: Buffer) => {
          let type = "unknown";
          try { const k = ssh2.utils.parseKey(key); if (!(k instanceof Error)) type = (Array.isArray(k) ? k[0] : k).type; } catch { /* keep unknown */ }
          seen = { type, fingerprint: fingerprintOf(key) };
          if (t.pinned && t.pinned.fingerprint !== seen.fingerprint) { mismatch = true; return false; }
          return true;
        },
      });
    } catch (e) { clearTimeout(hard); fail(plain(e, where)); }
  });
  const timed = <R>(p: Promise<R>, what: string): Promise<R> => new Promise<R>((resolve, reject) => {
    const tm = setTimeout(() => { reject(new TransportError(`${what} took longer than ${Math.round(env.opTimeoutMs / 1000)} s; the session was closed`)); try { client.end(); } catch { /* closed */ } }, env.opTimeoutMs);
    p.then((v) => { clearTimeout(tm); resolve(v); }, (e) => { clearTimeout(tm); reject(e); });
  });
  const cb = <R>(fn: (k: (err: Error | null | undefined, v?: R) => void) => void, what: string) =>
    timed(new Promise<R>((resolve, reject) => fn((err, v) => (err ? reject(plain(err, what)) : resolve(v as R)))), what);
  const exists = async (path: string) => {
    try { await cb((k) => sftp.stat(path, k), path); return true; } catch { return false; }
  };
  return {
    hostKey: seen!,
    async list(dir, globs) {
      const entries = await cb<import("ssh2").FileEntry[]>((k) => sftp.readdir(dir || ".", k), `listing ${dir || "the home folder"} on ${where}`);
      return entries
        .filter((e) => !e.filename.startsWith(".") && (e.attrs.mode == null || (e.attrs.mode & 0o170000) === 0o100000))
        .filter((e) => globAny(e.filename, globs))
        .map((e) => ({ name: e.filename, size: Number(e.attrs.size ?? 0), modifiedAt: e.attrs.mtime ? new Date(e.attrs.mtime * 1000).toISOString() : "" }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 500);
    },
    async get(dir, name, maxBytes) {
      const path = join(dir, safeName(name));
      return timed(new Promise<Buffer>((resolve, reject) => {
        const parts: Buffer[] = [];
        let n = 0;
        const rs = sftp.createReadStream(path);
        rs.on("data", (d: Buffer) => {
          n += d.length;
          if (n > maxBytes) { rs.destroy(); reject(new TransportError(`${name} is over ${Math.round(maxBytes / 1048576)} MB; it was left on the server`)); return; }
          parts.push(d);
        });
        rs.on("error", (e: Error) => reject(plain(e, `reading ${name} on ${where}`)));
        rs.on("end", () => resolve(Buffer.concat(parts)));
      }), `reading ${name}`);
    },
    async put(dir, name, bytes) {
      const final = join(dir, safeName(name));
      const part = `${final}.part`;
      await cb<void>((k) => sftp.writeFile(part, bytes, k), `writing ${name} to ${where}`);
      if (await exists(final)) throw new TransportError(`${name} is already in ${dir} on ${where}; nothing was overwritten`);
      await cb<void>((k) => sftp.rename(part, final, k), `naming ${name} on ${where}`);
      return final;
    },
    async move(dir, name, toDir) {
      const from = join(dir, safeName(name));
      let to = join(toDir, name);
      if (await exists(to)) to = join(toDir, `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${name}`);
      await cb<void>((k) => sftp.rename(from, to, k), `moving ${name} to ${toDir} on ${where}`);
      return to;
    },
    async remove(dir, name) {
      await cb<void>((k) => sftp.unlink(join(dir, safeName(name)), k), `deleting ${name} on ${where}`);
    },
    close() { try { client.end(); } catch { /* closed */ } },
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ HTTP --

export type HttpAuth = { mode: "none" | "basic" | "bearer" | "header"; user?: string; headerName?: string };

/** One GET, through the vendor feeds' checked caller. The answer is text (CSV, JSON, X12). */
export async function httpGet(env: NetEnv, endpoint: string, query: Record<string, string> | undefined, auth: HttpAuth,
  creds: Record<string, string>, timeoutMs = 30000): Promise<{ status: number; body: Buffer; contentType?: string; url: string }> {
  let u: URL;
  try { u = new URL(String(endpoint ?? "").trim()); } catch { throw new TransportError("the address is not a web address; it starts with https://"); }
  for (const [k, v] of Object.entries(query ?? {})) if (k.trim()) u.searchParams.set(k.trim(), String(v));
  const headers: Record<string, string> = { accept: "text/csv, application/json, application/edi-x12, text/plain, */*" };
  if (auth.mode === "basic") {
    need(auth.user && creds.password, "basic authentication needs the user and the password");
    headers.authorization = `Basic ${Buffer.from(`${auth.user}:${creds.password}`).toString("base64")}`;
  } else if (auth.mode === "bearer") {
    need(creds.token, "bearer authentication needs its token; type it in");
    headers.authorization = `Bearer ${creds.token}`;
  } else if (auth.mode === "header") {
    need(creds.apiKey, "the key header needs its key; type it in");
    const h = String(auth.headerName || "x-api-key").trim();
    need(/^[A-Za-z0-9-]{1,60}$/.test(h) && !/^(host|cookie|content-length)$/i.test(h), "the key header's name is letters, digits and dashes");
    headers[h] = creds.apiKey;
  }
  const what = `the vendor's address ${u.host}`;
  const r = await call(env.feeds, u.toString(), { method: "GET", headers }, timeoutMs, what, 2).catch((e: Error) => { throw new TransportError(e.message); });
  need(r.status !== 401 && r.status !== 403, `${what} refused the credentials (${r.status})`);
  return { status: r.status, body: Buffer.from(r.text, "utf8"), contentType: r.headers.get("content-type") ?? undefined, url: u.origin + u.pathname };
}
