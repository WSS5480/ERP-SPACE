// The platform: customers, sign-in, tenant isolation, support mode, tokens, the demo.
// Runs last: it ends by resetting the demo.
import type { T } from "./harness.ts";
import { ENTITY, TENANT, RIO_ENTITY } from "./harness.ts";

const OP_PASS = "operator-pass-123";
const RIO_TENANT = "dddd0000-0000-0000-0000-00000000000d";

type Res = { status: number; data: Record<string, unknown> & { error?: string }; cookie: string | null };

export async function run(t: T) {
  process.env.ERP_API_TOKEN = process.env.ERP_API_TOKEN && process.env.ERP_API_TOKEN.length >= 32 ? process.env.ERP_API_TOKEN : "t".repeat(48);
  process.env.ERP_LOGINS = `opsy:${OP_PASS},shorty:5480`;
  process.env.ERP_SECRET_TEST_NOCOMPANY = "hook-secret";
  const SYS = process.env.ERP_API_TOKEN;
  const { createServer, routeList, logPath } = await import("../../server/index.ts");
  const P = await import("../../server/platform.ts");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const call = async (method: string, path: string, o: { body?: unknown; cookie?: string | null; as?: string; bearer?: string; ip?: string } = {}): Promise<Res> => {
    const headers: Record<string, string> = { "x-erp-page": "1" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.cookie) headers.cookie = o.cookie;
    if (o.as) headers["x-erp-as"] = o.as;
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    if (o.ip) headers["x-forwarded-for"] = o.ip;
    const r = await fetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const sc = r.headers.get("set-cookie");
    let data: Res["data"] = {};
    try { data = await r.json(); } catch { /* empty */ }
    return { status: r.status, data, cookie: sc ? sc.split(";")[0] : null };
  };
  const tokenOf = (link: string) => link.slice(link.indexOf("=") + 1);
  const db = async <R>(sql: string, args: unknown[] = []) => {
    const c = await t.pool.connect();
    try { return (await c.query(sql, args)).rows as R[]; } finally { c.release(); }
  };

  try {
    // ------------------------------------------------------------ operators
    const bad = await call("POST", "/session", { body: { name: "opsy", key: "wrong-pass-0" }, ip: "198.51.100.1" });
    t.ok("an operator's wrong password is refused", bad.status === 401);
    const shorty = await call("POST", "/session", { body: { name: "shorty", key: "5480" }, ip: "198.51.100.9" });
    t.ok("an old 4-digit operator key is refused, saying what to set", shorty.status === 403 && /at least 10 characters/.test(shorty.data.error ?? ""), shorty.data.error);
    const opIn = await call("POST", "/session", { body: { name: "opsy", key: OP_PASS }, ip: "198.51.100.2" });
    t.ok("an operator signs in with name and password", opIn.status === 200 && !!opIn.cookie && opIn.data.kind === "operator");
    let op = opIn.cookie!;
    const opMe = await call("GET", "/api/me", { cookie: op });
    t.ok("an operator outside support mode opens no company (act as only in support)", opMe.status === 200 && (opMe.data.companies as unknown[]).length === 0);
    t.ok("an operator cannot open the demo company outside support mode", (await call("GET", `/api/c/${ENTITY}/home`, { cookie: op })).status === 404);

    // Lockout is per name and address, never install-wide.
    for (let i = 0; i < 5; i++) await call("POST", "/session", { body: { name: "opsy", key: `nope-nope-${i}` }, ip: "203.0.113.5" });
    const lockedHere = await call("POST", "/session", { body: { name: "opsy", key: OP_PASS }, ip: "203.0.113.5" });
    t.ok("five wrong tries lock that name from that address", lockedHere.status === 429, lockedHere.data.error);
    const elsewhere = await call("POST", "/session", { body: { name: "opsy", key: OP_PASS }, ip: "203.0.113.77" });
    t.ok("the correct password from another address still signs in", elsewhere.status === 200);
    await Promise.all(Array.from({ length: 32 }, (_, i) => call("POST", "/session", { body: { name: `madeup${i}`, key: "whatever-123" }, ip: `192.0.2.${i + 10}` })));
    const afterFlood = await call("POST", "/session", { body: { name: "opsy", key: OP_PASS }, ip: "198.51.100.3" });
    t.ok("32 wrong tries under made-up names lock out nobody real", afterFlood.status === 200);
    t.ok("wrong tries are counted in the database (a restart keeps them), by hashed key only",
      (await db<{ n: number }>(`select count(*)::int n from platform_signin_attempt`))[0].n > 30
      && (await db(`select 1 from platform_signin_attempt where key_hash like '%opsy%' or key_hash like '%203.0.113%'`)).length === 0);
    // Behind Cloudflare and Render: x-forwarded-for is "client, edge", the edge shared by many clients.
    process.env.ERP_TRUSTED_PROXY_HOPS = "2";
    try {
      const EDGE = "104.16.0.1";
      for (let i = 0; i < 5; i++) await call("POST", "/session", { body: { name: "opsy", key: `nope-edge-${i}` }, ip: `198.51.100.71, ${EDGE}` });
      const a1 = await call("POST", "/session", { body: { name: "opsy", key: OP_PASS }, ip: `198.51.100.71, ${EDGE}` });
      const a2 = await call("POST", "/session", { body: { name: "opsy", key: OP_PASS }, ip: `198.51.100.72, ${EDGE}` });
      t.ok("two clients behind the same edge do not lock each other out", a1.status === 429 && a2.status === 200, `${a1.status} ${a2.status}`);
      const spoof = await call("POST", "/session", { body: { name: "opsy", key: OP_PASS }, ip: `1.2.3.4, 198.51.100.71, ${EDGE}` });
      t.ok("and a client cannot dodge its lock by writing its own x-forwarded-for entry", spoof.status === 429);
    } finally { process.env.ERP_TRUSTED_PROXY_HOPS = "1"; }
    const { clientIp } = await import("../../server/client_ip.ts");
    const fake = (h: Record<string, string>) => ({ headers: h, socket: { remoteAddress: "10.0.0.9" } }) as unknown as import("node:http").IncomingMessage;
    process.env.ERP_CLIENT_IP_HEADER = "cf-connecting-ip";
    t.ok("cf-connecting-ip is used when ERP_CLIENT_IP_HEADER says so", clientIp(fake({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "5.5.5.5, 104.16.0.1" }), 2) === "203.0.113.9"
      && clientIp(fake({ "x-forwarded-for": "203.0.113.8, 104.16.0.1" }), 2) === "203.0.113.8" && clientIp(fake({ "x-forwarded-for": "203.0.113.7" }), 2) === "203.0.113.7");
    delete process.env.ERP_CLIENT_IP_HEADER;
    const savedRender = process.env.RENDER, savedHops = process.env.ERP_TRUSTED_PROXY_HOPS;
    delete process.env.ERP_TRUSTED_PROXY_HOPS; process.env.RENDER = "true";
    const onRender = clientIp(fake({ "x-forwarded-for": "203.0.113.6, 104.16.0.1" }));
    delete process.env.RENDER;
    const offRender = clientIp(fake({ "x-forwarded-for": "203.0.113.6, 104.16.0.1" }));
    if (savedRender !== undefined) process.env.RENDER = savedRender;
    process.env.ERP_TRUSTED_PROXY_HOPS = savedHops;
    t.ok("defaults: two hops on Render, the socket elsewhere", onRender === "203.0.113.6" && offRender === "10.0.0.9", `${onRender} ${offRender}`);

    // ------------------------------------------------------------ customers
    const before = await db<{ n: number }>(`select count(*)::int n from tenant`);
    const mk = (n: string, email: string, pack: string) => call("POST", "/api/platform/customers",
      { cookie: op, body: { tenantName: n, legalName: `${n} LLC`, state: "TX", pack, ownerName: `${n} Owner`, ownerEmail: email, plan: "standard" } });
    const A = await mk("Alpha Home", "owner@alpha.example", "furniture");
    t.ok("an operator creates a customer", A.status === 200 && !!A.data.inviteLink, A.data.error);
    const B = await mk("Bravo Goods", "owner@bravo.example", "retail");
    t.ok("and a second one", B.status === 200, B.data.error);
    const aT = A.data.tenantId as string, aE = A.data.entityId as string, bT = B.data.tenantId as string, bE = B.data.entityId as string;
    t.ok("each customer is its own new tenant", (await db<{ n: number }>(`select count(*)::int n from tenant`))[0].n === before[0].n + 2 && aT !== bT);
    const kind = await db<{ kind: string; plan: string }>(`select kind, plan from tenant where id = $1`, [aT]);
    t.ok("the new tenant is a customer, not the demo", kind[0].kind === "customer");
    const pack = await db<{ n: number }>(`select count(*)::int n from pack_application where entity_id = $1 and pack = 'furniture'`, [aE]);
    const mods = await db<{ n: number }>(`select count(*)::int n from entity_module where entity_id = $1 and enabled`, [aE]);
    t.ok("the chosen setup pack is applied (services on)", pack[0].n === 1 && mods[0].n > 3, `${mods[0].n} services`);
    const clean = await db<Record<string, number>>(`select
        (select count(*) from product where entity_id = $1)::int products, (select count(*) from customer where entity_id = $1)::int customers,
        (select count(*) from sales_order where entity_id = $1)::int orders, (select count(*) from vendor_entity where entity_id = $1)::int vendors,
        (select count(*) from journal_entry where entity_id = $1)::int entries, (select count(*) from invoice where entity_id = $1)::int bills,
        (select count(*) from app_user where tenant_id = $2)::int people`, [aE, aT]);
    t.ok("a new customer starts clean: no products, customers, orders, vendors, entries or bills, one person",
      !clean[0].products && !clean[0].customers && !clean[0].orders && !clean[0].vendors && !clean[0].entries && !clean[0].bills && clean[0].people === 1, JSON.stringify(clean[0]));
    const invited = await db<{ purpose: string; body: string }>(`select purpose, body from outbound_message where entity_id = $1 and purpose = 'platform_invite'`, [aE]);
    t.ok("the invite is logged (no email connected) with its token redacted",
      invited.length === 1 && !invited[0].body.includes(tokenOf(A.data.inviteLink as string)) && invited[0].body.includes("******"));

    // ------------------------------------------------- invite, password, sign in
    const aTok = tokenOf(A.data.inviteLink as string);
    const info = await call("GET", `/account/token?t=${aTok}`);
    t.ok("the invite link names the account", info.status === 200 && info.data.email === "owner@alpha.example" && info.data.purpose === "invite");
    const weak = await call("POST", "/account/accept", { body: { token: aTok, password: "short" } });
    t.ok("a password under 10 characters is refused", weak.status === 409 && /at least 10/.test(weak.data.error ?? ""));
    const accept = await call("POST", "/account/accept", { body: { token: aTok, password: "alpha-owner-pass", name: "Alice Alpha" } });
    t.ok("accepting the invite sets the password and signs in", accept.status === 200 && !!accept.cookie);
    t.ok("an invite link works once", (await call("POST", "/account/accept", { body: { token: aTok, password: "another-pass-1" } })).status === 409);
    const stored = await db<{ pw_hash: string }>(`select pw_hash from platform_login where email = 'owner@alpha.example'`);
    t.ok("the password is kept as a salted scrypt hash", /^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{86}$/.test(stored[0].pw_hash) && !stored[0].pw_hash.includes("alpha-owner"));
    const aIn = await call("POST", "/session", { body: { email: "OWNER@alpha.example", password: "alpha-owner-pass" } });
    t.ok("the owner signs in with email and password", aIn.status === 200 && aIn.data.kind === "customer");
    const aOwner = aIn.cookie!;
    const aMe = await call("GET", "/api/me", { cookie: aOwner });
    const aCos = aMe.data.companies as { id: string }[];
    t.ok("a customer sees only their own tenant's companies", aCos.length === 1 && aCos[0].id === aE && aMe.data.defaultCompany === aE);
    t.ok("and is the owner of their account", (aMe.data.viewer as { owner: boolean }).owner === true);
    t.ok("their own company opens", (await call("GET", `/api/c/${aE}/home`, { cookie: aOwner })).status === 200);
    const bAcc = await call("POST", "/account/accept", { body: { token: tokenOf(B.data.inviteLink as string), password: "bravo-owner-pass" } });
    const bOwner = bAcc.cookie!;

    // A second person in Alpha, invited by the owner.
    const inv = await call("POST", "/api/tenant/users", { cookie: aOwner, body: { name: "Sam Sales", email: "sam@alpha.example", entityId: aE, roles: ["sales"] } });
    t.ok("the owner invites someone with a role; with no email connected the link is not shown to the owner",
      inv.status === 200 && !inv.data.inviteLink && /not connected/.test(String(inv.data.note)), inv.data.error);
    const tokenFor = (email: string, purpose: "invite" | "reset" | "code") => t.pool.connect().then(async (c) => {
      try { const l = (await P.loginByEmail(c, email))!; return (await P.issueToken(c, l, purpose, "check")).token; } finally { c.release(); }
    });
    const samIn = await call("POST", "/account/accept", { body: { token: await tokenFor("sam@alpha.example", "invite"), password: "sam-sales-pass" } });
    const sam = samIn.cookie!;
    const samId = inv.data.userId as string;
    const ownerId = (aMe.data.viewer as { personId: string }).personId;
    const inviteOther = await call("POST", "/api/tenant/users", { cookie: aOwner, body: { name: "X", email: "x@x.example", entityId: bE, roles: ["sales"] } });
    t.ok("an owner cannot invite someone into another tenant's company", inviteOther.status === 409);
    // An address that signs in to another customer: the owner's answer is the same as for a new address.
    const fresh = await call("POST", "/api/tenant/users", { cookie: aOwner, body: { name: "Nina New", email: "nina@alpha.example", entityId: aE, roles: ["viewer"] } });
    const clash = await call("POST", "/api/tenant/users", { cookie: aOwner, body: { name: "Bob Bravo", email: "owner@bravo.example", entityId: aE, roles: ["viewer"] } });
    const keys = (r: Res) => Object.keys(r.data).filter((k) => k !== "userId").sort().join(",") + "|" + String(r.data.note);
    t.ok("inviting another customer's email reveals nothing: same answer as a new address", clash.status === 200 && keys(clash) === keys(fresh), `${keys(clash)} vs ${keys(fresh)}`);
    t.ok("no sign-in is made for it, and the clash is on the platform log for the ERP team",
      (await db(`select 1 from platform_login where email = 'owner@bravo.example' and tenant_id = $1`, [aT])).length === 0
      && (await db(`select 1 from platform_audit where tenant_id = $1 and action = 'user.invite_conflict'`, [aT])).length === 1);
    const listed = (await call("GET", "/api/tenant/users", { cookie: aOwner })).data as unknown as { email: string; status: string }[];
    t.ok("both read as invited in the owner's list", listed.filter((u) => ["nina@alpha.example", "owner@bravo.example"].includes(u.email)).every((u) => u.status === "invited")
      && listed.filter((u) => ["nina@alpha.example", "owner@bravo.example"].includes(u.email)).length === 2);
    const opClash = await call("POST", `/api/platform/customers/${aT}/users`, { cookie: op, body: { name: "Bob Bravo", email: "owner@bravo.example", entityId: aE, roles: ["viewer"] } });
    t.ok("the ERP team is told plainly", opClash.status === 409 && /another customer/.test(opClash.data.error ?? ""));
    t.ok("a non-owner cannot manage sign-ins", (await call("GET", "/api/tenant/users", { cookie: sam })).status === 403);

    // --------------------------------------------------------------- lockout
    for (let i = 0; i < 5; i++) await call("POST", "/session", { body: { email: "sam@alpha.example", password: `wrong-pass-${i}` }, ip: "10.9.9.9" });
    const samLocked = await call("POST", "/session", { body: { email: "sam@alpha.example", password: "sam-sales-pass" }, ip: "10.9.9.9" });
    t.ok("five wrong passwords lock the sign-in for 15 minutes", samLocked.status === 429, samLocked.data.error);
    const unknown = await call("POST", "/session", { body: { email: "nobody@nowhere.example", password: "whatever-123" }, ip: "10.9.9.8" });
    t.ok("an unknown email reads the same as a wrong password", unknown.status === 401 && unknown.data.error === "that email and password did not match");

    // -------------------------------------------------------------- reset
    const forgot = await call("POST", "/account/forgot", { body: { email: "sam@alpha.example" } });
    const forgotNone = await call("POST", "/account/forgot", { body: { email: "nobody@nowhere.example" } });
    t.ok("forgot-password answers alike for known and unknown emails", forgot.status === 200 && forgotNone.status === 200 && forgot.data.note === forgotNone.data.note);
    const resetMail = await db<{ body: string }>(`select body from outbound_message where purpose = 'platform_reset' and to_addr = 'sam@alpha.example'`);
    t.ok("the reset email is logged with its link redacted", resetMail.length === 1 && resetMail[0].body.includes("******") && !/#reset=[\w-]{20}/.test(resetMail[0].body));
    // The token itself only exists in the email; issue one the same way to follow the link.
    const issued = await t.pool.connect().then(async (c) => {
      try { const l = (await P.loginByEmail(c, "sam@alpha.example"))!; return (await P.issueToken(c, l, "reset", "check")).token; } finally { c.release(); }
    });
    const reset = await call("POST", "/account/reset", { body: { token: issued, password: "sam-new-pass-22" }, ip: "10.9.9.9" });
    t.ok("a reset link sets a new password and signs in", reset.status === 200 && !!reset.cookie);
    t.ok("the old session ended with the reset", (await call("GET", "/api/me", { cookie: sam })).status === 401);
    const samAgain = await call("POST", "/session", { body: { email: "sam@alpha.example", password: "sam-new-pass-22" }, ip: "10.9.9.9" });
    t.ok("and the new password works (the lock cleared)", samAgain.status === 200);
    const samC = samAgain.cookie!;
    // An emailed sign-in code.
    const codeReq = await call("POST", "/session/code", { body: { email: "sam@alpha.example" }, ip: "10.9.9.7" });
    t.ok("a sign-in code can be asked for", codeReq.status === 200);
    const code = await tokenFor("sam@alpha.example", "code");
    t.ok("a wrong code is refused", (await call("POST", "/session", { body: { email: "sam@alpha.example", code: "000000" === code ? "111111" : "000000" }, ip: "10.9.9.6" })).status === 401);
    t.ok("the emailed code signs in", (await call("POST", "/session", { body: { email: "sam@alpha.example", code }, ip: "10.9.9.6" })).status === 200);
    // A day's cap per sign-in, whatever address the tries come from.
    for (let i = 0; i < 10; i++) {
      await tokenFor("sam@alpha.example", "code");
      await call("POST", "/session", { body: { email: "sam@alpha.example", code: "000001" }, ip: `10.8.${i}.1` });
    }
    const cap = await tokenFor("sam@alpha.example", "code");
    const capped = await call("POST", "/session", { body: { email: "sam@alpha.example", code: cap }, ip: "10.8.99.1" });
    t.ok("after 10 wrong codes in a day, codes stop working for that sign-in (the password still does)", capped.status === 429
      && (await call("POST", "/session", { body: { email: "sam@alpha.example", password: "sam-new-pass-22" }, ip: "10.8.99.2" })).status === 200, capped.data.error);
    // 3 codes per 15 minutes, 5 a day. The quarter-hour brake is cleared here to reach the day's cap.
    const { createHash } = await import("node:crypto");
    const brake = (k: string) => createHash("sha256").update(`erp/brake/${k}`).digest("hex");
    let asked = 0, why = "";
    for (let i = 0; i < 6; i++) {
      const r = await call("POST", "/session/code", { body: { email: "nina@alpha.example" }, ip: `10.7.${i}.1` });
      if (r.status === 200) asked++; else why = r.data.error ?? "";
      await db(`delete from platform_signin_attempt where key_hash = $1`, [brake("r:code:nina@alpha.example")]);
    }
    t.ok("at most 5 codes a day are sent for one sign-in", asked === 5 && /in a day/.test(why), `${asked} ${why}`);

    // ----------------------------------------------------- tenant isolation
    const ROUTES = routeList().filter((r) => r.auth === "token" && r.path.source.startsWith("^\\/api\\/c\\/"));
    const CANDS = ["00000000-0000-4000-8000-000000000001", "1010", "abc", "x", "1", "pos", "a-b", "ABC1", "zpl", "store.js"];
    const sample = (inner: string) => {
      const alts = splitTop(inner, "|");
      for (const cand of [...CANDS, ...alts.map(unescape)]) { try { if (new RegExp(`^(?:${inner})$`).test(cand)) return cand; } catch { return null; } }
      return null;
    };
    const pathFor = (re: RegExp, co: string) => {
      const src = re.source.replace(/^\^/, "").replace(/\$$/, "");
      let out = "", i = 0, first = true;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") { out += src[i + 1]; i += 2; continue; }
        if (ch === "(") {
          let depth = 0, j = i;
          for (; j < src.length; j++) { if (src[j] === "\\") { j++; continue; } if (src[j] === "(") depth++; if (src[j] === ")" && --depth === 0) break; }
          let inner = src.slice(i + 1, j);
          if (inner.startsWith("?:")) inner = inner.slice(2);
          const optional = src[j + 1] === "?";
          const v = first ? co : optional ? "" : sample(inner);
          first = false;
          if (v === null) return null;
          out += v; i = j + 1 + (optional ? 1 : 0); continue;
        }
        if (ch === "?") { out = out.slice(0, -1); i++; continue; }
        out += ch; i++;
      }
      return re.test(out) ? out : null;
    };
    let tried = 0, leaked: string[] = [], skipped = 0;
    for (const r of ROUTES) {
      for (const [who, target] of [["B's company", bE], ["the demo company", ENTITY]] as const) {
        const p = pathFor(r.path, target);
        if (!p) { skipped++; continue; }
        const res = await call(r.method, p, { cookie: aOwner, body: r.method === "POST" ? {} : undefined });
        tried++;
        if (!(res.status === 404 && res.data.error === "no such company")) leaked.push(`${r.method} ${p} (${who}) -> ${res.status} ${res.data.error ?? ""}`);
      }
    }
    t.ok(`a customer is refused every company route of another tenant (${tried} requests over ${ROUTES.length} routes)`, tried > 600 && !leaked.length, leaked.slice(0, 5).join("; ") + (skipped ? ` skipped ${skipped}` : ""));
    let ownOk = 0;
    for (const tail of ["/home", "/people", "/setup/modules", "/options", "/books/trial-balance"]) if ((await call("GET", `/api/c/${aE}${tail}`, { cookie: aOwner })).status === 200) ownOk++;
    t.ok("while the same routes open for their own company", ownOk === 5, `${ownOk}/5`);
    const clients = await call("GET", "/api/clients", { cookie: aOwner });
    t.ok("the client list shows only their own tenant", (clients.data as unknown as { id: string }[]).length === 1 && (clients.data as unknown as { id: string }[])[0].id === aT);
    t.ok("install-wide feed routes refuse another tenant's company", (await call("GET", `/api/overview?co=${bE}`, { cookie: aOwner })).status === 404
      && (await call("GET", `/api/intake?co=${ENTITY}`, { cookie: aOwner })).status === 404);
    const conn = await db<{ id: string }>(`select id from connection where entity_id = $1 and channel = 'manual_upload' limit 1`, [ENTITY]);
    if (conn.length) t.ok("another tenant's feed connection reads as not there", (await call("POST", `/api/connections/${conn[0].id}/upload?filename=x.txt`, { cookie: aOwner, body: "x" })).status === 404);
    const addCo = await call("POST", "/api/companies", { cookie: aOwner, body: { clientId: bT, name: "Sneaky", legalName: "Sneaky LLC", people: [{ name: "Al Alpha", email: "a@a.example", roles: ["owner"] }],
      setup: "pack:retail", stores: [{ code: "SNK", name: "Sneaky store", state: "TX" }], banks: [{ purpose: "operating", name: "Operating", bankName: "First Bank", routingLast4: "1234", accountLast4: "5678" }] } });
    const landed = await db<{ tenant_id: string }>(`select tenant_id from entity where name = 'Sneaky'`);
    t.ok("adding a company always lands in the owner's own tenant", addCo.status === 200 && landed.length === 1 && landed[0].tenant_id === aT, addCo.data.error);
    t.ok("a customer cannot use the Operator console", (await call("GET", "/api/platform/customers", { cookie: aOwner })).status === 403);

    // --------------------------------------------------------- acting as
    t.ok("a customer cannot act as someone else (read)", (await call("GET", `/api/c/${aE}/home`, { cookie: samC, as: ownerId })).status === 403);
    t.ok("a customer cannot act as someone else (write)", (await call("POST", `/api/c/${aE}/setup/stores`, { cookie: samC, as: ownerId, body: { code: "X1", name: "X" } })).status === 403);
    const rioPerson = await db<{ id: string }>(`select id from app_user where tenant_id = $1 limit 1`, [RIO_TENANT]);
    t.ok("or as another tenant's person", (await call("GET", `/api/c/${aE}/home`, { cookie: samC, as: rioPerson[0].id })).status === 403);
    const samAs = await call("POST", `/api/c/${aE}/setup/stores`, { cookie: samC, body: { code: "SAM1", name: "Sam's store" } });
    t.ok("a change is done as the signed-in person, with their roles", samAs.status === 409 && /owner/.test(samAs.data.error ?? ""), samAs.data.error);

    // ------------------------------------------------------ owner preview
    t.ok("an owner may preview one of their people (read)", (await call("GET", `/api/c/${aE}/home`, { cookie: aOwner, as: samId })).status === 200);
    const pw = await call("POST", `/api/c/${aE}/setup/stores`, { cookie: aOwner, as: samId, body: { code: "PV1", name: "Preview" } });
    t.ok("a preview is read-only", pw.status === 403 && /read-only/.test(pw.data.error ?? ""));
    t.ok("an owner cannot preview someone outside their tenant", (await call("GET", `/api/c/${aE}/home`, { cookie: aOwner, as: rioPerson[0].id })).status === 403);
    const demoOwner = "55555555-0000-0000-0000-000000000001";
    t.ok("nor preview into another tenant's company", (await call("GET", `/api/c/${ENTITY}/home`, { cookie: aOwner, as: demoOwner })).status === 404);
    const asSelf = await call("POST", `/api/c/${aE}/setup/stores`, { cookie: aOwner, body: { code: "OWN1", name: "Owner's store" } });
    t.ok("the owner's own changes go through as themselves", asSelf.status === 200, asSelf.data.error);

    // ---------------------------------------------------------- support mode
    t.ok("support mode needs a reason", (await call("POST", `/api/platform/customers/${aT}/support`, { cookie: op, body: {} })).status === 409);
    const sup = await call("POST", `/api/platform/customers/${aT}/support`, { cookie: op, body: { reason: "ticket 42: cannot see the store" } });
    t.ok("an operator enters a customer in support mode", sup.status === 200 && !!sup.cookie);
    op = sup.cookie!;
    const supMe = await call("GET", "/api/me", { cookie: op });
    t.ok("support mode shows on /api/me (the banner) and opens only that tenant",
      (supMe.data.viewer as { support: { tenantId: string } }).support?.tenantId === aT && (supMe.data.companies as { id: string }[]).every((x) => x.id !== bE && x.id !== ENTITY));
    t.ok("in support mode the customer's company opens, as their person", (await call("GET", `/api/c/${aE}/home`, { cookie: op, as: ownerId })).status === 200);
    t.ok("but no other tenant's", (await call("GET", `/api/c/${bE}/home`, { cookie: op })).status === 404);
    const supWrite = await call("POST", `/api/c/${aE}/setup/stores`, { cookie: op, as: ownerId, body: { code: "SUP1", name: "Support store" } });
    t.ok("an operator may act as a person in support mode", supWrite.status === 200, supWrite.data.error);
    const logged = await db<{ action: string; actor: string }>(`select action, actor from platform_audit where tenant_id = $1 and action like 'support.%' order by id`, [aT]);
    t.ok("support mode is recorded: the start and each change, with the operator's name",
      logged.some((x) => x.action === "support.start" && x.actor === "opsy") && logged.some((x) => x.action === "support.write"));
    const trail = await db<{ actor_label: string }>(`select actor_label from audit_event where tenant_id = $1 and table_name = 'profit_object' order by id desc limit 1`, [aT]);
    t.ok("and the change itself carries 'opsy (support) as' in the audit trail", /opsy \(support\) as /.test(trail[0]?.actor_label ?? ""), trail[0]?.actor_label);
    const ended = await call("POST", "/api/platform/support/end", { cookie: op, body: {} });
    op = ended.cookie!;
    t.ok("leaving support mode is recorded and closes the tenant again",
      (await db(`select 1 from platform_audit where tenant_id = $1 and action = 'support.end'`, [aT])).length === 1 && (await call("GET", `/api/c/${aE}/home`, { cookie: op })).status === 404);
    t.ok("platform_audit cannot be changed", await db(`delete from platform_audit where tenant_id = $1`, [aT]).then(() => false, () => true));

    // ------------------------------------------------------------- tokens
    const mkTok = await call("POST", "/api/tenant/tokens", { cookie: aOwner, body: { name: "Catalog app" } });
    const tok = mkTok.data.token as string;
    t.ok("an owner makes an API token, shown once", mkTok.status === 200 && /^erpt_[\w-]{40,}$/.test(tok));
    const row = await db<{ token_hash: string; prefix: string }>(`select token_hash, prefix from platform_api_token where id = $1`, [mkTok.data.id]);
    t.ok("only its hash is stored", row[0].token_hash.length === 64 && row[0].token_hash !== tok && !JSON.stringify(row).includes(tok));
    t.ok("the list never shows the token again", !JSON.stringify((await call("GET", "/api/tenant/tokens", { cookie: aOwner })).data).includes(tok));
    t.ok("the token opens its own tenant", (await call("GET", `/api/c/${aE}/people`, { bearer: tok })).status === 200);
    let tokLeak = 0, tokTried = 0;
    for (const r of ROUTES.filter((x) => x.method === "GET").slice(0, 120)) {
      const p = pathFor(r.path, bE);
      if (!p) continue;
      tokTried++;
      const res = await call("GET", p, { bearer: tok });
      if (res.status !== 404) tokLeak++;
    }
    t.ok(`the token is refused other tenants' companies (${tokTried} routes)`, tokTried > 50 && !tokLeak);
    t.ok("the token cannot act as another tenant's person", (await call("POST", `/api/c/${aE}/setup/stores`, { bearer: tok, as: rioPerson[0].id, body: { code: "T1", name: "T" } })).status === 403);
    t.ok("nor reach the Operator console", (await call("GET", "/api/platform/customers", { bearer: tok })).status === 403);
    const rot = await call("POST", `/api/tenant/tokens/${mkTok.data.id}/rotate`, { cookie: aOwner, body: {} });
    t.ok("rotating gives a new token and ends the old one", rot.status === 200 && (await call("GET", `/api/c/${aE}/people`, { bearer: tok })).status === 401
      && (await call("GET", `/api/c/${aE}/people`, { bearer: rot.data.token as string })).status === 200);
    await call("POST", `/api/tenant/tokens/${rot.data.id}/revoke`, { cookie: aOwner, body: {} });
    t.ok("a revoked token is refused", (await call("GET", `/api/c/${aE}/people`, { bearer: rot.data.token as string })).status === 401);
    const tok2 = (await call("POST", "/api/tenant/tokens", { cookie: aOwner, body: { name: "Second" } })).data.token as string;

    // --------------------------------------------------------- suspension
    t.ok("suspending needs a reason", (await call("POST", `/api/platform/customers/${aT}/suspend`, { cookie: op, body: {} })).status === 409);
    const susp = await call("POST", `/api/platform/customers/${aT}/suspend`, { cookie: op, body: { reason: "unpaid invoice" } });
    t.ok("an operator suspends a customer", susp.status === 200);
    const RD = await import("../run-due.ts");
    const crmRun = await RD.runDueCrm(new Date());
    t.ok("the scheduler skips a suspended customer's companies", !crmRun.some((r) => r.entityId === aE) && crmRun.some((r) => r.entityId === bE));
    const susIn = await call("POST", "/session", { body: { email: "owner@alpha.example", password: "alpha-owner-pass" } });
    t.ok("a suspended customer cannot sign in, and is told why", susIn.status === 403 && /suspended/.test(susIn.data.error ?? ""));
    t.ok("their open sessions end", (await call("GET", "/api/me", { cookie: aOwner })).status === 401);
    t.ok("their API tokens stop working", (await call("GET", `/api/c/${aE}/people`, { bearer: tok2 })).status === 401);
    t.ok("their data is kept", (await db(`select 1 from entity where id = $1`, [aE])).length === 1);
    t.ok("another customer is untouched", (await call("GET", `/api/c/${bE}/home`, { cookie: bOwner })).status === 200);
    await call("POST", `/api/platform/customers/${aT}/reactivate`, { cookie: op, body: {} });
    t.ok("reactivated, they sign in again", (await call("POST", "/session", { body: { email: "owner@alpha.example", password: "alpha-owner-pass" } })).status === 200);

    // ---------------------------------------------------- the review's items
    const hook = await db<{ source_code: string }>(`select source_code from source_channel where channel = 'webhook' limit 1`);
    if (hook.length) {
      const nc = await db<{ id: string }>(`insert into connection (tenant_id, entity_id, source_code, channel, name, credential_ref, status)
          values ($1, null, $2, 'webhook', 'No company hook', 'secret://test/nocompany', 'active') returning id`, [TENANT, hook[0].source_code]);
      const h = await fetch(`${base}/hooks/${nc[0].id}`, { method: "POST", body: "{}" });
      const hb = await h.json();
      t.ok("a feed connection with no company is refused, not filed into the first company", h.status === 409 && /not attached to a company/.test(hb.error), hb.error);
    }
    t.ok("the request log hides link tokens", logPath("/sheet/AbCdEf0123456789xyzQ_k") === "/sheet/[token]" && logPath("/crm/u/Zx9_-abcdefghijklmnopq") === "/crm/u/[token]"
      && logPath("/delivery/schedule/abcDEF1234567890ghijKL") === "/delivery/schedule/[token]" && logPath(`/api/c/${ENTITY}/bills`) === `/api/c/${ENTITY}/bills` && logPath("/trade/buddys/api/orders") === "/trade/buddys/api/orders"
      && logPath("/sheet/abcdefghijklmnopqrstuvwx") === "/sheet/[token]" && logPath("/x/AbCdEfGhIjKlMnOpQrSt") === "/x/[token]"
      && logPath(`/api/c/${ENTITY}/payroll/periods/${ENTITY}/approve-timecards`) === `/api/c/${ENTITY}/payroll/periods/${ENTITY}/approve-timecards`);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try { await fetch(`${base}/sheet/SeCrEt0123456789abcdefXYZ`); } finally { console.log = orig; }
    t.ok("a live tear-sheet request is logged without its secret", lines.some((l) => l.includes("/sheet/[token]")) && !lines.some((l) => l.includes("SeCrEt0123456789")));

    // ------------------------------------------------------------ prospects
    const pr = await call("POST", "/api/platform/prospects", { cookie: op, body: { name: "Pat Prospect", email: "pat@prospect.example", days: 1 } });
    t.ok("an operator makes a time-limited demo sign-in", pr.status === 200 && typeof pr.data.password === "string");
    const prIn = await call("POST", "/session", { body: { email: "pat@prospect.example", password: pr.data.password } });
    const prMe = await call("GET", "/api/me", { cookie: prIn.cookie });
    t.ok("the prospect sees the demo and nothing else", prIn.status === 200 && (prMe.data.companies as { tenant_id: string }[]).every((x) => x.tenant_id === TENANT)
      && (prMe.data.companies as unknown[]).length > 0 && (await call("GET", `/api/c/${aE}/home`, { cookie: prIn.cookie })).status === 404);
    t.ok("a prospect cannot manage the demo's sign-ins", (await call("GET", "/api/tenant/users", { cookie: prIn.cookie })).status === 403);
    const pr2 = await call("POST", "/api/platform/prospects", { cookie: op, body: { name: "Quinn Prospect", email: "quinn@prospect.example", days: 1 } });
    const q2 = (await call("POST", "/session", { body: { email: "quinn@prospect.example", password: pr2.data.password } })).cookie;
    const ppl = (await call("GET", `/api/c/${ENTITY}/people`, { cookie: q2 })).data as unknown as { name: string }[];
    t.ok("a prospect sees themselves in the people list but not other prospects", ppl.some((p) => /Quinn/.test(p.name)) && !ppl.some((p) => /Pat Prospect/.test(p.name)));
    const ro = await call("POST", `/api/c/${ENTITY}/setup/stores`, { cookie: q2, body: { code: "PRS1", name: "Prospect store" } });
    t.ok("a prospect's demo sign-in is look-only", ro.status === 403 && /look at everything/.test(ro.data.error ?? ""), ro.data.error);
    const patId = (await db<{ app_user_id: string }>(`select app_user_id from platform_login where email = 'pat@prospect.example'`))[0].app_user_id;
    t.ok("and cannot act as another prospect", (await call("GET", `/api/c/${ENTITY}/home`, { cookie: q2, as: patId })).status === 403);
    const jobs0 = (await db<{ n: number }>(`select count(*)::int n from label_print_job where entity_id = $1`, [ENTITY]))[0].n;
    const sku = (await db<{ sku: string }>(`select sku from product where entity_id = $1 and status = 'active' order by sku limit 1`, [ENTITY]))[0]?.sku;
    const lbl = await fetch(`${base}/api/c/${ENTITY}/labels/print?source=tags&skus=${encodeURIComponent(sku ?? "x")}`, { headers: { cookie: q2!, "x-erp-page": "1" } });
    const jobs1 = (await db<{ n: number }>(`select count(*)::int n from label_print_job where entity_id = $1`, [ENTITY]))[0].n;
    t.ok("a look-only label print page writes nothing", lbl.status === 200 && jobs1 === jobs0, `${lbl.status} ${jobs0}->${jobs1}`);

    // ------------------------------------------------------------ demo reset
    const scopedTables = await db<{ t: string; col: string }>(`select table_name t, column_name col from information_schema.columns
        where table_schema = current_schema() and column_name in ('entity_id','tenant_id') and table_name not in ('audit_event','platform_audit')
          and table_name in (select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE')`);
    const census = async () => {
      const out: Record<string, number> = {};
      for (const { t: tb, col } of scopedTables) {
        const ids = col === "tenant_id" ? [aT, bT] : [aE, bE, ...(await db<{ id: string }>(`select id from entity where tenant_id = $1`, [aT])).map((x) => x.id)];
        out[`${tb}.${col}`] = (await db<{ n: number }>(`select count(*)::int n from "${tb}" where ${col} = any($1::uuid[])`, [ids]))[0].n;
      }
      return out;
    };
    const pre = await census();
    await db(`insert into customer (entity_id, number, name) values ($1, 'SCRATCH-1', 'Scratch Marker')`, [ENTITY]);
    const marker = await db(`select 1 from customer where entity_id = $1 and name = 'Scratch Marker'`, [ENTITY]);
    t.ok("refused without the typed confirmation", (await call("POST", "/api/platform/demo/reset", { cookie: op, body: {} })).status === 400);
    t.ok("a customer cannot reset the demo", (await call("POST", "/api/platform/demo/reset", { cookie: bOwner, body: { confirm: "RESET DEMO" } })).status === 403);
    const rs = await call("POST", "/api/platform/demo/reset", { cookie: op, body: { confirm: "RESET DEMO" } });
    t.ok("an operator resets the demo", rs.status === 200 && (rs.data.rowsRemoved as number) > 100, rs.data.error ?? `${rs.data.rowsRemoved} rows, ${rs.data.ms} ms`);
    const post = await census();
    const changed = Object.keys(pre).filter((k) => pre[k] !== post[k]);
    t.ok(`the reset leaves every other tenant's rows as they were (${Object.keys(pre).length} tables counted)`, !changed.length, changed.slice(0, 5).join(", "));
    t.ok("the demo's own scratch rows are gone and its sample data is back",
      marker.length === 1 && !(await db(`select 1 from customer where entity_id = $1 and name = 'Scratch Marker'`, [ENTITY])).length
      && (await db<{ n: number }>(`select count(*)::int n from product where entity_id = $1`, [ENTITY]))[0].n > 10
      && (await db(`select 1 from entity where id = $1`, [RIO_ENTITY])).length === 1);
    t.ok("the demo tenants are still the demo", (await db<{ kind: string }>(`select kind from tenant where id = any($1::uuid[])`, [[TENANT, RIO_TENANT]])).every((x) => x.kind === "demo"));
    t.ok("Alpha's people still sign in after the reset", (await call("POST", "/session", { body: { email: "sam@alpha.example", password: "sam-new-pass-22" }, ip: "10.1.1.1" })).status === 200);
    const prAgain = await call("POST", "/session", { body: { email: "pat@prospect.example", password: pr.data.password } });
    t.ok("a prospect's demo sign-in is kept across the reset", prAgain.status === 200);
    t.ok("the demo companies keep their setup checklist dismissed after a reset (a trading business)",
      (await db(`select 1 from onboarding_dismissal where entity_id = $1 and withdrawn_at is null`, [ENTITY])).length === 1);
    t.ok("the reset is on the platform log", (await db(`select 1 from platform_audit where action = 'demo.reset' and actor = 'opsy'`)).length === 1);
    const dupMail = await db(`insert into connection (tenant_id, entity_id, source_code, channel, name, config, allowed_senders, status)
        select tenant_id, entity_id, source_code, channel, 'Duplicate mailbox', config, allowed_senders, 'active' from connection where channel = 'email' and status = 'active' limit 1`).then(() => false, (e) => /connection_email_mailbox_key/.test(e.message));
    t.ok("two live email connections cannot share a mailbox address", dupMail);
    t.ok("a demo cannot be suspended", (await call("POST", `/api/platform/customers/${TENANT}/suspend`, { cookie: op, body: { reason: "testing it" } })).status === 409);

    // A prospect's sign-in ends on time.
    await db(`update platform_login set expires_at = now() - interval '1 minute' where email = 'pat@prospect.example'`);
    const late = await call("POST", "/session", { body: { email: "pat@prospect.example", password: pr.data.password } });
    t.ok("an expired prospect sign-in is refused, saying so", late.status === 403 && /expired/.test(late.data.error ?? ""));
    t.ok("and an open session of theirs ends", (await call("GET", "/api/me", { cookie: prAgain.cookie })).status === 401);

    // The system token still opens anything (scripts), and the old operator flow still works.
    t.ok("the install-wide ERP_API_TOKEN still works for scripts", (await call("GET", `/api/c/${ENTITY}/people`, { bearer: SYS })).status === 200);
    const legacy = await call("POST", "/session", { body: { name: "Script Person", key: SYS }, ip: "198.51.100.50" });
    t.ok("signing in with a name and the ERP_API_TOKEN still works (as an operator)", legacy.status === 200 && legacy.data.kind === "operator");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") { cur += ch + s[i + 1]; i++; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
const unescape = (s: string) => s.replace(/\\(.)/g, "$1");
