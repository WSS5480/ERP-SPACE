// Vendor files checks, over real sockets: an in-process SFTP server (ssh2's
// Server, files kept in memory, a test host key) and a local HTTPS server
// (a test certificate, trusted only by this check's own fetch).
//
//   SFTP connections: secrets write-only, a run refused before the first Test,
//   Test records the server key and counts files, list + download + routing by
//   pattern (catalog, prices, inventory), a bad file quarantined with the
//   reason, de-duplication, a file over the size cap left on the server,
//   move-after once the run commits, private-key sign-in, a changed server
//   key refused in words and trusted only by the owner (with an audit row),
//   a private address refused without the allow-list
//   EDI over SFTP: Test SFTP, an outbound 850 put into their inbox, polling
//   their outbox with archive
//   HTTPS ("api") connections: bearer token, wrong token, http refused
//   Vendor feeds by SFTP (mapping, key pinning, no file twice) and email-in
//   (vendor's own address, unknown sender held, assigned to the feed)
//   Vendor email connections: company address, sender routing, a zip, SPF
//   failure held, another client's address stays theirs
//   The catalog import template (CSV and XLSX headings = IMPORT_FIELDS,
//   automap, the example row skipped) and tenant isolation on every new route.
import { randomBytes, createHash } from "node:crypto";
import https from "node:https";
import { deflateRawSync, crc32 } from "node:zlib";
import ssh2 from "ssh2";
import { type T, ENTITY, RIO_ENTITY, PEOPLE } from "./harness.ts";
import { q, tx, type Client } from "../../packages/core/db.ts";
import * as C from "../../packages/core/connections.ts";
import * as vf from "../../packages/core/vendor_files.ts";
import * as feeds from "../../packages/core/vendor_feeds.ts";
import * as edi from "../../packages/core/edi.ts";
import * as cat from "../../packages/core/catalog.ts";
import { xlsxRows } from "../../packages/core/filekit.ts";
import type { NetEnv } from "../../packages/core/transports.ts";
import { module as vfModule } from "../../server/modules/vendor_files.ts";
import { module as catModule, templateCsv, templateXlsx } from "../../server/modules/catalog.ts";
import { Download } from "../../server/modules/kit.ts";
import { V, BUYER, companyOf } from "./catalog.ts";
import { scopeOf } from "../../server/actions.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";

const { Server, utils } = ssh2 as unknown as { Server: new (cfg: unknown, fn: (c: never) => void) => import("node:net").Server; utils: Record<string, any> };
const OWNER = PEOPLE.STEVE;
const RIO_OWNER = "eeee0000-0000-0000-0000-000000000201";
const KEY = randomBytes(32);

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgRWFxjXyrR6V/m3Kf
/4OA3IzKi/TdwL7JhxqIzGEKXauhRANCAASF6GJYTNJXmWkCKJhaen3YQgLr/uwM
MgpwLEpODocy5Cmj5wBy1cybh1VSh9KsIkCCvuqQVi1P8Yg++lbSlDrK
-----END PRIVATE KEY-----`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBszCCAVqgAwIBAgIUNrbWBYW1oeCIds/u6vJ7R9Af3ZwwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLdmVuZG9yLnRlc3QwIBcNMjYxMTExMTYxNzMyWhgPMjEyNjEw
MTgxNjE3MzJaMBYxFDASBgNVBAMMC3ZlbmRvci50ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEhehiWEzSV5lpAiiYWnp92EIC6/7sDDIKcCxKTg6HMuQpo+cA
ctXMm4dVUofSrCJAgr7qkFYtT/GIPvpW0pQ6yqOBgzCBgDAdBgNVHQ4EFgQUDEdU
T3B9+VKhKGtoGVaGnZtkVGMwHwYDVR0jBBgwFoAUDEdUT3B9+VKhKGtoGVaGnZtk
VGMwDwYDVR0TAQH/BAUwAwEB/zAtBgNVHREEJjAkhwR/AAABgglsb2NhbGhvc3SC
EWZpbGVzLnZlbmRvci50ZXN0MAoGCCqGSM49BAMCA0cAMEQCIDuVmYV6u6oihvYA
rTH/ZYyiirXKSsMaBJ+uj3EnXdyuAiBuzxpEsNTqs74E9wfjXCmlzGPwhdl6kxRs
jU2w7jI3Qw==
-----END CERTIFICATE-----`;

// ------------------------------------------------------ an SFTP server in memory
type FileRec = { data: Buffer; mtime: number };
function memSftp(users: { pw: Record<string, string>; keys: Record<string, any> }) {
  const files = new Map<string, FileRec>();
  const dirs = new Set<string>(["/"]);
  const norm = (p: string) => ("/" + String(p || "/").split("/").filter((x) => x && x !== ".").join("/")).replace(/\/+$/, "") || "/";
  const dirOf = (p: string) => norm(p).split("/").slice(0, -1).join("/") || "/";
  const mkdirs = (d: string) => { let cur = ""; for (const part of norm(d).split("/").filter(Boolean)) { cur += "/" + part; dirs.add(cur); } };
  const put = (path: string, data: Buffer | string, mtime = Math.floor(Date.now() / 1000)) => { mkdirs(dirOf(path)); files.set(norm(path), { data: Buffer.from(data), mtime }); };
  const { STATUS_CODE, OPEN_MODE } = utils.sftp;
  const fileAttrs = (f: FileRec) => ({ mode: 0o100644, size: f.data.length, uid: 0, gid: 0, atime: f.mtime, mtime: f.mtime });
  const dirAttrs = { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 };
  let server: import("node:net").Server | null = null;
  let port = 0;
  const start = (hostKey: string) => new Promise<number>((ok) => {
    server = new Server({ hostKeys: [hostKey] }, (client: any) => {
      client.on("error", () => {});
      client.on("authentication", (ctx: any) => {
        if (ctx.method === "password" && users.pw[ctx.username] && users.pw[ctx.username] === ctx.password) return ctx.accept();
        const k = users.keys[ctx.username];
        if (ctx.method === "publickey" && k && ctx.key.algo === k.type && Buffer.compare(ctx.key.data, k.getPublicSSH()) === 0) {
          if (!ctx.signature) return ctx.accept();
          return k.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
        }
        ctx.reject(["password", "publickey"]);
      });
      client.on("ready", () => client.on("session", (accept: any) => accept().on("sftp", (acc: any) => {
        const s = acc();
        const handles = new Map<string, { path: string; dir?: boolean; listed?: boolean; write?: boolean }>();
        let n = 0;
        const handle = (h: { path: string; dir?: boolean; write?: boolean }) => { const b = Buffer.alloc(4); b.writeUInt32BE(++n); handles.set(b.toString("hex"), h); return b; };
        const get = (b: Buffer) => handles.get(b.toString("hex"));
        s.on("REALPATH", (id: number, p: string) => s.name(id, [{ filename: norm(p), longname: norm(p), attrs: {} }]));
        const stat = (id: number, p: string) => { const f = files.get(norm(p)); if (f) return s.attrs(id, fileAttrs(f)); if (dirs.has(norm(p))) return s.attrs(id, dirAttrs); s.status(id, STATUS_CODE.NO_SUCH_FILE); };
        s.on("STAT", stat); s.on("LSTAT", stat);
        s.on("FSTAT", (id: number, h: Buffer) => { const x = get(h); const f = x && files.get(x.path); f ? s.attrs(id, fileAttrs(f)) : s.status(id, STATUS_CODE.FAILURE); });
        s.on("OPENDIR", (id: number, p: string) => dirs.has(norm(p)) ? s.handle(id, handle({ path: norm(p), dir: true })) : s.status(id, STATUS_CODE.NO_SUCH_FILE));
        s.on("READDIR", (id: number, h: Buffer) => {
          const x = get(h);
          if (!x || x.listed) return s.status(id, STATUS_CODE.EOF);
          x.listed = true;
          const kids = [...files.entries()].filter(([p]) => dirOf(p) === x.path).map(([p, f]) => ({ filename: p.split("/").pop(), longname: p.split("/").pop(), attrs: fileAttrs(f) }));
          const subdirs = [...dirs].filter((d) => d !== "/" && dirOf(d) === x.path).map((d) => ({ filename: d.split("/").pop(), longname: d.split("/").pop(), attrs: dirAttrs }));
          const all = [...kids, ...subdirs];
          all.length ? s.name(id, all) : s.status(id, STATUS_CODE.EOF);
        });
        s.on("OPEN", (id: number, p: string, flags: number) => {
          const path = norm(p);
          if (flags & OPEN_MODE.WRITE) {
            if (!dirs.has(dirOf(path))) return s.status(id, STATUS_CODE.NO_SUCH_FILE);
            if (!files.has(path) || flags & OPEN_MODE.TRUNC) files.set(path, { data: Buffer.alloc(0), mtime: Math.floor(Date.now() / 1000) });
            return s.handle(id, handle({ path, write: true }));
          }
          files.has(path) ? s.handle(id, handle({ path })) : s.status(id, STATUS_CODE.NO_SUCH_FILE);
        });
        s.on("READ", (id: number, h: Buffer, offset: number, len: number) => {
          const f = files.get(get(h)?.path ?? "");
          if (!f) return s.status(id, STATUS_CODE.FAILURE);
          if (offset >= f.data.length) return s.status(id, STATUS_CODE.EOF);
          s.data(id, f.data.subarray(offset, Math.min(f.data.length, offset + len)));
        });
        s.on("WRITE", (id: number, h: Buffer, offset: number, data: Buffer) => {
          const x = get(h); const f = x && files.get(x.path);
          if (!f) return s.status(id, STATUS_CODE.FAILURE);
          const nb = Buffer.alloc(Math.max(f.data.length, offset + data.length)); f.data.copy(nb); data.copy(nb, offset); f.data = nb;
          s.status(id, STATUS_CODE.OK);
        });
        s.on("CLOSE", (id: number, h: Buffer) => { handles.delete(h.toString("hex")); s.status(id, STATUS_CODE.OK); });
        s.on("RENAME", (id: number, from: string, to: string) => {
          const a = norm(from), b = norm(to);
          if (!files.has(a)) return s.status(id, STATUS_CODE.NO_SUCH_FILE);
          if (files.has(b) || !dirs.has(dirOf(b))) return s.status(id, STATUS_CODE.FAILURE);
          files.set(b, files.get(a)!); files.delete(a); s.status(id, STATUS_CODE.OK);
        });
        s.on("REMOVE", (id: number, p: string) => files.delete(norm(p)) ? s.status(id, STATUS_CODE.OK) : s.status(id, STATUS_CODE.NO_SUCH_FILE));
        s.on("MKDIR", (id: number, p: string) => { mkdirs(p); s.status(id, STATUS_CODE.OK); });
      })));
    });
    server.listen(port, "127.0.0.1", () => { port = (server!.address() as { port: number }).port; ok(port); });
  });
  const stop = () => new Promise<void>((ok) => { if (!server) return ok(); server.close(() => ok()); server = null; });
  return { files, dirs, put, mkdirs, start, stop, port: () => port };
}

// ------------------------------------------------------ a fetch that trusts the test CA
const caFetch: feeds.FetchLike = (url, init = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = https.request({ host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: init.method ?? "GET", headers: init.headers, ca: TLS_CERT, servername: "localhost" }, (res) => {
    const parts: Buffer[] = [];
    res.on("data", (d) => parts.push(d));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: { get: (k: string) => { const v = res.headers[k.toLowerCase()]; return v == null ? null : String(v); } }, text: async () => Buffer.concat(parts).toString("utf8") }));
  });
  req.on("error", reject);
  if (init.signal) init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
  if (init.body) req.write(init.body);
  req.end();
});

/** The module's routes, called as a person the way the server calls them (GETs too). */
function router(mod: { register: (k: never) => void }) {
  type Fn = (...a: unknown[]) => Promise<unknown>;
  const gets = new Map<string, Fn>(), posts = new Map<string, Fn>();
  mod.register({ coGet: (tail: string, fn: Fn) => gets.set(tail, fn), coPost: (tail: string, fn: Fn) => posts.set(tail, fn), publicRoute: () => {} } as never);
  const ID = "([0-9a-fA-F-]{36})";
  const key = (tail: string) => tail.replace(":id", ID);
  const company = async (entityId: string): Promise<Company> => { const c0 = await companyOf({ pool: (await import("../../packages/core/db.ts")).pool } as never, entityId); return c0; };
  return {
    post: async <R = any>(tail: string, who: string, body: Record<string, unknown>, id?: string, entityId = ENTITY): Promise<R> => {
      const co = await company(entityId);
      const a: Actor = { personId: who, personName: who === OWNER ? "Steve" : "check", label: "check" };
      return tx({ kind: "user", id: who, label: "check" }, (c) => posts.get(key(tail))!(c, co, a, body, ["", co.id, id]) as Promise<R>);
    },
    get: async <R = any>(tail: string, who: string, query = "", id?: string, entityId = ENTITY): Promise<R> => {
      const co = await company(entityId);
      const { pool } = await import("../../packages/core/db.ts");
      const c = await pool.connect();
      try { return await gets.get(key(tail))!(c, co, new URL("http://x/" + query), ["", co.id, id], who) as R; } finally { c.release(); }
    },
  };
}

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => { const c = await t.pool.connect(); try { return await fn(c); } finally { c.release(); } };
const mail = (to: string, from: string, atts: { name: string; content: Buffer | string; type?: string }[], extra: Record<string, unknown> = {}) => ({
  From: from, To: to, Subject: "Files", MessageID: `m-${randomBytes(4).toString("hex")}`,
  Attachments: atts.map((a) => ({ Name: a.name, ContentType: a.type ?? "text/csv", Content: Buffer.from(a.content).toString("base64") })), ...extra,
}) as vf.InboundMail;

/** A minimal stored zip (method 0), for a vendor's zipped attachment. */
function zipOf(entries: [string, string][]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let off = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text), nb = Buffer.from(name), crc = crc32(data), comp = deflateRawSync(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

export async function run(t: T) {
  const saved = { key: process.env.ERP_SECRET_KEY, addr: process.env.ERP_INBOUND_EMAIL_ADDRESS };
  process.env.ERP_SECRET_KEY = KEY.toString("base64");
  process.env.ERP_INBOUND_EMAIL_ADDRESS = "vendors@in.example.com";
  const allow = { hosts: ["127.0.0.1"] };
  const netEnv = async (): Promise<NetEnv> => ({
    resolve: async () => ["127.0.0.1"], sftpAllowHosts: allow.hosts, connectTimeoutMs: 5000, opTimeoutMs: 10000, secretKey: KEY,
    feeds: { ...feeds.liveEnv(), fetch: caFetch, allowHosts: ["127.0.0.1"], sleep: async () => {} },
  });
  C.useNetEnv(netEnv);

  const R = router(vfModule);
  const CR = router(catModule);
  const hostKey1 = utils.generateKeyPairSync("ed25519");
  const hostKey2 = utils.generateKeyPairSync("ed25519");
  const clientKey = utils.generateKeyPairSync("ed25519");
  const srv = memSftp({ pw: { buddys: "Sftp-Pass-7788" }, keys: { keyuser: utils.parseKey(clientKey.public) } });
  const port = await srv.start(hostKey1.private);
  const fp1 = "SHA256:" + createHash("sha256").update(utils.parseKey(hostKey1.public).getPublicSSH()).digest("base64").replace(/=+$/, "");
  try {
    // ============================================================ SFTP connection
    const now = Math.floor(Date.now() / 1000) - 60;
    srv.put("/vendor/coaster_catalog_1.csv", "vendor_sku,name,cost,price\nVF-100,Vendor Files Sofa,300.00,799.00\nVF-101,Vendor Files Chair,120.00,299.00\n", now);
    srv.put("/vendor/coaster_inv_1.csv", "sku,qty,lead_days\nVF-100,7,\nVF-101,0,21\n", now);
    srv.put("/vendor/coaster_price_1.csv", "Item Number,Dealer Cost,MAP\nVF-100,310.00,699.00\n", now);
    srv.put("/vendor/coaster_price_bad.csv", "colour,flavour\nred,lime\n", now);
    srv.put("/vendor/coaster_catalog_big.csv", "vendor_sku,name,cost\n" + "X,".repeat(800_000), now);
    srv.put("/vendor/readme.txt", "not for us", now);
    srv.mkdirs("/vendor/done");

    const base = { vendor_id: V.COASTER, channel: "sftp", host: "127.0.0.1", port, user: "buddys", path: "/vendor", schedule: "0 */4 * * *", maxMb: 1,
      carries: [{ kind: "catalog", glob: "*catalog*.csv" }, { kind: "prices", glob: "*price*.csv" }, { kind: "inventory", glob: "*inv*.csv" }] };
    await t.throws("sftp: with more than one kind, each needs its own pattern", () => R.post("/vendor-files/save", BUYER, { connection: { ...base, name: "x", carries: [{ kind: "catalog", glob: "" }, { kind: "prices", glob: "" }] } }), /its own file pattern/);
    await t.throws("sftp: a low port that is not SSH is refused", () => R.post("/vendor-files/save", BUYER, { connection: { ...base, name: "x", port: 25 } }), /not an SFTP port/);
    await t.throws("sftp: a pull needs a schedule", () => R.post("/vendor-files/save", BUYER, { connection: { ...base, name: "x", schedule: "" } }), /how often to look/);
    await t.throws("sftp: a store manager cannot set one up", () => R.post("/vendor-files/save", "55555555-0000-0000-0000-000000000018", { connection: { ...base, name: "x" } }), /needs one of/);
    const conn = await R.post<{ id: string }>("/vendor-files/save", BUYER, { connection: { ...base, name: "Coaster SFTP" }, secrets: { password: "Sftp-Pass-7788" } });
    const ov = await R.get("/vendor-files", BUYER);
    const card = ov.connections.find((x: { id: string }) => x.id === conn.id);
    t.ok("sftp: saved for the vendor; the secret is write-only (a read says which are set, never the value)",
      card && JSON.stringify(card.secrets) === '["password"]' && !JSON.stringify(ov).includes("Sftp-Pass-7788"), JSON.stringify(card?.secrets));
    const sealed = await read(t, (c) => q<{ ciphertext: Buffer }>(c, `select ciphertext from connection_secret where connection_id = $1 /* unscoped: check */`, [conn.id]));
    t.ok("sftp: the password is sealed (AES-GCM), not stored as typed", sealed.length === 1 && !sealed[0].ciphertext.toString("latin1").includes("Sftp-Pass"));

    const before = await R.post("/vendor-files/:id/run", BUYER, {}, conn.id);
    t.ok("sftp: a run before any Test is refused in words: no key recorded, nothing downloaded", !before.ok && /No server key is recorded/.test(before.words), before.words);
    const test1 = await R.post("/vendor-files/:id/test", BUYER, {}, conn.id);
    t.ok("sftp: Test connects, lists by the patterns, shows the server key and records it", test1.ok && test1.firstTime && test1.fingerprint === fp1 && test1.files === 5,
      `${test1.words} ${test1.fingerprint}`);
    const pin = await read(t, (c) => C.loadPin(c, { kind: "connection", id: conn.id, entityId: ENTITY }));
    t.ok("sftp: the key is pinned to this host and port, with who recorded it", pin?.fingerprint === fp1 && pin.port === port && pin.host === "127.0.0.1");

    const run1 = await R.post("/vendor-files/:id/run", BUYER, {}, conn.id);
    const files1 = await read(t, (c) => q<{ origin: string; status: string; quarantine_reason: string | null; note: string | null }>(c,
      `select f.origin, f.status, f.quarantine_reason, f.note from inbound_file f join connection cn on cn.id = f.connection_id where cn.entity_id = $1 and f.connection_id = $2 order by f.origin`, [ENTITY, conn.id]));
    const st = (n: string) => files1.find((f) => f.origin === n);
    t.ok("sftp: the run lists and downloads what matches (readme.txt is not listed)", run1.result?.seen === 5 && !st("readme.txt"), JSON.stringify(run1.result));
    const prod = await read(t, (c) => q<{ cost_minor: string; status: string }>(c, `select cost_minor, status from product where entity_id = $1 and vendor_id = $2 and vendor_sku = 'VF-100'`, [ENTITY, V.COASTER]));
    const avail = await read(t, (c) => q<{ qty_available: number; lead_days: number | null }>(c, `select qty_available, lead_days from vendor_availability where entity_id = $1 and vendor_id = $2 and vendor_sku = 'VF-101'`, [ENTITY, V.COASTER]));
    t.ok("sftp: the catalog file adds products, the price file reprices them, the inventory file records availability",
      st("coaster_catalog_1.csv")?.status === "applied" && st("coaster_price_1.csv")?.status === "applied" && st("coaster_inv_1.csv")?.status === "applied"
      && prod.length === 1 && prod[0].cost_minor === "31000" && Number(avail[0]?.qty_available) === 0 && avail[0]?.lead_days === 21,
      JSON.stringify({ prod, avail, notes: files1.map((f) => f.note) }));
    t.ok("sftp: a file it cannot read is quarantined with the reason (no column for the model or cost)",
      st("coaster_price_bad.csv")?.status === "quarantined" && /no column found for vendor sku, cost/.test(st("coaster_price_bad.csv")?.quarantine_reason ?? ""), st("coaster_price_bad.csv")?.quarantine_reason ?? "");
    t.ok("sftp: a file over the size cap is quarantined by name and left on the server, never downloaded",
      st("coaster_catalog_big.csv")?.status === "quarantined" && /over this connection's 1 MB limit; it was left on the server/.test(st("coaster_catalog_big.csv")?.quarantine_reason ?? "")
      && srv.files.has("/vendor/coaster_catalog_big.csv"));
    t.ok("sftp: after = leave keeps the files on the server", srv.files.has("/vendor/coaster_catalog_1.csv"));

    const run2 = await R.post("/vendor-files/:id/run", BUYER, {}, conn.id);
    t.ok("sftp: dedupe: a second run downloads nothing it has taken (same name, size, time); only the oversize file is listed again, not fetched", run2.ok && run2.result.seen === 1 && run2.result.fresh === 0, JSON.stringify(run2.result));
    srv.files.get("/vendor/coaster_inv_1.csv")!.mtime += 30;
    const run3 = await R.post("/vendor-files/:id/run", BUYER, {}, conn.id);
    t.ok("sftp: dedupe: the same bytes under a new time are downloaded once more, but not applied twice", run3.result.seen === 2 && run3.result.fresh === 0, JSON.stringify(run3.result));

    const detail = await R.get(`/vendor-files/:id`, BUYER, "?status=quarantined", conn.id);
    t.ok("sftp: the quarantine drills down from the connection (2 files) with runs listed", detail.files.length === 2 && detail.runs.length >= 4 && detail.files.every((f: { status: string }) => f.status === "quarantined"));
    const bad = detail.files.find((f: { origin: string }) => f.origin === "coaster_price_bad.csv");
    await R.post("/vendor-files/files/:id/dismiss", BUYER, { reason: "Coaster sent a test file" }, bad.id);
    const after = await R.get(`/vendor-files/:id`, BUYER, "?status=quarantined", conn.id);
    t.ok("sftp: a person sets a quarantined file aside with a reason; it stays on record", after.files.length === 1);

    // ---- move-after, private key
    srv.put("/vendor/keyed/coaster_inv_2.csv", "sku,qty\nVF-100,9\n", now);
    srv.mkdirs("/vendor/keyed/done");
    const keyed = await R.post<{ id: string }>("/vendor-files/save", BUYER, { connection: { vendor_id: V.COASTER, channel: "sftp", name: "Coaster SFTP (key)", host: "127.0.0.1", port,
      user: "keyuser", path: "/vendor/keyed", schedule: "0 * * * *", after: "move", moveTo: "/vendor/keyed/done", carries: [{ kind: "inventory", glob: "*.csv" }] },
      secrets: { privateKey: clientKey.private } });
    const kt = await R.post("/vendor-files/:id/test", BUYER, {}, keyed.id);
    t.ok("sftp: a private key signs in (no password)", kt.ok && kt.files === 1, kt.words);
    const kr = await R.post("/vendor-files/:id/run", BUYER, {}, keyed.id);
    await C.postRunSettled();
    const avail9 = await read(t, (c) => q<{ qty_available: number }>(c, `select qty_available from vendor_availability where entity_id = $1 and vendor_id = $2 and vendor_sku = 'VF-100'`, [ENTITY, V.COASTER]));
    t.ok("sftp: move-after moves the file once the run has committed", kr.ok && Number(avail9[0]?.qty_available) === 9 && srv.files.has("/vendor/keyed/done/coaster_inv_2.csv") && !srv.files.has("/vendor/keyed/coaster_inv_2.csv"),
      JSON.stringify([...srv.files.keys()].filter((k) => k.includes("keyed"))));

    // ---- the server key changes
    await srv.stop();
    await srv.start(hostKey2.private);
    const fp2 = "SHA256:" + createHash("sha256").update(utils.parseKey(hostKey2.public).getPublicSSH()).digest("base64").replace(/=+$/, "");
    srv.put("/vendor/coaster_inv_3.csv", "sku,qty\nVF-100,3\n");
    const changed = await R.post("/vendor-files/:id/run", BUYER, {}, conn.id);
    t.ok("host key: a changed key is refused in a plain sentence, before anything is sent or downloaded",
      !changed.ok && /showed a different key \(SHA256:.+\) from the one recorded \(SHA256:.+\)\. Nothing was sent to it or downloaded/.test(changed.words), changed.words);
    const ct = await R.post("/vendor-files/:id/test", BUYER, {}, conn.id);
    t.ok("host key: Test shows the new key and keeps the old one", !ct.ok && ct.changed && ct.fingerprint === fp2 && ct.recorded === fp1);
    await t.throws("host key: only the owner may trust a new key", () => R.post("/vendor-files/:id/trust-key", BUYER, { fingerprint: fp2 }, conn.id), /needs one of: owner/);
    await t.throws("host key: trusting needs the fingerprint the Test showed", () => R.post("/vendor-files/:id/trust-key", OWNER, { fingerprint: fp1 }, conn.id), /changed again since that Test/);
    await R.post("/vendor-files/:id/trust-key", OWNER, { fingerprint: fp2 }, conn.id);
    const auditRow = await read(t, (c) => q<{ reason: string; before: unknown; after: unknown }>(c,
      `select reason, before, after from audit_event where entity_id = $1 and table_name = 'sftp_host_pin' and row_id = $2 and reason is not null order by at desc limit 1`, [ENTITY, conn.id]).catch(() => []));
    t.ok("host key: the owner's trust is an audit row naming both keys", auditRow.length === 1 && /trusted a new server key/.test(auditRow[0].reason) && JSON.stringify(auditRow[0]).includes(fp1) && JSON.stringify(auditRow[0]).includes(fp2), JSON.stringify(auditRow));
    const again = await R.post("/vendor-files/:id/run", BUYER, {}, conn.id);
    t.ok("host key: after the owner trusts it, runs go through", again.ok && again.result.fresh === 1, again.words);

    allow.hosts = [];
    const priv = await R.post("/vendor-files/:id/test", BUYER, {}, conn.id);
    t.ok("network: a private address is refused unless the host is on ERP_SFTP_ALLOW_HOSTS", !priv.ok && /private network/.test(priv.words), priv.words);
    allow.hosts = ["127.0.0.1"];

    // ============================================================ EDI over SFTP
    const ashley = (await read(t, (c) => q<{ id: string }>(c, `select id from edi_partner where entity_id = $1 and vendor_id = $2`, [ENTITY, V.ASHLEY])))[0];
    srv.mkdirs("/edi/in"); srv.mkdirs("/edi/out/done");
    srv.put("/edi/out/hello.edi", "this is not X12");
    const ediEnv: edi.EdiEnv = { ...feeds.liveEnv(), secretKey: KEY, dropDir: null };
    const buyerScope = await (async () => { const co = await companyOf(t); return scopeOf(co, { personId: BUYER, personName: "Buyer", label: "Buyer" }); })();
    await tx(buyerScope.actor, async (c) => {
      await c.query(`update edi_partner set transport = 'sftp', transport_config = $3 where id = $1 and entity_id = $2`,
        [ashley.id, ENTITY, JSON.stringify({ host: "127.0.0.1", port: String(port), user: "buddys", inFolder: "/edi/out", outFolder: "/edi/in", archiveFolder: "/edi/out/done" })]);
      await edi.setPartnerSecrets(c, buyerScope, ediEnv, ashley.id, { sftpPassword: "Sftp-Pass-7788" });
    });
    const et = await tx(buyerScope.actor, (c) => edi.testPartnerSftp(c, buyerScope, ediEnv, ashley.id, "Buyer"));
    t.ok("edi sftp: Test SFTP lists their outbox and records the key", et.ok && et.firstTime && et.files === 1 && et.fingerprint === fp2, et.words);
    const sent = await tx(buyerScope.actor, (c) => edi.sendTest850(c, buyerScope, ediEnv, ashley.id));
    const putFile = [...srv.files.keys()].find((k) => k.startsWith("/edi/in/"));
    t.ok("edi sftp: an outbound 850 is put in their inbox (written as .part, then renamed)", sent.status === "sent" && !!putFile && !putFile.endsWith(".part")
      && srv.files.get(putFile!)!.data.toString("latin1").startsWith("ISA"), `${sent.status} ${sent.detail} ${putFile}`);
    const polled = await edi.pollPartner((fn) => tx(buyerScope.actor, fn), buyerScope, ediEnv, ashley.id);
    t.ok("edi sftp: polling takes their outbox file in (quarantined in the EDI inbox as unreadable) and archives it", polled.ok && polled.files === 1
      && polled.documents[0]?.status === "quarantined" && srv.files.has("/edi/out/done/hello.edi") && !srv.files.has("/edi/out/hello.edi"), polled.note);

    // ============================================================ vendor feeds by SFTP
    srv.mkdirs("/feed");
    srv.put("/feed/qty_today.csv", "Item,On Hand,Lead Time\nVF-100,12,\nVF-101,4,3\n", now);
    const qf = await CR.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { vendor_id: V.COASTER, purpose: "quantities", name: "Coaster stock (SFTP)", kind: "sftp", url: "", every_hours: 6,
      mapping: { vendor_sku: "Item", qty: "On Hand", lead_days: "Lead Time" }, options: { host: "127.0.0.1", port, user: "buddys", path: "/feed", pattern: "*.csv" } }, secrets: { sftpPassword: "Sftp-Pass-7788" } });
    const ftest = await CR.post("/catalog/feeds/test", BUYER, { feed: { id: qf.id } });
    t.ok("feed sftp: Test records the server key and maps the newest file's rows", ftest.sftp?.firstTime && ftest.sftp.fingerprint === fp2 && ftest.ok && ftest.recordsFound === 2 && ftest.mapping.qty === "On Hand",
      JSON.stringify({ sftp: ftest.sftp, problem: ftest.problem }));
    const fr1 = await CR.post("/catalog/feeds/:id/run", BUYER, {}, qf.id);
    const q12 = await read(t, (c) => q<{ qty_available: number }>(c, `select qty_available from vendor_availability where entity_id = $1 and vendor_id = $2 and vendor_sku = 'VF-100'`, [ENTITY, V.COASTER]));
    t.ok("feed sftp: a run applies the file through the feed's mapping", fr1.ok && Number(q12[0]?.qty_available) === 12, fr1.note);
    const fr2 = await CR.post("/catalog/feeds/:id/run", BUYER, {}, qf.id);
    t.ok("feed sftp: the same file is never applied twice", fr2.ok && /no new files/.test(fr2.note), fr2.note);
    const fview = await CR.get("/catalog/vendors/:id/feeds", BUYER, "", V.COASTER);
    const fcard = fview.feeds.find((f: { id: string }) => f.id === qf.id);
    t.ok("feed sftp: the card has no 'not built' note, and shows the key and the file taken", !fcard.transport_note && fcard.pin?.fingerprint === fp2 && fcard.files.length === 1 && fcard.files[0].name === "qty_today.csv");
    t.ok("feed sftp: the vendor's own inbound address shows in the feed dialog", /^vendors\+[a-z0-9]{20}@in\.example\.com$/.test(fview.mail.address ?? ""), fview.mail.address);

    // ============================================================ HTTPS (api) connection
    let served = "Item Number,Dealer Cost\nVF-101,125.00\n";
    const web = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
      if (req.headers.authorization !== "Bearer VF-TOKEN-5151") { res.writeHead(401); return res.end(); }
      res.writeHead(200, { "content-type": "text/csv" }); res.end(served);
    });
    await new Promise<void>((ok) => web.listen(0, "127.0.0.1", () => ok()));
    const wport = (web.address() as { port: number }).port;
    try {
      await t.throws("api: an http:// address is refused", () => R.post("/vendor-files/save", BUYER, { connection: { vendor_id: V.COASTER, channel: "api", name: "x", endpoint: `http://127.0.0.1:${wport}/p.csv`, schedule: "0 6 * * *", carries: [{ kind: "prices", glob: "" }] } }), /starts with https/);
      await t.throws("api: a key in the address is refused", () => R.post("/vendor-files/save", BUYER, { connection: { vendor_id: V.COASTER, channel: "api", name: "x", endpoint: `https://127.0.0.1:${wport}/p.csv?api_key=1`, schedule: "0 6 * * *", carries: [{ kind: "prices", glob: "" }] } }), /looks like a secret/);
      const api = await R.post<{ id: string }>("/vendor-files/save", BUYER, { connection: { vendor_id: V.COASTER, channel: "api", name: "Coaster price URL", endpoint: `https://127.0.0.1:${wport}/prices.csv`,
        auth: "bearer", schedule: "0 6 * * *", carries: [{ kind: "prices", glob: "" }] }, secrets: { token: "WRONG" } });
      const bad1 = await R.post("/vendor-files/:id/run", BUYER, {}, api.id);
      t.ok("api: a wrong token is refused in words, and the failure is recorded on the connection", !bad1.ok && /refused the credentials \(401\)/.test(bad1.words), bad1.words);
      await R.post("/vendor-files/save", BUYER, { connection: { id: api.id, vendor_id: V.COASTER, channel: "api", name: "Coaster price URL", endpoint: `https://127.0.0.1:${wport}/prices.csv`,
        auth: "bearer", schedule: "0 6 * * *", carries: [{ kind: "prices", glob: "" }] }, secrets: { token: "VF-TOKEN-5151" } });
      const at = await R.post("/vendor-files/:id/test", BUYER, {}, api.id);
      t.ok("api: Test makes one call over HTTPS and reads it, changing nothing", at.ok && at.status === 200 && at.rows === 1, at.words);
      const ar = await R.post("/vendor-files/:id/run", BUYER, {}, api.id);
      const p101 = await read(t, (c) => q<{ cost_minor: string }>(c, `select cost_minor from product where entity_id = $1 and vendor_id = $2 and vendor_sku = 'VF-101'`, [ENTITY, V.COASTER]));
      t.ok("api: a run pulls the file through the vendor feeds' checked caller and reprices", ar.ok && ar.result.fresh === 1 && p101[0]?.cost_minor === "12500", JSON.stringify(ar));
      const ar2 = await R.post("/vendor-files/:id/run", BUYER, {}, api.id);
      t.ok("api: the same answer twice is one file", ar2.ok && ar2.result.fresh === 0);
      served = "<html>maintenance</html>";
      const ar3 = await R.post("/vendor-files/:id/run", BUYER, {}, api.id);
      t.ok("api: an answer that does not read is quarantined with the reason", ar3.result.failed === 1 && /no rows|no column/.test(ar3.result.quarantined[0]?.reason ?? ""), JSON.stringify(ar3.result));
    } finally { await new Promise<void>((ok) => web.close(() => ok())); }

    // ============================================================ email
    const emailConn = await R.post<{ id: string }>("/vendor-files/save", BUYER, { connection: { vendor_id: V.COASTER, channel: "email", name: "Coaster email", senders: "@coaster.example",
      carries: [{ kind: "inventory", glob: "*inv*" }, { kind: "edi", glob: "*.edi" }] } });
    await t.throws("email: an email connection has no password", () => R.post("/vendor-files/save", BUYER, { connection: { id: emailConn.id, vendor_id: V.COASTER, channel: "email", name: "Coaster email", senders: "@coaster.example", carries: [{ kind: "inventory", glob: "*inv*" }] }, secrets: { password: "x" } }), /no password/);
    const ov2 = await R.get("/vendor-files", BUYER);
    t.ok("email: the company's own inbound address is shown", /^vendors\+[a-z0-9]{20}@in\.example\.com$/.test(ov2.address ?? ""), ov2.address);
    const r1 = await vf.receiveMail(mail(`Vendors <${ov2.address}>`, "Shipping <inventory@coaster.example>",
      [{ name: "stock.zip", type: "application/zip", content: zipOf([["coaster_inv_5.csv", "sku,qty\nVF-101,5\n"], ["__MACOSX/._x", "junk"]]) }, { name: "logo.png", type: "image/png", content: "png" }]));
    const a5 = await read(t, (c) => q<{ qty_available: number }>(c, `select qty_available from vendor_availability where entity_id = $1 and vendor_id = $2 and vendor_sku = 'VF-101'`, [ENTITY, V.COASTER]));
    t.ok("email: an attachment from a listed sender goes to that vendor's connection; a zip is opened; the logo is left out",
      r1?.accepted === 1 && Number(a5[0]?.qty_available) === 5 && r1.ignored.includes("logo.png") && r1.routed[0]?.to === "Coaster email", JSON.stringify(r1));
    const r2 = await vf.receiveMail(mail(ov2.address!, "someone@stranger.example", [{ name: "coaster_inv_6.csv", content: "sku,qty\nVF-101,99\n" }]));
    const held = await R.get("/vendor-files", BUYER);
    const h1 = held.held.find((h: { filename: string }) => h.filename === "coaster_inv_6.csv");
    t.ok("email: an unknown sender's file is held, not read", r2?.held.includes("coaster_inv_6.csv") && h1 && /not on the sender list/.test(h1.reason), JSON.stringify(r2));
    const r3 = await vf.receiveMail(mail(ov2.address!, "inventory@coaster.example", [{ name: "coaster_inv_7.csv", content: "sku,qty\nVF-101,77\n" }],
      { Headers: [{ Name: "Received-SPF", Value: "fail (domain does not designate)" }] }));
    t.ok("email: a sender whose domain did not vouch for it (SPF fail) is held", r3?.held.length === 1 && r3.accepted === 0, JSON.stringify(r3));
    t.ok("email: an address that is no company's is left to the older routes", (await vf.receiveMail(mail("vendors+zzzzzzzzzzzzzzzzzzzz@in.example.com", "a@coaster.example", [{ name: "a.csv", content: "x" }]))) === null);
    await R.post("/vendor-files/held/:id/assign", BUYER, { connectionId: emailConn.id, addSender: true }, h1.id);
    const a6 = await read(t, (c) => q<{ qty_available: number }>(c, `select qty_available from vendor_availability where entity_id = $1 and vendor_id = $2 and vendor_sku = 'VF-101'`, [ENTITY, V.COASTER]));
    const senders = await read(t, (c) => q<{ allowed_senders: string[] }>(c, `select allowed_senders from connection where id = $1 and entity_id = $2`, [emailConn.id, ENTITY]));
    t.ok("email: a person assigns held mail to a vendor; it is read then, and the sender added", Number(a6[0]?.qty_available) === 99 && senders[0].allowed_senders.includes("someone@stranger.example"));

    // ---- email-in feed, the vendor's own address
    const pf = await CR.post<{ id: string }>("/catalog/feeds", BUYER, { feed: { vendor_id: V.COASTER, purpose: "pricing", name: "Coaster prices (email)", kind: "email", url: "",
      mapping: { vendor_sku: "Item", cost: "Cost" }, options: { fromContains: "prices@coaster.example", pattern: "*.csv" } } });
    await t.throws("feed email: an email-in feed has no schedule", () => CR.post("/catalog/feeds", BUYER, { feed: { vendor_id: V.COASTER, purpose: "pricing", name: "y", kind: "email", url: "", every_hours: 4, options: { fromContains: "a@b.example" } } }), /no schedule/);
    const vmail = (await R.get("/vendor-files/vendor/:id", BUYER, "", V.COASTER)).address as string;
    const m1 = await vf.receiveMail(mail(vmail, "Prices <prices@coaster.example>", [{ name: "prices-nov.csv", content: "Item,Cost\nVF-100,333.00\n" }]));
    const p100 = await read(t, (c) => q<{ cost_minor: string }>(c, `select cost_minor from product where entity_id = $1 and vendor_id = $2 and vendor_sku = 'VF-100'`, [ENTITY, V.COASTER]));
    t.ok("feed email: mail to the vendor's own address from the feed's sender runs the feed through its mapping", m1?.accepted === 1 && p100[0]?.cost_minor === "33300" && m1.routed[0]?.to === "Coaster prices (email)", JSON.stringify(m1));
    const m2 = await vf.receiveMail(mail(vmail, "Prices <prices@coaster.example>", [{ name: "prices-nov.csv", content: "Item,Cost\nVF-100,333.00\n" }]));
    t.ok("feed email: the same attachment twice is applied once", m2?.duplicate === 1 && m2.accepted === 0, JSON.stringify(m2));
    const m3 = await vf.receiveMail(mail(vmail, "rep@elsewhere.example", [{ name: "prices-dec.csv", content: "Item,Cost\nVF-100,344.00\n" }]));
    const vh = await R.get("/vendor-files/vendor/:id", BUYER, "", V.COASTER);
    const h2 = vh.held.find((h: { filename: string }) => h.filename === "prices-dec.csv");
    t.ok("feed email: a stranger's mail to the vendor's address is held against that vendor", m3?.held.length === 1 && h2?.vendor_id === V.COASTER);
    const as = await R.post("/vendor-files/held/:id/assign", BUYER, { feedId: pf.id, addSender: true }, h2.id);
    const p100b = await read(t, (c) => q<{ cost_minor: string }>(c, `select cost_minor from product where entity_id = $1 and vendor_id = $2 and vendor_sku = 'VF-100'`, [ENTITY, V.COASTER]));
    t.ok("feed email: assigned to the feed, it runs, and the sender joins the feed's list", as.status === "applied" && p100b[0]?.cost_minor === "34400", JSON.stringify(as));
    const files = await read(t, (c) => feeds.feedFiles(c, ENTITY, pf.id));
    t.ok("feed email: each file taken is listed on the feed with its sender", files.length === 2 && files.some((f) => f.sender === "rep@elsewhere.example"));

    // ============================================================ tenant isolation
    const rioOv = await R.get("/vendor-files", RIO_OWNER, "", undefined, RIO_ENTITY);
    t.ok("isolation: another client's company sees none of these connections or held mail", rioOv.connections.length === 0 && rioOv.held.length === 0 && rioOv.address !== ov2.address);
    for (const [path, body] of [["/vendor-files/:id/test", {}], ["/vendor-files/:id/run", {}], ["/vendor-files/:id/status", { status: "paused" }], ["/vendor-files/:id/trust-key", { fingerprint: fp2 }]] as const) {
      await t.throws(`isolation: another client cannot reach ${path.replace("/vendor-files/:id/", "")} on this company's connection`, () => R.post(path, RIO_OWNER, body as Record<string, unknown>, conn.id, RIO_ENTITY), /no such vendor connection/);
    }
    await t.throws("isolation: another client cannot read this company's connection", () => R.get("/vendor-files/:id", RIO_OWNER, "", conn.id, RIO_ENTITY), /no such vendor connection/);
    await t.throws("isolation: another client cannot assign this company's held mail", () => R.post("/vendor-files/held/:id/assign", RIO_OWNER, { connectionId: emailConn.id }, h1.id, RIO_ENTITY), /no such held message/);
    await t.throws("isolation: another client cannot save a connection for this company's vendor", () => R.post("/vendor-files/save", RIO_OWNER, { connection: { ...base, name: "steal" } }, undefined, RIO_ENTITY), /not set up for this company/);
    await t.throws("isolation: another client cannot read this company's vendor address", () => R.get("/vendor-files/vendor/:id", RIO_OWNER, "", V.COASTER, RIO_ENTITY), /not set up for this company/);
    const rioMail = await vf.receiveMail(mail(rioOv.address!, "inventory@coaster.example", [{ name: "coaster_inv_8.csv", content: "sku,qty\nVF-101,1\n" }]));
    const a8 = await read(t, (c) => q<{ qty_available: number }>(c, `select qty_available from vendor_availability where entity_id = $1 and vendor_id = $2 and vendor_sku = 'VF-101'`, [ENTITY, V.COASTER]));
    t.ok("isolation: mail to another client's address stays theirs (held there), even from this company's vendor", rioMail?.company === RIO_ENTITY && rioMail.held.length === 1 && Number(a8[0]?.qty_available) === 99);
    await t.throws("isolation: another client cannot trust this company's feed key", () => CR.post("/catalog/feeds/:id/trust-key", RIO_OWNER, { fingerprint: fp2 }, qf.id).then(() => { throw new Error("allowed"); }), /no such feed|needs one of|allowed/);

    // ============================================================ the catalog import template
    const names = cat.IMPORT_FIELDS.map((f) => f.name);
    t.ok("template: the CSV is one heading row, the import fields in order", templateCsv().trim() === names.join(","));
    const xr = xlsxRows(templateXlsx());
    t.ok("template: the .xlsx's Catalog sheet headings equal IMPORT_FIELDS (18), so they cannot drift", JSON.stringify(xr[0]) === JSON.stringify(names) && names.length === 18 && xr[1][0] === cat.TEMPLATE_EXAMPLE_SKU, JSON.stringify(xr[0]));
    const am = cat.automap(names);
    t.ok("template: automap maps all 18 headings to themselves", names.every((n) => am[n] === n), JSON.stringify(am));
    const dl = await CR.get("/catalog/import/template\\.xlsx", BUYER);
    const dlc = await CR.get("/catalog/import/template\\.csv", BUYER);
    t.ok("template: both are served as downloads with their file names", dl instanceof Download && dl.filename === "vendor-catalog-template.xlsx" && dl.bytes.length > 1000
      && dlc instanceof Download && dlc.bytes.toString("utf8").startsWith("vendor_sku,name,cost"));
    const xcols = await CR.post("/catalog/import/columns", BUYER, { xlsx: templateXlsx().toString("base64") });
    t.ok("template: an .xlsx upload is read (its Catalog sheet) and every field maps", xcols.headers.length === 18 && !xcols.missing.length);
    const xpv = await CR.post("/catalog/import/preview", BUYER, { vendorId: V.COASTER, xlsx: templateXlsx().toString("base64"), filename: "t.xlsx", mapping: Object.fromEntries(names.map((n) => [n, n])) });
    t.ok("template: the example row (B1234-38) is skipped, so the template itself adds nothing", xpv.rows === 0 && !xpv.add, JSON.stringify(xpv).slice(0, 200));
    const cpv = await CR.post("/catalog/import/preview", BUYER, { vendorId: V.COASTER, csv: `${names.join(",")}\nB1234-38,Example,1,2,,,,,,,,,,,,,,Active\nVF-300,Real one,10.00,20.00,,,,,,,,,,,,,,Active\n`, filename: "t.csv", mapping: Object.fromEntries(names.map((n) => [n, n])) });
    t.ok("template: a filled-in copy keeps its own rows and still skips the example", cpv.add === 1, JSON.stringify(cpv).slice(0, 200));
    await CR.post(`/catalog/import/runs/:id/abandon`, BUYER, {}, cpv.runId);
  } finally {
    C.useNetEnv(null);
    await srv.stop();
    if (saved.key === undefined) delete process.env.ERP_SECRET_KEY; else process.env.ERP_SECRET_KEY = saved.key;
    if (saved.addr === undefined) delete process.env.ERP_INBOUND_EMAIL_ADDRESS; else process.env.ERP_INBOUND_EMAIL_ADDRESS = saved.addr;
  }
}
