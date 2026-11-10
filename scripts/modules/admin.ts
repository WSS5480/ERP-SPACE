// Admin checks: service switches (hide, never stop), parents, the single-store
// rule, role-and-service menus, the screen map in server/ui, and connections:
// the SMTP client against a fake server on this machine, the HTTP email and
// SMS providers against a fake network, sealed secrets that no GET returns,
// the trade sign-in code going through email (logged when none is set), the
// message log and resend, and who may do what.
import net from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { type T, ENTITY, RIO_ENTITY, TENANT, PEOPLE } from "./harness.ts";
import { tx, q, type Client } from "../../packages/core/db.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";
import * as svc from "../../packages/core/services.ts";
import * as msg from "../../packages/core/messaging.ts";
import * as trade from "../../packages/core/trade.ts";
import * as shop from "../../packages/core/shop.ts";
import * as fleet from "../../packages/core/fleet.ts";
import { MODULE_IDS, enabledModules, setModule } from "../../packages/core/setup.ts";
import type { FetchLike } from "../../packages/core/vendor_feeds.ts";
import { module as adminModule } from "../../server/modules/admin.ts";
import { module as setupModule } from "../../server/modules/setup.ts";
import { module as inventoryModule } from "../../server/modules/inventory.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const KEY = randomBytes(32);
const sys = { kind: "system" as const, label: "admin checks" };
const inTx = <R>(fn: (c: Client) => Promise<R>) => tx(sys, fn);
const WEB_ADMIN_NAME = "Kim (web store)";

type Fn = (...a: unknown[]) => Promise<unknown>;
function routes(t: T, mod: { register: (k: never) => void }) {
  const gets = new Map<string, Fn>(), posts = new Map<string, Fn>();
  mod.register({ coGet: (tail: string, fn: Fn) => gets.set(tail, fn), coPost: (tail: string, fn: Fn) => posts.set(tail, fn), publicRoute: () => {} } as never);
  return {
    get: async <R = Record<string, unknown>>(tail: string, personId: string | null, m: string[] = [], query = ""): Promise<R> => {
      const c = await t.pool.connect();
      try { const co = await t.company(); return await gets.get(tail)!(c, co, new URL("http://x/" + query), ["", co.id, ...m], personId) as R; }
      finally { c.release(); }
    },
    post: <R = Record<string, unknown>>(tail: string, personId: string, body: Record<string, unknown>, m: string[] = []): Promise<R> =>
      t.as(personId, (c: Client, co: Company, a: Actor) => posts.get(tail)!(c, co, a, body, ["", co.id, ...m]) as Promise<R>),
  };
}

// ------------------------------------------------------------ fake network
type Req = { url: string; method: string; headers: Record<string, string>; body: string };
function fakeNet() {
  const log: Req[] = [];
  const res = (status: number, body: string, extra: Record<string, string> = {}) =>
    ({ status, headers: { get: (k: string) => extra[k.toLowerCase()] ?? null }, text: async () => body });
  const fetch: FetchLike = async (url, init = {}) => {
    const r: Req = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? "" };
    log.push(r);
    const u = new URL(url);
    if (u.host === "api.sendgrid.com") return r.headers.authorization === "Bearer SG.good-key" ? res(202, "", { "x-message-id": "sg-msg-1" }) : res(401, '{"errors":[{"message":"bad key"}]}');
    if (u.host === "api.postmarkapp.com") return res(200, JSON.stringify({ MessageID: "pm-77", ErrorCode: 0 }));
    if (u.host === "api.twilio.com") {
      const ok = r.headers.authorization === `Basic ${Buffer.from(`AC${"a".repeat(32)}:tw-token`).toString("base64")}`;
      return ok ? res(201, JSON.stringify({ sid: "SM-fake-1", status: "queued" })) : res(401, "{}");
    }
    if (u.host === "sms.example.com") return res(200, JSON.stringify({ messageId: "gen-9" }));
    if (u.host === "hooks.example.com") return res(204, "");
    return res(404, "");
  };
  return { fetch, log };
}

// --------------------------------------------------------- fake SMTP server
function fakeSmtp(auth: "PLAIN" | "LOGIN", user: string, pass: string) {
  const got = { data: "", from: "", to: [] as string[], user: "", pass: "", cmds: [] as string[] };
  const server = net.createServer((s) => {
    let buf = "", mode = "cmd", step = 0, u = "";
    s.write("220 fake.local ESMTP ready\r\n");
    s.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        if (mode === "data") {
          const i = buf.indexOf("\r\n.\r\n");
          if (i < 0) return;
          got.data = buf.slice(0, i + 2); buf = buf.slice(i + 5); mode = "cmd";
          s.write("250 2.0.0 OK queued as FAKE123\r\n"); continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2); got.cmds.push(line);
        const dec = (x: string) => Buffer.from(x, "base64").toString("utf8");
        if (step === 1) { u = dec(line); step = 2; s.write("334 UGFzc3dvcmQ6\r\n"); continue; }
        if (step === 2) { step = 0; got.user = u; got.pass = dec(line); s.write(u === user && got.pass === pass ? "235 2.7.0 ok\r\n" : "535 5.7.8 bad credentials\r\n"); continue; }
        if (/^EHLO /i.test(line)) s.write(`250-fake.local\r\n250-AUTH ${auth}\r\n250 8BITMIME\r\n`);
        else if (/^AUTH PLAIN /i.test(line)) {
          const [, uu, pp] = dec(line.slice(11)).split("\0"); got.user = uu; got.pass = pp;
          s.write(uu === user && pp === pass ? "235 2.7.0 ok\r\n" : "535 5.7.8 bad credentials\r\n");
        } else if (/^AUTH LOGIN$/i.test(line)) { step = 1; s.write("334 VXNlcm5hbWU6\r\n"); }
        else if (/^MAIL FROM:/i.test(line)) { got.from = line.slice(10).replace(/[<>]/g, ""); s.write("250 ok\r\n"); }
        else if (/^RCPT TO:/i.test(line)) { got.to.push(line.slice(8).replace(/[<>]/g, "")); s.write("250 ok\r\n"); }
        else if (/^DATA$/i.test(line)) { mode = "data"; s.write("354 go ahead\r\n"); }
        else if (/^QUIT$/i.test(line)) { s.write("221 bye\r\n"); s.end(); }
        else s.write("502 not here\r\n");
      }
    });
    s.on("error", () => {});
  });
  return new Promise<{ port: number; got: typeof got; close: () => void }>((ok) =>
    server.listen(0, "127.0.0.1", () => ok({ port: (server.address() as net.AddressInfo).port, got, close: () => server.close() })));
}

export async function run(t: T) {
  const net0 = fakeNet();
  const ports: number[] = [];
  const env = (): msg.MsgEnv => ({ fetch: net0.fetch, secret: () => "", sleep: async () => {}, resolve: async () => ["93.184.216.34"],
    secretKey: KEY, smtpAllowPrivate: true, smtpAllowPlain: true, smtpTimeoutMs: 3000, smtpAllowPorts: ports });
  msg.useMsgEnv(env);
  const sql = async <R = Record<string, unknown>>(text: string, params: unknown[]): Promise<R[]> => {
    const c = await t.pool.connect();
    try { return await t.q<R>(c, text, params); } finally { c.release(); }
  };
  const A = routes(t, adminModule), S = routes(t, setupModule), INV = routes(t, inventoryModule);
  const person = async (name: string) => (await sql<{ id: string }>(`select id from app_user where tenant_id = $1 and name = $2 /* unscoped: a seeded person */`, [TENANT, name]))[0]?.id;
  const WEB = await person(WEB_ADMIN_NAME);
  const before = await inTx((c) => enabledModules(c, ENTITY));

  // ============================================================ services
  t.ok("services: every switch id has a catalog entry and a check-constraint value", MODULE_IDS.every((m) => svc.serviceById(m)) && svc.SERVICES.length === MODULE_IDS.length);
  const cons = (await sql<{ d: string }>(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'entity_module_module_check' /* unscoped: catalog */`, []))[0].d;
  t.ok("services: the entity_module check names every service", MODULE_IDS.every((m) => cons.includes(`'${m}'`)));

  // every screen in server/ui is mapped to the service the catalog says
  const ui = readdirSync(ROOT + "server/ui").filter((f) => f.endsWith(".js"));
  const regs: [string, string | null][] = [];
  for (const f of ui) for (const m of readFileSync(ROOT + "server/ui/" + f, "utf8").matchAll(/register\('([a-z]+)',[^\n]*?module: (null|'([a-z]+)')/g)) regs.push([m[1], m[3] ?? null]);
  const wrong = regs.filter(([n, mod]) => !(n in svc.SCREEN_SERVICE) || svc.SCREEN_SERVICE[n] !== mod);
  t.ok("services: every registered screen names its service", regs.length >= 35 && !wrong.length, JSON.stringify(wrong));
  const appJs = readFileSync(ROOT + "server/app.js", "utf8");
  const ROLE_SCREENS = new Function("return " + /const ROLE_SCREENS = (\{[\s\S]*?\n\});/.exec(appJs)![1])() as Record<string, string[]>;
  t.ok("roles: controllers get Services and Connections; the web admin gets Connections", ROLE_SCREENS.controller.includes("services") && ROLE_SCREENS.controller.includes("connections")
    && ROLE_SCREENS.web_admin.includes("connections") && !ROLE_SCREENS.sales.includes("connections"));
  const oldName = new RegExp(["Pen", "tex"].join(""));   // the company's old name never comes back on a screen
  t.ok("names: the old company name is on no screen", !oldName.test(appJs) && !ui.some((f) => oldName.test(readFileSync(ROOT + "server/ui/" + f, "utf8"))));

  // turn a service off: hidden from the menu, its API still answers
  await A.post("/admin/services/switch", PEOPLE.STEVE, { service: "inventory", enabled: true });
  const on1 = await inTx((c) => svc.effectiveServices(c, ENTITY));
  const navOn = svc.navScreens(on1, ["warehouse"], ROLE_SCREENS);
  t.ok("menu: a warehouse person sees Warehouse while it is on", navOn.includes("inventory") && navOn.includes("lots"));
  const r1 = await A.post<{ enabled: boolean; state: svc.ServiceState }>("/admin/services/switch", PEOPLE.CONTROLLER, { service: "inventory", enabled: false });
  const navOff = svc.navScreens(r1.state, ["warehouse"], ROLE_SCREENS);
  t.ok("hide: Warehouse off leaves it out of the warehouse person's menu", !navOff.includes("inventory") && navOff.includes("fleet"));
  t.ok("hide: and out of the owner's", !svc.navScreens(r1.state, ["owner"], ROLE_SCREENS).includes("inventory"));
  const mods = await S.get<{ modules: string[]; switches: string[] }>("/setup/modules", null);
  t.ok("hide: the page is told it is not showing", !mods.modules.includes("inventory") && !mods.switches.includes("inventory"));
  const layoutApi = await INV.get<{ locations: unknown[] }>("/inventory/layout", null);
  t.ok("hide, don't stop: the warehouse API still answers the services that use it", Array.isArray(layoutApi.locations) && layoutApi.locations.length > 0);

  // parent off: children hidden, their own switches kept
  t.ok("parent: Warehouse off hides Containers, Serials, Labels and As-is", ["wms", "lots", "labels", "asis"].every((x) => !r1.state.on.includes(x as never) && r1.state.switches[x as never]),
    JSON.stringify(r1.state.hidden));
  t.ok("parent: the reason is said in words", /Warehouse is off/.test(r1.state.hidden.lots ?? ""));
  await A.post("/admin/services/switch", PEOPLE.STEVE, { service: "inventory", enabled: true });
  const back = await inTx((c) => svc.effectiveServices(c, ENTITY));
  t.ok("parent: turning it back on brings the children back", ["inventory", "wms", "lots"].every((x) => back.on.includes(x as never)));
  await A.post("/admin/services/switch", PEOPLE.STEVE, { service: "loading", enabled: false });
  await A.post("/admin/services/switch", PEOPLE.STEVE, { service: "fleet", enabled: false });
  const r2 = await A.post<{ alsoOn: string[] }>("/admin/services/switch", PEOPLE.STEVE, { service: "haulaway", enabled: true });
  const st2 = await inTx((c) => svc.effectiveServices(c, ENTITY));
  t.ok("parent: turning a child on turns on what it belongs to", r2.alsoOn.includes("fleet") && st2.on.includes("haulaway") && st2.on.includes("fleet") && !st2.on.includes("loading"));
  await A.post("/admin/services/switch", PEOPLE.STEVE, { service: "loading", enabled: true });

  // the single-store rule
  const single = svc.computeState([...MODULE_IDS], { companies: 1, locations: 1, mode: "auto", multiCompany: false, multiStore: false, single: true });
  t.ok("single store: Group and store orders hide, the rest show", !single.on.includes("group") && !single.on.includes("storeorders") && single.on.includes("pos")
    && single.hidden.group === "only one company here");
  const rioL = await inTx((c) => svc.layoutOf(c, RIO_ENTITY));
  const rioS = await inTx((c) => svc.effectiveServices(c, RIO_ENTITY));
  const rioSet = await sql<{ set_by: string }>(`select set_by from entity_setting where entity_id = $1 and key = 'admin.layout'`, [RIO_ENTITY]);
  t.ok("kept: a one-company client that saw Group before 0049 still sees it (0050)", rioL.companies === 1 && rioL.mode === "multi" && rioS.on.includes("group")
    && /migration 0050/.test(rioSet[0]?.set_by ?? ""), JSON.stringify(rioL));
  const fresh = svc.computeState([...MODULE_IDS], { ...rioL, mode: "auto", multiCompany: false, multiStore: rioL.locations > 1, single: rioL.locations <= 1 });
  t.ok("single company: a new one-company client does not see Group", !fresh.on.includes("group"));
  const keepAgain = await inTx(async (c) => Number((await q<{ n: number }>(c, `select admin_keep_layout() n /* unscoped: the 0050 keep, run again */`, []))[0].n));
  t.ok("kept: running the keep again changes nothing", keepAgain === 0);
  const ours = await inTx((c) => svc.layoutOf(c, ENTITY));
  t.ok("several: two companies and several stores show Group and store orders", ours.multiCompany && ours.multiStore && back.on.includes("group"));
  await t.throws("layout: only the owner overrides it", () => A.post("/admin/services/layout", PEOPLE.CONTROLLER, { mode: "single" }), /needs one of: owner/);
  const ov = await A.post<{ layout: svc.Layout }>("/admin/services/layout", PEOPLE.STEVE, { mode: "single" });
  const ovS = await inTx((c) => svc.effectiveServices(c, ENTITY));
  t.ok("layout: the owner's override hides Group here", ov.layout.single && !ovS.on.includes("group"));
  await A.post("/admin/services/layout", PEOPLE.STEVE, { mode: "auto" });
  t.ok("layout: back to counted", (await inTx((c) => svc.effectiveServices(c, ENTITY))).on.includes("group"));

  // roles and the menu
  const sales = svc.navScreens(back, ["sales"], ROLE_SCREENS);
  t.ok("menu: a salesperson sees only their own screens", sales.includes("pos") && !sales.includes("payables") && !sales.includes("services"));
  await A.post("/admin/services/switch", PEOPLE.STEVE, { service: "crm", enabled: false });
  const noCrm = svc.navScreens(await inTx((c) => svc.effectiveServices(c, ENTITY)), ["sales"], ROLE_SCREENS);
  t.ok("menu: role and switches together (Customers off hides Customers and Leads from sales)", !noCrm.includes("crm") && !noCrm.includes("leads") && noCrm.includes("pos"));
  await A.post("/admin/services/switch", PEOPLE.STEVE, { service: "crm", enabled: true });
  await t.throws("roles: a clerk cannot switch services", () => A.post("/admin/services/switch", PEOPLE.CLERK, { service: "pos", enabled: false }), /needs one of: owner, controller/);
  await t.throws("roles: a clerk cannot read the Services screen", () => A.get("/admin/services", PEOPLE.CLERK), /owner or a controller/);
  const view = await A.get<{ services: { id: string; children: string[]; usedBy: string[] }[]; presets: unknown[]; companies: unknown[] }>("/admin/services", PEOPLE.CONTROLLER);
  const fl = view.services.find((s) => s.id === "fleet")!;
  t.ok("screen: a card says what depends on it", fl.children.includes("Loading dock") && view.services.find((s) => s.id === "inventory")!.usedBy.includes("Point of sale") && view.presets.length === 5);

  // presets and apply to all companies
  const chk = await A.get<{ open: { service: string; count: number }[] }>("/admin/services/preset-check", PEOPLE.CONTROLLER, [], "?preset=delivery");
  t.ok("preset: the check route answers", Array.isArray(chk.open));
  const openWork = await inTx((c) => svc.presetCheck(c, [{ id: ENTITY, name: "Enola" }], "delivery"));
  t.ok("preset: what it would hide with open work is listed", openWork.some((o) => o.service === "purchasing" || o.service === "ar") && openWork.every((o) => o.count > 0), JSON.stringify(openWork));
  await t.throws("preset: switching off services with open records needs a confirmation", () => A.post("/admin/services/preset", PEOPLE.STEVE, { preset: "delivery" }), /still have open records: .*Confirm/);
  const pr = await A.post<{ companies: number; state: svc.ServiceState; openHidden: unknown[] }>("/admin/services/preset", PEOPLE.STEVE, { preset: "delivery", confirm: true });
  t.ok("preset: Delivery company shows delivery and hides the store", pr.state.on.includes("fleet") && pr.state.on.includes("haulaway") && !pr.state.on.includes("pos") && !pr.state.on.includes("catalog"));
  const all = await A.post<{ companies: number }>("/admin/services/preset", PEOPLE.STEVE, { preset: "furniture", allCompanies: true });
  const sib = (await sql<{ id: string }>(`select id from entity where tenant_id = $1 and id <> $2 and status <> 'closed' /* unscoped: the sister company */`, [TENANT, ENTITY]))[0].id;
  const sibOn = await inTx((c) => enabledModules(c, sib));
  t.ok("preset: apply to all my companies sets each one", all.companies >= 2 && sibOn.length === MODULE_IDS.length);
  // put the company's switches back the way they were
  await inTx(async (c) => { for (const m of MODULE_IDS) await setModule(c, ENTITY, m, before.includes(m), "admin checks"); });

  // ======================================================== connections
  t.ok("smtp: dot-stuffing doubles a leading dot and ends lines CRLF", msg.dotStuff("a\n.b\n..c\r\nd") === "a\r\n..b\r\n...c\r\nd");
  t.ok("smtp: a lone CR or LF becomes CRLF before stuffing", msg.dotStuff("a\rb\n.c") === "a\r\nb\r\n..c");
  t.ok("smtp: the From name is quoted and loses angle brackets", msg.displayName('Bob <evil@x> "B"') === '"Bob evil@x B"');
  const plain = await fakeSmtp("PLAIN", "mailer", "pw-123");
  ports.push(plain.port);
  const sent1 = await msg.smtpSend({ host: "127.0.0.1", port: plain.port, security: "none", user: "mailer", password: "pw-123" },
    { from: "store@example.com", to: ["a@example.com", "b@example.com"], data: msg.buildMime({ name: "Store", address: "store@example.com" },
      { to: ["a@example.com"], subject: "Hi", text: "Line one\n.hidden line\n..two dots\nend" }) }, env());
  t.ok("smtp: plain AUTH PLAIN against a local server", plain.got.user === "mailer" && plain.got.pass === "pw-123" && plain.got.to.length === 2 && sent1.id === "FAKE123");
  t.ok("smtp: the message on the wire is dot-stuffed", plain.got.data.includes("\r\n..hidden line\r\n") && plain.got.data.includes("\r\n...two dots\r\n") && plain.got.data.includes("Subject: Hi"));
  plain.close();
  const login = await fakeSmtp("LOGIN", "u2", "p2");
  ports.push(login.port);
  await msg.smtpSend({ host: "127.0.0.1", port: login.port, security: "none", user: "u2", password: "p2" }, { from: "s@example.com", to: ["x@example.com"], data: "Subject: x\r\n\r\nhello" }, env());
  t.ok("smtp: AUTH LOGIN when that is all the server offers", login.got.user === "u2" && login.got.pass === "p2");
  await t.throws("smtp: a wrong password is said plainly", () => msg.smtpSend({ host: "127.0.0.1", port: login.port, security: "none", user: "u2", password: "nope" },
    { from: "s@example.com", to: ["x@example.com"], data: "x" }, env()), /did not accept the user name and password/);
  await t.throws("smtp: STARTTLS asked of a server that does not offer it is refused", () => msg.smtpSend({ host: "127.0.0.1", port: login.port, security: "starttls" },
    { from: "s@example.com", to: ["x@example.com"], data: "x" }, env()), /does not offer STARTTLS/);
  await t.throws("smtp: the port is checked even for a private relay", () => msg.smtpSend({ host: "127.0.0.1", port: login.port, security: "none" },
    { from: "s@example.com", to: ["x@example.com"], data: "x" }, { ...env(), smtpAllowPorts: [] }), /ports 25, 465, 587 or 2525/);
  await t.throws("smtp: with ERP_SMTP_ALLOW_HOSTS set, other servers are refused", () => msg.smtpSend({ host: "smtp.other.example", port: 587, security: "tls" },
    { from: "s@example.com", to: ["x@example.com"], data: "x" }, { ...env(), smtpAllowPrivate: false, smtpAllowHosts: ["relay.example.com"] }), /ERP_SMTP_ALLOW_HOSTS/);
  login.close();
  await t.throws("smtp: no TLS is refused unless allowed", () => msg.smtpSend({ host: "127.0.0.1", port: login.port, security: "none" },
    { from: "s@example.com", to: ["x@example.com"], data: "x" }, { ...env(), smtpAllowPlain: false }), /no encryption/);
  await t.throws("smtp: private addresses are refused in production", () => msg.smtpSend({ host: "127.0.0.1", port: 587, security: "tls" },
    { from: "s@example.com", to: ["x@example.com"], data: "x" }, { ...env(), smtpAllowPrivate: false }), /private networks/);
  // a server that says yes to STARTTLS and then goes quiet: the upgrade has its own clock
  const stall = net.createServer((sk) => { sk.write("220 hi\r\n"); sk.on("data", (d) => { const l = d.toString();
    if (/^EHLO/i.test(l)) sk.write("250-x\r\n250 STARTTLS\r\n"); else if (/^STARTTLS/i.test(l)) sk.write("220 go ahead\r\n"); }); sk.on("error", () => {}); });
  await new Promise<void>((ok) => stall.listen(0, "127.0.0.1", () => ok()));
  ports.push((stall.address() as net.AddressInfo).port);
  const t0 = Date.now();
  await t.throws("smtp: a STARTTLS upgrade that never finishes times out", () => msg.smtpSend({ host: "127.0.0.1", port: (stall.address() as net.AddressInfo).port, security: "starttls" },
    { from: "s@example.com", to: ["x@example.com"], data: "x" }, { ...env(), smtpTimeoutMs: 300 }), /did not finish STARTTLS|took longer/);
  t.ok("smtp: and it gave up promptly", Date.now() - t0 < 3000);
  stall.close();
  const silent = net.createServer(() => {}); await new Promise<void>((ok) => silent.listen(0, "127.0.0.1", () => ok()));
  ports.push((silent.address() as net.AddressInfo).port);
  await t.throws("smtp: each send has an overall deadline", () => msg.smtpSend({ host: "127.0.0.1", port: (silent.address() as net.AddressInfo).port, security: "none" },
    { from: "s@example.com", to: ["x@example.com"], data: "x" }, { ...env(), smtpTimeoutMs: 5000, smtpDeadlineMs: 250 }), /took longer than/);
  await t.throws("smtp: a server that never answers times out", () => msg.smtpSend({ host: "127.0.0.1", port: (silent.address() as net.AddressInfo).port, security: "none" },
    { from: "s@example.com", to: ["x@example.com"], data: "x" }, { ...env(), smtpTimeoutMs: 300 }), /stopped answering|did not answer/);
  silent.close();

  // roles on connections
  await t.throws("roles: a clerk cannot read Connections", () => A.get("/admin/connections", PEOPLE.CLERK), /owner, a controller or the web admin/);
  await t.throws("roles: a clerk cannot set up email", () => A.post("/admin/connections/save", PEOPLE.CLERK, { kind: "email", provider: "sendgrid", settings: {}, secrets: {} }), /needs one of: owner, controller/);
  if (WEB) {
    await t.throws("roles: the web admin cannot set up email", () => A.post("/admin/connections/save", WEB, { kind: "email", provider: "sendgrid", settings: { fromName: "x", fromAddress: "x@example.com" }, secrets: { apiKey: "k" } }), /needs one of: owner, controller/);
    const kl = await A.post<{ id: string }>("/admin/connections/save", WEB, { kind: "klaviyo", provider: "klaviyo", settings: { siteId: "PUB1" }, secrets: { privateApiKey: "pk_SECRET_klaviyo" } });
    t.ok("roles: the web admin saves a marketing key (sealed, nothing sent)", !!kl.id);
    const wv = await A.get<{ kinds: { id: string; manage: boolean; company: unknown }[] }>("/admin/connections", WEB);
    t.ok("roles: the web admin sees no email settings", wv.kinds.find((k) => k.id === "email")!.company === null && !wv.kinds.find((k) => k.id === "email")!.manage && wv.kinds.find((k) => k.id === "klaviyo")!.manage);
  } else t.ok("roles: a seeded web admin exists", false);
  await t.throws("settings: a secret typed into a plain setting is refused", () => A.post("/admin/connections/save", PEOPLE.STEVE,
    { kind: "email", provider: "sendgrid", settings: { fromName: "B", fromAddress: "s@example.com", apiKey: "SG.x" }, secrets: {} }), /secret/);
  await t.throws("settings: the database refuses a secret-looking setting too", () => inTx((c) => c.query(
    `insert into admin_connection (tenant_id, entity_id, kind, provider, settings) values ($1,$2,'amazon','amazon','{"refreshToken":"x"}')`, [TENANT, ENTITY])), /may not hold/);
  await t.throws("secrets: without ERP_SECRET_KEY nothing is saved", () => inTx((c) => msg.saveConnection(c, { tenantId: TENANT, entityId: ENTITY }, "sms", "twilio",
    { accountSid: "AC" + "a".repeat(32), fromNumber: "+17175550100" }, { authToken: "t" }, { personId: PEOPLE.STEVE, personName: "Steve" }, { ...env(), secretKey: null })), /ERP_SECRET_KEY/);

  // trade code: logged when no email is connected
  const site = (await inTx((c) => shop.siteBySlug(c, "buddys")))!;
  // a trade account of our own, so these checks stand alone
  await inTx(async (c) => {
    const u = randomBytes(3).toString("hex");
    const cu = (await q<{ id: string }>(c, `insert into customer (entity_id, number, name, email) values ($1,$2,$3,$4) returning id`,
      [site.entity_id, `C-ADM-${u}`, `Admin check studio ${u}`, `adm-${u}@example.com`]))[0].id;
    await c.query(`insert into trade_account (entity_id, number, customer_id, company_name, kind, contact_name, email, created_at) values ($1,$2,$3,$4,'designer','Ada',$5, now() + interval '1 minute')`,
      [site.entity_id, `TA-ADM-${u}`, cu, `Admin check studio ${u}`, `adm-${u}@example.com`]);
  });
  const acct = (await sql<{ email: string }>(`select email from trade_account where entity_id = $1 and status = 'active' and number like 'TA-ADM-%' order by created_at desc limit 1`, [site.entity_id]))[0];
  const future = (h: number) => new Date(Date.now() + h * 3600_000);
  const countMsgs = async (where: string) => Number((await sql<{ n: string }>(`select count(*) n from outbound_message where entity_id = $1 and ${where}`, [site.entity_id]))[0].n);
  if (acct) {
    const loggedBefore = await countMsgs(`purpose = 'trade_code' and status = 'logged'`);
    await inTx((c) => trade.requestCode(c, site, acct.email, "ip-adm", undefined, future(30)));
    const lg = await sql<{ body: string; resendable: boolean; redacted: boolean }>(`select body, resendable, redacted from outbound_message where entity_id = $1 and purpose = 'trade_code' order by created_at desc limit 1`, [site.entity_id]);
    t.ok("trade code: with no email connected it is logged, not sent", (await countMsgs(`purpose = 'trade_code' and status = 'logged'`)) === loggedBefore + 1);
    t.ok("trade code: the log keeps the code redacted and never resends it", !/\d{6}/.test(lg[0].body) && lg[0].body.includes("******") && lg[0].redacted && !lg[0].resendable);
  } else t.ok("trade code: a trade account to test with", false);

  // email by HTTP provider (SendGrid), set for the whole client
  await A.post("/admin/connections/save", PEOPLE.STEVE, { kind: "email", provider: "sendgrid", scope: "client",
    settings: { fromName: "Buddy's", fromAddress: "orders@example.com" }, secrets: { apiKey: "SG.bad-key" } });
  const bad = await A.post<{ ok: boolean; words: string }>("/admin/connections/test", PEOPLE.STEVE, { kind: "email", scope: "client", to: "me@example.com" });
  t.ok("http email: a refused key is failing, in plain words", !bad.ok && /did not accept the key/.test(bad.words));
  let cv = await A.get<{ kinds: { id: string; status: string; statusWords: string; using: string; client: { secrets: Record<string, string> } }[] }>("/admin/connections", PEOPLE.CONTROLLER);
  t.ok("status: failing shows its last error", cv.kinds.find((k) => k.id === "email")!.status === "failing" && /did not accept/.test(cv.kinds.find((k) => k.id === "email")!.statusWords));
  await A.post("/admin/connections/save", PEOPLE.STEVE, { kind: "email", provider: "sendgrid", scope: "client", settings: { fromName: "Buddy's", fromAddress: "orders@example.com" }, secrets: { apiKey: "SG.good-key" } });
  const good = await A.post<{ ok: boolean; message: { providerRef: string } }>("/admin/connections/test", PEOPLE.STEVE, { kind: "email", scope: "client", to: "me@example.com" });
  const sg = net0.log.filter((r) => r.url.includes("sendgrid")).pop()!;
  t.ok("http email: the test goes to SendGrid with the key and comes back with its id", good.ok && good.message.providerRef === "sg-msg-1" && JSON.parse(sg.body).personalizations[0].to[0].email === "me@example.com");
  cv = await A.get("/admin/connections", PEOPLE.CONTROLLER);
  t.ok("scope: a company with no own setting uses the client's", cv.kinds.find((k) => k.id === "email")!.using === "client" && cv.kinds.find((k) => k.id === "email")!.status === "connected");
  t.ok("secrets: a GET says set and nothing more", cv.kinds.find((k) => k.id === "email")!.client.secrets.apiKey === "set");
  const aud = await sql<{ after: { scope: string; settings: string[]; secretsChanged: string[] } }>(`select after from audit_event where entity_id = $1 and table_name = 'admin_connection' order by at desc limit 5`, [ENTITY]).catch(() => [] as never[]);
  const audC = aud.find((x) => x.after?.scope === "client");
  t.ok("audit: a client-wide save is audited by name, never by value", !!audC && audC.after.secretsChanged.includes("apiKey") && !JSON.stringify(aud).includes("SG.good-key") && !JSON.stringify(aud).includes("orders@example.com"));
  // a controller of this company only may not test the client's connection
  const ONLY = "55555555-0000-0000-0000-0000000000a9";
  await inTx(async (c) => {
    await c.query(`insert into app_user (id, tenant_id, name, email, status) values ($1,$2,'One-company controller','one@example.com','active') on conflict do nothing /* unscoped: test person */`, [ONLY, TENANT]);
    await c.query(`insert into role_grant (app_user_id, entity_id, role) select $1,$2,'controller' where not exists (select 1 from role_grant where app_user_id = $1) /* unscoped: test grant */`, [ONLY, ENTITY]);
  });
  await t.throws("scope: testing the client's connection needs the role in every company", () => A.post("/admin/connections/test", ONLY, { kind: "email", scope: "client", to: "me@example.com" }), /for the whole client .* too/);
  // a failed PO email keeps its log row through the savepoint rollback
  await A.post("/admin/connections/save", PEOPLE.STEVE, { kind: "email", provider: "sendgrid", scope: "client", settings: { fromName: "Buddy's", fromAddress: "orders@example.com" }, secrets: { apiKey: "SG.bad-key" } });
  const poTo = `vendor-${randomBytes(3).toString("hex")}@example.com`;
  const failedRows = await inTx(async (c) => {
    const ml = (await msg.mailerFor(c, ENTITY, "purchase_order"))!;
    await c.query("savepoint send");
    try { await ml.send({ to: poTo, subject: "PO 1", text: "x", attachments: [] }); }
    catch (e) { await c.query("rollback to savepoint send"); await (e as { relog: (c: Client) => Promise<void> }).relog(c); }
    return q<{ status: string }>(c, `select status from outbound_message where entity_id = $1 and purpose = 'purchase_order' and to_addr = $2`, [ENTITY, poTo]);
  });
  t.ok("purchase orders: a failed email stays in the log after the rollback", failedRows.length === 1 && failedRows[0].status === "failed");
  await A.post("/admin/connections/save", PEOPLE.STEVE, { kind: "email", provider: "sendgrid", scope: "client", settings: { fromName: "Buddy's", fromAddress: "orders@example.com" }, secrets: { apiKey: "SG.good-key" } });

  // trade code through the connection
  if (acct) {
    const n0 = net0.log.length;
    let inside = -1;
    await inTx(async (c) => { await trade.requestCode(c, site, acct.email, "ip-adm", undefined, future(60)); inside = net0.log.length - n0; });
    t.ok("trade code: nothing goes on the network inside the request's transaction", inside === 0);
    await msg.idle();
    const call = net0.log.slice(n0).find((r) => r.url.includes("sendgrid"));
    const code = call ? /(\d{6})/.exec(JSON.parse(call.body).content[0].value)?.[1] : null;
    const row = (await sql<{ status: string; body: string; provider: string }>(`select status, body, provider from outbound_message where entity_id = $1 and purpose = 'trade_code' order by created_at desc limit 1`, [site.entity_id]))[0];
    t.ok("trade code: with email connected the code goes out through it", !!code && JSON.parse(call!.body).personalizations[0].to[0].email === acct.email && row.status === "sent" && row.provider === "sendgrid");
    t.ok("trade code: the code reached the inbox but not the log", !row.body.includes(code!) && row.body.includes("******"));
  }

  // a company's own SMTP setting wins over the client's
  const relay = await fakeSmtp("PLAIN", "relay", "relay-pw");
  ports.push(relay.port);
  const saved = await A.post<{ missing: string[] }>("/admin/connections/save", PEOPLE.STEVE, { kind: "email", provider: "smtp", scope: "company",
    settings: { host: "127.0.0.1", port: relay.port, security: "none", user: "relay", fromName: "Enola store", fromAddress: "enola@example.com" }, secrets: { password: "relay-pw" } });
  t.ok("smtp: saved with nothing missing", saved.missing.length === 0);
  const viaSmtp = await inTx((c) => msg.sendEmail(c, ENTITY, { to: ["cust@example.com"], subject: "Your order", text: "Thanks.\n.\nBye" }, { purpose: "test" }));
  t.ok("scope: the company's own SMTP wins, through the fake server", viaSmtp.status === "sent" && viaSmtp.provider === "smtp" && relay.got.to[0] === "cust@example.com" && relay.got.data.includes("\r\n..\r\n"));
  const mailer = await inTx((c) => msg.mailerFor(c, ENTITY, "purchase_order"));
  t.ok("purchase orders: the PO mailer uses the email connection", !!mailer);
  relay.close();

  // SMS through a mock: Twilio, then delivery texts
  await A.post("/admin/connections/save", PEOPLE.CONTROLLER, { kind: "sms", provider: "twilio", settings: { accountSid: "AC" + "a".repeat(32), fromNumber: "+1 (717) 555-0100" }, secrets: { authToken: "tw-token" } });
  const tt = await A.post<{ ok: boolean; words: string }>("/admin/connections/test", PEOPLE.CONTROLLER, { kind: "sms", to: "717 555 0199" });
  const tw = net0.log.filter((r) => r.url.includes("twilio")).pop()!;
  t.ok("sms: the test text goes through Twilio", tt.ok && new URLSearchParams(tw.body).get("To") === "+17175550199" && new URLSearchParams(tw.body).get("From") === "+17175550100");
  const cust = (await sql<{ id: string }>(`select id from customer where entity_id = $1 and phone is not null limit 1`, [ENTITY]))[0];
  const cmId = await t.as(PEOPLE.STEVE, (c, co) => fleet.messageCustomer(c, { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: PEOPLE.STEVE, label: "x" } },
    { customerId: cust.id, body: "your delivery is booked" }));
  await msg.idle();
  const cm = (await sql<{ status: string; provider: string; provider_ref: string; channel: string }>(`select status, provider, provider_ref, channel from customer_message where entity_id = $1 and id = $2`, [ENTITY, cmId]))[0];
  t.ok("sms: a customer message goes out by text through the connection", cm.status === "sent" && cm.provider === "twilio" && cm.channel === "sms" && cm.provider_ref !== null);
  await A.post("/admin/connections/save", PEOPLE.STEVE, { kind: "sms", provider: "https", settings: { url: "https://sms.example.com/send", idField: "messageId" }, secrets: { authToken: "gen-key" } });
  const gen = await A.post<{ ok: boolean; message: { providerRef: string } }>("/admin/connections/test", PEOPLE.STEVE, { kind: "sms", to: "+17175550199" });
  const gr = net0.log.filter((r) => r.url.includes("sms.example.com")).pop()!;
  t.ok("sms: the generic HTTPS provider", gen.ok && gen.message.providerRef === "gen-9" && gr.headers.authorization === "Bearer gen-key" && JSON.parse(gr.body).to === "+17175550199");
  await t.throws("sms: an http address is refused", () => A.post("/admin/connections/save", PEOPLE.STEVE, { kind: "sms", provider: "https", settings: { url: "http://sms.example.com/x" }, secrets: { authToken: "k" } }), /https address/);

  // webhooks: a signed test
  await A.post("/admin/connections/save", PEOPLE.STEVE, { kind: "webhooks", provider: "https", settings: { url: "https://hooks.example.com/erp" }, secrets: { signingSecret: "whsec_1" } });
  const wh = await A.post<{ ok: boolean }>("/admin/connections/test", PEOPLE.STEVE, { kind: "webhooks" });
  const hk = net0.log.filter((r) => r.url.includes("hooks.example.com")).pop()!;
  const tsig = /t=(\d+),v1=/.exec(hk.headers["x-erp-signature"])![1];
  t.ok("webhooks: the test carries an HMAC signature of time.body", wh.ok && hk.headers["x-erp-signature"] === msg.signWebhook("whsec_1", hk.body, Number(tsig)));

  // a web order confirmation: queued with the order, sent after the commit (back on the client's SendGrid once the company's relay is off)
  await A.post("/admin/connections/off", PEOPLE.STEVE, { kind: "email", scope: "company" });
  const webCust = (await sql<{ id: string }>(`select id from customer where entity_id = $1 and email is not null and phone is null limit 1`, [ENTITY]))[0];
  if (webCust) {
    const n1 = net0.log.length;
    await inTx((c) => shop.ConnectedMessages.send(c, { entityId: ENTITY, siteId: site.id, orderId: null, customerId: webCust.id, channel: "email", toRef: "m***@example.com",
      template: "order_confirmed", body: "Buddy's: order W-1 is confirmed." }));
    await msg.idle();
    const wr = (await sql<{ status: string }>(`select status from outbound_message where entity_id = $1 and purpose = 'web_order' order by created_at desc limit 1`, [ENTITY]))[0];
    t.ok("web orders: the confirmation goes through the email connection after commit", wr?.status === "sent", JSON.stringify(wr));
    t.ok("web orders: by the provider", wr?.status === "sent" && net0.log.slice(n1).some((r) => r.url.includes("sendgrid")));
  } else t.ok("web orders: a customer with an email to test with", false);

  // the message log, resend, and no GET returns a secret
  const log = await A.get<{ messages: { id: string; purpose: string; resendable: boolean; status: string; body: string }[] }>("/admin/messages", PEOPLE.CONTROLLER);
  const again = log.messages.find((m) => m.purpose === "test" && m.resendable && m.status === "sent");
  const rs = await A.post<{ status: string }>(`/admin/messages/([0-9a-fA-F-]{36})/resend`, PEOPLE.STEVE, {}, [again!.id]);
  t.ok("log: a sent message can be sent again", rs.status === "sent");
  const codeMsg = log.messages.find((m) => m.purpose === "trade_code");
  if (codeMsg) await t.throws("log: a sign-in code is never resent", () => A.post(`/admin/messages/([0-9a-fA-F-]{36})/resend`, PEOPLE.STEVE, {}, [codeMsg.id]), /cannot be sent again/);
  if (WEB) {
    const wl = await A.get<{ webOnly: boolean; messages: { purpose: string }[] }>("/admin/messages", WEB);
    t.ok("log: the web admin sees only web store and marketing messages", wl.webOnly && wl.messages.length > 0 && wl.messages.every((m) => msg.WEB_PURPOSES.includes(m.purpose)));
  }
  const everything = JSON.stringify([await A.get("/admin/connections", PEOPLE.STEVE), await A.get("/admin/connections", PEOPLE.CONTROLLER), WEB ? await A.get("/admin/connections", WEB) : null,
    await A.get("/admin/messages", PEOPLE.STEVE), await A.get("/admin/services", PEOPLE.STEVE), await S.get("/setup/modules", null), await S.get("/setup/business", null)]);
  t.ok("secrets: no GET returns a key, token or password", !["SG.good-key", "SG.bad-key", "relay-pw", "tw-token", "gen-key", "whsec_1", "pk_SECRET_klaviyo"].some((s) => everything.includes(s))
    && !/ciphertext|"iv"/.test(everything));
  const sealed = await sql<{ n: string }>(`select count(*) n from admin_connection_secret where tenant_id = $1 and position(convert_to('good-key', 'UTF8') in ciphertext) > 0 /* unscoped: the client's secrets */`, [TENANT]);
  t.ok("secrets: stored sealed, not in the clear", sealed[0].n === "0");

  // turn everything off again (kept, never deleted), so nothing else sends
  for (const [kind, scope] of [["email", "client"], ["sms", "company"], ["webhooks", "company"]]) await A.post("/admin/connections/off", PEOPLE.STEVE, { kind, scope });
  if (WEB) await A.post("/admin/connections/off", WEB, { kind: "klaviyo", scope: "company" });
  const offNow = await inTx((c) => msg.isConnected(c, ENTITY, "email"));
  const kept = await sql<{ n: string }>(`select count(*) n from admin_connection where tenant_id = $1 /* unscoped: the client's connections */`, [TENANT]);
  t.ok("off: turned off, kept on file", !offNow && Number(kept[0].n) >= 5);
  msg.useMsgEnv(msg.liveMsgEnv);
}
